/**
 * Integration export for `init({ integrations: [fleetBloomIntegration(...)] })`.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Behavior:
 *   - On `setup()`, kicks off the bloom fetch (fire-and-forget; non-blocking).
 *     The first few events after init may not see the bloom — that's fine,
 *     they ship without `fleetMatch`. Subsequent events get the data.
 *   - On `onBeforeSend()`, attaches `event.fleetMatch = { bloomHit: bool }`
 *     so the server-side enricher (and the peer agent's `matchFingerprint`
 *     tool) have the result without their own RTT.
 *   - When `contribute: true` and the bloom did NOT hit (i.e. likely a new
 *     pattern), POSTs the anonymized fingerprint to the observe endpoint
 *     in the background. Capped at one contribution per fingerprint per
 *     process.
 */

import type { ErrorEvent, Integration } from "../types.js"
import {
  FleetBloomClient,
  contributeFingerprint,
  type FleetBloomClientOptions,
} from "./client.js"

export interface FleetBloomIntegrationConfig extends FleetBloomClientOptions {
  /** Send anonymized fingerprint POST when this SDK sees a bloom miss. Default: false. */
  contribute?: boolean
  /** Optional metadata sent with each contribution. */
  framework?: string
  language?: string
}

export function fleetBloomIntegration(
  config: FleetBloomIntegrationConfig = {},
): Integration {
  let client: FleetBloomClient | null = null

  return {
    name: "@inariwatch/capture-fleet",
    setup(): void {
      client = new FleetBloomClient(config)
      // Fire-and-forget — never block init.
      void client.init()
    },
    async onBeforeSend(event: ErrorEvent): Promise<ErrorEvent | null> {
      if (!client || !event.fingerprint) return event
      const bloomHit = client.hasAnyoneElseHit(event.fingerprint)

      // If user wants to contribute and we just hit a NEW fingerprint, fire
      // the observe request in the background. Don't block egress on it.
      if (config.contribute && !bloomHit && client.getMeta()) {
        void contributeFingerprint(
          config.baseUrl ?? "https://app.inariwatch.com",
          event.fingerprint,
          { framework: config.framework, language: config.language },
        )
      }

      // Attach fleetMatch (additive, doesn't overwrite a richer value if a
      // higher-priority integration already set it).
      if (event.fleetMatch !== undefined) return event
      return { ...event, fleetMatch: { bloomHit }, schemaVersion: "2.0" }
    },
  }
}
