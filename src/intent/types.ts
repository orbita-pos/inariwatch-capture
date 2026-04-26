/**
 * Intent contracts compiler — common types (SKYNET §3 piece 5, Track D).
 *
 * Goal: when an error throws, the AI knows what *actually* arrived
 * (`evidence.request.body`, locals, …). It does NOT know what the code
 * *expected*. The intent compiler closes that gap by extracting the
 * declared shape of the request param / validator / DTO from the user's
 * source and attaching it as `evidence.response_expected_schema`.
 *
 * 8 sources are planned (TS, Zod, OpenAPI, Drizzle, Prisma, GraphQL,
 * Pydantic, Java records, Rust serde). Part 1 ships TS + Zod — the two
 * shapes the JS ecosystem actually uses.
 *
 * Each source implements `IntentSource`. The compiler walks every source
 * registered, asks `canParse(file)`, then `extract(file, symbol)`. The
 * resolver picks the file from the failing stack frame and asks each
 * source what symbol is closest to that frame.
 *
 * IntentShape is a JSON-Schema-ish dialect. We intentionally don't import
 * the official JSON Schema types — different sources produce different
 * subsets, and locking to the spec would force conversions everyone
 * downstream has to undo. The shape is opaque to the wire payload anyway
 * (the LLM reads it as JSON).
 */

/**
 * The extracted shape — JSON Schema-flavored. Keys we use:
 *   - type: "object" | "array" | "string" | "number" | "boolean" | "null" | "any"
 *   - properties: { [k]: IntentShape }   — only on objects
 *   - required: string[]                  — only on objects
 *   - items: IntentShape                  — only on arrays
 *   - enum: unknown[]                     — for literal unions
 *   - description: string                 — JSDoc / comment if available
 *   - $ref: string                        — when transitive resolution gave up
 *   - _truncated: true                    — hit the size cap (10KB serialized)
 *
 * Fields are loosely typed because each source emits different subsets
 * (TS doesn't have JSDoc descriptions everywhere, Zod doesn't carry $refs).
 */
export interface IntentShape {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "boolean"
    | "null"
    | "any"
    | "unknown"
  properties?: Record<string, IntentShape>
  required?: string[]
  items?: IntentShape
  enum?: unknown[]
  description?: string
  $ref?: string
  _truncated?: true
  /** When `type === "string"` and the value is constrained, e.g. "email". */
  format?: string
  /** Original symbol name when known — helps the LLM cite the type. */
  _symbol?: string
}

/**
 * Source-of-shape contract. One instance per source kind (ts, zod, …).
 *
 * Implementations are pure — no I/O outside reading the target file. They
 * never throw on malformed input; they return `null`. The compiler treats
 * `null` as "this source has no opinion on this file".
 */
export interface IntentSource {
  /** Stable name. Mirrors the `IntentContract.source` enum on the wire. */
  readonly name:
    | "ts"
    | "zod"
    | "drizzle"
    | "openapi"
    | "prisma"
    | "graphql"
    | "pydantic"
    | "java"
    | "rust"

  /**
   * Cheap pre-check — usually an extension match. Returning `true` does
   * NOT promise a successful extract; it just means the compiler should
   * try this source on this file.
   */
  canParse(filePath: string): boolean

  /**
   * Extract the shape associated with `symbol` in `filePath`. `symbol`
   * comes from the failing stack frame's function name when known, or
   * `null` for "give me the file's primary contract" (e.g. default
   * exported schema, top-level Zod validator).
   *
   * Returns `null` when the source cannot find a contract — the caller
   * tries the next source. Must NEVER throw.
   */
  extract(filePath: string, symbol: string | null): IntentShape | null
}

/** Hard cap on serialized shape size — anything past this is truncated. */
export const MAX_SHAPE_BYTES = 10 * 1024

/**
 * Truncate a shape so its serialized JSON fits in MAX_SHAPE_BYTES. We
 * truncate by replacing nested object/array bodies with `{ _truncated: true }`
 * starting from the deepest leaves. The top-level type/symbol stays so the
 * LLM still gets *something*.
 */
export function capShapeSize(shape: IntentShape): IntentShape {
  const json = safeStringify(shape)
  if (json.length <= MAX_SHAPE_BYTES) return shape

  // Try progressively more aggressive truncation passes.
  for (let depth = 4; depth >= 1; depth--) {
    const candidate = truncateAtDepth(shape, depth)
    if (safeStringify(candidate).length <= MAX_SHAPE_BYTES) return candidate
  }
  // Last resort: just keep the top-level descriptor.
  return {
    type: shape.type ?? "object",
    _symbol: shape._symbol,
    _truncated: true,
  }
}

function truncateAtDepth(s: IntentShape, depth: number): IntentShape {
  if (depth <= 0) {
    return { type: s.type, _truncated: true, ...(s._symbol ? { _symbol: s._symbol } : {}) }
  }
  const out: IntentShape = { ...s }
  if (s.properties) {
    out.properties = {}
    for (const [k, v] of Object.entries(s.properties)) {
      out.properties[k] = truncateAtDepth(v, depth - 1)
    }
  }
  if (s.items) {
    out.items = truncateAtDepth(s.items, depth - 1)
  }
  return out
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ""
  } catch {
    return ""
  }
}
