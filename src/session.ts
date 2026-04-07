/**
 * Browser session recording via rrweb.
 *
 * Records DOM interactions (clicks, inputs, navigation) in a ring buffer.
 * On error, the buffer is flushed and attached to the error event as sessionEvents.
 *
 * rrweb is loaded dynamically (optional peer dependency) — the SDK stays zero-deps
 * for Node.js users who don't need browser recording.
 */

import type { SessionConfig, SessionEvent, CaptureConfig } from "./types.js"

const MAX_EVENTS = 200
const MAX_SECONDS = 60

let sessionBuffer: SessionEvent[] = []
let sessionActive = false

// ── CSS Selector Computation ────────────────────────────────────────────────

function computeSelector(element: Element): string {
  // 1. data-testid (most stable for React/testing-library apps)
  const testId = element.getAttribute("data-testid")
  if (testId) return `[data-testid="${testId}"]`

  // 2. id (skip dynamic-looking UUIDs)
  if (element.id && !/^[a-f0-9-]{20,}$/i.test(element.id)) {
    return `#${CSS.escape(element.id)}`
  }

  // 3. aria-label (truncate to prevent oversized selectors)
  const ariaLabel = element.getAttribute("aria-label")
  if (ariaLabel && ariaLabel.length <= 50) return `[aria-label="${CSS.escape(ariaLabel)}"]`

  // 4. Fallback: tag + nth-child ancestor chain
  const parts: string[] = []
  let el: Element | null = element
  while (el && el !== document.body && parts.length < 5) {
    let selector = el.tagName.toLowerCase()
    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter(
        (c) => c.tagName === el!.tagName
      )
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1
        selector += `:nth-child(${index})`
      }
    }
    parts.unshift(selector)
    el = el.parentElement
  }
  return parts.join(" > ")
}

// ── Ring Buffer ─────────────────────────────────────────────────────────────

function pushEvent(event: SessionEvent, maxEvents: number, maxSeconds: number) {
  sessionBuffer.push(event)

  // Evict by count
  while (sessionBuffer.length > maxEvents) {
    sessionBuffer.shift()
  }

  // Evict by age
  const cutoff = Date.now() - maxSeconds * 1000
  while (sessionBuffer.length > 0 && sessionBuffer[0].timestamp < cutoff) {
    sessionBuffer.shift()
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Returns current session events (called during error flush). */
export function getSessionEvents(): SessionEvent[] {
  return [...sessionBuffer]
}

/** Initialize session recording. Browser-only — no-ops in Node.js. */
export async function initSession(
  config: SessionConfig,
  captureConfig: CaptureConfig
): Promise<void> {
  if (typeof window === "undefined") return
  if (sessionActive) return

  const maxEvents = config.maxEvents ?? MAX_EVENTS
  const maxSeconds = config.maxSeconds ?? MAX_SECONDS
  const redactSelectors = config.redactSelectors ?? []
  const maskAllInputs = config.maskAllInputs ?? false

  try {
    // Dynamic import — rrweb is an optional peer dependency
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = "rrweb"
    const rrweb: any = await import(/* webpackIgnore: true */ pkg)
    const record = rrweb.record || rrweb.default?.record

    if (!record) {
      if (!captureConfig.silent) {
        console.warn("[@inariwatch/capture] session: true but rrweb.record not found.")
      }
      return
    }

    // Build mask selectors
    const sensitiveSelectors = [
      'input[type="password"]',
      'input[type="credit-card"]',
      'input[name*="card"]',
      'input[name*="cvv"]',
      'input[name*="ssn"]',
      ...redactSelectors,
    ].join(", ")

    record({
      // Mask sensitive inputs
      maskInputOptions: {
        password: true,
        ...(maskAllInputs ? { text: true, textarea: true, select: true } : {}),
      },
      maskTextSelector: sensitiveSelectors,

      // Event handler — extract actionable events and enrich with selectors
      async emit(rrwebEvent: Record<string, unknown>) {
        // rrweb event types: 0=DomContentLoaded, 1=Load, 2=FullSnapshot,
        // 3=IncrementalSnapshot, 4=Meta, 5=Custom
        const eventType = rrwebEvent.type as number
        const data = rrwebEvent.data as Record<string, unknown> | undefined

        if (eventType === 4) {
          // Meta event — navigation (scrub sensitive query params from URL)
          const href = (data?.href as string) ?? ""
          if (href) {
            const { scrubUrl } = await import("./breadcrumbs.js")
            pushEvent({
              timestamp: Date.now(),
              type: "navigation",
              url: scrubUrl ? scrubUrl(href) : href,
              rrwebEvent,
            }, maxEvents, maxSeconds)
          }
          return
        }

        if (eventType !== 3 || !data) return // Only IncrementalSnapshot

        const source = data.source as number
        // source 2 = MouseInteraction
        if (source === 2) {
          const interactionType = data.type as number
          // type 2 = click, 0 = mouseup, 1 = mousedown
          if (interactionType !== 2) return // Only clicks

          const targetId = data.id as number
          const targetNode = record.mirror?.getNode?.(targetId)
          const selector = targetNode instanceof Element
            ? computeSelector(targetNode)
            : `[data-rrweb-id="${targetId}"]`

          pushEvent({
            timestamp: Date.now(),
            type: "click",
            selector,
            rrwebEvent,
          }, maxEvents, maxSeconds)
        }

        // source 5 = Input
        if (source === 5) {
          const targetId = data.id as number
          let value = (data.text as string) ?? ""

          const targetNode = record.mirror?.getNode?.(targetId)
          const selector = targetNode instanceof Element
            ? computeSelector(targetNode)
            : `[data-rrweb-id="${targetId}"]`

          // Redact password and other sensitive input values (card, cvv, ssn, etc.)
          if (
            (targetNode instanceof HTMLInputElement && targetNode.type === "password") ||
            (targetNode instanceof Element && targetNode.matches(sensitiveSelectors))
          ) {
            value = "[REDACTED]"
          }

          pushEvent({
            timestamp: Date.now(),
            type: "input",
            selector,
            value,
            rrwebEvent,
          }, maxEvents, maxSeconds)
        }
      },
    })

    sessionActive = true
    if (!captureConfig.silent && captureConfig.debug) {
      console.warn("[@inariwatch/capture] Session recording active (rrweb ring buffer)")
    }
  } catch {
    if (!captureConfig.silent) {
      console.warn(
        "[@inariwatch/capture] session: true but rrweb not installed. Run: npm install rrweb"
      )
    }
  }
}
