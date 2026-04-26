/**
 * Causal Graph Engine — SKYNET §3 piece 7 (Track B), session 1.
 *
 * Builds a runtime graph of operations the request touched: each
 * instrumented op (DB query, HTTP call, Redis op, …) becomes a Node;
 * relations between ops become Edges. Three edge kinds:
 *
 *   - `causal`     — parent op invoked child op (synchronous or awaited)
 *   - `temporal`   — sibling op ran after another sibling under the same parent
 *   - `data-flow`  — value produced by one op was consumed by another
 *
 * Why this exists: linear breadcrumbs (Sentry's model) lose the structure
 * the AI needs to localize a bug. GALA (arXiv 2508.12472) measures +20pts
 * RCA accuracy when given a causal graph instead of a flat trace. Same
 * shape now enables Track B sessions 2-3 (HTTP/Redis hooks, edge stitching)
 * and Track G (substrate replay edge correlation).
 *
 * Storage: `node:async_hooks.AsyncLocalStorage` carries a per-context
 * `GraphBuffer` so concurrent requests don't fight. Each buffer caps at
 * 200 nodes (FIFO eviction with edge cleanup).
 *
 * Activation: opt-in. The SDK reads `CAPTURE_CAUSAL_GRAPH=1` (or
 * `INARIWATCH_CAUSAL_GRAPH=1`). When the flag is off every API in this
 * file short-circuits to a no-op so the SDK stays free for non-opted-in
 * users.
 *
 * Zero deps. Only Node built-ins (`async_hooks`).
 */

import type {
  CausalGraph,
  CausalGraphEdge,
  CausalGraphNode,
} from "../types.js"

// ─── Internal types ────────────────────────────────────────────────────────

export type EdgeKind = "causal" | "temporal" | "data-flow"

/** Internal node — richer than the wire `CausalGraphNode`. Serialized down at flush time. */
export interface Node {
  id: string
  op: string
  ts: number
  durationMs?: number
  attrs?: Record<string, unknown>
}

/** Internal edge — serialized to the frozen wire shape on flush. */
export interface Edge {
  from: string
  to: string
  kind: EdgeKind
}

interface GraphBuffer {
  nodes: Node[]
  edges: Edge[]
  parent: Map<string, string>
  evictedIds: Set<string>
  /** id of the most recent child added under each parent (key = parent id, "" for root). */
  lastSibling: Map<string, string>
}

interface ContextSlot {
  buffer: GraphBuffer
  /** id of the node currently active on this async chain, or null at the root. */
  currentNodeId: string | null
}

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined
  run<R>(store: T, fn: () => R): R
  enterWith(store: T): void
  disable(): void
}

// ─── Module state ──────────────────────────────────────────────────────────

const MAX_NODES = 200
const ROOT_PARENT_KEY = ""

let initialized = false
let als: AsyncLocalStorageLike<ContextSlot> | null = null

/**
 * Process-global fallback used when the flag is on but `runWithRoot` was
 * never called (ad-hoc scripts, tests). For multi-tenant servers each
 * request must call `runWithRoot` to get isolation; this fallback merges
 * everyone's nodes into one buffer, which is degraded but safe.
 */
let globalSlot: ContextSlot | null = null

let nodeCounter = 0

function isFlagOn(): boolean {
  if (typeof process === "undefined" || !process.env) return false
  const v =
    process.env.CAPTURE_CAUSAL_GRAPH ?? process.env.INARIWATCH_CAUSAL_GRAPH
  return v === "1" || v === "true"
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Resolve `node:async_hooks` once and create the AsyncLocalStorage instance.
 *
 * Idempotent — second call is a no-op. Safe to call without checking the
 * flag; if the flag is off we still resolve so a later flag flip during
 * tests works without re-init. Falls back to `null` ALS on browser/Edge —
 * `recordOp` and friends still work via the process-global slot.
 */
export async function initCausalGraph(): Promise<void> {
  if (initialized) return
  initialized = true
  if (typeof process === "undefined") return
  try {
    const pkg = "node:async_hooks"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* webpackIgnore: true */ pkg)
    if (mod?.AsyncLocalStorage) {
      als = new mod.AsyncLocalStorage()
    }
  } catch {
    // Browser / Edge / sandboxed Node — als stays null.
  }
}

