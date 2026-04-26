//! DSN parser + HMAC signed transport (ureq feature) + retry buffer.
//!
//! Wire format matches `capture/src/transport.ts` and the Python/Go SDKs:
//! HMAC-SHA256 over the raw JSON body, header `x-capture-signature: sha256=<hex>`.
//! Localhost DSNs skip TLS + HMAC to keep dev frictionless.

use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Arc;

use crate::types::ErrorEvent;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct ParsedDsn {
    pub url: String,
    pub secret: String,
    pub project_id: String,
    pub is_local: bool,
}

#[derive(Debug)]
pub enum DsnError {
    InvalidUrl(String),
    MissingSecret,
    MissingProjectId,
    HttpRequiresLocalhost,
}

impl std::fmt::Display for DsnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DsnError::InvalidUrl(s) => write!(f, "invalid DSN url: {}", s),
            DsnError::MissingSecret => write!(f, "DSN missing secret (use https://SECRET@host/capture/ID)"),
            DsnError::MissingProjectId => write!(f, "DSN missing project id"),
            DsnError::HttpRequiresLocalhost => {
                write!(f, "DSN must use HTTPS unless host is localhost / 127.0.0.1")
            }
        }
    }
}

impl std::error::Error for DsnError {}

/// Parse `https://SECRET@host/capture/PROJECT_ID` (and `http://...` for
/// localhost).
pub fn parse_dsn(dsn: &str) -> Result<ParsedDsn, DsnError> {
    let mut s = dsn.trim().to_string();

    let scheme;
    if let Some(rest) = s.strip_prefix("https://") {
        scheme = "https";
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("http://") {
        scheme = "http";
        s = rest.to_string();
    } else {
        return Err(DsnError::InvalidUrl(dsn.into()));
    }

    let (secret, host_path) = match s.split_once('@') {
        Some((sec, hp)) => (sec.to_string(), hp.to_string()),
        None => return Err(DsnError::MissingSecret),
    };

    if secret.is_empty() {
        return Err(DsnError::MissingSecret);
    }

    let (host, mut path) = match host_path.split_once('/') {
        Some((h, p)) => (h.to_string(), format!("/{}", p)),
        None => (host_path, "/".to_string()),
    };

    let host_only = host.split(':').next().unwrap_or("").to_string();
    let is_local = host_only == "localhost" || host_only == "127.0.0.1";

    if scheme == "http" && !is_local {
        return Err(DsnError::HttpRequiresLocalhost);
    }

    // Path normalization: `/capture/ID` -> `/api/webhooks/capture/ID`.
    let project_id = if let Some(rest) = path.strip_prefix("/capture/") {
        let id = rest.trim_end_matches('/').to_string();
        if id.is_empty() {
            return Err(DsnError::MissingProjectId);
        }
        path = format!("/api/webhooks/capture/{}", id);
        id
    } else if let Some(rest) = path.strip_prefix("/api/webhooks/capture/") {
        let id = rest.trim_end_matches('/').to_string();
        if id.is_empty() {
            return Err(DsnError::MissingProjectId);
        }
        id
    } else {
        return Err(DsnError::InvalidUrl(dsn.into()));
    };

    Ok(ParsedDsn {
        url: format!("{}://{}{}", scheme, host, path),
        secret,
        project_id,
        is_local,
    })
}

/// Compute the HMAC-SHA256 hex over `payload` using `secret`. Matches the
/// Python/Node/Go reference implementations bit-for-bit.
pub fn sign_payload(payload: &[u8], secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key length");
    mac.update(payload);
    hex::encode(mac.finalize().into_bytes())
}

/// Trait for outgoing event delivery — lets tests swap in a fake sink.
pub trait Transport: Send + Sync {
    fn send(&self, event: ErrorEvent);
    fn flush(&self, _timeout_seconds: u64) {}
    fn close(&self) {}
}

/// In-memory ring of unsent events keyed by fingerprint.
pub(crate) struct RetryBuffer {
    inner: Mutex<HashMap<String, ErrorEvent>>,
    cap: usize,
}

impl RetryBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Mutex::new(HashMap::with_capacity(cap)),
            cap,
        }
    }

    pub fn push(&self, ev: ErrorEvent) {
        let mut g = self.inner.lock();
        if g.len() >= self.cap && !g.contains_key(&ev.fingerprint) {
            // Drop the oldest by clearing (HashMap has no insertion order).
            // Keeping it bounded is more important than precise FIFO here —
            // the dedup-by-fingerprint behaviour is the primary contract.
            g.clear();
        }
        g.insert(ev.fingerprint.clone(), ev);
    }

    pub fn drain(&self) -> Vec<ErrorEvent> {
        let mut g = self.inner.lock();
        g.drain().map(|(_, v)| v).collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }
}

