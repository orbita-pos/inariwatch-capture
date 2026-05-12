import { captureLog } from "../client.js"

export function installBrokenResources(): void {
  if (typeof window === "undefined") return

  window.addEventListener(
    "error",
    (e: ErrorEvent) => {
      const target = e.target
      // Only handle resource load errors, not JS runtime errors
      if (!target || target === window) return

      if (target instanceof HTMLImageElement && target.src) {
        captureLog(`broken_image: ${target.src}`, "warn", {
          kind: "broken_resource",
          resourceType: "image",
          url: target.src,
          element: target.id ? `img#${target.id}` : target.alt ? `img[alt="${target.alt}"]` : "img",
        })
      } else if (target instanceof HTMLScriptElement && target.src) {
        captureLog(`broken_script: ${target.src}`, "error", {
          kind: "broken_resource",
          resourceType: "script",
          url: target.src,
          element: target.id ? `script#${target.id}` : "script",
        })
      } else if (
        target instanceof HTMLLinkElement &&
        target.href &&
        target.rel === "stylesheet"
      ) {
        captureLog(`broken_stylesheet: ${target.href}`, "warn", {
          kind: "broken_resource",
          resourceType: "stylesheet",
          url: target.href,
          element: target.id ? `link#${target.id}` : "link[rel=stylesheet]",
        })
      }
    },
    { capture: true, passive: true },
  )
}
