/**
 * @inariwatch/capture/shield — Runtime security detection via source-to-sink tracking.
 *
 * Import this module to automatically hook dangerous sinks (database queries,
 * shell commands, file operations) and detect when unsanitized user input reaches them.
 *
 * Usage (auto, recommended for Next.js):
 *   import "@inariwatch/capture/shield"
 *
 * Usage (middleware, for Express/Fastify):
 *   import { shield } from "@inariwatch/capture/shield"
 *   app.use(shield())
 *   // or with block mode:
 *   app.use(shield({ mode: "block" }))
 */

import type { ShieldConfig, SecurityContext } from "../types.js"
import { hookSinks } from "./sinks.js"
import { shieldMiddleware, markRequestTainted } from "./sources.js"
import { buildSecurityTitle, buildSecurityBody } from "./detect.js"

let initialized = false
let shieldConfig: ShieldConfig = {}

/** Report a security threat via the capture SDK. */
function reportThreat(ctx: SecurityContext): void {
  try {
    // Dynamic import to avoid circular dependency with client.ts
    const { captureException } = require("../client.js")

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
