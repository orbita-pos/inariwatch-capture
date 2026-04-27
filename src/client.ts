import type { CaptureConfig, ErrorEvent, Integration, SubstrateConfig, SessionConfig, FullTraceConfig } from "./types.js"
import { computeErrorFingerprint } from "./fingerprint.js"
import { parseDSN, createTransport, createLocalTransport, type Transport } from "./transport.js"
import { getGitContext } from "./git.js"
import { getEnvironmentContext } from "./environment.js"
import { getBreadcrumbs, initBreadcrumbs } from "./breadcrumbs.js"
import { getUser, getTags, getRequestContext } from "./scope.js"
import { initFullTrace, getSessionId } from "./fulltrace.js"
import { resolvePayloadVersion } from "./payload-version.js"

let globalTransport: Transport | null = null
let globalConfig: CaptureConfig | null = null
let lastReportedRelease: string | null = null
let substrateFlush: ((dsn?: string) => Promise<unknown>) | null = null
let sessionFlush: (() => import("./types.js").SessionEvent[]) | null = null
let registeredIntegrations: Integration[] = []

/**
 * Run all registered integrations' `onBeforeSend` hooks in registration order,
 * then the user-supplied `config.beforeSend`, then dispatch via the transport.
 *
 * Any hook returning `null` short-circuits the chain (event dropped). Any
 * hook that throws is logged in debug mode and skipped — a misbehaving
 * integration must never lose the underlying event. The chain is sequential
 * (not parallel) so each hook sees the prior hook's enrichments.
 */
async function sendWithHooks(event: ErrorEvent): Promise<void> {
  if (!globalTransport || !globalConfig) return
  let current: ErrorEvent | null = event

  for (const integration of registeredIntegrations) {
    if (!integration.onBeforeSend || !current) break
    try {
      current = await integration.onBeforeSend(current)
    } catch (err) {
      if (globalConfig.debug) {
        console.warn(
          `[@inariwatch/capture] integration "${integration.name}" onBeforeSend threw, skipping:`,
          err instanceof Error ? err.message : err,
        )
      }
      // Don't lose the event — keep the pre-hook value and move on.
    }
  }

  if (!current) return
  if (globalConfig.beforeSend) {
    const filtered = globalConfig.beforeSend(current)
    if (!filtered) return
    current = filtered
  }

  // Payload v2: opt-in via CAPTURE_PAYLOAD_VERSION=2 env var. The v1 path
  // remains the default — the wire format swap only happens for installs
  // that explicitly flipped the flag. Backward compat is absolute: server
  // accepts v1 indefinitely, and a v2 build error falls back to v1 silently.
  if (resolvePayloadVersion() === "2") {
    try {
      // String-variable indirection defeats Turbopack's static analysis of
      // dynamic imports (which still walks them by default and pulls
      // v2-emit's Node-only deps — signing, source-context — into Edge
      // bundles even though this branch never executes there).
      const v2EmitMod = "./v2-emit.js"
      const { prepareV2Payload } = await import(/* webpackIgnore: true */ v2EmitMod)
      const wire = await prepareV2Payload(current)
      // Transport's `send` types `ErrorEvent`; the v2 shape is structurally
      // wider but the transport only reads `fingerprint` for retry dedup
      // and JSON-stringifies everything else, so it round-trips safely.
      globalTransport.send(wire as unknown as ErrorEvent)
      return
    } catch (err) {
      if (globalConfig.debug) {
        console.warn(
          "[@inariwatch/capture] payload v2 build failed, falling back to v1:",
          err instanceof Error ? err.message : err,
        )
      }
      // fall through to v1 send
    }
  }

  globalTransport.send(current)
}

/** Flush all pending events — call this before process exit or serverless return. */
export async function flush(): Promise<void> {
  if (globalTransport) await globalTransport.flush()
}

