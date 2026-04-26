// Package capture — top-level API.
//
// ``Init`` wires the module-level transport + config. Subsequent calls
// to CaptureException / CaptureMessage / CaptureLog / Recover enrich
// the event with git + environment + breadcrumbs + scope (user, tags,
// request) and hand it to the transport.
//
// Concurrency model: one module-level transport behind a RWMutex. Reads
// (Send paths) take the RLock; Init takes the write lock. Transport
// itself owns a single goroutine so the API is safe to call from any
// number of handlers in parallel.
package capture

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

var (
	clientMu     sync.RWMutex
	clientT      Transport
	clientC      Config
	lastRelease  string
	clientInited bool
)

// Init configures the SDK. Safe to call more than once — the most
// recent config wins and any previous transport is closed. Missing
// fields fall back to env vars (INARIWATCH_DSN, INARIWATCH_ENVIRONMENT,
// INARIWATCH_RELEASE).
func Init(cfg Config) {
	if cfg.DSN == "" {
		cfg.DSN = os.Getenv("INARIWATCH_DSN")
	}
	if cfg.Environment == "" {
		cfg.Environment = firstEnv("INARIWATCH_ENVIRONMENT", "GO_ENV", "APP_ENV")
	}
	if cfg.Release == "" {
		cfg.Release = os.Getenv("INARIWATCH_RELEASE")
	}

	clientMu.Lock()
	if clientT != nil {
		clientT.Close()
	}
	clientC = cfg
	if cfg.DSN != "" {
		parsed := ParseDSN(cfg.DSN)
		if parsed.Endpoint != "" {
			clientT = NewTransport(cfg, parsed)
		} else {
			clientT = newLocalTransport()
		}
	} else {
		clientT = newLocalTransport()
		if !cfg.Silent {
			fmt.Fprintln(os.Stderr,
				"\x1b[2m[inariwatch-capture] Local mode — errors print to stderr. "+
					"Set INARIWATCH_DSN to send to cloud.\x1b[0m")
		}
	}
	clientInited = true
	release := cfg.Release
	announce := release != "" && release != lastRelease
	if announce {
		lastRelease = release
	}
	t := clientT
	env := cfg.Environment
	clientMu.Unlock()

	if announce {
		reportDeploy(t, release, env)
	}
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

func reportDeploy(t Transport, release, environment string) {
	if t == nil {
		return
	}
	fp := ComputeErrorFingerprint("deploy:"+release, environment)
	body := "New release deployed: " + release
	if environment != "" {
		body += " (" + environment + ")"
	}
	t.Send(ErrorEvent{
		Fingerprint: fp,
		Title:       "Deploy: " + release,
		Body:        body,
		Severity:    SeverityInfo,
		Timestamp:   nowISO(),
		Environment: environment,
		Release:     release,
		EventType:   "deploy",
		Runtime:     "go",
	})
}

// ── Enrichment ──────────────────────────────────────────────────────

func enrichEvent(ev ErrorEvent) ErrorEvent {
	if git := GetGitContext(); git != nil {
		ev.Git = git
	}
	if env := GetEnvironmentContext(); env != nil {
		ev.Env = env
	}
	if crumbs := GetBreadcrumbs(); len(crumbs) > 0 {
		ev.Breadcrumbs = crumbs
	}
	// Global-scope lookups — middleware passes its ctx via Capture*Ctx
	// variants below.
	if u := GetUser(nil); u != nil {
		ev.User = u
	}
	if tags := GetTags(nil); tags != nil {
		ev.Tags = tags
	}
	if req := GetRequestContext(nil); req != nil && ev.Request == nil {
		ev.Request = req
	}
	if ev.Runtime == "" {
		ev.Runtime = "go"
	}
	return ev
}

// ── Capture APIs ────────────────────────────────────────────────────

// CaptureException sends an error event. Extra context is merged into
// the ``context`` field. Nil-safe — if SDK is uninitialized it's a
// no-op.
func CaptureException(err error, context map[string]interface{}) {
	if err == nil {
		return
	}
	clientMu.RLock()
	t, cfg, inited := clientT, clientC, clientInited
	clientMu.RUnlock()
	if !inited || t == nil {
		return
	}

	title := fmt.Sprintf("%T: %s", err, err.Error())
	// Go's error type prints the bare type name; prefix it to match the
	// Node/Python SDKs that do "ClassName: message".
	title = normalizeErrorTitle(title)
	body := title + "\n" + string(debug.Stack())

	ev := enrichEvent(ErrorEvent{
		Fingerprint: ComputeErrorFingerprint(title, body),
		Title:       title,
		Body:        body,
		Severity:    SeverityCritical,
		Timestamp:   nowISO(),
		Environment: cfg.Environment,
		Release:     cfg.Release,
		EventType:   "error",
		Context:     context,
	})
	if rc, ok := context["request"].(*RequestContext); ok && ev.Request == nil {
		ev.Request = rc
	}
	dispatch(t, cfg, ev)
}

// normalizeErrorTitle shortens Go's default "*errors.errorString"
// representation to plain "error" so the title matches the Python and
// Node shape better. Other error types keep their actual type name.
func normalizeErrorTitle(title string) string {
	if strings.HasPrefix(title, "*errors.errorString: ") {
		return "error: " + strings.TrimPrefix(title, "*errors.errorString: ")
	}
	return title
}

// CaptureMessage sends an informational event.
func CaptureMessage(message string, severity Severity) {
	clientMu.RLock()
	t, cfg, inited := clientT, clientC, clientInited
	clientMu.RUnlock()
	if !inited || t == nil {
		return
	}
	if severity == "" {
		severity = SeverityInfo
	}
	ev := enrichEvent(ErrorEvent{
		Fingerprint: ComputeErrorFingerprint(message, ""),
		Title:       message,
		Body:        message,
		Severity:    severity,
		Timestamp:   nowISO(),
		Environment: cfg.Environment,
		Release:     cfg.Release,
		EventType:   "error",
	})
	dispatch(t, cfg, ev)
}

// CaptureLog sends a structured log event. ``metadata`` is rendered
// into the body as pretty JSON to match the Node SDK's shape.
func CaptureLog(message string, level LogLevel, metadata map[string]interface{}) {
	clientMu.RLock()
	t, cfg, inited := clientT, clientC, clientInited
	clientMu.RUnlock()
	if !inited || t == nil {
		return
	}
	if level == "" {
		level = LogInfo
	}
	severity := SeverityInfo
	switch level {
	case LogError, LogFatal:
		severity = SeverityCritical
	case LogWarn:
		severity = SeverityWarning
	}
	body := message
	if metadata != nil {
		if buf, err := json.MarshalIndent(metadata, "", "  "); err == nil {
			body = message + "\n\n" + string(buf)
		}
	}
	ev := enrichEvent(ErrorEvent{
		Fingerprint: ComputeErrorFingerprint("log:"+string(level)+":"+message, ""),
		Title:       "[" + strings.ToUpper(string(level)) + "] " + message,
		Body:        body,
		Severity:    severity,
		Timestamp:   nowISO(),
		Environment: cfg.Environment,
		Release:     cfg.Release,
		EventType:   "log",
		LogLevel:    level,
		Metadata:    metadata,
	})
	dispatch(t, cfg, ev)
}

func dispatch(t Transport, cfg Config, ev ErrorEvent) {
	final := ev
	if cfg.BeforeSend != nil {
		result := cfg.BeforeSend(&final)
		if result == nil {
			return
		}
		final = *result
	}
	t.Send(final)
}

// Recover is the defer-friendly panic catcher. Install at the top of
// each goroutine::
//
//	go func() {
//	    defer capture.Recover()
//	    ...
//	}()
//
// The panic value is re-raised after the event is queued so normal
// process termination (or an outer recover) still sees it.
func Recover() {
	if r := recover(); r != nil {
		err, ok := r.(error)
		if !ok {
			err = fmt.Errorf("panic: %v", r)
		}
		CaptureException(err, map[string]interface{}{
			"panic": true,
		})
		// Give the transport a beat to send before re-panicking.
		Flush(2)
		panic(r)
	}
}

// Flush blocks until queued events are sent or ``timeoutSeconds`` pass.
func Flush(timeoutSeconds int) {
	clientMu.RLock()
	t := clientT
	clientMu.RUnlock()
	if t == nil {
		return
	}
	t.Flush(timeoutSeconds)
}

// ResetForTesting tears down the singleton cleanly. Exported with the
// ``Testing`` suffix so it's easy to spot calls in production code
// reviews; semver-wise we don't consider this part of the stable API.
func ResetForTesting() {
	clientMu.Lock()
	defer clientMu.Unlock()
	if clientT != nil {
		clientT.Close()
	}
	clientT = nil
	clientC = Config{}
	clientInited = false
	lastRelease = ""
}

// SetTransportForTesting lets tests swap in a capturing transport
// without spinning up a real HTTP server. Same ``Testing`` suffix
// convention.
func SetTransportForTesting(t Transport) {
	clientMu.Lock()
	defer clientMu.Unlock()
	clientT = t
	clientInited = true
}

// Avoid "imported and not used" if tests don't reference time.
var _ = time.Millisecond
