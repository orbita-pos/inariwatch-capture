use inariwatch_capture::{
    capture_exception, capture_log, capture_message, init, reset_for_testing, set_before_send,
    set_transport_for_testing, Config, ErrorEvent, Severity, Transport,
};
use parking_lot::{Mutex, MutexGuard};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

// Client state is process-global; serialize so parallel tests don't race
// on the singleton transport.
fn lock() -> MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(())).lock()
}

#[derive(Default)]
struct Recording {
    events: Mutex<Vec<ErrorEvent>>,
}

impl Transport for Recording {
    fn send(&self, event: ErrorEvent) {
        self.events.lock().push(event);
    }
}

fn fresh() -> (Arc<Recording>, MutexGuard<'static, ()>) {
    let g = lock();
    reset_for_testing();
    init(Config {
        silent: true,
        environment: Some("test".into()),
        ..Default::default()
    });
    let rec = Arc::new(Recording::default());
    set_transport_for_testing(rec.clone());
    (rec, g)
}

#[derive(Debug)]
struct DemoErr(&'static str);

impl std::fmt::Display for DemoErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for DemoErr {}

#[test]
fn capture_exception_attaches_runtime_and_fingerprint() {
    let (rec, _g) = fresh();
    capture_exception(&DemoErr("boom"), None);
    let evs = rec.events.lock().clone();
    assert_eq!(evs.len(), 1);
    let ev = &evs[0];
    assert_eq!(ev.runtime, "rust");
    assert_eq!(ev.event_type, "error");
    assert!(matches!(ev.severity, Severity::Critical));
    assert_eq!(ev.fingerprint.len(), 64);
    assert!(ev.title.contains("boom"));
}

#[test]
fn capture_message_uses_severity_arg() {
    let (rec, _g) = fresh();
    capture_message("disk almost full", Severity::Warning);
    let evs = rec.events.lock().clone();
    assert_eq!(evs.len(), 1);
    assert!(matches!(evs[0].severity, Severity::Warning));
    assert_eq!(evs[0].title, "disk almost full");
}

#[test]
fn capture_log_metadata_round_trips() {
    let (rec, _g) = fresh();
    let mut meta = HashMap::new();
    meta.insert("region".into(), serde_json::json!("us-east-1"));
    meta.insert("attempt".into(), serde_json::json!(3));
    capture_log("retry exhausted", "error", meta);
    let evs = rec.events.lock().clone();
    let ev = &evs[0];
    assert_eq!(ev.event_type, "log");
    assert_eq!(ev.metadata.get("region").unwrap(), &serde_json::json!("us-east-1"));
}

#[test]
fn before_send_can_drop_event() {
    let (rec, _g) = fresh();
    set_before_send(|_| None);
    capture_exception(&DemoErr("nope"), None);
    let evs = rec.events.lock().clone();
    assert_eq!(evs.len(), 0);
}

#[test]
fn before_send_can_mutate_event() {
    let (rec, _g) = fresh();
    set_before_send(|mut ev| {
        ev.tags.insert("rewritten".into(), "yes".into());
        Some(ev)
    });
    capture_exception(&DemoErr("ok"), None);
    let evs = rec.events.lock().clone();
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0].tags.get("rewritten").map(String::as_str), Some("yes"));
}

#[test]
fn uninitialized_capture_is_a_no_op() {
    let _g = lock();
    reset_for_testing();
    // No init, no transport — must not panic.
    capture_exception(&DemoErr("ignored"), None);
    capture_message("ignored", Severity::Info);
}