export function init(config: CaptureConfig = {}): void {
  const env = typeof process !== "undefined" && process.env ? process.env : {} as Record<string, string | undefined>
  const dsn = config.dsn || env.INARIWATCH_DSN
  const environment = config.environment || env.INARIWATCH_ENVIRONMENT || env.NODE_ENV
  globalConfig = { ...config, dsn, environment }

  if (!dsn) {
    globalTransport = createLocalTransport(globalConfig)
    if (!config.silent) {
      console.log("\x1b[2m[@inariwatch/capture] Local mode — errors print to terminal. Set INARIWATCH_DSN to send to cloud.\x1b[0m")
    }
  } else {
    const parsed = parseDSN(dsn)
    globalTransport = createTransport(globalConfig, parsed)
  }

  // FullTrace session id propagation (browser-only). Default: enabled.
  // Initialized BEFORE breadcrumbs because the fetch interceptor in
  // breadcrumbs.ts calls injectSessionHeader on every request — needs
  // the session id to already exist.
  if (config.fullTrace !== false) {
    const ftConfig: FullTraceConfig = typeof config.fullTrace === "object" ? config.fullTrace : {}
    initFullTrace(ftConfig)
  }

  // Initialize breadcrumbs (auto-intercept console + fetch)
  initBreadcrumbs()

  // Precursor stream (SKYNET §3 piece 3). Only spin the 1Hz sampler up when
  // payload v2 is the active wire format — v1 ingest doesn't read the field
  // and there's no point paying the (already <1%) overhead otherwise.
  if (resolvePayloadVersion() === "2") {
    import("./precursors.js")
      .then(({ initPrecursors }) => initPrecursors())
      .catch(() => {
        // precursors module is best-effort; v2 emit handles the empty case
      })
  }

  // Causal Graph Engine (SKYNET §3 piece 7). Opt-in via
  // CAPTURE_CAUSAL_GRAPH=1; only meaningful when v2 is active because v1
  // ingest doesn't read `evidence.graph`. Driver hooks attach lazily —
  // installAllHooks resolves async_hooks first, then patches every DB
  // driver that resolves (skipping the ones the user didn't install).
  if (resolvePayloadVersion() === "2") {
    const env = (typeof process !== "undefined" && process.env) || {}
    const flag = env.CAPTURE_CAUSAL_GRAPH ?? env.INARIWATCH_CAUSAL_GRAPH
    if (flag === "1" || flag === "true") {
      import("./causal/index.js")
        .then(({ installAllHooks }) => installAllHooks())
        .catch(() => {
          // causal-graph is best-effort; v2 emit handles the empty case
        })
    }
  }

  // Report deploy if release is set
  if (config.release && config.release !== lastReportedRelease) {
    lastReportedRelease = config.release
    reportDeploy(config.release, config.environment)
  }

  // Activate Substrate I/O recording if enabled
  if (config.substrate) {
    const subConfig: SubstrateConfig = typeof config.substrate === "object" ? config.substrate : {}
    initSubstrate(subConfig, config)
  }

  // Activate browser session recording if enabled
  if (config.session) {
    const sesConfig: SessionConfig = typeof config.session === "object" ? config.session : {}
    import("./session.js").then(({ initSession, getSessionEvents }) => {
      initSession(sesConfig, config)
      sessionFlush = getSessionEvents
    }).catch(() => {
      // session.ts uses dynamic import of rrweb — errors handled there
    })
  }

  // Run registered integrations (replay, performance, feedback, …). Each
  // integration is a small object from a sibling package that installs its
  // own hooks. Core capture never imports integration code directly — that
  // keeps the error-tracking bundle at ~32KB for users who don't opt in.
  registeredIntegrations = []
  if (config.integrations && config.integrations.length > 0) {
    const seen = new Set<string>()
    for (const integration of config.integrations) {
      if (!integration || typeof integration.setup !== "function") continue
      if (seen.has(integration.name)) continue
      seen.add(integration.name)
      try {
        integration.setup(globalConfig)
        registeredIntegrations.push(integration)
      } catch (err) {
        if (!config.silent) {
          console.warn(`[@inariwatch/capture] integration "${integration.name}" setup failed:`, err instanceof Error ? err.message : err)
        }
      }
    }
  }
}

async function initSubstrate(subConfig: SubstrateConfig, config: CaptureConfig): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = "@inariwatch/substrate-agent"
    const agent: any = await import(/* webpackIgnore: true */ pkg)
    agent.init({
      bufferSeconds: subConfig.bufferSeconds ?? 60,
      ...(subConfig.redact ? { redact: subConfig.redact } : {}),
    })
    substrateFlush = agent.flush
    if (!config.silent) {
      const debug = config.debug ? console.warn : () => {}
      debug("[@inariwatch/capture] Substrate recording active (ring buffer)")
    }
  } catch {
    if (!config.silent) {
      console.warn("[@inariwatch/capture] substrate: true but @inariwatch/substrate-agent not installed. Run: npm install @inariwatch/substrate-agent")
    }
  }
}

