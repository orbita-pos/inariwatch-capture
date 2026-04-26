// Package nethttp — net/http middleware for inariwatch-capture.
//
//	import (
//	    "net/http"
//	    capturehttp "github.com/orbita-pos/inariwatch-capture-go/middleware/nethttp"
//	)
//
//	http.Handle("/", capturehttp.Middleware(myHandler))
//
// The middleware:
//   - Opens a fresh scope per request via WithScope so SetTag/SetUser
//     don't leak between concurrent requests.
//   - Attaches request context (method, URL, headers) with sensitive
//     header values redacted.
//   - Recovers panics and re-raises them after capturing, so your
//     framework's own error handler still runs.
package nethttp

import (
	"net/http"

	capture "github.com/orbita-pos/inariwatch-capture-go"
)

// Middleware wraps ``next`` with request-scoped capture.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := capture.WithScope(r.Context())
		r = r.WithContext(ctx)

		rawHeaders := make(map[string]string, len(r.Header))
		for k, v := range r.Header {
			if len(v) > 0 {
				rawHeaders[k] = v[0]
			}
		}
		headers := capture.RedactHeaders(rawHeaders)
		query := make(map[string]string, len(r.URL.Query()))
		for k, v := range r.URL.Query() {
			if len(v) > 0 {
				query[k] = v[0]
			}
		}

		reqCtx := capture.RequestContext{
			Method:  r.Method,
			URL:     r.URL.String(),
			Headers: headers,
			Query:   query,
		}
		capture.SetRequestContext(ctx, reqCtx)

		defer func() {
			if rec := recover(); rec != nil {
				// Pass the request context through the ``context`` map —
				// CaptureException reads ``context["request"]`` directly so
				// per-request data flows even though Go's CaptureException
				// has no ctx parameter.
				rcCopy := reqCtx
				capture.CaptureException(asError(rec), map[string]interface{}{
					"runtime": "go",
					"panic":   true,
					"request": &rcCopy,
				})
				panic(rec)
			}
		}()

		next.ServeHTTP(w, r)
	})
}

// MiddlewareFunc is the HandlerFunc-friendly variant.
func MiddlewareFunc(next http.HandlerFunc) http.HandlerFunc {
	return Middleware(http.HandlerFunc(next)).ServeHTTP
}

func asError(v interface{}) error {
	if err, ok := v.(error); ok {
		return err
	}
	return &panicValueError{v: v}
}

type panicValueError struct{ v interface{} }

func (e *panicValueError) Error() string {
	if s, ok := e.v.(string); ok {
		return s
	}
	return "panic"
}
