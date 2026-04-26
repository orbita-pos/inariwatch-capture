/**
 * Causal Graph barrel — SKYNET §3 piece 7. Public surface for Track B.
 *
 * Most consumers should reach for `installAllHooks()` to wire every
 * available DB driver in one call. The individual installers are exposed
 * for hosts that want fine-grained control (e.g. only Prisma).
 */

export {
  initCausalGraph,
  runWithRoot,
  recordOp,
  getCurrentNodeId,
  extractSubgraph,
  serializeForPayload,
  mergeSubgraph,
  serializeForHeader,
  deserializeFromHeader,
  __resetCausalGraphForTesting,
  __getBufferForTesting,
  __getCurrentIdForTesting,
  __isAlsActiveForTesting,
  __withFlagOnForTesting,
} from "./graph.js"
export type {
  Node as CausalNode,
  Edge as CausalEdge,
  EdgeKind as CausalEdgeKind,
  RecordHandle as CausalRecordHandle,
} from "./graph.js"

export { installPgHook } from "./hooks-pg.js"
export { installPrismaHook, instrumentPrismaClient } from "./hooks-prisma.js"
export { installDrizzleHook } from "./hooks-drizzle.js"
export { installHttpHook, installBrowserHttpHook } from "./hooks-http.js"
export { installRedisHook } from "./hooks-redis.js"
export {
  tagValue,
  getProvenance,
  findDataFromIds,
  markPendingHttpProvenance,
  installJsonParseTaint,
  __resetDataFlowForTesting,
  __getPendingForTesting,
} from "./data-flow.js"

import { initCausalGraph } from "./graph.js"
import { installPgHook } from "./hooks-pg.js"
import { installPrismaHook } from "./hooks-prisma.js"
import { installDrizzleHook } from "./hooks-drizzle.js"
import { installHttpHook } from "./hooks-http.js"
import { installRedisHook } from "./hooks-redis.js"

/**
 * Resolve `async_hooks` and install hooks for every driver that resolves.
 * Drivers that aren't installed are skipped silently. Returns the per-driver
 * patch outcome so callers can log what was wired.
 */
export async function installAllHooks(): Promise<{
  pg: boolean
  prisma: boolean
  drizzle: boolean
  http: boolean
  redis: boolean
}> {
  await initCausalGraph()
  const [pg, prisma, drizzle, http, redis] = await Promise.all([
    installPgHook().catch(() => false),
    installPrismaHook().catch(() => false),
    installDrizzleHook().catch(() => false),
    installHttpHook().catch(() => false),
    installRedisHook().catch(() => false),
  ])
  return { pg, prisma, drizzle, http, redis }
}
