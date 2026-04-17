/**
 * Breadcrumbs — automatic trail of actions before a crash.
 * Ring buffer of last 30 events: console, fetch, custom.
 * Secrets are scrubbed from messages automatically.
 *
 * Also the injection point for FullTrace's X-IW-Session-Id header — we
 * already wrap globalThis.fetch here for breadcrumb capture, so adding
 * one header to the same wrapper avoids a second monkey-patch.
 */

import type { Breadcrumb } from "./types.js"
import { injectSessionHeader } from "./fulltrace.js"

const MAX_BREADCRUMBS = 30
const breadcrumbs: Breadcrumb[] = []
let initialized = false

// Patterns that likely contain secrets
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,           // Bearer tokens
  /[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, // JWTs
  /(?:sk|pk|api|key|token|secret|password|passwd)[_-]?[:\s=]+\S{8,}/gi, // key=value secrets
  /:\/\/[^:]+:[^@]+@/g,                           // connection strings user:pass@
  /[?&](api_key|token|secret|key|password|auth|credential)=[^&\s]+/gi, // query string secrets
]

function scrubSecrets(text: string): string {
  let scrubbed = text
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]")
  }
  return scrubbed
}

/** Strip sensitive query params from URLs */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://localhost")
    const sensitiveParams = ["token", "key", "secret", "password", "auth", "credential", "api_key", "apiKey", "access_token"]
    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, "[REDACTED]")
      }
    }
    // Return just path+query if relative URL
    if (url.startsWith("/")) return parsed.pathname + parsed.search
    return parsed.href
  } catch {
    return scrubSecrets(url)
  }
}

export function addBreadcrumb(crumb: Partial<Breadcrumb> & { message: string }): void {
  breadcrumbs.push({
    timestamp: new Date().toISOString(),
    category: crumb.category ?? "custom",
    level: crumb.level ?? "info",
    message: scrubSecrets(crumb.message.slice(0, 200)),
    data: crumb.data,
  })
  if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift()
}

export function getBreadcrumbs(): Breadcrumb[] {
  return [...breadcrumbs]
}

/**
 * Auto-intercept console and fetch to record breadcrumbs.
 * Called once from init(). Safe to call multiple times (idempotent).
 */
export function initBreadcrumbs(): void {
  if (initialized) return
  initialized = true

  // Intercept console.log/warn/error
  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error

  console.log = (...args: unknown[]) => {
    addBreadcrumb({ category: "console", message: formatArgs(args), level: "info" })
    origLog.apply(console, args)
  }
  console.warn = (...args: unknown[]) => {
    addBreadcrumb({ category: "console", message: formatArgs(args), level: "warning" })
    origWarn.apply(console, args)
  }
  console.error = (...args: unknown[]) => {
    addBreadcrumb({ category: "console", message: formatArgs(args), level: "error" })
    origError.apply(console, args)
  }

  // Intercept fetch
  if (typeof globalThis.fetch === "function") {
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const url = scrubUrl(rawUrl)
      const method = init?.method ?? "GET"
      addBreadcrumb({ category: "fetch", message: `${method} ${url}`, level: "info" })

      // FullTrace: inject X-IW-Session-Id when same-origin (or cross-origin opt-in).
      // injectSessionHeader returns the original init if the session is inactive,
      // so this is a zero-cost no-op for users on v0.7.x behaviour.
      const finalInit = injectSessionHeader(rawUrl, init)

      try {
        const resp = await origFetch(input, finalInit)
        if (!resp.ok) {
          addBreadcrumb({ category: "fetch", message: `${method} ${url} → ${resp.status}`, level: "warning" })
        }
        return resp
      } catch (err) {
        addBreadcrumb({ category: "fetch", message: `${method} ${url} → FAILED`, level: "error" })
        throw err
      }
    }
  }
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === "string") return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(" ").slice(0, 200)
}
