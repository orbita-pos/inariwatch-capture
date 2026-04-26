# Middleware

| Package | Framework | Import path |
|---|---|---|
| `nethttp` | Go stdlib `net/http` | `.../middleware/nethttp` |
| `gin` | gin-gonic/gin | `.../middleware/gin` (build tag `capture_gin`) |
| `echo` | labstack/echo | `.../middleware/echo` (build tag `capture_echo`) |
| `chi` | go-chi/chi | `.../middleware/chi` (build tag `capture_chi`) |
| `fiber` | gofiber/fiber | `.../middleware/fiber` (build tag `capture_fiber`) |

All framework adapters implement the same contract as `nethttp.Middleware`:

1. Open a per-request scope via `capture.WithScope(ctx)`.
2. Attach request context (method, URL, headers) with sensitive headers redacted.
3. Recover panics and call `capture.CaptureException`, then re-panic so the framework's default error handler still renders the 500.

We gate the framework-specific adapters behind build tags so adding `inariwatch-capture-go` to your go.mod doesn't drag in gin/echo/chi/fiber if you're not using them. To enable gin support:

```bash
go build -tags capture_gin ./...
```

The skeletons ship pre-wired; fleshing out each adapter is a small amount of paste (~40 lines) — see [`nethttp/middleware.go`](./nethttp/middleware.go) for the reference implementation.
