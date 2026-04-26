//! Breadcrumb ring buffer (30 slots) — process-wide, thread-safe.

use parking_lot::Mutex;
use std::collections::HashMap;

use crate::types::Breadcrumb;

const MAX_BREADCRUMBS: usize = 30;

static RING: once_cell::sync::Lazy<Mutex<Vec<Breadcrumb>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::with_capacity(MAX_BREADCRUMBS)));

/// Push a breadcrumb onto the ring. Oldest entries are dropped when the
/// buffer is full (FIFO, matches the Node SDK).
pub fn add_breadcrumb(category: impl Into<String>, message: impl Into<String>) {
    add_breadcrumb_with_data(category, message, HashMap::new());
}

pub fn add_breadcrumb_with_data(
    category: impl Into<String>,
    message: impl Into<String>,
    data: HashMap<String, serde_json::Value>,
) {
    let crumb = Breadcrumb {
        timestamp: chrono::Utc::now().to_rfc3339(),
        category: category.into(),
        message: scrub_secrets(&message.into()),
        data,
    };
    let mut g = RING.lock();
    if g.len() >= MAX_BREADCRUMBS {
        g.remove(0);
    }
    g.push(crumb);
}

pub fn get_breadcrumbs() -> Vec<Breadcrumb> {
    RING.lock().clone()
}

pub fn clear_breadcrumbs() {
    RING.lock().clear();
}

/// URL query-string scrubber — drops the value half of any pair whose key
/// name looks sensitive. Mirrors the Node SDK's `scrubUrl` behaviour.
pub fn scrub_url(url: &str) -> String {
    if let Some(qmark) = url.find('?') {
        let (base, qs) = url.split_at(qmark);
        let qs = &qs[1..];
        let mut out_parts = Vec::new();
        for pair in qs.split('&') {
            if let Some((k, _v)) = pair.split_once('=') {
                let lower = k.to_lowercase();
                let sensitive = ["token", "key", "secret", "password", "auth", "credential"]
                    .iter()
                    .any(|p| lower.contains(p));
                if sensitive {
                    out_parts.push(format!("{}=[REDACTED]", k));
                } else {
                    out_parts.push(pair.to_string());
                }
            } else {
                out_parts.push(pair.to_string());
            }
        }
        format!("{}?{}", base, out_parts.join("&"))
    } else {
        url.to_string()
    }
}

/// Replace tokens that look like bearer / JWT / API key / connection
/// strings with `[REDACTED]`. Same pattern set as Python/Node.
pub fn scrub_secrets(text: &str) -> String {
    let r = secret_regex_set();
    let mut out = text.to_string();
    for re in r {
        out = re.replace_all(&out, "[REDACTED]").into_owned();
    }
    out
}

fn secret_regex_set() -> &'static [regex::Regex] {
    static SET: once_cell::sync::OnceCell<Vec<regex::Regex>> = once_cell::sync::OnceCell::new();
    SET.get_or_init(|| {
        let patterns = [
            r"(?i)bearer\s+[a-z0-9._\-]+",
            r"eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+",
            r"sk_[a-z]+_[a-zA-Z0-9]+",
            r"(?i)(?:postgres|mysql|mongodb|redis)://[^\s]*",
            r"(?i)(?:password|secret|token|api_key)=[^\s&]+",
        ];
        patterns
            .iter()
            .map(|p| regex::Regex::new(p).unwrap())
            .collect()
    })
}
