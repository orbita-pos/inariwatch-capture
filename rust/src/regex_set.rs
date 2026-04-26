//! Compiled-once regex set used by fingerprinting + breadcrumb scrubbing.
//!
//! Patterns mirror `capture/python/.../fingerprint.py` line-for-line so
//! cross-language outputs match. The `regex` crate runs in ASCII byte mode
//! by default — same semantics as the Python `re.ASCII` flag and JS
//! `RegExp` without the `u` flag — which is what keeps `\b` and `\w`
//! aligned across runtimes.

use once_cell::sync::OnceCell;
use regex::Regex;

pub struct RegexCache {
    pub uuid: Regex,
    pub iso_timestamp: Regex,
    pub unix_epoch: Regex,
    pub rel_time: Regex,
    pub hex_id: Regex,
    pub path: Regex,
    pub line_no: Regex,
    pub url: Regex,
    pub version: Regex,
    pub whitespace: Regex,
}

impl RegexCache {
    fn compile() -> Self {
        Self {
            uuid: Regex::new(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            )
            .unwrap(),
            iso_timestamp: Regex::new(r"\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s]*").unwrap(),
            unix_epoch: Regex::new(r"\b\d{10,13}\b").unwrap(),
            rel_time: Regex::new(
                r"\b\d+\s*(?:ms|seconds?|minutes?|hours?|days?)\s*ago\b",
            )
            .unwrap(),
            hex_id: Regex::new(r"\b[0-9a-f]{9,}\b").unwrap(),
            path: Regex::new(r"(?:/[\w.\-]+){2,}(?:\.\w+)?").unwrap(),
            line_no: Regex::new(r"(?:at line|line:?|:\d+:\d+)\s*\d+").unwrap(),
            url: Regex::new(r"https?://[^\s)]+").unwrap(),
            version: Regex::new(r"v?\d+\.\d+\.\d+[^\s]*").unwrap(),
            whitespace: Regex::new(r"\s+").unwrap(),
        }
    }
}

pub fn regex_cache() -> &'static RegexCache {
    static CACHE: OnceCell<RegexCache> = OnceCell::new();
    CACHE.get_or_init(RegexCache::compile)
}
