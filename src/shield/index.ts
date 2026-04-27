/**
 * @inariwatch/capture/shield — Runtime security detection via source-to-sink tracking.
 *
 * Import this module to automatically hook dangerous sinks (database queries,
 * shell commands, file operations) and detect when unsanitized user input reaches them.
 *
 * Usage (auto — any framework with instrumentation or a Web API request entrypoint):
 *   import "@inariwatch/capture/shield"
 *
 * Usage (middleware — Express, Fastify, Koa, Hono, Connect):
 *   import { shield } from "@inariwatch/capture/shield"
 *   app.use(shield())
 *   // or with block mode:
 *   app.use(shield({ mode: "block" }))
 *
 * Usage (Web Request object — Remix loaders, SvelteKit, Astro, Cloudflare Workers):
 *   import { markRequestTainted } from "@inariwatch/capture/shield"
 *   markRequestTainted(request)
 */

import type { ShieldConfig, SecurityContext } from "../types.js"
import { hookSinks } from "./sinks.js"
import { shieldMiddleware, markRequestTainted } from "./sources.js"
import { buildSecurityTitle, buildSecurityBody } from "./detect.js"

// Shield hooks Node.js SQL / FS / child_process drivers. It is strictly a
// server-side feature — no-op entirely in browsers and edge runtimes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IS_NODE = (() => {
  if (typeof window !== "undefined") return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = ((globalThis as any).process as any)
    return !!proc?.versions?.node
  } catch {
    return false
  }
})()

let initialized = false
let shieldConfig: ShieldConfig = {}

/** Report a security threat via the capture SDK. */
function reportThreat(ctx: SecurityContext): void {
  try {
    // Indirect eval keeps the bundler from trying to resolve the relative
    // path at build time (we're a published package; path walks happen at
    // runtime against the installed dist).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = ((globalThis as any).require as (m: string) => any)
    const { captureException } = req("../client.js")

    const title = buildSecurityTitle(ctx)
    const body = buildSecurityBody(ctx)

    // Create a synthetic error with the security context
    const err = new Error(title)
    err.name = "SecurityThreat"
    err.stack = `SecurityThreat: ${title}\n    at ${ctx.sink} (${ctx.sinkFile ?? "unknown"}:${ctx.sinkLine ?? 0})`

    captureException(err, {
      eventType: "security",
      securityContext: ctx,
      severity: "critical",
    })
  } catch {
    // Capture SDK not initialized — log to console as fallback
    console.warn(`[shield] ${ctx.vulnerability} detected in ${ctx.sink} from ${ctx.source}`)
  }
}

/** Initialize shield — hooks all sinks. Called automatically on import. */
function initShield(config: ShieldConfig = {}): void {
  if (initialized) return
  if (!IS_NODE) return  // browser / edge: shield is a no-op
  initialized = true
  shieldConfig = config
  hookSinks(config, reportThreat)
}

/**
 * Express/Connect middleware that marks request inputs as tainted
 * and optionally blocks threats.
 *
 * Usage:
 *   app.use(shield())
 *   app.use(shield({ mode: "block" }))
 */
export function shield(config: ShieldConfig = {}) {
  initShield(config)
  return shieldMiddleware()
}

// Re-export for manual Next.js usage
export { markRequestTainted } from "./sources.js"
export { markTainted, markObjectTainted, runWithTaintStore, clearTaint } from "./taint.js"

// Auto-initialize on import with report-only mode
initShield()
