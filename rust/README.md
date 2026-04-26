# inariwatch-capture (Rust)

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — Rust 1.74+.

Payload-compatible with `@inariwatch/capture` (npm), `inariwatch-capture` (PyPI), and the Go SDK. Same DSN, same event schema, **byte-identical fingerprint algorithm** so errors from Rust services dedupe cleanly against errors from any other runtime.

## Quick start

```rust
use inariwatch_capture::{init, capture_exception, Config};

fn main() {
    init(Config {
        dsn: std::env::var("INARIWATCH_DSN").ok(),
        environment: Some("production".into()),
        release: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    });

    if let Err(e) = run() {
        capture_exception(&e, None);
    }

    inariwatch_capture::flush(2);
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    Err("kaboom".into())
}
```

## Panic capture

```rust
inariwatch_capture::install_panic_hook();
```

Wraps `std::panic::take_hook` so unhandled panics get captured with `std::backtrace::Backtrace` before propagating to the previous hook.

## Features

| Feature | Default | What it brings in |
|---|---|---|
| `transport-ureq` | yes | Synchronous HTTP transport via `ureq` (no async runtime needed) |
| `transport-reqwest` | no | Async HTTP transport via `reqwest` + `tokio` |
| `axum` | no | `axum::middleware` adapter |
| `actix` | no | `actix-web` middleware adapter |

Mutually exclusive transports — pick one. Default is `ureq` because it works in synchronous binaries without pulling in a runtime.

## Cross-SDK conformance

All InariWatch capture SDKs share `shared/fingerprint-test-vectors.json` at the repo root. The Rust crate's `tests/fingerprint.rs` loads that file and asserts byte-equivalence against the canonical hashes — fingerprints generated here match Node, Python, Go, and the Rust CLI bit-for-bit.

## License

MIT.
