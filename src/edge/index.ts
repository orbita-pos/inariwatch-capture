/**
 * Edge runtime stub for `@inariwatch/capture` (main entry).
 *
 * Loaded automatically by bundlers that resolve the `"edge"` condition
 * (Next.js Edge Runtime, Cloudflare Workers via worker condition fallback,
 * Vercel Edge Functions). The full Node-targeted bundle lives at
 * `dist/index.js` and is selected by all other consumers.
 *
 * See ./noop.ts for the rationale.
 */
import { noopVoid, noopAsyncVoid, noopReturnArg, noopRunFn, noopReturnEmptyObj, noopReturnFalse } from "./noop.js"

// ── client.ts surface ───────────────────────────────────────────────────────
export const init = noopVoid
export const captureException = noopVoid
export const captureMessage = noopVoid
export const captureLog = noopVoid
export const flush = noopAsyncVoid

// ── tombstone.ts surface ────────────────────────────────────────────────────
export const isZeroRetentionEnabled = (): false => false
export const setZeroRetentionForTesting = noopVoid
export const persistTombstone = noopAsyncVoid
export const extractTombstone = (..._args: unknown[]): null => null

// ── integrations/nextjs.ts ──────────────────────────────────────────────────
export const captureRequestError = noopAsyncVoid

// ── plugins/next.ts ─────────────────────────────────────────────────────────
export const withInariWatch = noopReturnArg

// ── breadcrumbs.ts ──────────────────────────────────────────────────────────
export const addBreadcrumb = noopVoid

// ── scope.ts ────────────────────────────────────────────────────────────────
export const setUser = noopVoid
export const setTag = noopVoid
export const setRequestContext = noopVoid
export const runWithScope = noopRunFn

// ── fulltrace.ts ────────────────────────────────────────────────────────────
export const initFullTrace = noopVoid
export const getSessionId = (): null => null
export const setSessionId = noopVoid
export const injectSessionHeader = noopReturnEmptyObj
export const __resetFullTraceForTesting = noopVoid

// ── v2-budget.ts ────────────────────────────────────────────────────────────
export const applyTokenBudget = noopReturnArg
export const estimateTokens = (): 0 => 0
export const V2_FIELD_DROP_PRIORITY: readonly string[] = []

// ── payload-v2.ts ───────────────────────────────────────────────────────────
export const buildPayloadV2Unsigned = noopReturnArg
export const buildEvidencePack = noopReturnEmptyObj
export const computeEvidenceMerkleRootSync = (): string => ""
export const computeEvidenceMerkleRootAsync = async (): Promise<string> => ""
export const canonicalJsonStringify = (v: unknown): string => JSON.stringify(v)
export const estimateTokensTiktoken = (): 0 => 0
export const parseStackForEvidence = (..._args: unknown[]): never[] => []
export const PAYLOAD_V2_JSON_SCHEMA: Record<string, unknown> = {}

// ── v2-emit.ts (resolvePayloadVersion is also re-exported from payload-version) ─
export const prepareV2Payload = async (e: unknown): Promise<unknown> => e
export const resolvePayloadVersion = (): "1" => "1"

// ── precursors.ts ───────────────────────────────────────────────────────────
export const initPrecursors = noopVoid
export const stopPrecursors = noopVoid
export const snapshotPrecursors = (): never[] => []
export const recordNearMiss = noopVoid
export const recordRetry = noopVoid
export const recordCircuitBreakerTrip = noopVoid

// ── causal/index.ts ─────────────────────────────────────────────────────────
export const initCausalGraph = noopVoid
export const runWithRoot = noopRunFn
export const recordOp = (): null => null
export const getCurrentNodeId = (): null => null
export const extractSubgraph = noopReturnEmptyObj
export const serializeForPayload = noopReturnEmptyObj
export const installPgHook = noopReturnFalse
export const installPrismaHook = noopReturnFalse
export const installDrizzleHook = noopReturnFalse
export const instrumentPrismaClient = noopReturnArg
export const installAllHooks = noopReturnFalse

// ── Type re-exports (zero-cost, types are erased) ───────────────────────────
export type {
  CaptureConfig, ErrorEvent, ParsedDSN, SubstrateConfig, SessionConfig, SessionEvent,
  FullTraceConfig, Integration, Breadcrumb, GitContext, EnvironmentContext,
  SecurityContext, VulnerabilityType, ShieldConfig,
  SerializedValue, ForensicsCapture, SourceContextFrame, RuntimeSnap, Precursor,
  Hypothesis, FleetMatch, IntentContract, CausalGraph, CausalGraphNode, CausalGraphEdge,
  EapSignatures,
} from "../types.js"
export type { SignedTombstone } from "../tombstone.js"
export type {
  ErrorEventV2, SignatureBlock, EvidencePack, SeverityV2, RequestContextV2,
  DeployContextV2, CohortContextV2, NearMissV2,
} from "../payload-v2.js"
export type { CausalNode, CausalEdge, CausalEdgeKind, CausalRecordHandle } from "../causal/index.js"
