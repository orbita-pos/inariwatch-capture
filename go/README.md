# inariwatch-capture (Go)

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — zero third-party dependencies, Go 1.22+.

Payload-compatible with `@inariwatch/capture` on npm and `inariwatch-capture` on PyPI. Same DSN, same event schema, **byte-identical fingerprint algorithm** so errors from Go services dedupe cleanly against errors from Node / Python / Rust services.

## Quick start

```go
package main

import (
    "errors"

    capture "github.com/orbita-pos/inariwatch-capture-go"
)

func main() {
    capture.Init(capture.Config{
        DSN:         "https://SECRET@app.inariwatch.com/capture/YOUR_ID",
        Environment: "production",
        Release:     "v1.2.3",
    })
    defer capture.Flush(5)

    if err := doWork(); err != nil {
        capture.CaptureException(err, nil)
    }
}

func doWork() error {
    return errors.New("something went wrong")
}
```

## API

| Function | Description |
|---|---|
| `Init(Config)` | Configure the SDK. Call once at startup. |
| `CaptureException(err, ctx)` | Send an error event. |
| `CaptureMessage(msg, severity)` | Send an informational event. |
| `CaptureLog(msg, level, metadata)` | Send a log event. |
| `AddBreadcrumb(Breadcrumb)` | Append to the ring buffer. |
| `SetUser(User)` | User context (email stripped). |
| `SetTag(key, value)` | Custom tag. |
| `SetRequestContext(RequestContext)` | HTTP request metadata (secrets redacted). |
| `WithScope(ctx, fn)` | Isolated per-request scope via `context.Context`. |
| `Recover()` | `defer capture.Recover()` inside goroutines. |
| `Flush(timeoutSeconds)` | Wait for pending events. |

## Middleware

The `capture/middleware` subpackage ships middleware for `net/http`, `gin`, `echo`, `chi`, and `fiber`. Pick your framework:

```go
import capturehttp "github.com/orbita-pos/inariwatch-capture-go/middleware/nethttp"

http.Handle("/", capturehttp.Middleware(myHandler))
```

## Environment variables

| Variable | Description |
|---|---|
| `INARIWATCH_DSN` | Capture endpoint (omit for local mode). |
| `INARIWATCH_ENVIRONMENT` | Environment tag. |
| `INARIWATCH_RELEASE` | Release version. |
| `INARIWATCH_GIT_*` | Build-time git context. |

## Cross-SDK conformance

This SDK runs against the same `shared/fingerprint-test-vectors.json` used by the Node, Python, Rust, and web implementations. `go test ./...` enforces it.

## License

MIT
