/**
 * HTTP outbound hook — SKYNET §3 piece 7 (Track B), session 2.
 *
 * Two strategies, picked per environment:
 *
 *   - Node ≥18 (and Bun): subscribe to undici's diagnostics_channel events.
 *     Node's native `fetch` is undici under the hood, so this single hook
 *     covers `fetch`, `node-fetch` (npm), and direct undici callers in one
 *     pass — without monkey-patching globals.
 *
 *   - Browser: monkey-patch `window.fetch`. PerformanceObserver gives us
 *     timing but not the request/response object pair we need to inject
 *     stitching headers and tag the parsed body.
 *
 * Stitching:
 *   - On every outbound request we inject `X-IW-Session-Id` (from FullTrace)
 *     and `X-IW-Causal-Id` (the active node id). Downstream services running
 *     this SDK pick those up and link their nodes to the same chain.
 *   - On response, we look for `X-IW-Subgraph` — a base64-encoded
 *     `CausalGraph` from the downstream service — and merge it into the
 *     local buffer with a causal edge from the http node to the foreign
 *     root. That's what produces the cross-service unified graph.
 *
 * Data-flow:
 *   - On response trailer, mark a short pending-provenance window so the
 *     user's next `JSON.parse(responseBody)` tags the parsed value with the
 *     http node id. Downstream DB hooks then add `data-flow` edges if that
 *     value (or one level below it) is passed to a query.
 *
 * Browser/Edge runtime: undici diagnostics_channel doesn't exist in the
 * browser, so install resolves to `false`. A `installBrowserHttpHook`
 * export is provided for browser callers; it monkey-patches global `fetch`
 * and is wired by the browser entry, not the node `installAllHooks`.
 *
 * Cap: each request adds at most 2 nodes (request + response) — the cap in
 * graph.ts handles overflow naturally.
 */

import { recordOp, mergeSubgraph, deserializeFromHeader } from "./graph.js"
import { markPendingHttpProvenance, installJsonParseTaint } from "./data-flow.js"

const SESSION_HEADER = "x-iw-session-id"
const CAUSAL_HEADER = "x-iw-causal-id"
const SUBGRAPH_HEADER = "x-iw-subgraph"
const PATCH_MARK = Symbol.for("@inariwatch/capture.causal.http.patched")

type HandleEnd = (extras?: {
  durationMs?: number
  attrs?: Record<string, unknown>
  error?: unknown
}) => void

interface ActiveRequest {
  id: string
  end: HandleEnd
  start: number
  url: string
  method: string
}

// ─── Node: undici diagnostics_channel hook ─────────────────────────────────

interface UndiciCreatePayload {
  request: {
    origin?: string
    path?: string
    method?: string
    addHeader?: (k: string, v: string) => unknown
    headers?: string[] | Record<string, string>
  }
}

interface UndiciResponsePayload {
  request: object
  response?: { headers?: Record<string, string> | string[] }
}

interface UndiciErrorPayload {
  request: object
  error: unknown
}

let installedNode = false

/**
 * Install the undici diagnostics_channel hook. Idempotent. Returns true
 * when the channel was newly subscribed, false when undici/diagnostics
 * channel is unavailable or we've already installed.
 *
 * `loader` is a test seam — production passes `undefined` and we resolve
 * `node:diagnostics_channel` ourselves.
 */
