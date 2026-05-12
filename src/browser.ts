/**
 * Browser auto-init + Capture Awake proactive monitoring.
 *
 * Usage:
 *   <script>window.__INARIWATCH__ = { dsn: "...", integrations: [...] }</script>
 *   <script type="module">import "@inariwatch/capture/browser"</script>
 *
 * Reads config from `window.__INARIWATCH__`. Defaults to `{ session: true }`.
 *
 * Proactive monitoring (Capture Awake) runs automatically — detects Web Vitals,
 * Long Animation Frames, broken resources, slow images, rage clicks, memory leaks,
 * and more. Opt out: `window.__INARIWATCH__ = { awake: false }`.
 *
 * Full session replay lives in `@inariwatch/capture-replay`:
 *   window.__INARIWATCH__ = {
 *     projectId: "...",
 *     integrations: [replayIntegration()]
 *   }
 *
 * Browser-only — no-ops in Node.js.
 */

import { init } from "./client.js"
import { installAwake } from "./awake/index.js"
import type { CaptureConfig, AwakeConfig } from "./types.js"

if (typeof window !== "undefined") {
  const windowConfig = (window as unknown as { __INARIWATCH__?: CaptureConfig }).__INARIWATCH__ ?? {}
  const merged: CaptureConfig = {
    session: true,
    ...windowConfig,
  }
  init(merged)

  // Capture Awake: proactive performance + UX monitoring.
  // Opt out with awake: false, or tune via the AwakeConfig object.
  if (merged.awake !== false) {
    const awakeConfig: AwakeConfig = typeof merged.awake === "object" ? merged.awake : {}
    installAwake(awakeConfig)
  }
}
