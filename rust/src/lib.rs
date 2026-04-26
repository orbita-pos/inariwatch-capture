//! `inariwatch-capture` — error capture SDK for Rust.
//!
//! Public surface mirrors the Node / Python / Go SDKs. Identical DSN
//! format, identical event schema, **byte-identical fingerprint algorithm**
//! so an error thrown in a Rust service dedupes against the same error
//! thrown in a Node service or a Python service.
//!
//! # Quick start
//!
//! ```no_run
//! use inariwatch_capture::{init, capture_exception, Config};
//!
//! init(Config {
//!     dsn: std::env::var("INARIWATCH_DSN").ok(),
//!     environment: Some("production".into()),
//!     release: Some(env!("CARGO_PKG_VERSION").into()),
//!     ..Default::default()
//! });
//! ```

mod breadcrumbs;
mod client;
mod environment;
mod fingerprint;
mod git;
pub mod intent;
mod regex_set;
mod scope;
mod transport;
mod types;

#[cfg(feature = "axum")]
pub mod axum;

pub use breadcrumbs::{add_breadcrumb, add_breadcrumb_with_data, clear_breadcrumbs, get_breadcrumbs, scrub_secrets, scrub_url};
pub use client::{
    capture_exception, capture_log, capture_message, flush, init, install_panic_hook,
    reset_for_testing, set_before_send, set_transport_for_testing,
};
pub use fingerprint::compute_error_fingerprint;
pub use scope::{
    clear_scope, get_request_context, get_tags, get_user, redact_body, redact_request,
    set_request_context, set_tag, set_user, with_scope, Scope,
};
pub use transport::{parse_dsn, sign_payload, DsnError, LocalTransport, ParsedDsn, RemoteTransport, Transport};
pub use types::{
    Breadcrumb, Config, EnvironmentContext, ErrorEvent, GitContext, RequestContext, Severity, User,
};
