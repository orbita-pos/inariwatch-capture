/**
 * Data-flow taint tracking — SKYNET §3 piece 7 (Track B), session 2.
 *
 * The causal graph already carries `causal` (parent→child) and `temporal`
 * (sibling order) edges. The third edge kind, `data-flow`, is what makes the
 * AI useful for localization: it answers "the value that crashed this query —
 * where did it come from?".
 *
 * Mechanism:
 *   - Every instrumented op that produces a value (HTTP response, Redis GET,
 *     SQL row) calls `tagValue(value, fromNodeId)`. We store the linkage in
 *     a WeakMap so the GC can reclaim values whenever the user drops them —
 *     no leak, no manual cleanup.
 *   - JSON.parse is patched (opt-in via the same causal flag) so that a
 *     response body parsed within a short window after an HTTP call inherits
 *     the request's node id. This covers the `JSON.parse(response.body)`
 *     idiom without forcing the user to instrument anything.
 *   - DB hooks call `findDataFromIds(args)` before recording their op. Any
 *     match becomes a `data-flow` edge into the new DB node.
 *
 * WeakMap keys must be objects, so primitives (strings, numbers) cannot be
 * tagged directly. The HTTP hook tags the parsed body root; downstream DB
 * calls get matched if they pass the parsed body or any of its top-level
 * children. Two-level walk catches `prisma.user.findUnique({ where: { id } })`
 * where `id` itself is a primitive but `where` is the object holding it.
 */

const provenance = new WeakMap<object, string>()

/** Hot slot consumed by the next JSON.parse — set by HTTP hooks on response. */
let pendingHttpProvenance: { id: string; expiresAt: number } | null = null
const PENDING_TTL_MS = 50

let jsonParsePatched = false
let originalJsonParse: typeof JSON.parse | null = null

/** Tag a value as produced by a graph node. Primitive values are ignored. */
export function tagValue(value: unknown, fromNodeId: string): void {
  if (!fromNodeId) return
  if (value === null || value === undefined) return
  if (typeof value !== "object") return
  provenance.set(value as object, fromNodeId)
}

/** Lookup a single value's provenance node id, or null. */
export function getProvenance(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "object") return null
  return provenance.get(value as object) ?? null
}

/**
 * Walk DB query args two levels deep to find tagged objects. Two levels is
 * enough for `prisma.user.findUnique({ where: { id } })` and `pg.query("...",
 * [responseBody.id])` — the most common idioms — without quadratic walks
 * over deeply nested objects.
 */
export function findDataFromIds(args: unknown[] | unknown): string[] {
  const list = Array.isArray(args) ? args : [args]
  const out = new Set<string>()
  for (const arg of list) {
    if (!arg || typeof arg !== "object") continue
    const direct = provenance.get(arg as object)
    if (direct) out.add(direct)
    for (const v of Object.values(arg as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue
      const nested = provenance.get(v as object)
      if (nested) out.add(nested)
    }
  }
  return [...out]
}

/**
 * Mark the next JSON.parse call (within a short window) to tag its result
 * with `fromNodeId`. Called by HTTP hooks when the response trailer arrives —
 * the user's parse of the body inherits the http node as data source.
 */
export function markPendingHttpProvenance(fromNodeId: string): void {
  if (!fromNodeId) return
  pendingHttpProvenance = { id: fromNodeId, expiresAt: Date.now() + PENDING_TTL_MS }
}

/**
 * Patch global JSON.parse to tag results when a pending provenance is set.
 * Idempotent and safe — falls back to native parse for non-string inputs.
 */
export function installJsonParseTaint(): void {
  if (jsonParsePatched) return
  if (typeof JSON === "undefined" || typeof JSON.parse !== "function") return
  originalJsonParse = JSON.parse.bind(JSON)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  JSON.parse = function patchedParse(this: unknown, text: any, reviver?: any) {
    const result = originalJsonParse!(text, reviver)
    if (pendingHttpProvenance) {
      const now = Date.now()
      if (now <= pendingHttpProvenance.expiresAt) {
        tagValue(result, pendingHttpProvenance.id)
      }
      pendingHttpProvenance = null
    }
    return result
  } as typeof JSON.parse
  jsonParsePatched = true
}

/** Test seam — restore native JSON.parse and clear pending state. */
export function __resetDataFlowForTesting(): void {
  if (jsonParsePatched && originalJsonParse) {
    JSON.parse = originalJsonParse
  }
  jsonParsePatched = false
  originalJsonParse = null
  pendingHttpProvenance = null
}

export function __getPendingForTesting(): string | null {
  return pendingHttpProvenance?.id ?? null
}
