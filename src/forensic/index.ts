import type { ForensicHook, ForensicOptions } from "./types.js"
import * as fallback from "./fallback-inspector.js"
import * as fork from "./fork-bridge.js"

export type {
  ForensicValue,
  FrameSnapshot,
  ForensicCapture,
  ForensicHook,
  ForensicOptions,
} from "./types.js"
export { serializeValue } from "./serialize.js"
export { isAvailable as isForkAvailable } from "./fork-bridge.js"
export { decode as decodeMsgpack, decodeForensicPayload } from "./msgpack-decoder.js"
export {
  installSessionFile,
  updateRequestContext,
  uninstallSessionFile,
} from "./session-file.js"
export type { SessionContext } from "./session-file.js"
export {
  forensicIntegration,
  __pushCaptureForTesting,
  __resetForensicIntegrationForTesting,
} from "./integration.js"
export type { ForensicIntegrationConfig } from "./integration.js"

let mode: "fork" | "inspector" | null = null

/**
 * Register a hook fired on every uncaught exception with frame locals,
 * closures, and receiver `this`. The hook runs off the throw path —
 * synchronously on the fork, asynchronously on the inspector fallback.
 *
 * Call once per process. A second call throws until `unregisterForensicHook`.
 *
 * Resolution order:
 *   1. ForensicVM fork when `process.versions.iw_forensic` is set and
 *      `forceFallback` is not true.
 *   2. Otherwise `inspector.Session` attach-on-throw.
 *
 * See `docs/forensic-architecture.md` for the full picture and
 * `docs/forensic-locals-schema.md` for the locals shape this ships to
 * the capture ingest.
 */
export async function registerForensicHook(
  hook: ForensicHook,
  options: ForensicOptions = {},
): Promise<{ mode: "fork" | "inspector" }> {
  if (mode !== null) {
    throw new Error("@inariwatch/node-forensic: hook already registered")
  }
  const wantsFork = !options.forceFallback && fork.isAvailable()
  if (wantsFork) {
    await fork.install(hook, options)
    mode = "fork"
    return { mode }
  }
  await fallback.install(hook, options)
  mode = "inspector"
  return { mode }
}

export async function unregisterForensicHook(): Promise<void> {
  if (mode === "fork") await fork.uninstall()
  else if (mode === "inspector") await fallback.uninstall()
  mode = null
}

/** Exposed for tests and debugging. */
export function __mode(): "fork" | "inspector" | null {
  return mode
}
