/**
 * Browser auto-init.
 *
 * Usage:
 *   <script>window.__INARIWATCH__ = { dsn: "...", integrations: [...] }</script>
 *   <script type="module">import "@inariwatch/capture/browser"</script>
 *
 * Reads config from `window.__INARIWATCH__`. Defaults to `{ session: true }`
 * (the legacy 60-second ring buffer that attaches on error).
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
import type { CaptureConfig } from "./types.js"

if (typeof window !== "undefined") {
  const windowConfig = (window as unknown as { __INARIWATCH__?: CaptureConfig }).__INARIWATCH__ ?? {}
  const merged: CaptureConfig = {
    session: true,
    ...windowConfig,
  }
  init(merged)
}
