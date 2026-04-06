export interface CaptureConfig {
  /** DSN — reads from INARIWATCH_DSN env var if not provided. Omit for local mode. */
  dsn?: string
  /** Environment tag (e.g. "production", "preview", "development") */
  environment?: string
  /** Release tag (e.g. "v1.2.3") */
  release?: string
  /** Log transport errors to console.warn */
  debug?: boolean
  /** Suppress all console output */
  silent?: boolean
  /** Transform or filter events before sending — return null to drop */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null
  /** Enable Substrate I/O recording — requires @inariwatch/substrate-agent installed. */
  substrate?: boolean | SubstrateConfig
  /** Enable browser session recording — requires rrweb installed. Browser-only. */
  session?: boolean | SessionConfig
}

export interface SubstrateConfig {
  /** Ring buffer duration in seconds (default: 60) */
  bufferSeconds?: number
  /** Redaction config for sensitive data */
  redact?: Record<string, unknown>
}

export interface SessionConfig {
  /** Max events in ring buffer (default: 200) */
  maxEvents?: number
  /** Max seconds to keep in buffer (default: 60) */
  maxSeconds?: number
  /** CSS selectors whose text content should be redacted */
  redactSelectors?: string[]
  /** Mask all input values (default: false — only passwords are masked) */
  maskAllInputs?: boolean
}

export interface SessionEvent {
  timestamp: number
  type: "click" | "input" | "navigation" | "scroll"
  /** CSS selector for the interacted element */
  selector?: string
  /** Input value (redacted for passwords) */
  value?: string
  /** Page URL for navigation events */
  url?: string
  /** Raw rrweb event for the dashboard viewer replay */
  rrwebEvent: unknown
}

export interface Breadcrumb {
  timestamp: string
  category: "console" | "fetch" | "navigation" | "custom"
  message: string
  level: "debug" | "info" | "warning" | "error"
  data?: Record<string, unknown>
}

export interface GitContext {
  commit: string
  branch: string
  message: string
  timestamp: string
  dirty: boolean
}

export interface EnvironmentContext {
  node: string
  platform: string
  arch: string
  cpuCount: number
  totalMemoryMB: number
  freeMemoryMB: number
  heapUsedMB: number
  heapTotalMB: number
  uptime: number
}

export interface ErrorEvent {
  fingerprint: string
  title: string
  body: string
  severity: "critical" | "warning" | "info"
  timestamp: string
  environment?: string
  release?: string
  context?: Record<string, unknown>
  request?: {
    method: string
    url: string
    headers?: Record<string, string>
    query?: Record<string, string>
    body?: unknown
    ip?: string
  }
  runtime?: "nodejs" | "edge"
  routePath?: string
  routeType?: string
  eventType?: "error" | "log" | "deploy"
  logLevel?: "debug" | "info" | "warn" | "error" | "fatal"
  metadata?: Record<string, unknown>
  /** Git context — injected at build time */
  git?: GitContext
  /** Last N actions before the error */
  breadcrumbs?: Breadcrumb[]
  /** System environment at time of error */
  env?: EnvironmentContext
  /** User who triggered the error */
  user?: { id?: string; role?: string }
  /** Custom tags */
  tags?: Record<string, string>
  /** Browser session events (rrweb) — attached on error flush */
  sessionEvents?: SessionEvent[]
}

export interface ParsedDSN {
  endpoint: string
  secretKey: string
  isLocal: boolean
}
