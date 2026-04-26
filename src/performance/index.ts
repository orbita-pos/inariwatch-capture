/**
 * @inariwatch/capture-performance — Web Vitals integration for @inariwatch/capture.
 *
 * Measures the five Core Web Vitals Google actually ranks on in 2026:
 *   • LCP  — Largest Contentful Paint
 *   • INP  — Interaction to Next Paint (replaced FID in 2024)
 *   • CLS  — Cumulative Layout Shift
 *   • FCP  — First Contentful Paint
 *   • TTFB — Time to First Byte
 *
 * Each metric is reported once per page load (rating: good/needs-improvement/poor).
 * Forwarded to InariWatch via `captureLog` so it lands in the same alert stream
 * as errors — no separate ingestion endpoint needed.
 *
 * Usage:
 *   import { init } from "../types.js"
 *   import { performanceIntegration } from "@inariwatch/capture-performance"
 *
 *   init({
 *     dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
 *     integrations: [performanceIntegration()],
 *   })
 */

import type { Integration, CaptureConfig } from "../types.js"
import { captureLog } from "../client.js"

export interface PerformanceOptions {
  /**
   * Which metrics to collect. Omit a metric to skip its observer entirely —
   * cheaper than letting it fire and ignoring the result.
   */
  metrics?: Array<"LCP" | "INP" | "CLS" | "FCP" | "TTFB">
  /**
   * Only report metrics whose rating is at or above this level. Defaults to
   * `"needs-improvement"` so you aren't spammed with good-performance noise.
   *   - `"good"`               — report everything
   *   - `"needs-improvement"`  — skip metrics rated `good` (default)
   *   - `"poor"`               — only report poor-rated metrics
   */
  minRating?: "good" | "needs-improvement" | "poor"
  /**
   * Custom callback invoked for every reported metric. Useful for piping
   * metrics into your own analytics on top of InariWatch.
   */
  onMetric?: (metric: PerformanceMetric) => void
  /**
   * Include `location.pathname` in the metric metadata. Enabled by default
   * because per-route performance is usually what you want. Disable if your
   * app uses sensitive path tokens (magic-link URLs, password-reset flows,
   * user-id-in-path) you don't want leaving the browser.
   *
   * You can also pass a redactor to keep per-route grouping while stripping
   * dynamic segments: `redactPathname: (p) => p.replace(/\/[a-f0-9-]{36}/g, "/:id")`.
   */
  includePathname?: boolean
  /** Custom pathname redactor. Overrides `includePathname: true` default passthrough. */
  redactPathname?: (pathname: string) => string
}

export interface PerformanceMetric {
  name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB"
  value: number
  rating: "good" | "needs-improvement" | "poor"
  /** First paint / first input delta used for the metric calculation. */
  delta: number
  id: string
  /** Navigation type that produced this metric — "navigate", "reload", etc. */
  navigationType: string
}

const DEFAULT_METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const

const RATING_ORDER: Record<NonNullable<PerformanceOptions["minRating"]>, number> = {
  good: 0,
  "needs-improvement": 1,
  poor: 2,
}

function meetsThreshold(rating: string, min: NonNullable<PerformanceOptions["minRating"]>): boolean {
  const r = RATING_ORDER[rating as keyof typeof RATING_ORDER]
  if (r === undefined) return true
  return r >= RATING_ORDER[min]
}

/**
 * Create a performance integration. Pass to `init({ integrations: [...] })`.
 *
 * No-ops on the server (web-vitals is browser-only). Safe to import from
 * isomorphic code paths.
 */
export function performanceIntegration(options: PerformanceOptions = {}): Integration {
  return {
    name: "Performance",
    setup(config: CaptureConfig) {
      if (typeof window === "undefined") return

      const metricsToObserve = options.metrics ?? DEFAULT_METRICS
      const minRating: NonNullable<PerformanceOptions["minRating"]> = options.minRating ?? "needs-improvement"

      // Dynamic import keeps web-vitals (~3 KB) out of apps that don't install
      // this integration. Fire and forget — if web-vitals fails to load we
      // don't block the rest of capture.
      void (async () => {
        try {
          const webVitals = await import("web-vitals")

          const register = (name: PerformanceMetric["name"], fn: (cb: (m: WebVitalMetric) => void) => void) => {
            if (!metricsToObserve.includes(name)) return
            fn((metric) => {
              if (!meetsThreshold(metric.rating, minRating)) return
              const payload: PerformanceMetric = {
                name,
                value: metric.value,
                rating: metric.rating,
                delta: metric.delta,
                id: metric.id,
                navigationType: metric.navigationType,
              }
              report(payload, config, options)
            })
          }

          register("LCP", webVitals.onLCP)
          register("INP", webVitals.onINP)
          register("CLS", webVitals.onCLS)
          register("FCP", webVitals.onFCP)
          register("TTFB", webVitals.onTTFB)
        } catch (err) {
          if (config.debug && !config.silent) {
            console.warn("[@inariwatch/capture-performance] web-vitals failed to load:", err instanceof Error ? err.message : err)
          }
        }
      })()
    },
  }
}

interface WebVitalMetric {
  value: number
  rating: "good" | "needs-improvement" | "poor"
  delta: number
  id: string
  navigationType: string
}

/**
 * Forward a metric to InariWatch as a structured log event. Log level
 * follows the rating so dashboards can filter:
 *   good → info, needs-improvement → warn, poor → error.
 */
function report(
  metric: PerformanceMetric,
  config: CaptureConfig,
  options: PerformanceOptions,
): void {
  try {
    if (options.onMetric) options.onMetric(metric)
  } catch {
    // User callbacks shouldn't break metric reporting
  }

  const level: "info" | "warn" | "error" =
    metric.rating === "good" ? "info" :
    metric.rating === "poor" ? "error" : "warn"

  const title = `vitals.${metric.name.toLowerCase()}: ${Math.round(metric.value)}${metric.name === "CLS" ? "" : "ms"}`

  // Pathname emission — opt out or redact for apps that put sensitive tokens
  // into URL paths (magic links, password resets). Default includes the raw
  // pathname because per-route grouping is the usual reason to use this.
  const includePathname = options.includePathname !== false
  let pathname: string | undefined
  if (includePathname && typeof location !== "undefined") {
    const raw = location.pathname
    pathname = options.redactPathname ? options.redactPathname(raw) : raw
  }

  try {
    captureLog(title, level, {
      kind: "web_vitals",
      metric: metric.name,
      value: metric.value,
      rating: metric.rating,
      delta: metric.delta,
      id: metric.id,
      navigationType: metric.navigationType,
      pathname,
    })
  } catch (err) {
    if (config.debug && !config.silent) {
      console.warn("[@inariwatch/capture-performance] captureLog failed:", err instanceof Error ? err.message : err)
    }
  }
}
