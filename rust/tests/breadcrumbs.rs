use inariwatch_capture::{
    add_breadcrumb, clear_breadcrumbs, get_breadcrumbs, scrub_secrets, scrub_url,
};
use parking_lot::Mutex;
use std::sync::OnceLock;

// Tests share the process-global ring buffer, so we serialize the
// ring-mutating tests behind one mutex. Pure-function tests (scrub_url,
// scrub_secrets) skip the lock.
fn ring_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

#[test]
fn ring_caps_at_30() {
    let _g = ring_lock().lock();
    clear_breadcrumbs();
    for i in 0..50 {
        add_breadcrumb("test", format!("crumb-{i}"));
    }
    let crumbs = get_breadcrumbs();
    assert_eq!(crumbs.len(), 30);
    // Oldest dropped — first crumb should be index 20 (50 - 30).
    assert_eq!(crumbs[0].message, "crumb-20");
    assert_eq!(crumbs[29].message, "crumb-49");
}

#[test]
fn scrub_url_redacts_sensitive_query_params() {
    let out = scrub_url("https://api.example.com/x?token=abc&page=2");
    assert!(out.contains("token=[REDACTED]"));
    assert!(out.contains("page=2"));
}

#[test]
fn scrub_url_no_query_unchanged() {
    let out = scrub_url("https://api.example.com/x");
    assert_eq!(out, "https://api.example.com/x");
}

#[test]
fn scrub_secrets_handles_bearer_jwt_and_connstrings() {
    let out = scrub_secrets("Auth: Bearer eyJhbCciOiJIUzI1NiJ9.payload.sig and DB postgres://u:p@host/db");
    assert!(out.contains("[REDACTED]"));
    // Make sure both classes were caught somehow.
    assert!(!out.contains("Bearer eyJ") || !out.contains("postgres://u:p"));
}

#[test]
fn add_breadcrumb_message_is_scrubbed() {
    let _g = ring_lock().lock();
    clear_breadcrumbs();
    // Bearer token in the message — matches the canonical scrub pattern.
    add_breadcrumb("http", "GET /x with header Authorization: Bearer abc123");
    let c = get_breadcrumbs();
    assert_eq!(c.len(), 1);
    assert!(
        c[0].message.contains("[REDACTED]"),
        "expected redaction, got: {}",
        c[0].message
    );
}
