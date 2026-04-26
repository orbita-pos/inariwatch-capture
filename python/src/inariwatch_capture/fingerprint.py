"""Fingerprint algorithm v1 — byte-identical to:

- ``capture/src/fingerprint.ts`` (Node SDK)
- ``web/lib/ai/fingerprint.ts`` (web ingest)
- ``cli/src/mcp/fingerprint.rs`` (Rust CLI)

**If you change the normalization, regenerate
``shared/fingerprint-test-vectors.json`` and update every implementation in
the same PR.** ``tests/test_fingerprint.py`` loads that file and will fail
if any vector diverges.

Normalization steps (ORDER MATTERS for cross-language determinism):
    1. Concatenate title + body with a newline, lowercase.
    2. Strip UUIDs (before epochs — UUIDs contain digit sequences).
    3. Strip ISO 8601 timestamps (lowercase ``t``).
    4. Strip Unix epochs (10-13 digits).
    5. Strip relative times (``"5 minutes ago"``).
    6. Strip hex IDs (>8 chars).
    7. Strip file paths (``/foo/bar.ts``).
    8. Strip line numbers (``at line 42``, ``:42:10``).
    9. Strip URLs.
    10. Strip version numbers (``v1.2.3``).
    11. Collapse whitespace, trim.
    12. SHA-256 -> lowercase hex (64 chars).

Every regex uses ``re.ASCII`` so ``\\b`` and ``\\w`` behave like the Rust
``regex`` crate (ASCII by default) and JavaScript ``RegExp`` without the
``u`` flag. Without this, Unicode word boundaries would match differently
on inputs with accented characters and break cross-language parity — this
is exercised by the ``unicode_accents`` vector.
"""

from __future__ import annotations

import hashlib
import re

_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.ASCII
)
_ISO8601 = re.compile(r"\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s]*", re.ASCII)
_EPOCH = re.compile(r"\b\d{10,13}\b", re.ASCII)
_REL_TIME = re.compile(
    r"\b\d+\s*(?:ms|seconds?|minutes?|hours?|days?)\s*ago\b", re.ASCII
)
_HEX_ID = re.compile(r"\b[0-9a-f]{9,}\b", re.ASCII)
_PATH = re.compile(r"(?:/[\w.\-]+){2,}(?:\.\w+)?", re.ASCII)
_LINE_NO = re.compile(r"(?:at line|line:?|:\d+:\d+)\s*\d+", re.ASCII)
_URL = re.compile(r"https?://[^\s)]+", re.ASCII)
_VERSION = re.compile(r"v?\d+\.\d+\.\d+[^\s]*", re.ASCII)
_WS = re.compile(r"\s+", re.ASCII)


def _normalize(text: str) -> str:
    s = text
    s = _UUID.sub("<uuid>", s)
    s = _ISO8601.sub("<timestamp>", s)
    s = _EPOCH.sub("<timestamp>", s)
    s = _REL_TIME.sub("<time_ago>", s)
    s = _HEX_ID.sub("<hex_id>", s)
    s = _PATH.sub("<path>", s)
    s = _LINE_NO.sub("at line <N>", s)
    s = _URL.sub("<url>", s)
    s = _VERSION.sub("<version>", s)
    return _WS.sub(" ", s).strip()


def compute_error_fingerprint(title: str, body: str) -> str:
    """Compute a deterministic fingerprint for an error pattern.

    Same error class (regardless of timestamps, IDs, paths) -> same hash.
    Returns a 64-character lowercase hex SHA-256 digest.
    """
    combined = f"{title}\n{body}".lower()
    normalized = _normalize(combined)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


__all__ = ["compute_error_fingerprint"]
