/**
 * Integration export — adapts the forensic hook (`registerForensicHook`)
 * into the `@inariwatch/capture` Integration shape so it can be consumed via:
 *
 *   import { init } from "../types.js"
 *   import { forensicIntegration } from "@inariwatch/node-forensic"
 *
 *   init({
 *     dsn: process.env.INARIWATCH_DSN,
 *     integrations: [forensicIntegration()],
 *   })
 *
 * The forensic peer ships `registerForensicHook` because the hook is also
 * useful outside the capture pipeline (eBPF stitching, custom forwarders).
 * The Integration adapter is opt-in glue that buffers captures from the
 * hook and attaches them to the matching event during `onBeforeSend`.
 *
 * Match heuristic: forensic captures buffer up to `bufferSize` entries and
 * are paired to events by stack-line alignment (top of stack === top of
 * event.body second line). Best score wins; the picked capture is removed.
 */

import type { ErrorEvent, Integration, SerializedValue, ForensicsCapture } from "../types.js"
import type { ForensicCapture, ForensicOptions, ForensicValue } from "./types.js"
import { registerForensicHook } from "./index.js"

const DEFAULT_BUFFER = 8

export interface ForensicIntegrationConfig extends ForensicOptions {
  /** Max captures buffered for matching. Default 8. */
  bufferSize?: number
}

let buffered: ForensicCapture[] = []
let registered = false
let bufferMax = DEFAULT_BUFFER

function valueToSerialized(v: ForensicValue): SerializedValue {
  return { type: "object", preview: v.repr, truncated: !!v.truncated }
}

function captureToForensicsField(c: ForensicCapture): ForensicsCapture {
  const locals: Record<string, Record<string, SerializedValue>> = {}
  const closureChains: Record<string, Record<string, SerializedValue>> = {}
  for (const f of c.frames) {
    if (f.locals.length > 0) {
      locals[String(f.index)] = Object.fromEntries(
        f.locals.map((l) => [l.name, valueToSerialized(l)] as const),
      )
    }
    if (f.closure.length > 0) {
      closureChains[String(f.index)] = Object.fromEntries(
        f.closure.map((cv) => [cv.name, valueToSerialized(cv)] as const),
      )
    }
  }
  return { locals, closureChains }
}

function matchScore(capture: ForensicCapture, event: ErrorEvent): number {
  const stack = capture.error.stack ?? ""
  const body = event.body ?? ""
  if (!stack || !body) return 1
  // First "at …" line of each stack — when both align, it's the same throw.
  const a = stack.split("\n")[1]?.trim() ?? ""
  const b = body.split("\n")[1]?.trim() ?? ""
  if (a && a === b) return 100
  if (a && body.includes(a)) return 50
  return 1
}

export function forensicIntegration(config: ForensicIntegrationConfig = {}): Integration {
  bufferMax = config.bufferSize ?? DEFAULT_BUFFER
  return {
    name: "@inariwatch/node-forensic",
    setup(): void {
      if (registered) return
      registered = true
      // Fire-and-forget — installing a forensic hook can fail (already
      // registered, inspector unavailable, fork bridge not present). On
      // failure, the integration silently no-ops; events still flow.
      registerForensicHook((capture) => {
        buffered.push(capture)
        while (buffered.length > bufferMax) buffered.shift()
      }, config).catch(() => {
        registered = false
      })
    },
    async onBeforeSend(event: ErrorEvent): Promise<ErrorEvent | null> {
      if (event.forensics) return event
      if (buffered.length === 0) return event
      let bestIdx = -1
      let bestScore = 0
      for (let i = 0; i < buffered.length; i++) {
        const s = matchScore(buffered[i]!, event)
        if (s > bestScore) {
          bestScore = s
          bestIdx = i
        }
      }
      if (bestIdx === -1) return event
      const picked = buffered.splice(bestIdx, 1)[0]
      if (!picked) return event
      return {
        ...event,
        forensics: captureToForensicsField(picked),
        schemaVersion: "2.0",
      }
    },
  }
}

/** Test-only: inject a synthetic capture into the buffer. */
export function __pushCaptureForTesting(c: ForensicCapture): void {
  buffered.push(c)
  while (buffered.length > bufferMax) buffered.shift()
}

/** Test-only: clear buffer and reset registration state. */
export function __resetForensicIntegrationForTesting(): void {
  buffered = []
  registered = false
  bufferMax = DEFAULT_BUFFER
}
