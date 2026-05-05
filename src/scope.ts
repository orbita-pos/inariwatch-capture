/**
 * Scope — request context, user context, and tags.
 * Uses AsyncLocalStorage for per-request isolation in Node.js.
 * Falls back to global state in edge runtime.
 *
 * ── Two-layer redaction model ────────────────────────────────────────────
 *
 * This module runs an always-on baseline scrub at `setRequestContext()`
 * time. It (a) redacts headers whose name matches a sensitive pattern
 * (`token` / `key` / `auth` / …), (b) wholesales sensitive body fields
 * (matched against the shared `SENSITIVE_KEYS` set imported from
 * `redact/keys.ts`), (c) trims oversized strings and arrays, and
 * (d) hard-redacts forwarded-IP headers.
 *
 * The full `redact/` module is OPT-IN (`init({ redact: true })`) and
 * complements this baseline: regex-based content scrubs (email, JWT,
 * Stripe / AWS / GitHub keys, Luhn-validated card numbers), allowlists,
 * hash mode, etc., over the whole event at send time.
 *
 * Both layers share `SENSITIVE_KEYS` so the field-name list cannot drift
 * between them.
 */

import { SENSITIVE_KEYS } from "./redact/keys.js"

let asyncStorage: any = null
try {
  const { AsyncLocalStorage } = require("node:async_hooks")
  asyncStorage = new AsyncLocalStorage()
} catch {
  // Edge runtime — fallback to global
}

interface Scope {
  user?: { id?: string; role?: string }
  tags?: Record<string, string>
  requestContext?: {
    method: string
    url: string
    headers?: Record<string, string>
    query?: Record<string, string>
    body?: unknown
    ip?: string
  }
}

let globalScope: Scope = {}

// Pattern-based: redact any header whose NAME contains one of these
// substrings. Complements `SENSITIVE_KEYS` (which is exact-match only).
const REDACT_HEADER_PATTERNS = ["token", "key", "secret", "auth", "credential", "password", "cookie", "session"]

function shouldRedactHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return REDACT_HEADER_PATTERNS.some((p) => lower.includes(p))
}

function redactBody(body: unknown): unknown {
  if (body === null || body === undefined) return body
  if (typeof body === "string") {
    return body.length > 1024 ? body.slice(0, 1024) + "...[truncated]" : body
  }
  if (typeof body !== "object") return body
  if (Array.isArray(body)) return body.slice(0, 20)

  const safe: Record<string, unknown> = {}
  const obj = body as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      safe[k] = "[REDACTED]"
    } else if (typeof v === "string" && v.length > 500) {
      safe[k] = v.slice(0, 500) + "...[truncated]"
    } else {
      safe[k] = v
    }
  }
  return safe
}

function getScope(): Scope {
  if (asyncStorage) {
    return asyncStorage.getStore() ?? globalScope
  }
  return globalScope
}

// ── Public API ──────────────────────────────────────────────────────────────

export function setUser(user: { id?: string; email?: string; role?: string }): void {
  // Strip email by default (PII) — only keep id + role
  const safe = { id: user.id, role: user.role }
  const scope = getScope()
  scope.user = safe
}

export function setTag(key: string, value: string): void {
  const scope = getScope()
  if (!scope.tags) scope.tags = {}
  scope.tags[key] = value
}

export function setRequestContext(ctx: {
  method: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  ip?: string
}): void {
  const scope = getScope()

  // Redact sensitive headers (pattern-based)
  const safeHeaders: Record<string, string> = {}
  if (ctx.headers) {
    for (const [k, v] of Object.entries(ctx.headers)) {
      safeHeaders[k] = shouldRedactHeader(k) ? "[REDACTED]" : v
    }
    // Also redact IP-related headers
    for (const h of ["x-forwarded-for", "x-real-ip"]) {
      if (safeHeaders[h]) safeHeaders[h] = "[REDACTED]"
    }
  }

  scope.requestContext = {
    method: ctx.method,
    url: ctx.url,
    headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined,
    query: ctx.query,
    body: redactBody(ctx.body),
    // IP omitted by default (PII/GDPR) — only sent if explicitly set
  }
}

export function getUser(): Scope["user"] {
  return getScope().user
}

export function getTags(): Scope["tags"] {
  return getScope().tags
}

export function getRequestContext(): Scope["requestContext"] {
  return getScope().requestContext
}

/**
 * Run a function with an isolated scope (for per-request isolation).
 * Use in middleware: runWithScope(() => handleRequest(req, res))
 */
export function runWithScope<T>(fn: () => T): T {
  if (asyncStorage) return asyncStorage.run({}, fn);
  const prev = globalScope;
  globalScope = {};
  try { return fn(); }
  finally { globalScope = prev; }
}