function reportDeploy(release: string, environment?: string): void {
  if (!globalTransport || !globalConfig) return
  const transport = globalTransport
  const config = globalConfig

  computeErrorFingerprint(`deploy:${release}`, environment || "").then((fp) => {
    const event: ErrorEvent = {
      fingerprint: fp,
      title: `Deploy: ${release}`,
      body: `New release deployed: ${release}${environment ? ` (${environment})` : ""}`,
      severity: "info",
      timestamp: new Date().toISOString(),
      environment: config.environment,
      release,
      eventType: "deploy",
    }
    transport.send(event)
  })
}

/** Enrich event with git, env, breadcrumbs, user, tags, request context, session id */
function enrichEvent(event: ErrorEvent): ErrorEvent {
  // FullTrace session id. Same value the SDK propagates as X-IW-Session-Id
  // on outbound fetches — including it on the error event lets the backend
  // correlate even when the failing request happened to bypass our fetch
  // interceptor (XHR, third-party SDK, beacon API).
  // Falls back to window.__INARIWATCH_SESSION__ for hosts running the
  // capture-replay package without the FullTrace init path.
  const sessionId = getSessionId() ?? (typeof window !== "undefined"
    ? (window as unknown as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__
    : undefined)

  return {
    ...event,
    git: getGitContext() ?? undefined,
    env: getEnvironmentContext(),
    breadcrumbs: getBreadcrumbs(),
    user: getUser(),
    tags: getTags(),
    request: getRequestContext() ?? event.request,
    metadata: sessionId
      ? { ...event.metadata, replaySessionId: sessionId, sessionId }
      : event.metadata,
  }
}

export function captureException(
  error: Error,
  context?: Record<string, unknown>,
): void {
  if (!globalTransport || !globalConfig) return

  const title = `${error.name}: ${error.message}`
  const body = error.stack || title

  const event: Omit<ErrorEvent, "fingerprint"> & { fingerprint?: string } = {
    title,
    body,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: globalConfig.environment,
    release: globalConfig.release,
    context,
    request: context?.request as ErrorEvent["request"],
    runtime: context?.runtime as ErrorEvent["runtime"],
    routePath: context?.routePath as string | undefined,
    routeType: context?.routeType as string | undefined,
  }

  const transport = globalTransport
  const config = globalConfig
  computeErrorFingerprint(title, body).then(async (fp) => {
    const fullEvent = enrichEvent({ ...event, fingerprint: fp })

    // Attach session recording if available (before send)
    if (sessionFlush) {
      fullEvent.sessionEvents = sessionFlush()
    }

    // Attach substrate I/O recording if available (piggybacked on error event)
    if (substrateFlush) {
      try {
        const recording = await substrateFlush()
        if (recording && typeof recording === "object" && "events" in (recording as Record<string, unknown>)) {
          fullEvent.substrateEvents = (recording as { events: unknown[] }).events
        }
      } catch {
        if (config.debug) console.warn("[@inariwatch/capture] Substrate flush failed")
      }
    }

    void sendWithHooks(fullEvent)
  })
}

export function captureMessage(
  message: string,
  level: "info" | "warning" | "critical" = "info",
): void {
  if (!globalTransport || !globalConfig) return

  const transport = globalTransport
  const config = globalConfig

  computeErrorFingerprint(message, "").then((fp) => {
    const event = enrichEvent({
      fingerprint: fp,
      title: message,
      body: message,
      severity: level,
      timestamp: new Date().toISOString(),
      environment: config.environment,
      release: config.release,
    })

    void sendWithHooks(event)
  })
}

const LOG_SEVERITY_MAP: Record<string, "critical" | "warning" | "info"> = {
  fatal: "critical",
  error: "critical",
  warn: "warning",
  info: "info",
  debug: "info",
}

export function captureLog(
  message: string,
  level: "debug" | "info" | "warn" | "error" | "fatal" = "info",
  metadata?: Record<string, unknown>,
): void {
  if (!globalTransport || !globalConfig) return

  const transport = globalTransport
  const config = globalConfig

  computeErrorFingerprint(`log:${level}:${message}`, "").then((fp) => {
    const event = enrichEvent({
      fingerprint: fp,
      title: `[${level.toUpperCase()}] ${message}`,
      body: metadata ? `${message}\n\n${JSON.stringify(metadata, null, 2)}` : message,
      severity: LOG_SEVERITY_MAP[level] || "info",
      timestamp: new Date().toISOString(),
      environment: config.environment,
      release: config.release,
      eventType: "log",
      logLevel: level,
      metadata,
    })

    void sendWithHooks(event)
  })
}
