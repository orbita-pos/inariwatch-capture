/**
 * Integration export — the surface end users actually consume.
 *
 *   import { init } from "../types.js"
 *   import { peerAgentIntegration } from "@inariwatch/capture-agent"
 *
 *   init({
 *     dsn: process.env.INARIWATCH_DSN,
 *     integrations: [
 *       peerAgentIntegration({ apiKey: process.env.OPENAI_API_KEY! }),
 *     ],
 *   })
 *
 * The integration:
 *   - Reads the env var INARIWATCH_PEER_AGENT_DISABLED — if "true", it
 *     no-ops cleanly (lets users disable the peer in CI without changing
 *     code).
 *   - Lazily constructs PeerAgent on first use (saves init time).
 *   - On `onBeforeSend`, races the agent's `diagnose()` against the
 *     deadline. On success, attaches `event.hypotheses[]`. On failure /
 *     timeout, returns the event unchanged. NEVER drops the event.
 */

import type { ErrorEvent, Integration } from "../types.js"
import { PeerAgent, type PeerAgentConfig } from "./agent.js"

export interface PeerAgentIntegrationConfig extends PeerAgentConfig {
  /**
   * Skip diagnose for events whose severity is below this threshold.
   * Default: "warning". Critical-only would set "critical". Set "info"
   * to diagnose all events including logs (expensive, not recommended).
   */
  minSeverity?: "info" | "warning" | "critical"
}

const SEVERITY_RANK: Record<"info" | "warning" | "critical", number> = {
  info: 0,
  warning: 1,
  critical: 2,
}

/**
 * Plugin contract for `init({ integrations: [...] })`. See
 * capture/src/types.ts Integration interface.
 */
export function peerAgentIntegration(
  config: PeerAgentIntegrationConfig,
): Integration {
  const minSeverity = config.minSeverity ?? "warning"
  const minRank = SEVERITY_RANK[minSeverity]

  let agent: PeerAgent | null = null
  let disabled = false

  return {
    name: "@inariwatch/capture-agent",
    setup(): void {
      if (process.env.INARIWATCH_PEER_AGENT_DISABLED === "true") {
        disabled = true
        return
      }
      if (!config.apiKey) {
        // Don't crash init — degrade quietly. Users wiring the env var
        // late shouldn't fight a hard error.
        disabled = true
        return
      }
      agent = new PeerAgent(config)
    },
    async onBeforeSend(event: ErrorEvent): Promise<ErrorEvent | null> {
      if (disabled || !agent) return event
      const sev = event.severity ?? "critical"
      if (SEVERITY_RANK[sev] < minRank) return event

      // Skip events that already have hypotheses (some other source
      // produced them — bloom match, server-side analysis). Don't double up.
      if (event.hypotheses && event.hypotheses.length > 0) return event

      try {
        const hypotheses = await agent.diagnose(event)
        if (hypotheses.length > 0) {
          return { ...event, hypotheses, schemaVersion: "2.0" }
        }
      } catch {
        // PeerAgent.diagnose already swallows errors, but be defensive.
      }
      return event
    },
  }
}
