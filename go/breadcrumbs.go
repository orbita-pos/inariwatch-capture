// Breadcrumb ring buffer (30 slots, FIFO) + secret scrubbing +
// optional http.Client RoundTripper wrap. Mirrors the Python / Node
// SDK behaviour: process-wide ring, bounded, thread-safe.
package capture

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"
)

const maxBreadcrumbs = 30

var (
	breadcrumbMu sync.Mutex
	breadcrumbs  = make([]Breadcrumb, 0, maxBreadcrumbs)
)

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`Bearer\s+[A-Za-z0-9\-._~+/]+=*`),
	regexp.MustCompile(`[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}`),
	regexp.MustCompile(`(?i)(?:sk|pk|api|key|token|secret|password|passwd)[_-]?[:\s=]+\S{8,}`),
	regexp.MustCompile(`://[^:/]+:[^@]+@`),
	regexp.MustCompile(`(?i)[?&](api_key|token|secret|key|password|auth|credential)=[^&\s]+`),
}

func scrubSecrets(text string) string {
	out := text
	for _, p := range secretPatterns {
		out = p.ReplaceAllString(out, "[REDACTED]")
	}
	return out
}

var sensitiveQueryParams = map[string]struct{}{
	"token": {}, "key": {}, "secret": {}, "password": {}, "auth": {},
	"credential": {}, "api_key": {}, "apiKey": {}, "access_token": {},
}

// ScrubURL replaces sensitive query parameters with [REDACTED].
func ScrubURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return scrubSecrets(raw)
	}
	if u.RawQuery == "" {
		return scrubSecrets(raw)
	}
	vals := u.Query()
	for k := range vals {
		if _, sensitive := sensitiveQueryParams[k]; sensitive {
			vals.Set(k, "[REDACTED]")
		}
	}
	u.RawQuery = vals.Encode()
	return u.String()
}

// AddBreadcrumb appends an entry to the ring. Secrets inside
// ``message`` are scrubbed via secretPatterns before storage. Messages
// longer than 200 chars are truncated.
func AddBreadcrumb(b Breadcrumb) {
	if b.Timestamp == "" {
		b.Timestamp = nowISO()
	}
	if b.Category == "" {
		b.Category = "custom"
	}
	if b.Level == "" {
		b.Level = "info"
	}
	msg := b.Message
	if len(msg) > 200 {
		msg = msg[:200]
	}
	b.Message = scrubSecrets(msg)

	breadcrumbMu.Lock()
	defer breadcrumbMu.Unlock()
	if len(breadcrumbs) >= maxBreadcrumbs {
		breadcrumbs = append(breadcrumbs[1:], b)
	} else {
		breadcrumbs = append(breadcrumbs, b)
	}
}

// GetBreadcrumbs returns a snapshot of the ring buffer.
func GetBreadcrumbs() []Breadcrumb {
	breadcrumbMu.Lock()
	defer breadcrumbMu.Unlock()
	if len(breadcrumbs) == 0 {
		return nil
	}
	out := make([]Breadcrumb, len(breadcrumbs))
	copy(out, breadcrumbs)
	return out
}

// ClearBreadcrumbs — for tests.
func ClearBreadcrumbs() {
	breadcrumbMu.Lock()
	breadcrumbs = breadcrumbs[:0]
	breadcrumbMu.Unlock()
}

func nowISO() string {
	// Node's new Date().toISOString() uses UTC + millisecond precision
	// + trailing Z. time.Time's RFC3339Nano prints nanoseconds, so we
	// format manually for cross-SDK consistency.
	t := time.Now().UTC()
	return t.Format("2006-01-02T15:04:05.000Z")
}

// ── http.Client auto-intercept ──────────────────────────────────────

type breadcrumbTransport struct {
	inner http.RoundTripper
}

// WrapHTTPClient returns a RoundTripper that records every outbound
// request + response status as a breadcrumb. Opt-in per client; we
// don't globally patch http.DefaultTransport to stay friendly to apps
// that wire their own transports.
func WrapHTTPClient(inner http.RoundTripper) http.RoundTripper {
	if inner == nil {
		inner = http.DefaultTransport
	}
	return &breadcrumbTransport{inner: inner}
}

func (t *breadcrumbTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	safeURL := ScrubURL(req.URL.String())
	AddBreadcrumb(Breadcrumb{
		Category: "http",
		Level:    "info",
		Message:  req.Method + " " + safeURL,
	})
	resp, err := t.inner.RoundTrip(req)
	if err != nil {
		AddBreadcrumb(Breadcrumb{
			Category: "http",
			Level:    "error",
			Message:  fmt.Sprintf("%s %s -> FAILED", req.Method, safeURL),
		})
		return resp, err
	}
	if resp.StatusCode >= 400 {
		AddBreadcrumb(Breadcrumb{
			Category: "http",
			Level:    "warning",
			Message:  fmt.Sprintf("%s %s -> %d", req.Method, safeURL, resp.StatusCode),
		})
	}
	return resp, nil
}
