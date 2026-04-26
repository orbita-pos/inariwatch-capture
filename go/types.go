// Package capture — wire-compatible payload types. Field names are JSON-
// encoded to match the Node/Python SDKs byte-for-byte so the ingest sees
// a single schema regardless of source runtime.
package capture

// Severity levels match the Node SDK's "severity" field.
type Severity string

const (
	SeverityCritical Severity = "critical"
	SeverityWarning  Severity = "warning"
	SeverityInfo     Severity = "info"
)

// LogLevel mirrors the Node SDK's "logLevel" values.
type LogLevel string

const (
	LogDebug LogLevel = "debug"
	LogInfo  LogLevel = "info"
	LogWarn  LogLevel = "warn"
	LogError LogLevel = "error"
	LogFatal LogLevel = "fatal"
)

// Breadcrumb is a ring-buffer entry — same 30-slot cap as the Node SDK.
type Breadcrumb struct {
	Timestamp string                 `json:"timestamp"`
	Category  string                 `json:"category"`
	Message   string                 `json:"message"`
	Level     string                 `json:"level"`
	Data      map[string]interface{} `json:"data,omitempty"`
}

// GitContext is populated from INARIWATCH_GIT_* env vars at runtime (set
// by the build step) or by `git rev-parse` if the env vars are empty.
type GitContext struct {
	Commit    string `json:"commit"`
	Branch    string `json:"branch"`
	Message   string `json:"message"`
	Timestamp string `json:"timestamp"`
	Dirty     bool   `json:"dirty"`
}

// EnvironmentContext uses the Node SDK's field names verbatim. The
// `Node` field stores the Go runtime version string so a single field
// name carries the language version regardless of SDK.
type EnvironmentContext struct {
	Node          string `json:"node"`
	Platform      string `json:"platform"`
	Arch          string `json:"arch"`
	CPUCount      int    `json:"cpuCount"`
	TotalMemoryMB int    `json:"totalMemoryMB"`
	FreeMemoryMB  int    `json:"freeMemoryMB"`
	HeapUsedMB    int    `json:"heapUsedMB"`
	HeapTotalMB   int    `json:"heapTotalMB"`
	Uptime        int    `json:"uptime"`
}

// RequestContext is what webhooks + integrations attach to each event.
// Matches the Node SDK's shape — redaction runs before this is
// constructed so secrets never touch the wire.
type RequestContext struct {
	Method  string                 `json:"method"`
	URL     string                 `json:"url"`
	Headers map[string]string      `json:"headers,omitempty"`
	Query   map[string]string      `json:"query,omitempty"`
	Body    interface{}            `json:"body,omitempty"`
	IP      string                 `json:"ip,omitempty"`
}

// User is always (id, role) — email is stripped in SetUser.
type User struct {
	ID   string `json:"id,omitempty"`
	Role string `json:"role,omitempty"`
}

// ErrorEvent is the wire payload. ``omitempty`` on optional fields keeps
// the JSON compact and matches Node's JSON.stringify semantics.
type ErrorEvent struct {
	Fingerprint string                 `json:"fingerprint"`
	Title       string                 `json:"title"`
	Body        string                 `json:"body"`
	Severity    Severity               `json:"severity"`
	Timestamp   string                 `json:"timestamp"`
	Environment string                 `json:"environment,omitempty"`
	Release     string                 `json:"release,omitempty"`
	Context     map[string]interface{} `json:"context,omitempty"`
	Request     *RequestContext        `json:"request,omitempty"`
	Runtime     string                 `json:"runtime,omitempty"`
	RoutePath   string                 `json:"routePath,omitempty"`
	RouteType   string                 `json:"routeType,omitempty"`
	EventType   string                 `json:"eventType,omitempty"`
	LogLevel    LogLevel               `json:"logLevel,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
	Git         *GitContext            `json:"git,omitempty"`
	Breadcrumbs []Breadcrumb           `json:"breadcrumbs,omitempty"`
	Env         *EnvironmentContext    `json:"env,omitempty"`
	User        *User                  `json:"user,omitempty"`
	Tags        map[string]string      `json:"tags,omitempty"`
}

// ParsedDSN is the result of parseDSN — same triple as the Node SDK.
type ParsedDSN struct {
	Endpoint  string
	SecretKey string
	IsLocal   bool
}

// BeforeSendHook lets callers filter or transform events. Return nil to
// drop the event entirely.
type BeforeSendHook func(*ErrorEvent) *ErrorEvent

// Config holds init parameters. Every field is optional — missing
// values fall back to env vars (see resolveEnv).
type Config struct {
	DSN            string
	Environment    string
	Release        string
	Debug          bool
	Silent         bool
	BeforeSend     BeforeSendHook
	AutoBreadcrumb bool // enable log + http.Client auto-intercept (default true)
	ProjectID      string
}
