import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"
import { getPathname, ratingForMs, levelForRating } from "./utils.js"

const DEFAULT_SLOW_MS = 1000
const POOR_MS = 3000
// Emitted so other modules (memory-leak, dom-size) can react to navigation
export const NAVIGATION_EVENT = "inari:navigation"

export function installSpaRouting(config: AwakeConfig): void {
  if (typeof window === "undefined" || !window.history) return

  const slowMs = config.slowRouteMs ?? DEFAULT_SLOW_MS
  let routeStart: number | null = null
  let routeFrom: string | null = null
  let settlingTimer: ReturnType<typeof setTimeout> | null = null

  function startRoute(): void {
    routeStart = performance.now()
    routeFrom = location.pathname
  }

  function scheduleRouteEnd(): void {
    if (settlingTimer) clearTimeout(settlingTimer)
    // Wait for DOM to settle: check 500ms after navigation dispatch
    settlingTimer = setTimeout(() => {
      const to = location.pathname
      if (routeStart === null) return
      const durationMs = Math.round(performance.now() - routeStart)
      routeStart = null

      window.dispatchEvent(
        new CustomEvent(NAVIGATION_EVENT, {
          detail: { from: routeFrom, to, durationMs },
        }),
      )

      if (durationMs < slowMs) return

      const rating = ratingForMs(durationMs, slowMs, POOR_MS)
      captureLog(
        `slow_route: ${durationMs}ms ${routeFrom ?? "?"} → ${to}`,
        levelForRating(rating),
        {
          kind: "spa_route",
          from: routeFrom,
          to,
          durationMs,
          rating,
          pathname: getPathname(config),
        },
      )
    }, 500)
  }

  const origPush = history.pushState.bind(history)
  const origReplace = history.replaceState.bind(history)

  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    startRoute()
    origPush(...args)
    scheduleRouteEnd()
  }

  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    startRoute()
    origReplace(...args)
    scheduleRouteEnd()
  }

  window.addEventListener("popstate", () => {
    startRoute()
    scheduleRouteEnd()
  })
}
