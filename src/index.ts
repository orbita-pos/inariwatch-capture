export { init, captureException, captureMessage, captureLog, flush } from "./client.js"
export {
  isZeroRetentionEnabled,
  setZeroRetentionForTesting,
  persistTombstone,
  extractTombstone,
} from "./tombstone.js"
export type { SignedTombstone } from "./tombstone.js"
export { captureRequestError } from "./integrations/nextjs.js"
export { withInariWatch } from "./plugins/next.js"
export { addBreadcrumb } from "./breadcrumbs.js"
export { setUser, setTag, setRequestContext, runWithScope } from "./scope.js"
export { initFullTrace, getSessionId, setSessionId, injectSessionHeader, __resetFullTraceForTesting } from "./fulltrace.js"

export type {
  CaptureConfig, ErrorEvent, ParsedDSN, SubstrateConfig, SessionConfig, SessionEvent,
  FullTraceConfig, Integration, Breadcrumb, GitContext, EnvironmentContext,
  SecurityContext, VulnerabilityType, ShieldConfig,
  // Payload v2 (CAPTURE_V2_IMPLEMENTATION.md §3.1)
  SerializedValue, ForensicsCapture, SourceContextFrame, RuntimeSnap, Precursor,
  Hypothesis, FleetMatch, IntentContract, CausalGraph, CausalGraphNode, CausalGraphEdge,
  EapSignatures,
} from "./types.js"

export { applyTokenBudget, estimateTokens, V2_FIELD_DROP_PRIORITY } from "./v2-budget.js"

// Payload v2 wire contract — frozen as of 2026-04-25. Tracks B-H of
// SKYNET §3 read/write this shape. Additive changes only.
export {
  buildPayloadV2Unsigned,
  buildEvidencePack,
  computeEvidenceMerkleRootSync,
  computeEvidenceMerkleRootAsync,
  canonicalJsonStringify,
  estimateTokensTiktoken,
  parseStackForEvidence,
  PAYLOAD_V2_JSON_SCHEMA,
} from "./payload-v2.js"
export type {
  ErrorEventV2,
  SignatureBlock,
  EvidencePack,
  SeverityV2,
  RequestContextV2,
  DeployContextV2,
  CohortContextV2,
  NearMissV2,
} from "./payload-v2.js"
export { prepareV2Payload, resolvePayloadVersion } from "./v2-emit.js"

// Precursor stream (SKYNET §3 piece 3). `init()` auto-starts the sampler
// when payload v2 is enabled; the named hooks let undici/axios/opossum
// callers feed the counters when this SDK can't auto-detect them.
export {
  initPrecursors,
  stopPrecursors,
  snapshotPrecursors,
  recordNearMiss,
  recordRetry,
  recordCircuitBreakerTrip,
} from "./precursors.js"

// Causal Graph Engine (SKYNET §3 piece 7). Opt-in via
// CAPTURE_CAUSAL_GRAPH=1; `init()` calls installAllHooks when the flag is
// on. The named exports let frameworks call runWithRoot per-request and
// recordOp from custom integrations.
export {
  initCausalGraph,
  runWithRoot,
  recordOp,
  getCurrentNodeId,
  extractSubgraph,
  serializeForPayload,
  installPgHook,
  installPrismaHook,
  installDrizzleHook,
  instrumentPrismaClient,
  installAllHooks,
} from "./causal/index.js"
export type {
  CausalNode,
  CausalEdge,
  CausalEdgeKind,
  CausalRecordHandle,
} from "./causal/index.js"
