//! Top-level API: `init`, `capture_exception`, `capture_message`,
//! `capture_log`, `flush`, `install_panic_hook`.

use parking_lot::RwLock;
use std::backtrace::Backtrace;
use std::collections::HashMap;
use std::sync::Arc;

use crate::breadcrumbs::get_breadcrumbs;
use crate::environment::get_environment_context;
use crate::fingerprint::compute_error_fingerprint;
use crate::git::get_git_context;
use crate::scope::{get_request_context, get_tags, get_user};
use crate::transport::{parse_dsn, LocalTransport, Transport};
use crate::types::{Config, ErrorEvent, Severity};

struct State {
    transport: Option<Arc<dyn Transport>>,
    config: Config,
    inited: bool,
    before_send: Option<Box<dyn Fn(ErrorEvent) -> Option<ErrorEvent> + Send + Sync>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            transport: None,
            config: Config::default(),
            inited: false,
            before_send: None,
        }
    }
}

static STATE: once_cell::sync::Lazy<RwLock<State>> =
    once_cell::sync::Lazy::new(|| RwLock::new(State::default()));

/// Initialize the SDK. Idempotent: a second `init` replaces config + transport.
pub fn init(config: Config) {
    let transport: Arc<dyn Transport> = match config.dsn.as_deref() {
        Some(dsn) => match parse_dsn(dsn) {
            Ok(parsed) => {
                #[cfg(feature = "transport-ureq")]
                {
                    Arc::new(crate::transport::make_ureq_transport(parsed))
                }
                #[cfg(not(feature = "transport-ureq"))]
                {
                    let _ = parsed;
                    Arc::new(LocalTransport)
                }
            }
            Err(e) => {
                eprintln!("[inariwatch-capture] DSN parse error: {e} — falling back to local mode");
                Arc::new(LocalTransport)
            }
        },
        None => {
            if !config.silent {
                eprintln!(
                    "[inariwatch-capture] Local mode — errors print to stderr. Set INARIWATCH_DSN to send to cloud."
                );
            }
            Arc::new(LocalTransport)
        }
    };

    let mut g = STATE.write();
    g.transport = Some(transport);
    g.config = config;
    g.inited = true;
}

/// Replace the active transport — primarily for tests.
pub fn set_transport_for_testing(t: Arc<dyn Transport>) {
    let mut g = STATE.write();
    g.transport = Some(t);
    g.inited = true;
}

pub fn reset_for_testing() {
    let mut g = STATE.write();
    g.transport = None;
    g.config = Config::default();
    g.inited = false;
    g.before_send = None;
}

/// Register a `before_send` filter. Returning `None` drops the event.
pub fn set_before_send<F>(f: F)
where
    F: Fn(ErrorEvent) -> Option<ErrorEvent> + Send + Sync + 'static,
{
    let mut g = STATE.write();
    g.before_send = Some(Box::new(f));
}

fn dispatch(mut event: ErrorEvent) {
    let g = STATE.read();
    if !g.inited {
        return;
    }
    let transport = match &g.transport {
        Some(t) => t.clone(),
        None => return,
    };

    if let Some(hook) = &g.before_send {
        match hook(event) {
            Some(out) => event = out,
            None => return,
        }
    }
    drop(g);
    transport.send(event);
}

fn enrich(mut ev: ErrorEvent) -> ErrorEvent {
    if let Some(g) = get_git_context() {
        ev.git = Some(g);
    }
    ev.env = Some(get_environment_context());
    let crumbs = get_breadcrumbs();
    if !crumbs.is_empty() {
        ev.breadcrumbs = crumbs;
    }
    if let Some(u) = get_user() {
        ev.user = Some(u);
    }
    let tags = get_tags();
    if !tags.is_empty() {
        ev.tags = tags;
    }
    if ev.request.is_none() {
        if let Some(req) = get_request_context() {
            ev.request = Some(req);
        }
    }
    if ev.runtime.is_empty() {
        ev.runtime = "rust".into();
    }
    ev
}

/// Capture a `std::error::Error` reference.
pub fn capture_exception(err: &(dyn std::error::Error + 'static), context: Option<HashMap<String, serde_json::Value>>) {
    let title = format!("{}: {}", std::any::type_name_of_val(err), err);
    let bt = Backtrace::capture();
    let body = format!("{title}\n{bt}");
    let cfg = STATE.read().config.clone();

    let mut ev = enrich(ErrorEvent {
        fingerprint: compute_error_fingerprint(&title, &body),
        title: title.clone(),
        body,
        severity: Severity::Critical,
        timestamp: chrono::Utc::now().to_rfc3339(),
        environment: cfg.environment,
        release: cfg.release,
        event_type: "error".into(),
        ..Default::default()
    });
    if let Some(ctx) = context {
        ev.context = ctx;
    }
    dispatch(ev);
}

/// Capture a free-form panic / message.
pub fn capture_message(message: impl Into<String>, severity: Severity) {
    let m = message.into();
    let cfg = STATE.read().config.clone();
    let ev = enrich(ErrorEvent {
        fingerprint: compute_error_fingerprint(&m, ""),
        title: m.clone(),
        body: m,
        severity,
        timestamp: chrono::Utc::now().to_rfc3339(),
        environment: cfg.environment,
        release: cfg.release,
        event_type: "error".into(),
        ..Default::default()
    });
    dispatch(ev);
}

/// Capture a structured log line. `level` is one of "debug" / "info" /
/// "warning" / "error" / "critical".
pub fn capture_log(message: impl Into<String>, level: &str, metadata: HashMap<String, serde_json::Value>) {
    let severity = match level.to_lowercase().as_str() {
        "critical" | "fatal" => Severity::Critical,
        "warn" | "warning" => Severity::Warning,
        "info" => Severity::Info,
        "debug" => Severity::Debug,
        _ => Severity::Error,
    };
    let m = message.into();
    let cfg = STATE.read().config.clone();
    let mut ev = enrich(ErrorEvent {
        fingerprint: compute_error_fingerprint(&m, ""),
        title: m.clone(),
        body: m,
        severity,
        timestamp: chrono::Utc::now().to_rfc3339(),
        environment: cfg.environment,
        release: cfg.release,
        event_type: "log".into(),
        ..Default::default()
    });
    ev.metadata = metadata;
    dispatch(ev);
}

/// Flush any buffered events. Safe to call multiple times.
pub fn flush(timeout_seconds: u64) {
    let g = STATE.read();
    if let Some(t) = g.transport.as_ref() {
        t.flush(timeout_seconds);
    }
}

/// Install a panic hook that captures unhandled panics before falling
/// through to the previously-registered hook.
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let location = info
            .location()
            .map(|l| format!(" at {}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let bt = Backtrace::capture();
        let title = format!("panic: {msg}{location}");
        let body = format!("{title}\n{bt}");
        let cfg = STATE.read().config.clone();
        let ev = enrich(ErrorEvent {
            fingerprint: compute_error_fingerprint(&title, &body),
            title,
            body,
            severity: Severity::Critical,
            timestamp: chrono::Utc::now().to_rfc3339(),
            environment: cfg.environment,
            release: cfg.release,
            event_type: "error".into(),
            ..Default::default()
        });
        dispatch(ev);
        prev(info);
    }));
}
