//! Wire-format payload types. Field names in the on-the-wire JSON match
//! the Node/Python/Go SDKs exactly so a single backend handler can ingest
//! events from any runtime without conditionals.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct User {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct GitContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct EnvironmentContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>, // runtime version — name kept for cross-SDK parity
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct RequestContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub query: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Breadcrumb {
    pub timestamp: String,
    pub category: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub data: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Error,
    Warning,
    Info,
    Debug,
}

impl Default for Severity {
    fn default() -> Self {
        Severity::Error
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ErrorEvent {
    pub fingerprint: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub severity: Severity,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    #[serde(default, rename = "eventType")]
    pub event_type: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<User>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub tags: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<EnvironmentContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestContext>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub breadcrumbs: Vec<Breadcrumb>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub context: HashMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Default)]
pub struct Config {
    /// `https://SECRET@host/capture/ID`. Localhost DSNs skip HMAC.
    pub dsn: Option<String>,
    pub environment: Option<String>,
    pub release: Option<String>,
    /// When `true`, suppress the local-mode startup banner.
    pub silent: bool,
}
