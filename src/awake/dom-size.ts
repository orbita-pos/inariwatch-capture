import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"
import { getPathname } from "./utils.js"
import { NAVIGATION_EVENT } from "./spa-routing.js"

const DEFAULT_WARN = 800
const DEFAULT_CRITICAL = 1400

function measure(config: AwakeConfig): void {
  const count = document.querySelectorAll("*").length
  const warnAt = config.domSizeWarn ?? DEFAULT_WARN
  const criticalAt = config.domSizeCritical ?? DEFAULT_CRITICAL

  if (count < warnAt) return

  const rating = count >= criticalAt ? "critical" : "warning"
  captureLog(
    `dom_size: ${count} nodes`,
    count >= criticalAt ? "error" : "warn",
    {
      kind: "dom_size",
      nodeCount: count,
      rating,
      pathname: getPathname(config),
      url: location.href,
    },
  )
}

export function checkDomSize(config: AwakeConfig): void {
  if (typeof window === "undefined") return

  // Check on install (page initial load)
  if (document.readyState === "complete") {
    measure(config)
  } else {
    window.addEventListener("load", () => measure(config), { once: true })
  }

  // Re-check after each SPA navigation — DOM often grows in SPAs
  window.addEventListener(NAVIGATION_EVENT, () => measure(config))
}