// ─── Buffer plumbing ───────────────────────────────────────────────────────

function newBuffer(): GraphBuffer {
  return {
    nodes: [],
    edges: [],
    parent: new Map(),
    evictedIds: new Set(),
    lastSibling: new Map(),
  }
}

function getOrCreateSlot(): ContextSlot {
  if (als) {
    let slot = als.getStore()
    if (!slot) {
      // Outside any `runWithRoot` scope — enter the current async chain
      // with a fresh slot so subsequent calls see it.
      slot = { buffer: newBuffer(), currentNodeId: null }
      als.enterWith(slot)
    }
    return slot
  }
  if (!globalSlot) globalSlot = { buffer: newBuffer(), currentNodeId: null }
  return globalSlot
}

function getActiveSlot(): ContextSlot | null {
  if (als) {
    const s = als.getStore()
    if (s) return s
  }
  return globalSlot
}

function genId(): string {
  // Cheap monotonic id; uniqueness only needs to hold within a buffer's
  // lifetime (a few seconds typically). Counter wraps via |0 to stay i32.
  nodeCounter = (nodeCounter + 1) | 0
  return `n${nodeCounter.toString(36)}`
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run `fn` inside a fresh causal-graph buffer. The SDK calls this around
 * each incoming request (HTTP handler, queue worker) so concurrent
 * requests don't share nodes. If the flag is off or `async_hooks` is
 * unavailable, runs `fn` directly with no overhead.
 */
export function runWithRoot<T>(fn: () => T): T {
  if (!isFlagOn() || !als) return fn()
  return als.run({ buffer: newBuffer(), currentNodeId: null }, fn)
}

export interface RecordHandle {
  /** Empty string when the flag is off. Stable id otherwise. */
  id: string
  /**
   * Mark this op finished. `durationMs` overrides our wall-clock measure
   * (some drivers report their own server-side duration); `dataFrom`
   * stitches data-flow edges from earlier nodes into this one.
   *
   * Idempotent — only the first call has any effect.
   */
  end(extras?: {
    durationMs?: number
    attrs?: Record<string, unknown>
    dataFrom?: string[]
    error?: unknown
  }): void
}

const NOOP_HANDLE: RecordHandle = {
  id: "",
  end() {
    /* no-op */
  },
}

/**
 * Push a new node into the active buffer with a causal edge to the
 * current parent (if any) and a temporal edge from the previous sibling.
 *
 * Returns a handle whose `end()` restores the previous parent so nested
 * ops form a tree rather than a flat list. If the flag is off this is
 * a single boolean check + a constant-handle return — sub-microsecond.
 */
export function recordOp(
  op: string,
  attrs?: Record<string, unknown>,
): RecordHandle {
  if (!isFlagOn()) return NOOP_HANDLE
  const slot = getOrCreateSlot()
  const id = genId()
  const node: Node = { id, op, ts: Date.now() }
  if (attrs) node.attrs = attrs
  pushNode(slot.buffer, node)

  const parentId = slot.currentNodeId
  if (parentId) {
    addEdge(slot.buffer, { from: parentId, to: id, kind: "causal" })
    slot.buffer.parent.set(id, parentId)
  }

  // Temporal sibling edge: previous child of the same parent → this node.
  const parentKey = parentId ?? ROOT_PARENT_KEY
  const prevSibling = slot.buffer.lastSibling.get(parentKey)
  if (prevSibling && prevSibling !== id) {
    addEdge(slot.buffer, { from: prevSibling, to: id, kind: "temporal" })
  }
  slot.buffer.lastSibling.set(parentKey, id)

  const previousCurrent = parentId
  slot.currentNodeId = id

  let ended = false
  const start = node.ts
  return {
    id,
    end(extras) {
      if (ended) return
      ended = true
      // Restore parent unconditionally — if we don't, every following
      // recordOp inside this scope inherits this node as parent and the
      // graph tilts into a chain instead of a tree.
      if (slot.currentNodeId === id) slot.currentNodeId = previousCurrent
      if (slot.buffer.evictedIds.has(id)) return
      const dur = extras?.durationMs ?? Date.now() - start
      node.durationMs = dur
      if (extras?.attrs) {
        node.attrs = { ...(node.attrs ?? {}), ...extras.attrs }
      }
      if (extras?.error !== undefined) {
        node.attrs = {
          ...(node.attrs ?? {}),
          error: serializeError(extras.error),
        }
      }
      if (extras?.dataFrom?.length) {
        for (const fromId of extras.dataFrom) {
          if (!fromId || slot.buffer.evictedIds.has(fromId)) continue
          addEdge(slot.buffer, { from: fromId, to: id, kind: "data-flow" })
        }
      }
    },
  }
}

/** id of the active node on this async chain, or `null` at the root. */
export function getCurrentNodeId(): string | null {
  if (!isFlagOn()) return null
  const slot = getActiveSlot()
  return slot?.currentNodeId ?? null
}

/**
 * BFS from `rootId` (or the current node) up the parent chain to depth
 * `maxDepth`, also pulling in adjacent siblings/children up to `maxNodes`.
 *
 * Used at throw-time to attach a focused subgraph to the v2 payload —
 * the AI only needs the chain that led to the failing frame, not the
 * entire request's I/O.
 */
export function extractSubgraph(
  rootId?: string,
  maxDepth = 5,
  maxNodes = MAX_NODES,
): CausalGraph | undefined {
  if (!isFlagOn()) return undefined
  const slot = getActiveSlot()
  if (!slot || slot.buffer.nodes.length === 0) return undefined
  const start =
    rootId ??
    slot.currentNodeId ??
    slot.buffer.lastSibling.get(ROOT_PARENT_KEY) ??
    slot.buffer.nodes[slot.buffer.nodes.length - 1]?.id ??
    null
  if (!start) return serializeBuffer(slot.buffer, maxNodes)

  const include = new Set<string>([start])
  let frontier: string[] = [start]
  for (let depth = 0; depth < maxDepth && include.size < maxNodes; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      if (include.size >= maxNodes) break
      const parent = slot.buffer.parent.get(id)
      if (parent && !include.has(parent)) {
        include.add(parent)
        next.push(parent)
        if (include.size >= maxNodes) break
      }
      // Pull adjacent edges (both directions) to widen the frame's
      // local context — caps via maxNodes.
      for (const e of slot.buffer.edges) {
        if (include.size >= maxNodes) break
        if (e.from === id && !include.has(e.to)) {
          include.add(e.to)
          next.push(e.to)
        } else if (e.to === id && !include.has(e.from)) {
          include.add(e.from)
          next.push(e.from)
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  const nodes: CausalGraphNode[] = []
  for (const node of slot.buffer.nodes) {
    if (!include.has(node.id)) continue
    nodes.push(toCausalNode(node))
    if (nodes.length >= maxNodes) break
  }
  const ids = new Set(nodes.map((n) => n.id))
  const edges: CausalGraphEdge[] = []
  for (const edge of slot.buffer.edges) {
    if (ids.has(edge.from) && ids.has(edge.to)) {
      edges.push(toCausalEdge(edge))
    }
  }
  return { nodes, edges }
}

/** Serialize the entire active buffer into the wire `CausalGraph` shape. */
export function serializeForPayload(
  maxNodes = MAX_NODES,
): CausalGraph | undefined {
  if (!isFlagOn()) return undefined
  const slot = getActiveSlot()
  if (!slot || slot.buffer.nodes.length === 0) return undefined
  return serializeBuffer(slot.buffer, maxNodes)
}

/**
 * Merge a foreign subgraph (received from a downstream service via response
 * header or a sibling event sharing the same session id) into the active
 * buffer. Each foreign node is namespaced — its id is prefixed with `prefix:`
 * — so it cannot collide with locally generated ids and stays attributable
 * back to its origin in the rendered graph.
 *
 * If `parentId` is given, a `causal` edge is added from the local parent to
 * each foreign root (a foreign node with no inbound edge inside the foreign
 * graph). This is the stitch point that turns "two graphs from two services"
 * into "one graph that crosses a service boundary".
 *
 * Cap policy: total nodes after merge stays ≤ MAX_NODES. If the foreign
 * graph would exceed the cap, the merge truncates from the END of the
 * foreign array (latest foreign nodes are the most relevant — closest to
 * the throw frame in the downstream service).
 */
export function mergeSubgraph(
  foreign: CausalGraph,
  prefix: string,
  parentId?: string,
): { merged: number; skipped: number } {
  if (!isFlagOn()) return { merged: 0, skipped: 0 }
  if (!foreign?.nodes?.length) return { merged: 0, skipped: 0 }
  const slot = getOrCreateSlot()
  const buf = slot.buffer
  const remaining = MAX_NODES - buf.nodes.length
  if (remaining <= 0) return { merged: 0, skipped: foreign.nodes.length }

  // Take the last `remaining` foreign nodes — closest to the throw point
  // in the downstream service.
  const incomingNodes = foreign.nodes.slice(-remaining)
  const accepted = new Set(incomingNodes.map((n) => n.id))
  const idMap = new Map<string, string>()

  for (const fn of incomingNodes) {
    const localId = `${prefix}:${fn.id}`
    idMap.set(fn.id, localId)
    buf.nodes.push({
      id: localId,
      op: fn.label.replace(/\s*\(dur=\d+ms.*?\)\s*$/, ""),
      ts: Date.now(),
      attrs: { foreign: true, origin: prefix },
    })
  }

  const inboundCount = new Map<string, number>()
  for (const fe of foreign.edges) {
    if (!accepted.has(fe.to) || !accepted.has(fe.from)) continue
    inboundCount.set(fe.to, (inboundCount.get(fe.to) ?? 0) + 1)
  }

  for (const fe of foreign.edges) {
    if (!accepted.has(fe.from) || !accepted.has(fe.to)) continue
    const from = idMap.get(fe.from)
    const to = idMap.get(fe.to)
    if (!from || !to) continue
    const kind: EdgeKind = fe.kind === "data" ? "data-flow" : fe.kind
    buf.edges.push({ from, to, kind })
    if (kind === "causal") buf.parent.set(to, from)
  }

  if (parentId) {
    for (const fn of incomingNodes) {
      const inbound = inboundCount.get(fn.id) ?? 0
      if (inbound > 0) continue
      const localId = idMap.get(fn.id)
      if (!localId) continue
      buf.edges.push({ from: parentId, to: localId, kind: "causal" })
      buf.parent.set(localId, parentId)
    }
  }

  return {
    merged: incomingNodes.length,
    skipped: foreign.nodes.length - incomingNodes.length,
  }
}

/**
 * Serialize the active buffer to a compact `CausalGraph` and base64-encode
 * it for transport in HTTP headers. Returns null if no graph or > maxBytes.
 *
 * Used by the HTTP outbound hook to attach the downstream service's
 * subgraph to its response, and by handlers to embed in their own response
 * when they want to expose their causal trail to upstream callers.
 */
export function serializeForHeader(maxBytes = 8192): string | null {
  if (!isFlagOn()) return null
  const graph = serializeForPayload(MAX_NODES)
  if (!graph) return null
  let json: string
  try {
    json = JSON.stringify(graph)
  } catch {
    return null
  }
  if (json.length > maxBytes) return null
  // Base64 keeps the header value safe for HTTP. atob/btoa only handle latin1
  // — so we pass through Buffer in Node, fallback to btoa(unescape...) in
  // browser (unicode-safe).
  if (typeof Buffer !== "undefined") return Buffer.from(json, "utf8").toString("base64")
  if (typeof btoa === "function") {
    try {
      return btoa(unescape(encodeURIComponent(json)))
    } catch {
      return null
    }
  }
  return null
}

/** Decode a base64 header value into a CausalGraph. Returns null on any failure. */
export function deserializeFromHeader(header: string): CausalGraph | null {
  if (!header) return null
  let json: string
  try {
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(header, "base64").toString("utf8")
    } else if (typeof atob === "function") {
      json = decodeURIComponent(escape(atob(header)))
    } else {
      return null
    }
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== "object") return null
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null
    return parsed as CausalGraph
  } catch {
    return null
  }
}

// ─── Internals ─────────────────────────────────────────────────────────────

function pushNode(buf: GraphBuffer, node: Node): void {
  buf.nodes.push(node)
  if (buf.nodes.length > MAX_NODES) {
    const evicted = buf.nodes.shift()
    if (!evicted) return
    buf.evictedIds.add(evicted.id)
    buf.parent.delete(evicted.id)
    // Drop edges referencing the evicted node — keeping them would
    // produce dangling refs in the serialized graph.
    if (buf.edges.length > 0) {
      buf.edges = buf.edges.filter(
        (e) => e.from !== evicted.id && e.to !== evicted.id,
      )
    }
    // Cap evictedIds so it doesn't grow unbounded across long-lived
    // global-slot processes (workers, daemons).
    if (buf.evictedIds.size > MAX_NODES * 4) buf.evictedIds.clear()
    // lastSibling pointers may now reference an evicted id — it's a
    // best-effort; next recordOp under that parent will overwrite.
  }
}

function addEdge(buf: GraphBuffer, edge: Edge): void {
  if (buf.evictedIds.has(edge.from) || buf.evictedIds.has(edge.to)) return
  buf.edges.push(edge)
}

function serializeBuffer(
  buf: GraphBuffer,
  maxNodes: number,
): CausalGraph | undefined {
  if (buf.nodes.length === 0) return undefined
  const nodes = buf.nodes.slice(-maxNodes).map(toCausalNode)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = buf.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map(toCausalEdge)
  return { nodes, edges }
}

function toCausalNode(n: Node): CausalGraphNode {
  // The wire `CausalGraphNode` is `{ id, kind, label }` — three strings.
  // We fold duration + error into label so the wire shape stays frozen
  // (Tracks B-H read/write CausalGraph and we promised additive-only
  // changes to that contract).
  const labelExtras: string[] = []
  if (n.durationMs !== undefined) {
    labelExtras.push(`dur=${Math.round(n.durationMs)}ms`)
  }
  if (n.attrs && (n.attrs as Record<string, unknown>).error !== undefined) {
    labelExtras.push("err=1")
  }
  const label =
    labelExtras.length > 0 ? `${n.op} (${labelExtras.join(" ")})` : n.op
  return {
    id: n.id,
    kind: classifyKind(n.op),
    label,
  }
}

function toCausalEdge(e: Edge): CausalGraphEdge {
  // Internal "data-flow" → wire "data" (matches types.ts's frozen union).
  const kind: CausalGraphEdge["kind"] =
    e.kind === "data-flow" ? "data" : (e.kind as "causal" | "temporal")
  return { from: e.from, to: e.to, kind }
}

function classifyKind(op: string): CausalGraphNode["kind"] {
  if (
    op.startsWith("pg.") ||
    op.startsWith("prisma.") ||
    op.startsWith("drizzle.") ||
    op.startsWith("redis.") ||
    op.startsWith("http.") ||
    op.startsWith("fetch.") ||
    op.startsWith("undici.")
  ) {
    return "io"
  }
  if (op.startsWith("syscall.")) return "syscall"
  if (op.startsWith("promise.")) return "promise"
  return "fn"
}

function serializeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`
  }
  try {
    return String(err)
  } catch {
    return "<unserializable>"
  }
}

// ─── Test helpers ──────────────────────────────────────────────────────────
// `__` prefix mirrors the convention in `signing.ts` / `precursors.ts`. Not
// part of the public API.

export function __resetCausalGraphForTesting(): void {
  initialized = false
  if (als && typeof als.disable === "function") {
    try {
      als.disable()
    } catch {
      // best-effort
    }
  }
  als = null
  globalSlot = null
  nodeCounter = 0
}

export function __getBufferForTesting(): GraphBuffer | null {
  const slot = getActiveSlot()
  return slot ? slot.buffer : null
}

export function __getCurrentIdForTesting(): string | null {
  return getActiveSlot()?.currentNodeId ?? null
}

export function __isAlsActiveForTesting(): boolean {
  return als !== null
}

/** Force the flag on for a single test block — restores on return. */
export function __withFlagOnForTesting<T>(fn: () => T): T {
  const env = (typeof process !== "undefined" && process.env) || {}
  const prev1 = env.CAPTURE_CAUSAL_GRAPH
  const prev2 = env.INARIWATCH_CAUSAL_GRAPH
  env.CAPTURE_CAUSAL_GRAPH = "1"
  try {
    return fn()
  } finally {
    if (prev1 === undefined) delete env.CAPTURE_CAUSAL_GRAPH
    else env.CAPTURE_CAUSAL_GRAPH = prev1
    if (prev2 === undefined) delete env.INARIWATCH_CAUSAL_GRAPH
    else env.INARIWATCH_CAUSAL_GRAPH = prev2
  }
}
