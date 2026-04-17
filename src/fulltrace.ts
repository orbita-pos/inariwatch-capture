/**
 * FullTrace — session id propagation for causal debugging.
 *
 * Generates a stable per-user session id and injects it as `X-IW-Session-Id`
 * on every same-origin fetch/XHR. The backend reads the header and tags
 * Substrate I/O records + alerts with the same id, letting the dashboard
 * stitch frontend events ↔ backend events ↔ AI fix into one timeline.
 *
 * Design rules:
 *   - Browser-only. In Node.js this module is a no-op — the server is the
 *     receiver of the header, never the generator.
 *   - Backward compatible. If `fullTrace: false` the SDK behaves exactly
 *     like v0.7.x (no header, no cookie, no global). If `__INARIWATCH_SESSION__`
 *     is already set (e.g. by `@inariwatch/capture-replay`) we adopt that id
 *     instead of generating a new one — replay session and FullTrace session
 *     are the same concept, only one id can win.
 *   - Same-origin only by default. Adding a custom header to a cross-origin
 *     fetch promotes it to a "non-simple" CORS request, triggering a preflight
 *     that third-party APIs (Stripe, Algolia, …) won't allow. Users can opt
 *     into cross-origin propagation via `fullTrace: { allowCrossOrigin: true }`
 *     when their backend also lives off-origin and they control the CORS config.
 *   - Cookie + sessionStorage. Cookie keeps the session alive across tabs
 *     (one user, one timeline). sessionStorage is the fallback if cookies are
 *     blocked. Both are renewed on every emit so an inactive tab doesn't
 *     prematurely expire a real-time session.
 */

import type { FullTraceConfig } from "./types.js"

const COOKIE_NAME = "iw_session"
const STORAGE_KEY = "iw_session"
const HEADER_NAME = "X-IW-Session-Id"
/** 30 min sliding window. Long enough to cover idle tabs, short enough that a
 *  closed laptop doesn't keep correlating to the same session next morning. */
const TTL_SECONDS = 1800

let activeSessionId: string | null = null
let activeConfig: FullTraceConfig = {}
let initialized = false
let originHostname = ""

// ── id generation ───────────────────────────────────────────────────────────

function generateSessionId(): string {
  // crypto.randomUUID is widely available (Chrome 92, Safari 15.4, FF 95).
  // Fallback uses crypto.getRandomValues if randomUUID is missing — covers
  // older browsers without bringing in a polyfill.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    // RFC 4122 v4 marker bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  // Last-resort: timestamp + Math.random. Not cryptographically strong but
  // good enough for a session correlation id; collisions only matter inside
  // one workspace's session pool.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}

// ── storage helpers ─────────────────────────────────────────────────────────

function readCookie(): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function writeCookie(id: string): void {
  if (typeof document === "undefined") return
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(id)}; Max-Age=${TTL_SECONDS}; Path=/; SameSite=Lax${secure}`
}

function readStorage(): string | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null
  } catch {
    return null
  }
}

function writeStorage(id: string): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(STORAGE_KEY, id)
  } catch {
    // sessionStorage can throw in private mode or if quota is exceeded.
    // Cookie + window var still cover the propagation path.
  }
}

function readGlobal(): string | null {
  if (typeof window === "undefined") return null
  return (window as unknown as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__ ?? null
}

function writeGlobal(id: string): void {
  if (typeof window === "undefined") return
  ;(window as unknown as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__ = id
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * Initialize FullTrace. Idempotent. Browser-only — no-ops in Node.js.
 *
 * Resolution order for the session id:
 *   1. `window.__INARIWATCH_SESSION__` (set by replay package)
 *   2. `iw_session` cookie
 *   3. `iw_session` sessionStorage
 *   4. Generate new UUID v4
 *
 * Whichever wins is then propagated to all three storages so the next read
 * (or a hydration boundary) finds it cheaply.
 */
export function initFullTrace(config: FullTraceConfig = {}): void {
  if (typeof window === "undefined") return
  if (initialized) return
  initialized = true
  activeConfig = config

  try {
    originHostname = location.hostname
  } catch {
    originHostname = ""
  }

  const existing = readGlobal() ?? readCookie() ?? readStorage()
  const id = existing ?? generateSessionId()

  activeSessionId = id
  writeCookie(id)
  writeStorage(id)
  writeGlobal(id)
}

/** Returns the active session id, or null if FullTrace was never initialized
 *  or we're running outside a browser. */
export function getSessionId(): string | null {
  return activeSessionId
}

/** Re-anchor the session id (useful when a host app issues its own ids,
 *  e.g. from auth). Triggers a refresh of all three storages. */
export function setSessionId(id: string): void {
  if (!id) return
  activeSessionId = id
  writeCookie(id)
  writeStorage(id)
  writeGlobal(id)
}

/**
 * Decide whether to inject the session header for a given URL.
 *
 * Same-origin: always (no preflight cost).
 * Cross-origin: only if the user opted in via `allowCrossOrigin: true`.
 */
function shouldInject(url: string): boolean {
  if (!activeSessionId) return false
  if (!url) return true // relative path = same-origin
  try {
    const parsed = new URL(url, typeof location !== "undefined" ? location.href : undefined)
    if (parsed.hostname === originHostname) return true
    return Boolean(activeConfig.allowCrossOrigin)
  } catch {
    return true
  }
}

/**
 * Return a new RequestInit with the session header injected, or the original
 * init if injection is not appropriate. Never mutates the input.
 *
 * Used by breadcrumbs.ts in its globalThis.fetch interceptor.
 */
export function injectSessionHeader(
  url: string,
  init?: RequestInit,
): RequestInit | undefined {
  if (!shouldInject(url)) return init

  const headers = new Headers(init?.headers ?? undefined)
  // Don't overwrite a header the caller explicitly set.
  if (headers.has(HEADER_NAME)) return init
  headers.set(HEADER_NAME, activeSessionId!)

  return { ...(init ?? {}), headers }
}

/** Test seam — reset module state. Production code shouldn't call this. */
export function __resetFullTraceForTesting(): void {
  activeSessionId = null
  activeConfig = {}
  initialized = false
  originHostname = ""
}
