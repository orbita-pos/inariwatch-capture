import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"
import { elSelector, getPathname } from "./utils.js"

const DEFAULT_RAGE_COUNT = 3
const DEFAULT_RAGE_MS = 1000
const DEFAULT_RAGE_RADIUS = 20
const DEFAULT_DEAD_MS = 3000

interface ClickRecord {
  x: number
  y: number
  el: Element
  ts: number
}

/**
 * Pending dead-click candidate. A click on an interactive element starts
 * one; the persistent MutationObserver below clears the `mutated=false`
 * flag if any DOM change lands during the dead-window. After deadMs we
 * decide based on the flag.
 */
interface PendingDeadCheck {
  el: Element
  ts: number
  mutated: boolean
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (["a", "button", "input", "select", "textarea", "label"].includes(tag)) return true
  if (el.getAttribute("role") === "button") return true
  if (el.getAttribute("tabindex") !== null) return true
  // Walk up to 3 ancestors
  let parent = el.parentElement
  let depth = 0
  while (parent && depth < 3) {
    const ptag = parent.tagName.toLowerCase()
    if (["a", "button"].includes(ptag)) return true
    parent = parent.parentElement
    depth++
  }
  return false
}

export function installRageClicks(config: AwakeConfig): void {
  if (typeof window === "undefined") return

  const rageCount = config.rageClickCount ?? DEFAULT_RAGE_COUNT
  const rageMs = config.rageClickMs ?? DEFAULT_RAGE_MS
  const rageRadius = config.rageClickRadiusPx ?? DEFAULT_RAGE_RADIUS
  const deadMs = config.deadClickMs ?? DEFAULT_DEAD_MS
  const pathname = getPathname(config)

  const clicks: ClickRecord[] = []
  let lastRageTs = 0

  // ── ONE persistent MutationObserver shared across all dead-click checks
  // ──────────────────────────────────────────────────────────────────────
  // The previous implementation installed a fresh observer per click with
  // `subtree:true` over the whole body. Modern SPAs mutate the body
  // continuously (animations, Intercom widgets, etc.) so `mutated` flipped
  // to `true` near 100% of the time and dead-clicks were never reported.
  //
  // Instead we keep a single observer running and tick a sticky
  // `mutationTs` on every change. A click is "dead" iff no mutation
  // happened in the deadMs window AFTER the click.
  const pending: PendingDeadCheck[] = []
  let lastMutationTs = 0

  const observer = new MutationObserver(() => {
    lastMutationTs = Date.now()
    // Mark any pending dead-click checks whose window has been touched
    // by this mutation batch.
    for (const p of pending) {
      if (lastMutationTs > p.ts) p.mutated = true
    }
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "disabled"],
  })

  // Optional teardown for tests / unmount scenarios. Idempotent.
  const teardown = (): void => observer.disconnect()
  ;(window as unknown as { __inariwatchAwakeTeardownRageClicks?: () => void })
    .__inariwatchAwakeTeardownRageClicks = teardown

  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      const { clientX: x, clientY: y } = e
      const el = e.target as Element
      const ts = Date.now()

      clicks.push({ x, y, el, ts })
      // Keep last 8 clicks
      if (clicks.length > 8) clicks.shift()

      // ── Rage click: 3+ clicks within window, within radius ──────────────
      const recent = clicks.filter(c => ts - c.ts <= rageMs)
      if (recent.length >= rageCount) {
        const cluster = recent.filter(
          c => Math.hypot(c.x - x, c.y - y) <= rageRadius,
        )
        if (cluster.length >= rageCount && ts - lastRageTs > 2000) {
          lastRageTs = ts
          captureLog(
            `rage_click: ${cluster.length}x on ${elSelector(el)}`,
            "warn",
            {
              kind: "rage_click",
              clickCount: cluster.length,
              timespanMs: ts - (cluster[0]?.ts ?? ts),
              element: elSelector(el),
              url: location.href,
              pathname,
            },
          )
        }
      }

      // ── Dead click: interactive element, no DOM mutation in window ──────
      // We seed `mutated` from `lastMutationTs > ts` (already-fired mutations
      // immediately after the click frame count) and let the shared observer
      // flip it later.
      if (isInteractive(el)) {
        const entry: PendingDeadCheck = { el, ts, mutated: lastMutationTs >= ts }
        pending.push(entry)

        setTimeout(() => {
          const idx = pending.indexOf(entry)
          if (idx >= 0) pending.splice(idx, 1)
          if (!entry.mutated) {
            captureLog(
              `dead_click: ${elSelector(el)}`,
              "warn",
              {
                kind: "dead_click",
                element: elSelector(el),
                url: location.href,
                pathname,
              },
            )
          }
        }, deadMs)
      }
    },
    { passive: true },
  )

  // Clean up observer on page hide / BFCache freeze. Capture's other
  // detectors share this same cleanup path (see installAwake's pagehide
  // listener once it's wired in).
  window.addEventListener("pagehide", teardown, { once: true })
}
