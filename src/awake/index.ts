/**
 * Capture Awake — proactive browser performance and UX monitoring.
 *
 * Zero-config. Installed automatically by `@inariwatch/capture/browser`.
 * Detects: Web Vitals (LCP/INP/CLS/TTFB/FCP), Long Animation Frames, broken
 * resources (404 images/scripts/fonts), slow images, slow API calls,
 * render-blocking resources, third-party script impact, rage clicks, dead clicks,
 * SPA route timing, memory leak heuristic, image optimization opportunities,
 * storage quota pressure, hydration mismatches, and excessive DOM size.
 *
 * Opt out: `init({ awake: false })` or `window.__INARIWATCH__ = { awake: false }`
 *
 * Selective disable:
 *   init({ awake: { disable: ["memory-leak", "image-optimizer"] } })
 */

import type { AwakeConfig } from "../types.js"
import { onIdle } from "./utils.js"
import { installLoAF } from "./loaf.js"
import { installBrokenResources } from "./broken-resources.js"
import { installSpaRouting } from "./spa-routing.js"
import { installWebVitals } from "./web-vitals.js"
import { installResourceAudit } from "./resource-audit.js"
import { installRageClicks } from "./rage-clicks.js"
import { installMemoryLeak } from "./memory-leak.js"
import { scanImages } from "./image-optimizer.js"
import { checkStorageQuota } from "./storage-quota.js"
import { installHydrationDetector } from "./hydration.js"
import { checkDomSize } from "./dom-size.js"

export type { AwakeConfig }

export function installAwake(config: AwakeConfig = {}): void {
  if (typeof window === "undefined") return

  const skip = new Set(config.disable ?? [])

  // ── Phase 1: Critical — install immediately ────────────────────────────
  // These must run before the first resource load / user interaction to capture
  // all events. PerformanceObserver with buffered:true handles already-fired
  // entries; error capture-phase listener must be on before dynamic resources load.

  if (!skip.has("broken-resources")) installBrokenResources()
  if (!skip.has("loaf")) installLoAF(config)
  if (!skip.has("spa-routing")) installSpaRouting(config)
  if (!skip.has("web-vitals")) installWebVitals(config)
  if (!skip.has("resource-audit")) installResourceAudit(config)

  // ── Phase 2: Idle — install during browser free time ──────────────────
  // Won't block LCP/FCP. requestIdleCallback with 5s deadline ensures these
  // run within 5 seconds even on heavily loaded pages.

  onIdle(() => {
    if (!skip.has("rage-clicks")) installRageClicks(config)
    if (!skip.has("memory-leak")) installMemoryLeak(config)
    if (!skip.has("storage-quota")) { void checkStorageQuota() }
    if (!skip.has("dom-size")) checkDomSize(config)
    if (!skip.has("hydration")) installHydrationDetector()

    if (!skip.has("image-optimizer")) {
      if (document.readyState === "complete") {
        // naturalWidth is available after load — scan immediately
        scanImages(config)
      } else {
        // Wait for full load so naturalWidth/naturalHeight are populated
        window.addEventListener("load", () => scanImages(config), { once: true })
      }
    }
  })
}
