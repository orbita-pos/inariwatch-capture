//! Per-task / per-thread scope: user, tags, request context.
//!
//! Rust has no AsyncLocalStorage primitive, so we keep a global scope
//! protected by `parking_lot::Mutex` plus a cheap `with_scope` API that
//! takes a closure and isolates state for its duration. For tokio apps
//! `tokio::task_local!` is recommended once the `axum` feature is enabled
//! (the adapter binds the scope into the request future).

use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

use crate::types::{RequestContext, User};

#[derive(Default)]
pub(crate) struct ScopeData {
    pub user: Option<User>,
    pub tags: HashMap<String, String>,
    pub request: Option<RequestContext>,
}

#[derive(Clone)]
pub struct Scope(pub(crate) Arc<RwLock<ScopeData>>);

impl Scope {
    pub fn new() -> Self {
        Self(Arc::new(RwLock::new(ScopeData::default())))
    }
}

impl Default for Scope {
    fn default() -> Self {
        Self::new()
    }
}

static GLOBAL_SCOPE: once_cell::sync::Lazy<Scope> = once_cell::sync::Lazy::new(Scope::new);

pub(crate) fn global_scope() -> Scope {
    GLOBAL_SCOPE.clone()
}

pub fn set_user(user: User) {
    let safe = User { id: user.id, role: user.role };
    let scope = global_scope();
    scope.0.write().user = Some(safe);
}

pub fn get_user() -> Option<User> {
    global_scope().0.read().user.clone()
}

pub fn set_tag(key: impl Into<String>, value: impl Into<String>) {
    let scope = global_scope();
    scope.0.write().tags.insert(key.into(), value.into());
}

pub fn get_tags() -> HashMap<String, String> {
    global_scope().0.read().tags.clone()
}

pub fn set_request_context(req: RequestContext) {
    let safe = redact_request(req);
    global_scope().0.write().request = Some(safe);
}

pub fn get_request_context() -> Option<RequestContext> {
    global_scope().0.read().request.clone()
}

pub fn clear_scope() {
    let scope = global_scope();
    let mut g = scope.0.write();
    g.user = None;
    g.tags.clear();
    g.request = None;
}

const HEADER_REDACT_PATTERNS: &[&str] = &[
    "token", "key", "secret", "auth",
    "credential", "password", "cookie", "session",
];

const REDACT_BODY_FIELDS: &[&str] = &[
    "password", "passwd", "pass", "secret", "token",
    "api_key", "apikey", "access_token", "accesstoken",
    "refresh_token", "refreshtoken", "credit_card", "creditcard",
    "card_number", "cardnumber", "cvv", "cvc", "ssn",
    "social_security", "authorization",
];

pub fn should_redact_header(name: &str) -> bool {
    let lower = name.to_lowercase();
    HEADER_REDACT_PATTERNS.iter().any(|p| lower.contains(p))
}

fn is_redacted_field(k: &str) -> bool {
    let lower = k.to_lowercase();
    REDACT_BODY_FIELDS.iter().any(|f| *f == lower)
}

pub fn redact_body(value: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::String(s) => {
            if s.len() > 1024 {
                let mut out = s.chars().take(1024).collect::<String>();
                out.push_str("...[truncated]");
                Value::String(out)
            } else {
                Value::String(s)
            }
        }
        Value::Object(map) => {
            let mut safe = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                if is_redacted_field(&k) {
                    safe.insert(k, Value::String("[REDACTED]".into()));
                } else {
                    safe.insert(k, redact_body(v));
                }
            }
            Value::Object(safe)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(redact_body).collect()),
        other => other,
    }
}

pub fn redact_request(mut req: RequestContext) -> RequestContext {
    let scrubbed = req
        .headers
        .into_iter()
        .map(|(k, v)| {
            if should_redact_header(&k) {
                (k, "[REDACTED]".into())
            } else {
                (k, v)
            }
        })
        .collect();
    req.headers = scrubbed;

    if let Some(body) = req.body.take() {
        req.body = Some(redact_body(body));
    }
    req
}

/// Run `f` with a fresh scope, then restore the previous one. Useful for
/// short critical sections; framework adapters should swap to a
/// `task_local!`-based isolation when async work is involved.
pub fn with_scope<R>(f: impl FnOnce() -> R) -> R {
    let prev = {
        let scope = global_scope();
        let g = scope.0.read();
        ScopeData {
            user: g.user.clone(),
            tags: g.tags.clone(),
            request: g.request.clone(),
        }
    };
    clear_scope();
    let out = f();
    let scope = global_scope();
    let mut g = scope.0.write();
    *g = prev;
    out
}
