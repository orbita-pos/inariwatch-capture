use inariwatch_capture::{
    clear_scope, get_request_context, get_tags, get_user, redact_body, redact_request,
    set_request_context, set_tag, set_user, RequestContext, User,
};
use parking_lot::{Mutex, MutexGuard};
use serde_json::json;
use std::collections::HashMap;
use std::sync::OnceLock;

fn lock() -> MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(())).lock()
}

fn fresh() -> MutexGuard<'static, ()> {
    let g = lock();
    clear_scope();
    g
}

#[test]
fn set_user_strips_email() {
    let _g = fresh();
    set_user(User {
        id: "u1".into(),
        role: Some("admin".into()),
    });
    let u = get_user().expect("user");
    assert_eq!(u.id, "u1");
    assert_eq!(u.role.as_deref(), Some("admin"));
}

#[test]
fn set_tag_accumulates() {
    let _g = fresh();
    set_tag("region", "us-east-1");
    set_tag("k8s_namespace", "prod");
    let tags = get_tags();
    assert_eq!(tags.get("region").map(String::as_str), Some("us-east-1"));
    assert_eq!(tags.get("k8s_namespace").map(String::as_str), Some("prod"));
}

#[test]
fn set_request_context_redacts_headers() {
    let _g = fresh();
    let mut headers = HashMap::new();
    headers.insert("Authorization".into(), "Bearer abc".into());
    headers.insert("X-Auth-Token".into(), "leak".into());
    headers.insert("Accept".into(), "application/json".into());
    set_request_context(RequestContext {
        method: Some("POST".into()),
        url: Some("/x".into()),
        headers,
        ..Default::default()
    });
    let req = get_request_context().expect("req");
    assert_eq!(req.headers.get("Authorization").unwrap(), "[REDACTED]");
    assert_eq!(req.headers.get("X-Auth-Token").unwrap(), "[REDACTED]");
    assert_eq!(req.headers.get("Accept").unwrap(), "application/json");
}

#[test]
fn redact_body_scrubs_nested_secrets() {
    let body = json!({
        "user": "alice",
        "password": "hunter2",
        "nested": {
            "api_key": "sk_live_xxx",
            "deep": { "token": "leak" }
        },
        "items": [{ "secret": "X", "ok": "Y" }]
    });
    let safe = redact_body(body);
    assert_eq!(safe["password"], json!("[REDACTED]"));
    assert_eq!(safe["nested"]["api_key"], json!("[REDACTED]"));
    assert_eq!(safe["nested"]["deep"]["token"], json!("[REDACTED]"));
    assert_eq!(safe["items"][0]["secret"], json!("[REDACTED]"));
    assert_eq!(safe["items"][0]["ok"], json!("Y"));
}

#[test]
fn redact_request_scrubs_body_and_headers() {
    let mut headers = HashMap::new();
    headers.insert("Cookie".into(), "session=xxx".into());
    let req = RequestContext {
        method: Some("PUT".into()),
        url: Some("/profile".into()),
        headers,
        body: Some(json!({ "password": "hunter2", "name": "alice" })),
        ..Default::default()
    };
    let safe = redact_request(req);
    assert_eq!(safe.headers.get("Cookie").unwrap(), "[REDACTED]");
    let body = safe.body.unwrap();
    assert_eq!(body["password"], json!("[REDACTED]"));
    assert_eq!(body["name"], json!("alice"));
}
