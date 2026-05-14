/**
 * Tiny, static-import-safe slice of the redact module.
 *
 * Why this file exists: `init()` needs to translate the user's
 * `redact: true | { ... }` config into a normalized `RedactConfig` at
 * startup. The full redactor (`redactPayload` + patterns + Luhn + FNV)
 * weighs ~7 KB minified and is only needed at *send* time, and only
 * when redaction is actually enabled.
 *
 * Splitting `resolveRedactConfig` here lets `client.ts` static-import
 * just the config normalizer, then dynamic-import the heavy
 * `redactPayload` inside `sendWithHooks` only when
 * `resolvedRedactConfig.enabled === true`. That trims ~3 KB gzipped
 * from the default initial bundle for users who don't opt into
 * redaction — the 90% case.
 *
 * The full `redact/index.ts` re-exports `RedactConfig` and
 * `resolveRedactConfig` from here so the public API stays unchanged.
 * Anyone importing `@inariwatch/capture/redact` (or the symbol via
 * the main entry) sees the same surface they always did.
 *
 * See `docs/decisions/0001-lazy-redact.md` for the full design
 * rationale and latency tradeoffs.
 */

import type { Pattern } from "./patterns.js"

export interface RedactConfig {
  /**
   * Master switch. When `Capture.init({ redact: true })` is used, this is
   * set to `true`. When `redact: false` or unset, the redactor never runs.
   */
  enabled?: boolean
  /**
   * Additional patterns appended to the default set. Use to scrub
   * project-specific identifiers (employee IDs, internal account
   * numbers, license keys, etc.).
   */
  customPatterns?: Pattern[]
  /**
   * Dot-path keys to skip even if their value matches a pattern.
   * Example: `["request.headers.user-agent", "env.node"]`.
   *
   * Path comparison is case-sensitive against the canonical key chain
   * built during traversal — for HTTP header objects the key is whatever
   * the consumer set, typically lowercased.
   */
  allowlist?: string[]
  /**
   * When true, replacements include an FNV-1a hash of the original
   * value: `[REDACTED_EMAIL:a1b2c3d4]`. Lets engineers correlate the
   * same redacted value across events without ever exposing the
   * original. Default: false (just `[REDACTED_EMAIL]`).
   */
  hashMode?: boolean
  /**
   * Redact IPv4 addresses. Default: false. Many users want IPs visible
   * for debugging routing / rate-limiting / abuse cases. Flip on if your
   * compliance posture requires IP scrubbing.
   */
  redactIPs?: boolean
  /**
   * Detect 40-char [A-Za-z0-9/+] runs as AWS secrets. Default: false —
   * the shape collides with base64 blobs and long file paths, producing
   * false positives in normal logs. The `aws_secret_access_key` key path
   * is always scrubbed regardless of this flag (via SENSITIVE_KEYS).
   */
  redactAwsSecrets?: boolean
  /**
   * Hard recursion depth limit. Default: 32. Prevents pathological
   * nested objects (or accidental cycles, though we also use a WeakSet
   * cycle guard) from blowing the stack.
   */
  maxDepth?: number
}

/**
 * Coerce the user-provided `redact` config (boolean | partial object)
 * into a `RedactConfig` with `enabled` set. Used by `init()` to keep
 * the caller-facing API simple (`redact: true`).
 *
 * This is a sub-1 KB function with zero deps on patterns/keys/hash —
 * deliberately small so it can be static-imported into the hot path
 * of `init()` without dragging in the full redactor.
 */
export function resolveRedactConfig(
  raw: boolean | Partial<RedactConfig> | undefined,
): RedactConfig {
  if (raw === true) return { enabled: true }
  if (raw === false || raw === undefined) return { enabled: false }
  return { enabled: true, ...raw }
}
