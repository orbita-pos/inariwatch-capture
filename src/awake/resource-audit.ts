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

// Hard flush cadence for third-party impact aggregation. The previous
// implementation used a 3s debounce that reset on every resource — a
// chat app that loads assets every <3s never flushed its totals. A
// fixed 10s interval guarantees periodic flushes regardless of traffic
// pattern, plus an immediate flush on page hide / visibilitychange so
// totals reach the cloud before the session ends.
const THIRD_PARTY_FLUSH_INTERVAL_MS = 10_000
// Per-tab cap on slow_image / slow_fetch / oversized_image / render_blocking
// events. Without this cap, a render thrash producing 50+ entries each
// fires 50+ network sends. We keep the cap generous enough that real
// regressions still reach the cloud.
const RESOURCE_EVENT_CAP_PER_KIND = 25

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
  // Per-kind event counters for flood protection.
  const emittedCounts: Record<string, number> = {
    slow_image: 0,
    slow_fetch: 0,
    oversized_image: 0,
    render_blocking: 0,
  }
  function shouldEmit(kind: keyof typeof emittedCounts): boolean {
    if (emittedCounts[kind] >= RESOURCE_EVENT_CAP_PER_KIND) return false
    emittedCounts[kind]++
    return true
  }

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
    // Reset so the next interval reports DELTAS rather than ever-growing
    // monotonic totals. This matches what "impact in the last 10s" means
    // for an ops dashboard.
    thirdPartyTotals.clear()
  }

  if (!PerformanceObserver.supportedEntryTypes.includes("resource")) return

  try {
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as ExtendedResourceTiming

        // ── Slow images ────────────────────────────────────────────────────
        if (entry.initiatorType === "img" && entry.duration >= slowImageMs && shouldEmit("slow_image")) {
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
        if (entry.initiatorType === "img" && entry.transferSize > oversizedBytes && shouldEmit("oversized_image")) {
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
          entry.duration > 100 &&
          shouldEmit("render_blocking")
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
          entry.duration >= slowFetchMs &&
          shouldEmit("slow_fetch")
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
          }
        } catch {
          // Opaque cross-origin URL or relative URL — skip
        }
      }
    }).observe({ type: "resource", buffered: true })
  } catch {
    // resource observer not available
    return
  }

  // ── Hard-interval flush + lifecycle hooks ───────────────────────────────
  const flushTimer = setInterval(flushThirdParty, THIRD_PARTY_FLUSH_INTERVAL_MS)
  const flushOnHidden = (): void => {
    if (document.visibilityState === "hidden") flushThirdParty()
  }
  document.addEventListener("visibilitychange", flushOnHidden)
  window.addEventListener("pagehide", flushThirdParty, { once: true })

  // Expose teardown for tests / unmount. Idempotent.
  ;(window as unknown as { __inariwatchAwakeTeardownResourceAudit?: () => void })
    .__inariwatchAwakeTeardownResourceAudit = () => {
      clearInterval(flushTimer)
      document.removeEventListener("visibilitychange", flushOnHidden)
    }
}
