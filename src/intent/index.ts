/**
 * Intent contracts compiler — public surface (SKYNET §3 piece 5, Track D).
 *
 * Consumers (mostly `v2-emit.ts`) import from this barrel. The two source
 * implementations stay re-exported so polyglot SDKs and tests can compose
 * a custom source list.
 */

export type { IntentShape, IntentSource } from "./types.js"
export { capShapeSize, MAX_SHAPE_BYTES } from "./types.js"
export {
  extractIntentForFrame,
  DEFAULT_SOURCES,
  __resetCacheForTesting,
  __getCacheStats,
  __cacheHitRatio,
  type ResolverFrame,
  type ExtractOptions,
} from "./compiler.js"
export { typescriptSource } from "./sources/typescript.js"
export { zodSource } from "./sources/zod.js"
export { openapiSource, __resetOpenapiCacheForTesting } from "./sources/openapi.js"
export { drizzleSource } from "./sources/drizzle.js"
export { prismaSource, __resetPrismaCacheForTesting } from "./sources/prisma.js"
export { graphqlSource, __resetGraphqlCacheForTesting } from "./sources/graphql.js"
