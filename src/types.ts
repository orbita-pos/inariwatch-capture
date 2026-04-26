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
  /**
   * FullTrace session id propagation. Default: enabled in browser.
   * Set to `false` to disable header injection entirely (returns SDK to
   * v0.7.x behaviour). See `fulltrace.ts` for the resolution order.
   */
  fullTrace?: boolean | FullTraceConfig
  /**
   * Project UUID — required by some integrations (e.g. `replayIntegration`)
   * that identify the target workspace.
   */
  projectId?: string
  /**
   * Plugin-style integrations that extend core capture behaviour. Each
   * integration's `setup()` runs once during `init()` and can spin up
   * long-running subsystems (replay recording, performance observer, etc.).
   *
   * Example:
   *   import { replayIntegration } from "@inariwatch/capture-replay"
   *   init({ integrations: [replayIntegration()] })
   */
  integrations?: Integration[]
}

/**
 * Plugin contract. Implementations live in sibling packages
 * (`@inariwatch/capture-replay`, `@inariwatch/capture-performance`, …) so the
 * core SDK stays lean and zero-dep. `setup` is called once from `init()` —
 * keep it cheap and non-blocking (spawn async work if needed).
 */
export interface Integration {
  /** Stable identifier — used for debug logs and dedup. */
  name: string
  /** Called once during init. Runs synchronously — queue async work yourself. */
  setup: (config: CaptureConfig) => void
  /**
   * Optional async hook fired immediately before an event is sent to the
   * transport. Lets integrations enrich (e.g. the in-package `agent`
   * integration attaches `event.hypotheses[]`) or drop (return `null`)
   * events.
   *
   * Hooks run in registration order; any one returning `null` short-
   * circuits the chain (event is dropped, transport not called). The user-
   * supplied `config.beforeSend` runs AFTER all integration hooks.
   *
   * Hooks must respect their own deadline — core does not enforce a global
   * timeout. A blocking hook stalls the event flush. Recommended: race
   * against `AbortSignal.timeout()` inside the hook.
   */
  onBeforeSend?: (event: ErrorEvent) => Promise<ErrorEvent | null>
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

export interface FullTraceConfig {
  /**
   * Inject `X-IW-Session-Id` on cross-origin fetches too. Defaults to false
   * because cross-origin custom headers trigger CORS preflights that most
   * third-party APIs (Stripe, Algolia, …) won't allow. Enable only when
   * your backend lives off-origin AND you control its CORS config.
   */
  allowCrossOrigin?: boolean
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
  eventType?: "error" | "log" | "deploy" | "security"
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
  /** Substrate I/O recording — attached on error flush */
  substrateEvents?: unknown[]

  // ─── Payload v2 (additive, all optional) ─────────────────────────────
  // Spec: CAPTURE_V2_IMPLEMENTATION.md §3.1
  // Wire-format contract: server treats unknown v2 fields as opaque
  // correlationData extensions; v1-only events keep working unchanged.

  /** v2 marker — advisory only. Absence = v1 behavior. */
  schemaVersion?: "2.0"

  /** Forensic capture from inspector.Session (forensicsIntegration) */
  forensics?: ForensicsCapture

  /** Per-frame source slice + git blame (sourceContextIntegration) */
  sourceContext?: SourceContextFrame[]

  /** Runtime snapshot at throw time (cheap, always-on when v2 enabled) */
  runtimeSnap?: RuntimeSnap

  /** 1Hz precursor signals from last 60s (precursorsIntegration) */
  precursors?: Precursor[]

  /** Hypotheses produced by local capture-agent peer (Q5.3) */
  hypotheses?: Hypothesis[]

  /** Fleet bloom-filter match result (Q5.4) */
  fleetMatch?: FleetMatch

  /** Intent contracts compiler output (Q5.7) */
  expected?: { contracts: IntentContract[] }

  /** Causal graph edgelist (Q5.6) */
  causalGraph?: CausalGraph

  /** EAP signatures over evidence merkle root (Q5.2 + Q5.9) */
  eapSignatures?: EapSignatures

  /** SDK-side estimated token count for the whole payload */
  tokensEstimated?: number
}

// ─── Payload v2 supporting types ──────────────────────────────────────

export type SerializedValue =
  | { type: "primitive"; value: string | number | boolean | null }
  | { type: "object"; preview: string; truncated: boolean }
  | { type: "redacted"; reason: "pii" | "size" | "secret" }

export interface ForensicsCapture {
  /** Per-frame locals (frame index → name → value). Capped 4KB/frame. */
  locals?: Record<string, Record<string, SerializedValue>>
  /** Closure variable chains per frame */
  closureChains?: Record<string, Record<string, SerializedValue>>
  /** Async stack from inspector.Session */
  asyncStack?: string[]
}

export interface SourceContextFrame {
  frameIndex: number
  before: string[]
  line: string
  after: string[]
  blame?: { commit: string; author: string; date: string; message: string }
}

export interface RuntimeSnap {
  heapMb: number
  rssMb: number
  eventloopP99Ms: number
  openHandles: number
}

export interface Precursor {
  signal:
    | "eventloop_p99"
    | "rss_trend"
    | "retry_burst"
    | "circuit_breaker_trip"
    | "near_miss_rejection"
  deltaPct: number
  windowSeconds: number
}

export interface Hypothesis {
  text: string
  prior: number
  cites: string[]
  confidence: number
  source: "local_agent" | "bloom_match" | "heuristic"
}

export interface FleetMatch {
  bloomHit: boolean
  communityFixId?: string
  teamsHit?: number
}

export interface IntentContract {
  source: "ts" | "zod" | "drizzle" | "openapi" | "prisma" | "graphql" | "pydantic" | "java" | "rust"
  path: string
  shape: unknown
}

export interface CausalGraphNode {
  id: string
  kind: "io" | "fn" | "promise" | "syscall"
  label: string
}

export interface CausalGraphEdge {
  from: string
  to: string
  kind: "causal" | "temporal" | "data"
}

export interface CausalGraph {
  nodes: CausalGraphNode[]
  edges: CausalGraphEdge[]
}

export interface EapSignatures {
  evidenceMerkleRoot: string
  evidenceSignature: string
  signerPubkey: string
  signedAt: string
  receiptId?: string
}

export type VulnerabilityType =
  | "sql_injection"
  | "command_injection"
  | "path_traversal"
  | "ssrf"
  | "nosql_injection"
  | "prototype_pollution"

export interface SecurityContext {
  vulnerability: VulnerabilityType
  /** The dangerous function called (e.g. "pg.query", "child_process.exec") */
  sink: string
  /** The module containing the sink (e.g. "pg", "child_process") */
  sinkModule: string
  /** File where the sink was called (from stack trace) */
  sinkFile?: string
  /** Line number where the sink was called */
  sinkLine?: number
  /** Where the tainted input came from (e.g. "req.query.q", "req.body.name") */
  source: string
  /** The actual user input that reached the sink (truncated) */
  taintedInput: string
  /** What was passed to the sink function (truncated) */
  sinkArgument: string
  /** Whether the request was blocked */
  blocked: boolean
}

export interface ShieldConfig {
  /** "report" (default) — detect and report. "block" — reject requests with detected threats. */
  mode?: "report" | "block"
  /** Custom handler when a request is blocked (only in block mode) */
  onBlock?: (threat: SecurityContext) => void
  /** Disable specific sink hooks */
  disableSinks?: string[]
  /** Minimum tainted input length to check (default: 3) */
  minInputLength?: number
}

export interface ParsedDSN {
  endpoint: string
  secretKey: string
  isLocal: boolean
}
