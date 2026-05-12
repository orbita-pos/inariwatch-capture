import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"

// LoAF types — not in TS lib.dom as of TS 5.5
interface PerformanceScriptTiming extends PerformanceEntry {
  readonly invoker: string
  readonly invokerType: string
  readonly sourceURL: string
  readonly sourceFunctionName: string
  readonly sourceCharPosition: number
  readonly executionStart: DOMHighResTimeStamp
  readonly pauseDuration: DOMHighResTimeStamp
  readonly forcedStyleAndLayoutDuration: DOMHighResTimeStamp
}

interface PerformanceLongAnimationFrameTiming extends PerformanceEntry {
  readonly blockingDuration: DOMHighResTimeStamp
  readonly renderStart: DOMHighResTimeStamp
  readonly styleAndLayoutStart: DOMHighResTimeStamp
  readonly firstUIEventTimestamp: DOMHighResTimeStamp
  readonly scripts: ReadonlyArray<PerformanceScriptTiming>
}

const WARN_MS = 50
const POOR_MS = 200

function rateBlocking(ms: number): "needs-improvement" | "poor" {
  return ms >= POOR_MS ? "poor" : "needs-improvement"
}

export function installLoAF(config: AwakeConfig): void {
  if (typeof window === "undefined" || !("PerformanceObserver" in window)) return

  const minRating = config.minRating ?? "needs-improvement"
  const supported = PerformanceObserver.supportedEntryTypes

  if (supported.includes("long-animation-frame")) {
    try {
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as PerformanceLongAnimationFrameTiming
          const blockingMs = entry.blockingDuration

          if (blockingMs < WARN_MS) continue
          const rating = rateBlocking(blockingMs)
          if (minRating === "poor" && rating !== "poor") continue

          const scripts = Array.from(entry.scripts)
            .slice(0, 5)
            .map(s => ({
              invoker: s.invoker || undefined,
              invokerType: s.invokerType || undefined,
              sourceURL: s.sourceURL || undefined,
              sourceFunctionName: s.sourceFunctionName || undefined,
              durationMs: Math.round(s.duration),
              forcedLayoutMs: s.forcedStyleAndLayoutDuration > 1
                ? Math.round(s.forcedStyleAndLayoutDuration)
                : undefined,
            }))

          // Flag layout-thrashing scripts specifically
          const thrashingScript = scripts.find(s => (s.forcedLayoutMs ?? 0) > 30)

          captureLog(
            `loaf: ${Math.round(blockingMs)}ms blocking${thrashingScript ? " (layout thrash)" : ""}`,
            rating === "poor" ? "error" : "warn",
            {
              kind: "long_animation_frame",
              blockingDurationMs: Math.round(blockingMs),
              renderStartMs: Math.round(entry.renderStart),
              rating,
              scriptCount: entry.scripts.length,
              scripts,
              layoutThrash: thrashingScript
                ? { invoker: thrashingScript.invoker, forcedLayoutMs: thrashingScript.forcedLayoutMs }
                : undefined,
              url: location.href,
            },
          )
        }
      }).observe({ type: "long-animation-frame", buffered: true })
      return
    } catch {
      // Fall through to longtask
    }
  }

  // Fallback: Long Tasks API (Firefox, Safari, older Chrome)
  if (supported.includes("longtask")) {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < WARN_MS) continue
          const rating = rateBlocking(entry.duration)
          if (minRating === "poor" && rating !== "poor") continue

          captureLog(
            `long_task: ${Math.round(entry.duration)}ms`,
            rating === "poor" ? "error" : "warn",
            {
              kind: "long_task",
              durationMs: Math.round(entry.duration),
              rating,
              url: location.href,
            },
          )
        }
      }).observe({ type: "longtask", buffered: true })
    } catch {
      // longtask not available on this browser
    }
  }
}
