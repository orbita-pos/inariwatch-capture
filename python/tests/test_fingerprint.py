"""Cross-language fingerprint conformance.

Loads the same ``shared/fingerprint-test-vectors.json`` that the Rust CLI
and TypeScript web tests consume. If any vector fails here the SDK has
diverged from the canonical algorithm — do NOT regenerate the vectors
unless you are intentionally updating the algorithm across all
implementations in the same PR.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from inariwatch_capture.fingerprint import compute_error_fingerprint


def test_same_input_same_hash() -> None:
    a = compute_error_fingerprint("TypeError: x is null", "at UserProfile.tsx:42")
    b = compute_error_fingerprint("TypeError: x is null", "at UserProfile.tsx:42")
    assert a == b
    assert len(a) == 64


def test_different_timestamps_same_hash() -> None:
    a = compute_error_fingerprint("Error at 2024-01-15T10:30:00Z", "deploy failed")
    b = compute_error_fingerprint("Error at 2026-03-24T15:00:00Z", "deploy failed")
    assert a == b


def test_different_uuids_same_hash() -> None:
    a = compute_error_fingerprint(
        "Failed for user a1b2c3d4-e5f6-7890-abcd-ef1234567890", ""
    )
    b = compute_error_fingerprint(
        "Failed for user 11111111-2222-3333-4444-555555555555", ""
    )
    assert a == b


def test_different_line_numbers_same_hash() -> None:
    a = compute_error_fingerprint("TypeError", "at line 42 in render()")
    b = compute_error_fingerprint("TypeError", "at line 999 in render()")
    assert a == b


def test_different_paths_same_hash() -> None:
    a = compute_error_fingerprint("Error in /src/components/UserProfile.tsx", "")
    b = compute_error_fingerprint("Error in /src/pages/Dashboard.tsx", "")
    assert a == b


def test_different_versions_same_hash() -> None:
    a = compute_error_fingerprint("next@14.1.0 build failed", "")
    b = compute_error_fingerprint("next@15.0.3 build failed", "")
    assert a == b


def test_empty_input_stable() -> None:
    a = compute_error_fingerprint("", "")
    b = compute_error_fingerprint("", "")
    assert a == b
    assert len(a) == 64


def test_different_errors_different_hash() -> None:
    a = compute_error_fingerprint("TypeError: x is null", "")
    b = compute_error_fingerprint("SyntaxError: unexpected token", "")
    assert a != b


def test_case_insensitive() -> None:
    a = compute_error_fingerprint("ERROR: CONNECTION refused", "")
    b = compute_error_fingerprint("error: connection Refused", "")
    assert a == b


def test_whitespace_collapsed() -> None:
    a = compute_error_fingerprint("Error   with   extra    spaces", "body")
    b = compute_error_fingerprint("Error with extra spaces", "body")
    assert a == b


def test_hash_is_lowercase_hex() -> None:
    fp = compute_error_fingerprint("TypeError", "stack")
    assert len(fp) == 64
    assert all(c in "0123456789abcdef" for c in fp)


@pytest.fixture(scope="module")
def cross_language_vectors(fingerprint_vectors_path: Path) -> list[dict]:
    data = json.loads(fingerprint_vectors_path.read_text(encoding="utf-8"))
    return data["vectors"]


def test_cross_language_golden_vectors(cross_language_vectors: list[dict]) -> None:
    """Every vector in shared/fingerprint-test-vectors.json must match.

    If this fails, Python and the Node/Rust/web implementations have
    diverged. The fix is almost always to bring the Python side back in
    line, not to regenerate the vectors.
    """
    failures: list[str] = []
    for vector in cross_language_vectors:
        vid: str = vector["id"]
        title: str = vector["title"]
        body: str = vector["body"]
        expected: str = vector["expected"]
        actual = compute_error_fingerprint(title, body)
        if actual != expected:
            failures.append(f"  [{vid}] expected={expected} actual={actual}")

    assert not failures, (
        "Fingerprint mismatch vs shared vectors — Python SDK has diverged:\n"
        + "\n".join(failures)
    )
