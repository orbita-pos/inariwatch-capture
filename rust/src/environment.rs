//! Build-time + runtime environment introspection — std-only.

use crate::types::EnvironmentContext;
use std::time::Instant;

static START: once_cell::sync::Lazy<Instant> = once_cell::sync::Lazy::new(Instant::now);

pub fn get_environment_context() -> EnvironmentContext {
    EnvironmentContext {
        node: Some(format!("rustc-{}", env!("CARGO_PKG_RUST_VERSION", "unknown"))),
        os: Some(std::env::consts::OS.to_string()),
        arch: Some(std::env::consts::ARCH.to_string()),
        mem: None,
        uptime: Some(START.elapsed().as_secs()),
    }
}
