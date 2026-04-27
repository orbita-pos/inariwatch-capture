/**
 * v2 wire emission — assembles a signed `ErrorEventV2` from the in-memory
 * `ErrorEvent` and hands it to the transport.
 *
 * Activation: opt-in. The SDK reads `CAPTURE_PAYLOAD_VERSION` (or its env
 * counterpart `INARIWATCH_PAYLOAD_VERSION`) at init. When the value is "2",
 * `client.ts` calls `prepareV2Payload` instead of sending the raw v1 event.
 *
 * All Node-only paths (filesystem keypair, source-context, git blame) are
 * isolated here. `client.ts` performs a dynamic import so the browser
 * bundle never pulls this file in.
 *
 * Backward compat:
 *   - If signing fails (no node:crypto, no writable home, etc.), this falls
 *     back to the v1 event unchanged. The server already accepts v1
 *     indefinitely.
 *   - If `getSourceContext` throws, we still build a v2 payload — without
 *     source slices but still signed. AI quality degrades, ingest works.
 */

import type { ErrorEvent } from "./types.js"
import {
  buildPayloadV2Unsigned,
  computeEvidenceMerkleRootSync,
  estimateTokensTiktoken,
  type ErrorEventV2,
} from "./payload-v2.js"

/**
 * Prepare a v2 wire payload. Returns either the signed `ErrorEventV2` or the
 * unchanged v1 `ErrorEvent` if anything in the v2 path failed. Callers send
 * whichever they get.
 *
 * Why fall back instead of throwing: v2 is a delivery optimization, never a
 * correctness requirement. A signing failure must not lose the error event.
 */
export async function prepareV2Payload(
  event: ErrorEvent,
): Promise<ErrorEventV2 | ErrorEvent> {
  // Enrich with source context + git blame (best-effort).
  try {
    if (event.body && (!event.sourceContext || event.sourceContext.length === 0)) {
      const sourceContextMod = "./source-context.js"
      const { getSourceContext } = await import(/* webpackIgnore: true */ sourceContextMod)
      const ctx = getSourceContext(event.body)
      if (ctx.length > 0) event.sourceContext = ctx
    }
  } catch {
    // ignore — proceed without source context
  }

  // Snapshot the precursor ring (SKYNET §3 piece 3). Empty array if the
  // sampler was never started or the window is still warming up; we keep the
  // assignment so `buildEvidencePack` reaches a deterministic shape.
  if (!event.precursors) {
    try {
      const { snapshotPrecursors } = await import("./precursors.js")
      const snap = snapshotPrecursors()
      if (snap.length > 0) event.precursors = snap
    } catch {
      // precursors module unavailable — proceed without
    }
  }

  // Snapshot the causal graph (SKYNET §3 piece 7). BFS up to depth 5 from
  // the active frame, capped at 200 nodes — that's the slice of the
  // request's I/O the AI needs to localize the failing op without
  // drowning in unrelated nodes from the same async chain.
  if (!event.causalGraph) {
    try {
      const { extractSubgraph } = await import("./causal/graph.js")
      const graph = extractSubgraph(undefined, 5, 200)
      if (graph) event.causalGraph = graph
    } catch {
      // causal-graph module unavailable or flag off — proceed without
    }
  }

  // Intent contracts (SKYNET §3 piece 5). Best-effort: read the top
  // stack frame, ask the compiler what shape the code expected at that
  // call site (TS interfaces, Zod schemas, …). Skipped silently when
  // sources are unreachable (Edge / browser / production bundle without
  // source files), gated by CAPTURE_INTENT_COMPILER for opt-in safety.
  if (!event.expected && intentCompilerEnabled() && event.body) {
    try {
      const { parseStackForEvidence } = await import("./payload-v2.js")
      const frames = parseStackForEvidence(event.body, event.sourceContext)
      const top = frames[0]
      if (top && top.file && top.file !== "<unknown>") {
        const { extractIntentForFrame } = await import("./intent/index.js")
        const contracts = extractIntentForFrame({
          file: top.file,
          line: top.line,
          function: top.function,
        })
        if (contracts.length > 0) event.expected = { contracts }
      }
    } catch {
      // intent compiler unavailable or threw — proceed without
    }
  }

  // Build the unsigned canonical wire shape.
  const unsigned = buildPayloadV2Unsigned(event)

  // Compute Merkle root + sign. Both require node:crypto.
  let merkleRoot: string
  let signaturePayload: ErrorEventV2["signature"] | null = null
  try {
    const pkg = "node:crypto"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeCrypto: any = await import(/* webpackIgnore: true */ pkg)
    merkleRoot = computeEvidenceMerkleRootSync(unsigned.evidence, nodeCrypto)
    const signingMod = "./signing.js"
    const { getOrCreateKeypair, signReceiptId } = await import(/* webpackIgnore: true */ signingMod)
    const kp = getOrCreateKeypair()
    const sig = signReceiptId(merkleRoot, kp)
    signaturePayload = {
      alg: "ed25519",
      pub_key_id: kp.pubKeyId,
      signer_pubkey: kp.publicKeyHex,
      evidence_merkle_root: merkleRoot,
      sig,
      signed_at: new Date().toISOString(),
    }
  } catch {
    return event
  }

  if (!signaturePayload) return event

  const v2: ErrorEventV2 = {
    ...unsigned,
    signature: signaturePayload,
  }

  // Update tokens_estimated_total to include the signature block — the
  // signature itself is small (~250 bytes) but consumers reading
  // tokens_estimated_total to budget context need the real cost.
  v2.evidence.tokens_estimated_total = estimateTokensTiktoken(v2)
  return v2
}

// Re-exported for back-compat with anything that grabbed it from this module.
// New code should import from "./payload-version.js" directly to avoid
// pulling the v2-emit chunk (and its Node-only deps) into client / Edge code.
export { resolvePayloadVersion } from "./payload-version.js"

function intentCompilerEnabled(): boolean {
  const env =
    typeof process !== "undefined" && process.env
      ? process.env
      : ({} as Record<string, string | undefined>)
  const v =
    env.CAPTURE_INTENT_COMPILER ?? env.INARIWATCH_INTENT_COMPILER ?? ""
  return v === "1" || v === "true"
}
