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
  const rageFired = new WeakSet<Element>()
  let lastRageTs = 0

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

      // ── Dead click: interactive element, no DOM response in window ───────
      if (isInteractive(el) && !rageFired.has(el)) {
        const snapshot = document.body.children.length
        let mutated = false

        const obs = new MutationObserver(() => {
          mutated = true
          obs.disconnect()
        })
        obs.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "style", "hidden", "aria-hidden"],
        })

        setTimeout(() => {
          obs.disconnect()
          if (!mutated && document.body.children.length === snapshot) {
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
}