export async function installHttpHook(
  loader?: () => Promise<unknown>,
): Promise<boolean> {
  if (installedNode) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dc: any
  try {
    if (loader) {
      dc = await loader()
    } else {
      const pkg = "node:diagnostics_channel"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dc = await import(/* webpackIgnore: true */ pkg)
    }
  } catch {
    return false
  }
  if (!dc?.subscribe) return false

  const active = new WeakMap<object, ActiveRequest>()

  installJsonParseTaint()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.subscribe("undici:request:create", (payload: UndiciCreatePayload) => {
    const req = payload?.request
    if (!req || typeof req !== "object") return
    if ((req as Record<symbol, unknown>)[PATCH_MARK]) return
    const url = `${req.origin ?? ""}${req.path ?? ""}` || "<unknown>"
    const method = (req.method ?? "GET").toUpperCase()
    const handle = recordOp(`http.${method.toLowerCase()}`, {
      url: truncate(url, 500),
      method,
      direction: "outbound",
    })
    if (!handle.id) return
    ;(req as Record<symbol, unknown>)[PATCH_MARK] = true

    // Inject stitching headers — best-effort. addHeader is the public API on
    // undici Request, but it's not in older versions; falling back to a
    // direct headers array push covers v5/v6.
    injectUndiciHeader(req, "x-iw-causal-id", handle.id)
    const sessionId = readSessionId()
    if (sessionId) injectUndiciHeader(req, "x-iw-session-id", sessionId)

    active.set(req, { id: handle.id, end: handle.end, start: Date.now(), url, method })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.subscribe("undici:request:trailers", (payload: UndiciResponsePayload) => {
    const req = payload?.request
    if (!req || typeof req !== "object") return
    const slot = active.get(req)
    if (!slot) return
    active.delete(req)
    const headers = readHeaders(payload.response?.headers)
    const subgraphHeader = headers[SUBGRAPH_HEADER]
    if (subgraphHeader) {
      const foreign = deserializeFromHeader(subgraphHeader)
      if (foreign) {
        const origin = safeOrigin(slot.url)
        mergeSubgraph(foreign, origin, slot.id)
      }
    }
    // Open the data-flow window so the next JSON.parse of the body inherits
    // this http node as its source.
    markPendingHttpProvenance(slot.id)
    slot.end({ durationMs: Date.now() - slot.start })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dc.subscribe("undici:request:error", (payload: UndiciErrorPayload) => {
    const req = payload?.request
    if (!req || typeof req !== "object") return
    const slot = active.get(req)
    if (!slot) return
    active.delete(req)
    slot.end({ durationMs: Date.now() - slot.start, error: payload.error })
  })

  installedNode = true
  return true
}

// ─── Browser: fetch monkey-patch ───────────────────────────────────────────

let installedBrowser = false

/**
 * Install the browser fetch hook. Adds a wrapper around `globalThis.fetch`
 * that records http.<method> nodes, injects stitching headers, and merges
 * the X-IW-Subgraph response header into the active causal buffer.
 *
 * Browser-only. Returns true when newly installed.
 */
export function installBrowserHttpHook(): boolean {
  if (installedBrowser) return false
  if (typeof globalThis === "undefined") return false
  const g = globalThis as { fetch?: typeof fetch }
  if (typeof g.fetch !== "function") return false
  const original = g.fetch.bind(globalThis)

  installJsonParseTaint()

  g.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const method = (
      typeof input === "object" && "method" in input
        ? (input.method as string)
        : init?.method ?? "GET"
    ).toUpperCase()
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const handle = recordOp(`http.${method.toLowerCase()}`, {
      url: truncate(url, 500),
      method,
      direction: "outbound",
    })
    if (!handle.id) return original(input, init)
    const start = Date.now()

    const headers = new Headers(init?.headers ?? undefined)
    if (!headers.has("x-iw-causal-id")) headers.set("x-iw-causal-id", handle.id)
    const sessionId = readSessionId()
    if (sessionId && !headers.has("x-iw-session-id")) {
      headers.set("x-iw-session-id", sessionId)
    }

    let res: Response
    try {
      res = await original(input, { ...(init ?? {}), headers })
    } catch (err) {
      handle.end({ durationMs: Date.now() - start, error: err })
      throw err
    }
    const subgraphHeader = res.headers.get(SUBGRAPH_HEADER) ?? undefined
    if (subgraphHeader) {
      const foreign = deserializeFromHeader(subgraphHeader)
      if (foreign) mergeSubgraph(foreign, safeOrigin(url), handle.id)
    }
    markPendingHttpProvenance(handle.id)
    handle.end({ durationMs: Date.now() - start, attrs: { status: res.status } })
    return res
  } as typeof fetch

  installedBrowser = true
  return true
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function injectUndiciHeader(
  req: { addHeader?: (k: string, v: string) => unknown; headers?: unknown },
  key: string,
  value: string,
): void {
  try {
    if (typeof req.addHeader === "function") {
      req.addHeader(key, value)
      return
    }
  } catch {
    // fall through to direct header manipulation
  }
  // undici v5 stores headers as a flat string[] — push key/value pairs.
  if (Array.isArray(req.headers)) {
    req.headers.push(key, value)
    return
  }
  // Older custom shapes — best-effort plain object set.
  if (req.headers && typeof req.headers === "object") {
    ;(req.headers as Record<string, string>)[key] = value
  }
}

function readHeaders(
  headers: Record<string, string> | string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const k = String(headers[i]).toLowerCase()
      out[k] = String(headers[i + 1])
    }
    return out
  }
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = String(v)
  }
  return out
}

function readSessionId(): string | null {
  // FullTrace runs in browser — pick up the global it writes to. In Node we
  // rely on the upstream caller to have injected x-iw-session-id and the
  // server to have surfaced it; this hook never invents a session id.
  if (typeof globalThis === "undefined") return null
  const g = globalThis as { __INARIWATCH_SESSION__?: string }
  return g.__INARIWATCH_SESSION__ ?? null
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).host || "remote"
  } catch {
    return "remote"
  }
}

function truncate(s: string, n: number): string {
  if (!s) return s
  return s.length <= n ? s : s.slice(0, n) + "…"
}

// ─── Test seams ─────────────────────────────────────────────────────────────

export function __resetHttpHookForTesting(): void {
  installedNode = false
  installedBrowser = false
}

export const __HTTP_PATCH_MARK_FOR_TESTING: symbol = PATCH_MARK
export const __HTTP_HEADERS = {
  SESSION: SESSION_HEADER,
  CAUSAL: CAUSAL_HEADER,
  SUBGRAPH: SUBGRAPH_HEADER,
}
