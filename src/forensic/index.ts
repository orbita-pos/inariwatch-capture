import type { ForensicHook, ForensicOptions } from "./types.js"
import * as fallback from "./fallback-inspector.js"

export type {
  ForensicValue,
  FrameSnapshot,
  ForensicCapture,
  ForensicHook,
  ForensicOptions,
} from "./types.js"
export { serializeValue } from "./serialize.js"
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

/**
 * Backward-compat shim. The ForensicVM fork was cancelled in 2026-04;
 * stock Node never had the binding, and no public release ever shipped
 * one. Kept exported so existing callers compile, but always reports
 * unavailable. Inspector fallback is now the only path.
 */
export function isForkAvailable(): boolean {
  return false
}

let mode: "fork" | "inspector" | null = null

/**
 * Register a hook fired on every uncaught exception with frame locals,
 * closures, and receiver `this`. The hook runs off the throw path
 * asynchronously via `inspector.Session` attach-on-throw.
 *
 * Call once per process. A second call throws until `unregisterForensicHook`.
 *
 * The `forceFallback` option is accepted for API compatibility but is a
 * no-op in this runtime — the inspector fallback is the only available
 * path. The Python port still honors it because PEP 669
 * (`sys.monitoring`) and the `settrace` fallback are both real options
 * there.
 *
 * Return type retains the `"fork"` literal for compatibility with
 * existing exhaustive switches; in practice this runtime only ever
 * returns `{ mode: "inspector" }`.
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
  void options.forceFallback
  await fallback.install(hook, options)
  mode = "inspector"
  return { mode }
}

export async function unregisterForensicHook(): Promise<void> {
  if (mode === "inspector") await fallback.uninstall()
  mode = null
}

/** Exposed for tests and debugging. */
export function __mode(): "fork" | "inspector" | null {
  return mode
}
