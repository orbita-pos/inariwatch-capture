/**
 * In-process PII / secret redactor for `@inariwatch/capture` Node SDK.
 *
 * Goal: scrub user-side payloads BEFORE they leave the user's process,
 * so the InariWatch cloud never sees emails, phone numbers, credit
 * cards, JWTs, API keys, etc. — even by accident in stack traces or
 * breadcrumb context.
 *
 * Design constraints (per v0.3 S6 + `feedback_no_proprietary_ai.md`):
 *   - Regex-based and synchronous. NO ML model, NO ONNX runtime, NO
 *     extra deps. The SDK stays zero-dep.
 *   - Deterministic + auditable: every redacted slot is tagged with the
 *     pattern label so support can answer "what was scrubbed here?"
 *     without ever seeing the original.
 *   - Hot-path safe: target <5ms p95 for a 5KB payload.
 *
 * Activation: `Capture.init({ redact: true })` or
 *             `Capture.init({ redact: { allowlist: [...] } })`.
 *
 * The redactor runs at the very end of the send pipeline (after all
 * integration `onBeforeSend` hooks and the user's `beforeSend`), so it
 * sees the final wire payload. When it runs, it tags
 * `payload._meta.redact_applied = true` so the server can flag the
 * event as scrubbed and skip enrichment paths that would re-derive PII.
 */

import {
  DEFAULT_PATTERNS,
  IPV4_PATTERN,
  AWS_SECRET_PATTERN,
  type Pattern,
} from "./patterns.js"
import { SENSITIVE_KEYS } from "./keys.js"
import { fnv1a32 } from "./hash.js"

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

const DEFAULT_MAX_DEPTH = 32
const REDACTED_VALUE = "[REDACTED_VALUE]"

/**
 * Apply redaction to a payload object. Returns the redacted payload as a
 * new object — does NOT mutate the input. When the redactor performed
 * any work (regardless of whether anything matched), the result has
 * `_meta.redact_applied = true` so downstream consumers know the event
 * was scrubbed.
 */
export function redactPayload<T>(payload: T, config: RedactConfig = {}): T {
  if (config.enabled === false) return payload

  const opts: Required<Omit<RedactConfig, "customPatterns" | "allowlist">> & {
    customPatterns: Pattern[]
    allowlist: Set<string>
  } = {
    enabled: true,
    customPatterns: config.customPatterns ?? [],
    allowlist: new Set(config.allowlist ?? []),
    hashMode: config.hashMode ?? false,
    redactIPs: config.redactIPs ?? false,
    redactAwsSecrets: config.redactAwsSecrets ?? false,
    maxDepth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
  }

  const patterns: Pattern[] = [...DEFAULT_PATTERNS, ...opts.customPatterns]
  if (opts.redactIPs) patterns.push(IPV4_PATTERN)
  if (opts.redactAwsSecrets) {
    patterns.push({
      ...AWS_SECRET_PATTERN,
      // Only redact 40-char base64 runs when the surrounding text smells
      // secret-y. Avoids torching every base64 binary blob in logs.
      validate: () => true, // string-level scoring is done in scrubString
    })
  }

  const result = walk(payload, "", 0, opts, patterns, new WeakSet())

  // Tag the payload so the server can flag scrubbed events. Only
  // applies to plain objects — primitives at the top level keep their
  // shape (the SDK never sends a primitive as the wire payload anyway).
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>
    const meta = (obj._meta && typeof obj._meta === "object" && !Array.isArray(obj._meta))
      ? { ...(obj._meta as Record<string, unknown>) }
      : {}
    meta.redact_applied = true
    obj._meta = meta
  }
  return result as T
}

interface WalkOpts {
  hashMode: boolean
  redactAwsSecrets: boolean
  allowlist: Set<string>
  maxDepth: number
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  opts: WalkOpts,
  patterns: Pattern[],
  seen: WeakSet<object>,
): unknown {
  if (depth > opts.maxDepth) return value
  if (value === null || value === undefined) return value
  if (opts.allowlist.has(path)) return value

  const t = typeof value
  if (t === "string") {
    return scrubString(value as string, opts, patterns)
  }
  if (t !== "object") return value

  // Cycle guard — replace cycle targets with a marker rather than
  // recursing forever. Caller will see the marker and know the structure
  // wasn't safe to traverse.
  if (seen.has(value as object)) return "[REDACTED_CYCLE]"
  seen.add(value as object)

  if (Array.isArray(value)) {
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) {
      out[i] = walk(value[i], `${path}[${i}]`, depth + 1, opts, patterns, seen)
    }
    return out
  }

  // Plain object. Buffer, Date, etc. can also be `typeof === "object"`
  // but we don't expect those in serialized event payloads — they'd be
  // toJSON'd before this point. If they slip through, they pass through
  // unchanged (no own enumerable props to walk).
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    const childPath = path ? `${path}.${key}` : key
    if (opts.allowlist.has(childPath)) {
      out[key] = obj[key]
      continue
    }
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      // Whole-value scrub. The value text might be ANY shape (token,
      // password, object) — we never want to leak it.
      out[key] = opts.hashMode
        ? `[REDACTED_VALUE:${fnv1a32(stringify(obj[key]))}]`
        : REDACTED_VALUE
      continue
    }
    out[key] = walk(obj[key], childPath, depth + 1, opts, patterns, seen)
  }
  return out
}

/**
 * Used by hash mode for non-string values. Cheap toString that handles
 * objects, arrays, and primitives without throwing on cycles (the outer
 * walk's seen set already broke cycles, so JSON.stringify is safe here).
 */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

const AWS_CONTEXT_RE = /(?:secret|key|token|password|credential|auth)/i

function scrubString(input: string, opts: WalkOpts, patterns: Pattern[]): string {
  if (input.length < 4) return input
  let s = input
  for (const p of patterns) {
    // Reset lastIndex defensively — global regexes are stateful and
    // patterns is a module-level array shared across walks.
    p.regex.lastIndex = 0
    if (!p.regex.test(s)) {
      p.regex.lastIndex = 0
      continue
    }
    p.regex.lastIndex = 0
    s = s.replace(p.regex, (match, ..._args) => {
      // Per-match validator (Luhn for credit cards, etc.).
      if (p.validate && !p.validate(match)) return match
      // Context check for AWS secret false-positive guard.
      if (p.label === "AWS_SECRET" && !opts.redactAwsSecrets) return match
      if (p.label === "AWS_SECRET" && !AWS_CONTEXT_RE.test(input)) return match
      return opts.hashMode
        ? `[REDACTED_${p.label}:${fnv1a32(match)}]`
        : `[REDACTED_${p.label}]`
    })
  }
  return s
}

/**
 * Coerce the user-provided `redact` config (boolean | partial object)
 * into a `RedactConfig` with `enabled` set. Used by `init()` to keep the
 * caller-facing API simple (`redact: true`).
 */
export function resolveRedactConfig(
  raw: boolean | Partial<RedactConfig> | undefined,
): RedactConfig {
  if (raw === true) return { enabled: true }
  if (raw === false || raw === undefined) return { enabled: false }
  return { enabled: true, ...raw }
}

export type { Pattern } from "./patterns.js"
