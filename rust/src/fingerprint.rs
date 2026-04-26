//! Fingerprint algorithm v1 — byte-identical to:
//!
//! - `capture/src/fingerprint.ts` (Node SDK)
//! - `capture/python/.../fingerprint.py` (Python SDK)
//! - `capture/go/fingerprint.go` (Go SDK)
//! - `web/lib/ai/fingerprint.ts` (web ingest)
//! - `cli/src/mcp/fingerprint.rs` (Rust CLI)
//!
//! Steps (ORDER MATTERS):
//! 1. Concatenate `title + "\n" + body`, lowercase the whole thing.
//! 2. UUID -> `<uuid>` (must run before epoch — UUIDs contain digit runs).
//! 3. ISO 8601 timestamps (`t` is already lowercased) -> `<timestamp>`.
//! 4. Unix epochs (10-13 digits) -> `<timestamp>`.
//! 5. Relative times (`5 minutes ago`) -> `<time_ago>`.
//! 6. Hex IDs (9+ chars) -> `<hex_id>`.
//! 7. File paths (`/foo/bar.ts`) -> `<path>`.
//! 8. Line numbers (`at line 42`, `:42:10`) -> `at line <N>`.
//! 9. URLs -> `<url>`.
//! 10. Version numbers -> `<version>`.
//! 11. Collapse whitespace, trim.
//! 12. SHA-256, lowercase hex.

use sha2::{Digest, Sha256};

use crate::regex_set::regex_cache;

pub fn compute_error_fingerprint(title: &str, body: &str) -> String {
    let combined = format!("{}\n{}", title, body).to_lowercase();
    let normalized = normalize(&combined);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

fn normalize(text: &str) -> String {
    let r = regex_cache();
    let mut s = text.to_string();
    s = r.uuid.replace_all(&s, "<uuid>").into_owned();
    s = r.iso_timestamp.replace_all(&s, "<timestamp>").into_owned();
    s = r.unix_epoch.replace_all(&s, "<timestamp>").into_owned();
    s = r.rel_time.replace_all(&s, "<time_ago>").into_owned();
    s = r.hex_id.replace_all(&s, "<hex_id>").into_owned();
    s = r.path.replace_all(&s, "<path>").into_owned();
    s = r.line_no.replace_all(&s, "at line <N>").into_owned();
    s = r.url.replace_all(&s, "<url>").into_owned();
    s = r.version.replace_all(&s, "<version>").into_owned();
    s = r.whitespace.replace_all(&s, " ").into_owned();
    s.trim().to_string()
}
