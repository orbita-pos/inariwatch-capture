import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"
import { getPathname, meetsMinRating } from "./utils.js"

// web-vitals v4 attribution types (subset)
interface WebVitalMetric {
  name: string
  value: number
  rating: "good" | "needs-improvement" | "poor"
  delta: number
  id: string
  navigationType: string
}

interface LCPAttribution {
  element?: string
  url?: string
  timeToFirstByte?: number
  resourceLoadDelay?: number
  resourceLoadDuration?: number
  elementRenderDelay?: number
}

interface INPAttribution {
  interactionTarget?: string
  interactionType?: string
  inputDelay?: number
  processingDuration?: number
  presentationDelay?: number
}

interface CLSAttribution {
  largestShiftTarget?: string
  largestShiftValue?: number
  loadState?: string
}

interface TTFBAttribution {
  waitingDuration?: number
  cacheDuration?: number
  dnsDuration?: number
  connectionDuration?: number
  requestDuration?: number
}

interface LCPMetric extends WebVitalMetric { attribution: LCPAttribution }
interface INPMetric extends WebVitalMetric { attribution: INPAttribution }
interface CLSMetric extends WebVitalMetric { attribution: CLSAttribution }
interface TTFBMetric extends WebVitalMetric { attribution: TTFBAttribution }
interface FCPAttribution { timeToFirstByte?: number; firstByteToFCP?: number; loadState?: string }
interface FCPMetric extends WebVitalMetric { attribution: FCPAttribution }

let installed = false

export function installWebVitals(config: AwakeConfig): void {
  if (typeof window === "undefined") return
  if (installed) return
  installed = true

  const minRating = config.minRating ?? "needs-improvement"
  const pathname = getPathname(config)

  void (async () => {
    try {
      const wv = await import("web-vitals/attribution")

      wv.onLCP((metric: LCPMetric) => {
        if (!meetsMinRating(metric.rating, minRating)) return
        captureLog(
          `vitals.lcp: ${Math.round(metric.value)}ms`,
          metric.rating === "poor" ? "error" : "warn",
          {
            kind: "web_vital",
            metric: "LCP",
            valueMs: Math.round(metric.value),
            rating: metric.rating,
            delta: metric.delta,
            id: metric.id,
            navigationType: metric.navigationType,
            pathname,
            attribution: {
              element: metric.attribution.element,
              url: metric.attribution.url,
              timeToFirstByteMs: metric.attribution.timeToFirstByte,
              resourceLoadDurationMs: metric.attribution.resourceLoadDuration,
              elementRenderDelayMs: metric.attribution.elementRenderDelay,
            },
          },
        )
      })

      wv.onINP((metric: INPMetric) => {
        if (!meetsMinRating(metric.rating, minRating)) return
        captureLog(
          `vitals.inp: ${Math.round(metric.value)}ms`,
          metric.rating === "poor" ? "error" : "warn",
          {
            kind: "web_vital",
            metric: "INP",
            valueMs: Math.round(metric.value),
            rating: metric.rating,
            delta: metric.delta,
            id: metric.id,
            navigationType: metric.navigationType,
            pathname,
            attribution: {
              interactionTarget: metric.attribution.interactionTarget,
              interactionType: metric.attribution.interactionType,
              inputDelayMs: metric.attribution.inputDelay,
              processingDurationMs: metric.attribution.processingDuration,
              presentationDelayMs: metric.attribution.presentationDelay,
            },
          },
        )
      })

      wv.onCLS((metric: CLSMetric) => {
        if (!meetsMinRating(metric.rating, minRating)) return
        captureLog(
          `vitals.cls: ${metric.value.toFixed(3)}`,
          metric.rating === "poor" ? "error" : "warn",
          {
            kind: "web_vital",
            metric: "CLS",
            value: metric.value,
            rating: metric.rating,
            delta: metric.delta,
            id: metric.id,
            navigationType: metric.navigationType,
            pathname,
            attribution: {
              largestShiftTarget: metric.attribution.largestShiftTarget,
              largestShiftValue: metric.attribution.largestShiftValue,
              loadState: metric.attribution.loadState,
            },
          },
        )
      })

      wv.onTTFB((metric: TTFBMetric) => {
        if (!meetsMinRating(metric.rating, minRating)) return
        captureLog(
          `vitals.ttfb: ${Math.round(metric.value)}ms`,
          metric.rating === "poor" ? "error" : "warn",
          {
            kind: "web_vital",
            metric: "TTFB",
            valueMs: Math.round(metric.value),
            rating: metric.rating,
            delta: metric.delta,
            id: metric.id,
            navigationType: metric.navigationType,
            pathname,
            attribution: {
              waitingDurationMs: metric.attribution.waitingDuration,
              dnsDurationMs: metric.attribution.dnsDuration,
              connectionDurationMs: metric.attribution.connectionDuration,
              requestDurationMs: metric.attribution.requestDuration,
            },
          },
        )
      })

      wv.onFCP((metric: FCPMetric) => {
        if (!meetsMinRating(metric.rating, minRating)) return
        captureLog(
          `vitals.fcp: ${Math.round(metric.value)}ms`,
          metric.rating === "poor" ? "error" : "warn",
          {
            kind: "web_vital",
            metric: "FCP",
            valueMs: Math.round(metric.value),
            rating: metric.rating,
            delta: metric.delta,
            id: metric.id,
            navigationType: metric.navigationType,
            pathname,
          },
        )
      })
    } catch {
      // web-vitals not installed — skip silently. Install with: npm i web-vitals
    }
  })()
}
