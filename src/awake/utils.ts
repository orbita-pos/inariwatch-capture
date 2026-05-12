import type { AwakeConfig } from "../types.js"

/** Short CSS selector for an element — best-effort, not guaranteed unique. */
export function elSelector(el: Element): string {
  if (el.id) return `#${el.id}`
  const tag = el.tagName.toLowerCase()
  const classes = Array.from(el.classList).slice(0, 2).map(c => `.${c}`).join("")
  return `${tag}${classes}`
}

/** Apply optional pathname redaction from AwakeConfig. */
export function getPathname(config: AwakeConfig): string | undefined {
  if (typeof window === "undefined") return undefined
  const raw = location.pathname
  const r = config.redactPathname
  if (!r) return raw
  if (typeof r === "function") return r(raw)
  return "[redacted]"
}

/** Schedule work during browser idle time (with a 5-second deadline). */
export function onIdle(cb: () => void): void {
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(cb, { timeout: 5000 })
  } else {
    setTimeout(cb, 1000)
  }
}

export function ratingForMs(
  ms: number,
  goodThreshold: number,
  poorThreshold: number,
): "good" | "needs-improvement" | "poor" {
  if (ms < goodThreshold) return "good"
  if (ms < poorThreshold) return "needs-improvement"
  return "poor"
}

export function levelForRating(rating: "good" | "needs-improvement" | "poor"): "info" | "warn" | "error" {
  if (rating === "good") return "info"
  if (rating === "needs-improvement") return "warn"
  return "error"
}

export function meetsMinRating(
  rating: "good" | "needs-improvement" | "poor",
  min: "good" | "needs-improvement" | "poor",
): boolean {
  const order = { good: 0, "needs-improvement": 1, poor: 2 }
  return order[rating] >= order[min]
}
