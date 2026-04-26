use inariwatch_capture::{parse_dsn, sign_payload, DsnError};

#[test]
fn parse_local_dsn_skips_https_check() {
    let parsed = parse_dsn("http://devsecret@localhost:3000/capture/abc").expect("ok");
    assert!(parsed.is_local);
    assert_eq!(parsed.project_id, "abc");
    assert_eq!(parsed.secret, "devsecret");
    assert!(parsed.url.contains("/api/webhooks/capture/abc"));
}

#[test]
fn parse_cloud_dsn_requires_https() {
    let err = parse_dsn("http://secret@example.com/capture/abc").unwrap_err();
    matches!(err, DsnError::HttpRequiresLocalhost);
}

#[test]
fn parse_cloud_dsn_accepts_https() {
    let parsed = parse_dsn("https://prodsecret@app.inariwatch.com/capture/proj42").expect("ok");
    assert!(!parsed.is_local);
    assert_eq!(parsed.project_id, "proj42");
    assert!(parsed.url.starts_with("https://"));
    assert!(parsed.url.ends_with("/api/webhooks/capture/proj42"));
}

#[test]
fn parse_dsn_rejects_missing_secret() {
    let err = parse_dsn("https://app.inariwatch.com/capture/proj").unwrap_err();
    matches!(err, DsnError::MissingSecret);
}

#[test]
fn parse_dsn_rejects_missing_project_id() {
    let err = parse_dsn("https://secret@app.inariwatch.com/capture/").unwrap_err();
    matches!(err, DsnError::MissingProjectId);
}

#[test]
fn sign_payload_matches_known_hmac() {
    // Reference HMAC-SHA256("hello", "secret") computed by openssl.
    let sig = sign_payload(b"hello", "secret");
    assert_eq!(
        sig,
        "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b"
    );
}

#[test]
fn sign_payload_changes_with_input() {
    let a = sign_payload(b"hello", "secret");
    let b = sign_payload(b"hello!", "secret");
    assert_ne!(a, b);
}
