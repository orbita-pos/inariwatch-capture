import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"
import { getPathname, ratingForMs, levelForRating } from "./utils.js"

// PerformanceResourceTiming.renderBlockingStatus — Chrome 107+, not in TS 5.5 lib
interface ExtendedResourceTiming extends PerformanceResourceTiming {
  readonly renderBlockingStatus?: "blocking" | "non-blocking"
}

const DEFAULT_SLOW_IMAGE_MS = 1000
const POOR_IMAGE_MS = 3000
const DEFAULT_SLOW_FETCH_MS = 1000
const POOR_FETCH_MS = 3000
const DEFAULT_OVERSIZED_BYTES = 500_000

// Known third-party origins and their human-readable labels
const THIRD_PARTY_LABELS: Record<string, string> = {
  "www.google-analytics.com": "Google Analytics",
  "analytics.google.com": "Google Analytics",
  "www.googletagmanager.com": "Google Tag Manager",
  "connect.facebook.net": "Facebook Pixel",
  "platform.twitter.com": "Twitter/X Widget",
  "static.ads-twitter.com": "Twitter Ads",
  "cdn.segment.com": "Segment",
  "api.segment.io": "Segment",
  "js.intercomcdn.com": "Intercom",
  "widget.intercom.io": "Intercom",
  "cdn.heapanalytics.com": "Heap Analytics",
  "js.stripe.com": "Stripe",
}

function getThirdPartyLabel(hostname: string): string {
  return THIRD_PARTY_LABELS[hostname] ?? hostname
}

export function installResourceAudit(config: AwakeConfig): void {
  if (typeof window === "undefined" || !("PerformanceObserver" in window)) return

  const slowImageMs = config.slowImageMs ?? DEFAULT_SLOW_IMAGE_MS
  const slowFetchMs = config.slowFetchMs ?? DEFAULT_SLOW_FETCH_MS
  const oversizedBytes = config.oversizedImageBytes ?? DEFAULT_OVERSIZED_BYTES
  const pathname = getPathname(config)

  // Track third-party totals across resources (report once per origin after load)
  const thirdPartyTotals = new Map<string, { durationMs: number; scriptMs: number; count: number }>()
  let thirdPartyFlushTimer: ReturnType<typeof setTimeout> | null = null

  function flushThirdParty(): void {
    for (const [hostname, data] of thirdPartyTotals) {
      if (data.durationMs < 200) continue
      captureLog(
        `third_party_impact: ${getThirdPartyLabel(hostname)} ${Math.round(data.durationMs)}ms`,
        data.durationMs > 1000 ? "warn" : "info",
        {
          kind: "third_party_impact",
          origin: hostname,
          label: getThirdPartyLabel(hostname),
          totalDurationMs: Math.round(data.durationMs),
          scriptBlockingMs: Math.round(data.scriptMs),
          resourceCount: data.count,
          pathname,
        },
      )
    }
  }

  if (!PerformanceObserver.supportedEntryTypes.includes("resource")) return

  try {
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as ExtendedResourceTiming

        // ── Slow images ────────────────────────────────────────────────────
        if (entry.initiatorType === "img" && entry.duration >= slowImageMs) {
          const rating = ratingForMs(entry.duration, slowImageMs, POOR_IMAGE_MS)
          captureLog(
            `slow_image: ${Math.round(entry.duration)}ms ${entry.name}`,
            levelForRating(rating),
            {
              kind: "slow_image",
              url: entry.name,
              durationMs: Math.round(entry.duration),
              transferSizeKb: entry.transferSize > 0 ? Math.round(entry.transferSize / 1024) : undefined,
              rating,
              pathname,
            },
          )
        }

        // ── Oversized images (large transfer) ─────────────────────────────
        if (entry.initiatorType === "img" && entry.transferSize > oversizedBytes) {
          captureLog(
            `oversized_image: ${Math.round(entry.transferSize / 1024)}KB ${entry.name}`,
            "warn",
            {
              kind: "oversized_image",
              url: entry.name,
              transferSizeKb: Math.round(entry.transferSize / 1024),
              transferSizeBytes: entry.transferSize,
              pathname,
            },
          )
        }

        // ── Render-blocking resources (Chrome 107+) ───────────────────────
        if (
          entry.renderBlockingStatus === "blocking" &&
          entry.duration > 100
        ) {
          captureLog(
            `render_blocking: ${Math.round(entry.duration)}ms ${entry.name}`,
            entry.duration > 500 ? "error" : "warn",
            {
              kind: "render_blocking",
              url: entry.name,
              resourceType: entry.initiatorType,
              durationMs: Math.round(entry.duration),
              pathname,
            },
          )
        }

        // ── Slow fetch / XHR ──────────────────────────────────────────────
        if (
          (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") &&
          entry.duration >= slowFetchMs
        ) {
          const rating = ratingForMs(entry.duration, slowFetchMs, POOR_FETCH_MS)
          captureLog(
            `slow_fetch: ${Math.round(entry.duration)}ms ${entry.name}`,
            levelForRating(rating),
            {
              kind: "slow_fetch",
              url: entry.name,
              durationMs: Math.round(entry.duration),
              rating,
              pathname,
            },
          )
        }

        // ── Third-party impact tracking ───────────────────────────────────
        try {
          const entryHost = new URL(entry.name).hostname
          if (entryHost && entryHost !== location.hostname) {
            const existing = thirdPartyTotals.get(entryHost) ?? { durationMs: 0, scriptMs: 0, count: 0 }
            existing.durationMs += entry.duration
            existing.count += 1
            if (entry.initiatorType === "script") existing.scriptMs += entry.duration
            thirdPartyTotals.set(entryHost, existing)

            // Debounce flush: report third-party totals 3s after last resource
            if (thirdPartyFlushTimer) clearTimeout(thirdPartyFlushTimer)
            thirdPartyFlushTimer = setTimeout(flushThirdParty, 3000)
          }
        } catch {
          // Opaque cross-origin URL or relative URL — skip
        }
      }
    }).observe({ type: "resource", buffered: true })
  } catch {
    // resource observer not available
  }
}