/// Local development transport — pretty-prints to stderr instead of HTTP.
pub struct LocalTransport;

impl Transport for LocalTransport {
    fn send(&self, event: ErrorEvent) {
        let severity = event.severity_str();
        let title = event.title.clone();
        let body_first = event.body.lines().next().unwrap_or("").to_string();
        eprintln!("[inariwatch-capture] {} — {}", severity, title);
        if !body_first.is_empty() && body_first != title {
            eprintln!("                    {}", body_first);
        }
    }
}

impl ErrorEvent {
    pub(crate) fn severity_str(&self) -> &'static str {
        match self.severity {
            crate::types::Severity::Critical => "CRITICAL",
            crate::types::Severity::Error => "ERROR",
            crate::types::Severity::Warning => "WARNING",
            crate::types::Severity::Info => "INFO",
            crate::types::Severity::Debug => "DEBUG",
        }
    }
}

/// HTTP transport — generic over a "send raw bytes" closure so we can keep
/// the ureq + reqwest backends behind cargo features without duplicating
/// the retry / dedup logic.
pub struct RemoteTransport {
    pub(crate) parsed: ParsedDsn,
    pub(crate) buffer: Arc<RetryBuffer>,
    pub(crate) sender: Box<dyn Fn(&str, &str, &str, &[u8]) -> Result<(), String> + Send + Sync>,
}

impl RemoteTransport {
    pub fn new<F>(parsed: ParsedDsn, sender: F) -> Self
    where
        F: Fn(&str, &str, &str, &[u8]) -> Result<(), String> + Send + Sync + 'static,
    {
        Self {
            parsed,
            buffer: Arc::new(RetryBuffer::new(30)),
            sender: Box::new(sender),
        }
    }
}

impl Transport for RemoteTransport {
    fn send(&self, event: ErrorEvent) {
        let payload = match serde_json::to_vec(&event) {
            Ok(p) => p,
            Err(_) => return,
        };
        let signature = if self.parsed.is_local {
            String::new()
        } else {
            format!("sha256={}", sign_payload(&payload, &self.parsed.secret))
        };

        // Drain whatever was buffered first, then send the new one.
        let mut to_send = self.buffer.drain();
        to_send.push(event.clone());

        for ev in to_send {
            let body = match serde_json::to_vec(&ev) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let sig = if self.parsed.is_local {
                String::new()
            } else {
                format!("sha256={}", sign_payload(&body, &self.parsed.secret))
            };
            if let Err(_e) = (self.sender)(&self.parsed.url, &self.parsed.project_id, &sig, &body) {
                self.buffer.push(ev);
            }
        }
        // Ensure nothing references `signature` if all sends were OK; the
        // local block above would have drained the buffer cleanly.
        let _ = signature;
    }

    fn flush(&self, _timeout: u64) {
        let to_send = self.buffer.drain();
        for ev in to_send {
            let body = match serde_json::to_vec(&ev) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let sig = if self.parsed.is_local {
                String::new()
            } else {
                format!("sha256={}", sign_payload(&body, &self.parsed.secret))
            };
            if let Err(_e) = (self.sender)(&self.parsed.url, &self.parsed.project_id, &sig, &body) {
                self.buffer.push(ev);
            }
        }
    }
}

#[cfg(feature = "transport-ureq")]
pub fn make_ureq_transport(parsed: ParsedDsn) -> RemoteTransport {
    RemoteTransport::new(parsed, |url, project_id, signature, body| {
        let mut req = ureq::post(url)
            .set("content-type", "application/json")
            .set("x-capture-project", project_id);
        if !signature.is_empty() {
            req = req.set("x-capture-signature", signature);
        }
        match req.send_bytes(body) {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("ureq: {}", e)),
        }
    })
}
