// Package chi — go-chi/chi middleware for inariwatch-capture.
// Because chi implements the net/http middleware signature, the adapter
// is just a re-export of the core net/http wrapper. Users who want to
// mount it on a chi.Router can do so without a separate import path,
// but keeping this subpackage gives us room to add chi-specific routing
// context (chi.RouteContext) to the event later without breaking the
// nethttp adapter.
package chi

import (
	"net/http"

	capturehttp "github.com/orbita-pos/inariwatch-capture-go/middleware/nethttp"
)

// Middleware implements the chi.Middlewares signature
// (func(http.Handler) http.Handler) — chi routers accept this directly.
func Middleware(next http.Handler) http.Handler {
	return capturehttp.Middleware(next)
}
