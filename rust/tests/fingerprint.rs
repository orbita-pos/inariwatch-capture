//! Cross-language fingerprint conformance.
//!
//! Loads the same `shared/fingerprint-test-vectors.json` the Node SDK,
//! Python SDK, and Rust CLI consume. Any divergence here means this SDK
//! has drifted from the canonical algorithm — do not regenerate the
//! vectors unless every implementation is being updated in the same PR.

use inariwatch_capture::compute_error_fingerprint;
use std::fs;
use std::path::PathBuf;

#[derive(serde::Deserialize)]
struct Vector {
    id: String,
    title: String,
    body: String,
    expected: String,
}

#[derive(serde::Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

fn vectors_path() -> PathBuf {
    // The crate sits at capture/rust/, the shared file lives at the repo root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("shared")
        .join("fingerprint-test-vectors.json")
}

#[test]
fn cross_language_golden_vectors() {
    let path = vectors_path();
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("read {} failed: {}", path.display(), e);
    });
    let parsed: Vectors = serde_json::from_str(&raw).expect("parse vectors json");
    let mut failures = Vec::new();
    for v in &parsed.vectors {
        let got = compute_error_fingerprint(&v.title, &v.body);
        if got != v.expected {
            failures.push(format!(
                "{}: expected {} got {}",
                v.id, v.expected, got
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} vector(s) diverged:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn same_input_same_hash() {
    let a = compute_error_fingerprint("ValueError", "stack trace");
    let b = compute_error_fingerprint("ValueError", "stack trace");
    assert_eq!(a, b);
}

#[test]
fn different_uuids_same_hash() {
    let a = compute_error_fingerprint(
        "ValueError",
        "user 550e8400-e29b-41d4-a716-446655440000 not found",
    );
    let b = compute_error_fingerprint(
        "ValueError",
        "user 6ba7b810-9dad-11d1-80b4-00c04fd430c8 not found",
    );
    assert_eq!(a, b);
}

#[test]
fn different_line_numbers_same_hash() {
    // Use the canonical "at line N" form — that's what the line-number
    // normalizer is built around.
    let a = compute_error_fingerprint("Error", "thrown at line 42");
    let b = compute_error_fingerprint("Error", "thrown at line 99");
    assert_eq!(a, b);
}
