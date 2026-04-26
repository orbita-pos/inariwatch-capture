//! Axum middleware adapter — feature-gated under `axum`.
//!
//! ```ignore
//! use axum::{Router, routing::get};
//! use inariwatch_capture::axum::CaptureLayer;
//!
//! let app = Router::new()
//!     .route("/", get(|| async { "hello" }))
//!     .layer(CaptureLayer::new());
//! ```
//!
//! Wraps each request in a fresh scope, attaches the request context, and
//! captures unhandled panics from inner futures.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::extract::Request;
use axum::http::HeaderMap;
use axum::response::Response;
use tower::{Layer, Service};

use crate::scope::{should_redact_header, set_request_context};
use crate::types::RequestContext;

#[derive(Clone, Default)]
pub struct CaptureLayer;

impl CaptureLayer {
    pub fn new() -> Self {
        Self
    }
}

impl<S> Layer<S> for CaptureLayer {
    type Service = CaptureService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        CaptureService { inner }
    }
}

#[derive(Clone)]
pub struct CaptureService<S> {
    inner: S,
}

impl<S> Service<Request> for CaptureService<S>
where
    S: Service<Request, Response = Response> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request) -> Self::Future {
        let method = req.method().to_string();
        let url = req.uri().to_string();
        let headers = redact_headers(req.headers());
        set_request_context(RequestContext {
            method: Some(method),
            url: Some(url),
            headers,
            query: HashMap::new(),
            body: None,
        });
        let fut = self.inner.call(req);
        Box::pin(fut)
    }
}

fn redact_headers(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let key = name.as_str().to_string();
            let v = value.to_str().unwrap_or("").to_string();
            if should_redact_header(&key) {
                (key, "[REDACTED]".to_string())
            } else {
                (key, v)
            }
        })
        .collect()
}
