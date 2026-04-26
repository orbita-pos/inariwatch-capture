/**
 * Intent contracts compiler — orchestrator (SKYNET §3 piece 5, Track D).
 *
 * Public API: `extractIntentForFrame({ file, line, function })`.
 *
 * Pipeline:
 *   1. resolve frame → (file, symbol)              ← `resolver.ts` logic inlined
 *   2. cache lookup keyed by (file mtime, commit)  ← skip work on hot paths
 *   3. for each registered source:                 ← `sources/typescript`, `sources/zod`
 *        if `canParse(file)` and `extract` returns a shape, wrap in
 *        `IntentContract` and add to the result list
 *   4. cap output at MAX_SHAPE_BYTES per contract
 *   5. write back to cache
 *
 * Sources are best-effort; one source returning `null` doesn't stop the
 * others. Multiple sources can emit for the same file (e.g. a handler
 * with both a TS-typed param AND a Zod validator inside) — the LLM gets
 * both contracts.
 *
 * Cache stats are exposed for the acceptance test (>90% hit ratio on
 * subsequent runs). See `__getCacheStats`.
 */

import { statSync } from "node:fs"
import type { IntentContract } from "../types.js"
import type { IntentShape, IntentSource } from "./types.js"
import { typescriptSource } from "./sources/typescript.js"
import { zodSource } from "./sources/zod.js"
import { openapiSource } from "./sources/openapi.js"
import { drizzleSource } from "./sources/drizzle.js"
import { prismaSource } from "./sources/prisma.js"
import { graphqlSource } from "./sources/graphql.js"

export interface ResolverFrame {
  /** Absolute or repo-relative file path. */
  file: string
  /** 1-based line number inside the file. */
  line: number
  /** Function or method name as it appears in the stack frame. Optional. */
  function?: string
}

export interface ExtractOptions {
  /** Override the default source list. Useful for tests / future polyglot fan-out. */
  sources?: IntentSource[]
  /**
   * Commit SHA for cache keying — typically `process.env.GIT_COMMIT` or
   * `process.env.VERCEL_GIT_COMMIT_SHA`. When present we include it in the
   * cache key so a deploy that changed the file invalidates instantly,
   * even if mtime didn't move (e.g. CI build with reset timestamps).
   */
  commitSha?: string
  /** Skip cache entirely. Tests and one-shot CLI runs use this. */
  bypassCache?: boolean
}

export const DEFAULT_SOURCES: IntentSource[] = [
  typescriptSource,
  zodSource,
  openapiSource,
  drizzleSource,
  prismaSource,
  graphqlSource,
]

interface CacheEntry {
  key: string
  mtimeMs: number
  contracts: IntentContract[]
}

const cache = new Map<string, CacheEntry>()
const stats = { hits: 0, misses: 0 }

/**
 * Main entry. Returns 0+ contracts for the frame. Never throws — every
 * failure mode degrades to `[]`.
 *
 * Cost: hot path (cached) is one stat() call + Map lookup. Cold path is
 * a single TS parse per source per file (~20-50ms for typical handler
 * files; we cache the result by mtime so it's amortized to ~0).
 */
export function extractIntentForFrame(
  frame: ResolverFrame,
  options: ExtractOptions = {},
): IntentContract[] {
  if (!frame || !frame.file) return []

  // Cheap pre-check: is this even a file we can read?
  let mtimeMs: number
  try {
    mtimeMs = statSync(frame.file).mtimeMs
  } catch {
    return []
  }

  const symbol = frame.function ?? null
  const cacheKey = makeCacheKey(frame.file, symbol, options.commitSha)

  if (!options.bypassCache) {
    const hit = cache.get(cacheKey)
    if (hit && hit.mtimeMs === mtimeMs) {
      stats.hits += 1
      return hit.contracts
    }
  }
  stats.misses += 1

  const sources = options.sources ?? DEFAULT_SOURCES
  const contracts: IntentContract[] = []

  for (const source of sources) {
    let canParse = false
    try {
      canParse = source.canParse(frame.file)
    } catch {
      canParse = false
    }
    if (!canParse) continue

    let shape: IntentShape | null = null
    try {
      shape = source.extract(frame.file, symbol)
    } catch {
      shape = null
    }
    if (!shape) continue

    contracts.push({
      source: source.name,
      path: pathFor(frame.file, symbol, shape),
      shape,
    })
  }

  if (!options.bypassCache) {
    cache.set(cacheKey, { key: cacheKey, mtimeMs, contracts })
  }
  return contracts
}

function makeCacheKey(file: string, symbol: string | null, sha?: string): string {
  return `${sha ?? ""}::${file}::${symbol ?? ""}`
}

function pathFor(file: string, symbol: string | null, shape: IntentShape): string {
  // The wire `path` is meant to help the LLM cite *where* the contract
  // came from. We use `file#symbol` when we know the symbol, otherwise
  // `file#<shape._symbol>`, otherwise just `file`.
  const sym = symbol ?? shape._symbol ?? null
  return sym ? `${file}#${sym}` : file
}

// ─── Test hooks ────────────────────────────────────────────────────────────

export function __resetCacheForTesting(): void {
  cache.clear()
  stats.hits = 0
  stats.misses = 0
}

export function __getCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: stats.hits, misses: stats.misses, size: cache.size }
}

export function __cacheHitRatio(): number {
  const total = stats.hits + stats.misses
  if (total === 0) return 0
  return stats.hits / total
}
