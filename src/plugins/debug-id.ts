/**
 * Source-map debug IDs (TC39 ecma426 — Source Map Debug IDs).
 *
 * Spec: https://github.com/tc39/ecma426/blob/main/proposals/debug-id.md
 *
 * A debug ID is a UUID that uniquely identifies a single bundled source
 * file. It's embedded in two places:
 *
 *   1. The JS output: `//# debugId=<uuid>` magic comment at the bottom.
 *   2. The source map: `"debugId": "<uuid>"` field at the top level.
 *
 * The UUID is derived deterministically from the file's source content
 * + a stable namespace, so the same input always produces the same ID.
 * That gives the SDK + symbolicator a stable lookup key that survives
 * file renames, hash-suffixed asset paths, and CDN cache busts.
 *
 * Why TC39 instead of "release version + abs_path":
 *   - Sentry's pre-debug-ID model breaks when source maps drift between
 *     deploys, when path normalization fails, or when a CDN serves a
 *     stale bundle. Debug IDs are content-addressed and therefore
 *     stable across all of these.
 *   - Sentry, Rollup, esbuild, Vite, and Webpack 5 all support the
 *     spec; emitting it makes our bundles interoperable with any
 *     symbolicator that reads the field, not just InariWatch's.
 *
 * This module is the shared building block. Each per-bundler plugin
 * (vite.ts / webpack.ts / next.ts / nuxt.ts) calls
 * `computeDebugId()` + `injectDebugIdComment()` from its own transform
 * hook. Today only the Vite plugin is wired; the other three are
 * tracked as Sprint-2 follow-ups in CHANGELOG.
 */

import { createHash } from "node:crypto"

/**
 * Stable namespace for InariWatch debug IDs. Generated once via
 * `crypto.randomUUID()` and frozen — DO NOT regenerate or every
 * existing source map binding becomes invalid.
 */
const NAMESPACE_UUID = "9f4e8c7a-2b1d-5e3f-8a9c-6d0e7b1f4a3c"

/**
 * UUIDv5 derived from `content` under the InariWatch namespace.
 *
 * The standard UUIDv5 algorithm: SHA-1(namespace_bytes || content_bytes),
 * keep first 16 bytes, set the version (5) and variant (RFC 4122) bits,
 * format as canonical UUID string.
 *
 * Determinism: same `content` always produces the same UUID, so the
 * SDK on the user's machine and the symbolicator on the server
 * compute identical IDs without any handshake.
 */
export function computeDebugId(content: string | Buffer): string {
  const namespace = uuidStringToBytes(NAMESPACE_UUID)
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content
  const hash = createHash("sha1").update(namespace).update(data).digest()
  // Take first 16 bytes for the UUID body.
  const out = Buffer.from(hash.subarray(0, 16))
  // Set version 5 (high 4 bits of byte 6 to 0101).
  out[6] = (out[6] & 0x0f) | 0x50
  // Set RFC 4122 variant (high 2 bits of byte 8 to 10).
  out[8] = (out[8] & 0x3f) | 0x80
  return formatUuid(out)
}

/**
 * Append (or replace) the `//# debugId=<id>` magic comment to a JS chunk.
 * Called from per-bundler hooks AFTER the chunk content is final but
 * BEFORE it's written to disk or fed into a sourcemap merge step.
 *
 * Returns the new chunk text. Idempotent — calling twice with the same
 * ID is a no-op; calling twice with different IDs replaces the
 * existing comment so the latest one wins.
 */
export function injectDebugIdComment(code: string, debugId: string): string {
  const re = /\n\/\/# debugId=[a-f0-9-]+\s*$/i
  const stripped = re.test(code) ? code.replace(re, "") : code
  // Trailing newline only if the original had one — preserve EOL hygiene.
  const eol = stripped.endsWith("\n") ? "" : "\n"
  return `${stripped}${eol}//# debugId=${debugId}\n`
}

/**
 * Inject the `debugId` field into a source-map JSON string. Returns
 * the new JSON text (still a string — we don't parse + re-serialize
 * unless we have to, to preserve any byte-for-byte invariants the
 * upstream emitter cares about).
 *
 * If parsing fails (e.g. a base64-encoded inline map), the function
 * silently returns the original — debug-id injection is best-effort,
 * not a correctness-blocking step.
 */
export function injectDebugIdIntoSourceMap(mapJson: string, debugId: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(mapJson) as Record<string, unknown>
  } catch {
    return mapJson
  }
  if (parsed.debugId === debugId) return mapJson
  parsed.debugId = debugId
  return JSON.stringify(parsed)
}

// ── Internals ──────────────────────────────────────────────────────────

function uuidStringToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "")
  if (hex.length !== 32) throw new Error(`namespace UUID has wrong length: ${uuid}`)
  return Buffer.from(hex, "hex")
}

function formatUuid(bytes: Buffer): string {
  if (bytes.length !== 16) throw new Error(`UUID must be 16 bytes, got ${bytes.length}`)
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// Test-only.
export const __testing = { NAMESPACE_UUID, uuidStringToBytes, formatUuid }
