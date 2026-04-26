/**
 * @inariwatch/capture-feedback — user feedback widget for @inariwatch/capture.
 *
 * Floating button → modal with description + email + optional screenshot.
 * Screenshot uses the browser's native Screen Capture API (no html2canvas,
 * no node_modules bloat). User approves a native dialog before anything is
 * captured — no silent screenshot ever.
 *
 * Usage:
 *   import { init } from "../types.js"
 *   import { feedbackIntegration } from "@inariwatch/capture-feedback"
 *
 *   init({
 *     dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
 *     integrations: [feedbackIntegration({ position: "bottom-right" })],
 *   })
 */

import type { Integration, CaptureConfig } from "../types.js"
import { captureLog } from "../client.js"
import { mountFeedbackWidget, type WidgetOptions, type FeedbackPayload } from "./widget.js"

export type { WidgetOptions, FeedbackPayload } from "./widget.js"

export interface FeedbackOptions extends WidgetOptions {
  /** Custom callback invoked on submit. Runs BEFORE the default captureLog send — return `false` to skip default send. */
  onSubmit?: (payload: FeedbackPayload) => boolean | void
}

/**
 * Create a feedback integration. Pass to `init({ integrations: [...] })`.
 *
 * No-ops on the server (renders into DOM). Safe to import from isomorphic
 * code paths.
 */
export function feedbackIntegration(options: FeedbackOptions = {}): Integration {
  return {
    name: "Feedback",
    setup(config: CaptureConfig) {
      if (typeof window === "undefined") return
      if (typeof document === "undefined") return

      const mount = () => {
        mountFeedbackWidget(options, (payload) => {
          // User-supplied hook runs first and can opt out of the default send
          let shouldSend = true
          if (options.onSubmit) {
            try {
              const result = options.onSubmit(payload)
              if (result === false) shouldSend = false
            } catch (err) {
              if (config.debug && !config.silent) {
                console.warn("[@inariwatch/capture-feedback] onSubmit hook threw:", err)
              }
            }
          }
          if (!shouldSend) return

          try {
            // Feedback lands in the same stream as errors — shows up in the
            // dashboard under the "info" tab so ops teams can triage it.
            captureLog(`feedback: ${payload.description.slice(0, 80)}`, "info", {
              kind: "user_feedback",
              description: payload.description,
              email: payload.email || undefined,
              url: payload.url,
              userAgent: payload.userAgent,
              viewport: payload.viewport,
              hasScreenshot: !!payload.screenshot,
              screenshot: payload.screenshot,
            })
          } catch (err) {
            if (config.debug && !config.silent) {
              console.warn("[@inariwatch/capture-feedback] captureLog failed:", err)
            }
          }
        })
      }

      // Mount after DOMContentLoaded so the widget appears even if this ran
      // during SSR hydration before the body is fully interactive.
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mount, { once: true })
      } else {
        mount()
      }
    },
  }
}
