import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"
import { getPathname, ratingForMs, levelForRating } from "./utils.js"

const DEFAULT_SLOW_MS = 1000
const POOR_MS = 3000
// Emitted so other modules (memory-leak, dom-size) can react to navigation
export const NAVIGATION_EVENT = "inari:navigation"

// Singleton marker so re-installing (e.g., HMR on Next App Router) doesn't
// double-wrap pushState/replaceState and ratchet the wrapper chain.
const INSTALLED_MARKER = "__inariwatchAwakeSpaRoutingInstalled" as const

interface HistoryWithMarker extends History {
  [INSTALLED_MARKER]?: true
}

export function installSpaRouting(config: AwakeConfig): void {
  if (typeof window === "undefined" || !window.history) return

  const hist = window.history as HistoryWithMarker
  if (hist[INSTALLED_MARKER]) {
    // Already installed in this realm — silently no-op so we don't add a
    // second wrapper that would re-fire NAVIGATION_EVENT.
    return
  }
  // Mark non-enumerable so feature-detection scripts don't trip over it.
  Object.defineProperty(hist, INSTALLED_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  })

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

  // ── Coexist with other libs that wrap pushState / replaceState ──────────
  // The previous implementation overwrote history.pushState directly and
  // never restored it, which clashed cumulatively with React Router /
  // Next Router / MUI / Sentry — whichever one ran LAST won, and earlier
  // wrappers either got skipped or re-applied themselves and chained.
  //
  // The pattern below captures the CURRENT implementation at install time
  // (which is whoever wrapped before us) and forwards to it after our
  // bookkeeping. This way every wrapper in the chain still runs, in the
  // order they installed, and the original native History.prototype
  // method is reachable via the chain head.
  const wrap = <K extends "pushState" | "replaceState">(method: K): void => {
    const current = hist[method].bind(hist)
    hist[method] = function (this: History, ...args: Parameters<History[K]>): void {
      startRoute()
      // Forward to whoever wrapped before us (or the native impl). Cast
      // is safe because we preserve the argument shape.
      ;(current as (...a: Parameters<History[K]>) => ReturnType<History[K]>)(...args)
      scheduleRouteEnd()
    } as History[K]
  }
  wrap("pushState")
  wrap("replaceState")

  window.addEventListener("popstate", () => {
    startRoute()
    scheduleRouteEnd()
  })
}
