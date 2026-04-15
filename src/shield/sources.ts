/**
 * Source hooks — mark user inputs as tainted when they enter the application.
 *
 * Provides middleware for Express/Fastify/Hono and a function for Next.js.
 */

import { markTainted, markObjectTainted, runWithTaintStore, clearTaint } from "./taint.js"

/**
 * Express/Connect-style middleware — marks req.query, req.params, req.body,
 * req.headers, req.cookies as tainted for the duration of the request.
 *
 * Usage: app.use(shieldMiddleware())
 */
export function shieldMiddleware() {
  return (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    runWithTaintStore(() => {
      // Mark all user-controlled inputs
      if (req.query) markObjectTainted(req.query, "req.query")
      if (req.params) markObjectTainted(req.params, "req.params")
      if (req.body) markObjectTainted(req.body, "req.body")
      if (req.cookies) markObjectTainted(req.cookies, "req.cookies")

      // Mark specific dangerous headers (not all — too noisy)
      const headers = req.headers as Record<string, string> | undefined
      if (headers) {
        for (const key of ["x-forwarded-for", "x-forwarded-host", "referer", "origin"]) {
          if (headers[key]) markTainted(headers[key], `req.headers.${key}`)
        }
      }

      // Mark URL path segments
      const url = req.url as string | undefined
      if (url) {
        const pathSegments = url.split("?")[0].split("/").filter(Boolean)
        for (const seg of pathSegments) {
          if (seg.length >= 3) markTainted(decodeURIComponent(seg), "req.url.path")
        }

        // Mark raw query string values (in case req.query isn't parsed yet)
        const qs = url.split("?")[1]
        if (qs) {
          for (const pair of qs.split("&")) {
            const [, val] = pair.split("=")
            if (val && val.length >= 3) {
              markTainted(decodeURIComponent(val), "req.url.query")
            }
          }
        }
      }

      next()
    })
  }
}

/**
 * Mark a Web API Request object's inputs as tainted.
 * Works with any framework that passes a Fetch-compatible Request: Next.js,
 * Remix, SvelteKit, Astro, Hono, Cloudflare Workers, Deno, Bun, etc.
 *
 * Call this in instrumentation.ts, middleware.ts, or your framework's
 * equivalent request entrypoint.
 *
 * Usage: markRequestTainted(request)
 */
export function markRequestTainted(request: {
  url?: string
  headers?: { get?: (key: string) => string | null; forEach?: (fn: (v: string, k: string) => void) => void }
}): void {
  if (request.url) {
    try {
      const url = new URL(request.url)

      // URL search params
      url.searchParams.forEach((value, key) => {
        markTainted(value, `req.searchParams.${key}`)
      })

      // URL path segments
      for (const seg of url.pathname.split("/").filter(Boolean)) {
        if (seg.length >= 3) markTainted(decodeURIComponent(seg), "req.url.path")
      }
    } catch { /* invalid URL */ }
  }

  // Dangerous headers
  if (request.headers?.get) {
    for (const key of ["x-forwarded-for", "x-forwarded-host", "referer", "origin"]) {
      const val = request.headers.get(key)
      if (val) markTainted(val, `req.headers.${key}`)
    }
  }
}
