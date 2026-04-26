// Per-request scope via context.Context (Go's idiomatic equivalent of
// Python contextvars / Node AsyncLocalStorage).
//
// SetUser / SetTag / SetRequestContext mutate either:
//   - the scope stored in the current context.Context (preferred), or
//   - a process-global fallback scope (for simple scripts with no ctx).
//
// Middleware should always call WithScope(ctx, fn) — that gives each
// request an isolated scope instance and prevents leakage between
// concurrent requests.
package capture

import (
	"context"
	"strings"
	"sync"
)

type scopeData struct {
	mu       sync.RWMutex
	user     *User
	tags     map[string]string
	request  *RequestContext
}

// Context key type — unexported to avoid collision with other packages.
type scopeKey struct{}

var globalScope = &scopeData{}

func currentScope(ctx context.Context) *scopeData {
	if ctx != nil {
		if s, ok := ctx.Value(scopeKey{}).(*scopeData); ok {
			return s
		}
	}
	return globalScope
}

// WithScope returns a new context that owns a fresh, isolated scope.
// Use in middleware: ctx = WithScope(ctx); defer ctx.Done().
func WithScope(parent context.Context) context.Context {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithValue(parent, scopeKey{}, &scopeData{})
}

// ── User/tag/request setters ────────────────────────────────────────

// SetUser attaches user context. Email is always stripped for privacy
// — only ID + Role survive. Pass ctx=nil to write to the global scope.
func SetUser(ctx context.Context, user User) {
	safe := &User{ID: user.ID, Role: user.Role}
	s := currentScope(ctx)
	s.mu.Lock()
	s.user = safe
	s.mu.Unlock()
}

// SetTag accumulates custom tags on the current scope.
func SetTag(ctx context.Context, key, value string) {
	s := currentScope(ctx)
	s.mu.Lock()
	if s.tags == nil {
		s.tags = make(map[string]string)
	}
	s.tags[key] = value
	s.mu.Unlock()
}

// Header redaction — matches Python/Node SDK patterns.
var redactHeaderPatterns = []string{
	"token", "key", "secret", "auth",
	"credential", "password", "cookie", "session",
}

func shouldRedactHeader(name string) bool {
	lower := strings.ToLower(name)
	for _, p := range redactHeaderPatterns {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

// RedactHeaders returns a copy of the header map with sensitive values
// replaced by ``[REDACTED]``. Exposed publicly so framework middleware
// can scrub headers before storing them on the scope.
func RedactHeaders(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		if shouldRedactHeader(k) {
			out[k] = "[REDACTED]"
		} else {
			out[k] = v
		}
	}
	return out
}

// Body fields to always replace with [REDACTED]. Matches the Node
// REDACT_BODY_FIELDS set.
var redactBodyFields = map[string]struct{}{
	"password": {}, "passwd": {}, "pass": {}, "secret": {}, "token": {},
	"api_key": {}, "apiKey": {}, "access_token": {}, "accessToken": {},
	"refresh_token": {}, "refreshToken": {}, "credit_card": {}, "creditCard": {},
	"card_number": {}, "cardNumber": {}, "cvv": {}, "cvc": {}, "ssn": {},
	"social_security": {}, "authorization": {},
}

func isRedactedField(k string) bool {
	if _, ok := redactBodyFields[k]; ok {
		return true
	}
	_, ok := redactBodyFields[strings.ToLower(k)]
	return ok
}

// RedactBody returns a copy of ``body`` with sensitive keys scrubbed.
// Exposed publicly so middleware can redact payloads before attaching
// them to the scope.
func RedactBody(body interface{}) interface{} {
	switch v := body.(type) {
	case nil:
		return nil
	case string:
		const maxLen = 1024
		if len(v) > maxLen {
			return v[:maxLen] + "...[truncated]"
		}
		return v
	case map[string]interface{}:
		safe := make(map[string]interface{}, len(v))
		for k, val := range v {
			if isRedactedField(k) {
				safe[k] = "[REDACTED]"
				continue
			}
			if s, ok := val.(string); ok && len(s) > 500 {
				safe[k] = s[:500] + "...[truncated]"
				continue
			}
			safe[k] = val
		}
		return safe
	case []interface{}:
		const maxItems = 20
		if len(v) > maxItems {
			return v[:maxItems]
		}
		return v
	default:
		return v
	}
}

// SetRequestContext attaches request metadata. Sensitive headers and
// body fields are redacted before storage. IP is included only when
// the caller explicitly sets it (GDPR-friendly default).
func SetRequestContext(ctx context.Context, rc RequestContext) {
	safe := RequestContext{
		Method: rc.Method,
		URL:    rc.URL,
		Query:  rc.Query,
	}
	if len(rc.Headers) > 0 {
		safeHeaders := make(map[string]string, len(rc.Headers))
		for k, v := range rc.Headers {
			if shouldRedactHeader(k) {
				safeHeaders[k] = "[REDACTED]"
				continue
			}
			safeHeaders[k] = v
		}
		// IP-bearing headers scrubbed too.
		for h := range safeHeaders {
			if lower := strings.ToLower(h); lower == "x-forwarded-for" || lower == "x-real-ip" {
				safeHeaders[h] = "[REDACTED]"
			}
		}
		safe.Headers = safeHeaders
	}
	if rc.Body != nil {
		safe.Body = RedactBody(rc.Body)
	}
	if rc.IP != "" {
		safe.IP = rc.IP
	}

	s := currentScope(ctx)
	s.mu.Lock()
	s.request = &safe
	s.mu.Unlock()
}

// GetUser returns the current scope's user, or nil.
func GetUser(ctx context.Context) *User {
	s := currentScope(ctx)
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.user
}

// GetTags returns a copy of the current scope's tags.
func GetTags(ctx context.Context) map[string]string {
	s := currentScope(ctx)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.tags) == 0 {
		return nil
	}
	out := make(map[string]string, len(s.tags))
	for k, v := range s.tags {
		out[k] = v
	}
	return out
}

// GetRequestContext returns the current scope's request context, or nil.
func GetRequestContext(ctx context.Context) *RequestContext {
	s := currentScope(ctx)
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.request
}

// ClearScope resets the active scope — primarily for tests.
func ClearScope(ctx context.Context) {
	s := currentScope(ctx)
	s.mu.Lock()
	s.user = nil
	s.tags = nil
	s.request = nil
	s.mu.Unlock()
}
