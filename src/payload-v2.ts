/**
 * Payload v2 — frozen wire contract (Track A, SKYNET §3 piece 1+4+17).
 *
 * v1 talked to a human dashboard. v2 talks to an LLM. Every field exists
 * because a model needs it to localize, hypothesize, or apply a fix without
 * a separate round trip.
 *
 * The wire shape is a strict superset of v1. Servers detect v2 by
 * `schema_version === "2.0"`; v1 callers keep working unchanged.
 *
 * Frozen as of 2026-04-25 — every track B-H of the SKYNET plan reads/writes
 * this shape. Additive changes only. Renames or removals are a major bump.
 *
 * Wire format (snake_case at the boundary, camelCase only inside legacy
 * compat fields). The transformer in `buildPayloadV2` handles the conversion
 * from the in-memory `ErrorEvent` (camelCase, used by integrations) to this
 * canonical shape.
 *
 * Crypto contract — must stay byte-identical to `web/lib/services/eap-verify-local.ts`:
 *   leaf            = SHA-256(canonical_json(evidence))
 *   merkle_root     = SHA-256(leaf || leaf)            // single-leaf, duplicate-pad
 *   receipt_id_hex  = hex(merkle_root)
 *   sign_digest     = SHA-256(receipt_id_hex_utf8_bytes)
 *   signature       = Ed25519.sign(private_key, sign_digest)
 *
 * Canonical JSON: object keys sorted alphabetically, recursively. Arrays keep
 * order. Strings stringified through `JSON.stringify` (escapes match RFC 8259).
 *
 * Zero deps. Crypto comes from `node:crypto` (Ed25519 supported since Node 15;
 * we target Node ≥20). Falls back to a no-op signature on Edge / Browser.
 */

import type {
  ErrorEvent,
  Breadcrumb,
  ForensicsCapture,
  SourceContextFrame,
  RuntimeSnap,
  Precursor,
  Hypothesis,
  FleetMatch,
  IntentContract,
  CausalGraph,
} from "./types.js"

// ───────────────────────── Wire shape ──────────────────────────────────────

export type SeverityV2 = "critical" | "error" | "warning" | "info"

export interface SignatureBlock {
  /** Algorithm tag — frozen. */
  alg: "ed25519"
  /** First 16 hex chars of SHA-256(public_key_bytes). Stable across the install lifetime. */
  pub_key_id: string
  /** Hex of the 32-byte Ed25519 public key. Lets the server verify without a keypair lookup. */
  signer_pubkey: string
  /** 64-hex SHA-256 Merkle root over the canonical evidence pack. Equal to receipt_id. */
  evidence_merkle_root: string
  /** 128-hex Ed25519 signature over SHA-256(evidence_merkle_root). */
  sig: string
  /** ISO 8601 — when the SDK signed this event. */
  signed_at: string
}

export interface RequestContextV2 {
  method?: string
  url?: string
  headers?: Record<string, string>
  query?: Record<string, string>
  body?: unknown
  ip?: string
}

export interface DeployContextV2 {
  sha?: string
  diff_urls?: string[]
  risk_tags?: string[]
  age_seconds?: number
}

export interface CohortContextV2 {
  users_hit?: number
  rps_delta?: number
  canary_pct?: number
}

export interface NearMissV2 {
  signal: string
  delta_pct: number
  window_seconds: number
}

/** AI-shaped evidence pack — every field is optional, only what the SDK collected appears. */
export interface EvidencePack {
  stack: Array<{
    file: string
    line: number
    col?: number
    function: string
    locals?: Record<string, unknown>
    closure?: Record<string, unknown>
    source_slice?: { before: string[]; line: string; after: string[] }
    git_blame?: { commit: string; author: string; date: string; message: string }
    tokens_estimated: number
  }>
  breadcrumbs?: Breadcrumb[]
  request?: RequestContextV2
  response_expected_schema?: IntentContract[]
  deploy?: DeployContextV2
  flags?: Record<string, string>
  experiments?: Record<string, string>
  runtime_snap?: RuntimeSnap
  precursors?: Precursor[]
  near_misses_last_60s?: NearMissV2[]
  cohort?: CohortContextV2
  tokens_estimated_total: number
}

/** Top-level frozen wire contract. */
export interface ErrorEventV2 {
  schema_version: "2.0"
  fingerprint: string
  title: string
  severity: SeverityV2
  timestamp: string

  evidence: EvidencePack
  hypotheses: Hypothesis[]
  graph?: CausalGraph
  embedding_v1?: number[]
  fleet_match?: FleetMatch

  signature: SignatureBlock

  // Legacy compat — server still consumes these for v1 dashboards.
  body?: string
  environment?: string
  release?: string
  runtime?: "nodejs" | "edge" | "python" | "go" | "rust" | "jvm" | "dotnet" | "browser"
  user?: { id?: string; role?: string }
  tags?: Record<string, string>
}

// ───────────────────────── JSON Schema (draft-07) ──────────────────────────
//
// Exported so server-side validators (Zod gen, Ajv) can lock the shape.
// Kept inline rather than in a separate file because it doubles as docs.

export const PAYLOAD_V2_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://inariwatch.com/schemas/capture/error-event-v2.json",
  title: "ErrorEventV2",
  type: "object",
  required: [
    "schema_version",
    "fingerprint",
    "title",
    "severity",
    "timestamp",
    "evidence",
    "hypotheses",
    "signature",
  ],
  additionalProperties: true, // forward-compat: unknown fields pass through
  properties: {
    schema_version: { const: "2.0" },
    fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    title: { type: "string", maxLength: 1000 },
    severity: { enum: ["critical", "error", "warning", "info"] },
    timestamp: { type: "string", format: "date-time" },
    evidence: {
      type: "object",
      required: ["stack", "tokens_estimated_total"],
      properties: {
        stack: {
          type: "array",
          items: {
            type: "object",
            required: ["file", "line", "function", "tokens_estimated"],
            properties: {
              file: { type: "string" },
              line: { type: "integer", minimum: 0 },
              col: { type: "integer", minimum: 0 },
              function: { type: "string" },
              locals: { type: "object" },
              closure: { type: "object" },
              source_slice: {
                type: "object",
                required: ["before", "line", "after"],
                properties: {
                  before: { type: "array", items: { type: "string" } },
                  line: { type: "string" },
                  after: { type: "array", items: { type: "string" } },
                },
              },
              git_blame: {
                type: "object",
                required: ["commit", "author", "date", "message"],
                properties: {
                  commit: { type: "string" },
                  author: { type: "string" },
                  date: { type: "string" },
                  message: { type: "string" },
                },
              },
              tokens_estimated: { type: "integer", minimum: 0 },
            },
          },
        },
        breadcrumbs: { type: "array" },
        request: { type: "object" },
        response_expected_schema: { type: "array" },
        deploy: { type: "object" },
        flags: { type: "object" },
        experiments: { type: "object" },
        runtime_snap: { type: "object" },
        precursors: { type: "array" },
        near_misses_last_60s: { type: "array" },
        cohort: { type: "object" },
        tokens_estimated_total: { type: "integer", minimum: 0 },
      },
    },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        required: ["text", "prior", "cites", "confidence", "source"],
        properties: {
          text: { type: "string" },
          prior: { type: "number", minimum: 0, maximum: 1 },
          cites: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source: { enum: ["local_agent", "bloom_match", "heuristic"] },
        },
      },
    },
    graph: { type: "object" },
    embedding_v1: { type: "array", items: { type: "number" } },
    fleet_match: { type: "object" },
    signature: {
      type: "object",
      required: [
        "alg",
        "pub_key_id",
        "signer_pubkey",
        "evidence_merkle_root",
        "sig",
        "signed_at",
      ],
      properties: {
        alg: { const: "ed25519" },
        pub_key_id: { type: "string", pattern: "^[0-9a-f]{16}$" },
        signer_pubkey: { type: "string", pattern: "^[0-9a-f]{64}$" },
        evidence_merkle_root: { type: "string", pattern: "^[0-9a-f]{64}$" },
        sig: { type: "string", pattern: "^[0-9a-f]{128}$" },
        signed_at: { type: "string", format: "date-time" },
      },
    },
  },
} as const

// ───────────────────────── Canonical JSON ──────────────────────────────────

/**
 * Canonical JSON encoder — sorts object keys alphabetically, recursively.
 * Byte-identical to `canonicalJsonStringify` in
 * `web/lib/services/eap-verify-local.ts`. Server reuses this when it
 * recomputes the Merkle root.
 *
 * Arrays preserve order. Primitives go through `JSON.stringify` so escape
 * rules match RFC 8259 (and the Rust `serde_json` impl in eap/crates/receipt).
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null)
  if (typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  )
  return `{${parts.join(",")}}`
}

// ───────────────────────── Tokens estimator ────────────────────────────────

/**
 * tiktoken-compatible token estimator without the dependency.
 *
 * Approach: tuned single-rate `chars × 0.28` against measured tiktoken
 * `cl100k_base` rates across 100 sample payloads (English error text, JS
 * stack traces, JSON evidence packs, code snippets). The empirical rate
 * varies between 0.24 and 0.33 tokens/char depending on punctuation
 * density; 0.28 hits the mean.
 *
 *   tokens ≈ ceil(char_count × 0.28)
 *
 * Acceptance (PAYLOAD_V2_SPEC.md): <10% mean error vs tiktoken `cl100k_base`
 * across the test corpus. Verified in payload-v2.test.mjs.
 *
 * For non-string values we serialize once (canonical) and run the same rate
 * so callers can pass any payload subtree.
 *
 * Pathological inputs (long repeated single-char runs like "aaaa...") will
 * undershoot — BPE merges those into very few tokens and our estimator can't
 * cheaply detect that. Real payloads don't contain such runs; the SDK's
 * fingerprint+evidence shape is well-mixed text.
 */
export function estimateTokensTiktoken(value: unknown): number {
  let s: string
  if (typeof value === "string") {
    s = value
  } else if (value === null || value === undefined) {
    return 0
  } else {
    try {
      s = canonicalJsonStringify(value)
    } catch {
      return 0
    }
  }
  if (s.length === 0) return 0
  return Math.max(1, Math.ceil(s.length * 0.28))
}

// ───────────────────────── Evidence Merkle root ────────────────────────────

/**
 * Compute the Merkle root over the evidence pack using single-leaf,
 * duplicate-last padding (matches `recomputeMerkleRoot` in eap-verify-local).
 *
 *   leaf = SHA-256(canonical_json(evidence))
 *   root = SHA-256(leaf || leaf)         // odd → duplicate
 *
 * Returns 64-char lowercase hex.
 *
 * Pure CPU; safe to call sync. Uses node:crypto when available, falls back
 * to Web Crypto via the async overload `computeEvidenceMerkleRootAsync`.
 */
export function computeEvidenceMerkleRootSync(
  evidence: EvidencePack,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  crypto: any,
): string {
  const canonical = canonicalJsonStringify(evidence)
  const leaf: Buffer = crypto.createHash("sha256").update(canonical, "utf8").digest()
  const root: Buffer = crypto
    .createHash("sha256")
    .update(leaf)
    .update(leaf)
    .digest()
  return root.toString("hex")
}

export async function computeEvidenceMerkleRootAsync(
  evidence: EvidencePack,
): Promise<string> {
  const canonical = canonicalJsonStringify(evidence)
  // Node path
  if (typeof window === "undefined") {
    try {
      const pkg = "node:crypto"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeCrypto: any = await import(/* webpackIgnore: true */ pkg)
      if (nodeCrypto?.createHash) {
        return computeEvidenceMerkleRootSync(evidence, nodeCrypto)
      }
    } catch {
      // fall through to Web Crypto
    }
  }
  // Web Crypto fallback
  const encoder = new TextEncoder()
  const leafBuf = await crypto.subtle.digest("SHA-256", encoder.encode(canonical))
  const leaf = new Uint8Array(leafBuf)
  const concat = new Uint8Array(leaf.length * 2)
  concat.set(leaf, 0)
  concat.set(leaf, leaf.length)
  const rootBuf = await crypto.subtle.digest("SHA-256", concat)
  return Array.from(new Uint8Array(rootBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ───────────────────────── Build v2 from v1 in-memory event ────────────────

/**
 * Convert the in-memory `ErrorEvent` (which integrations have already
 * enriched with `forensics`, `sourceContext`, `hypotheses`, etc.) into the
 * canonical wire shape `ErrorEventV2`. Does NOT sign — that's a separate
 * step in `signing.ts` so the unsigned shape is testable and the signing
 * key path stays optional (Edge / Browser SDKs cannot persist a keypair).
 *
 * The transformer is purely structural: no I/O, no async, no globals.
 * Same input always produces the same output (deterministic).
 */
export function buildEvidencePack(event: ErrorEvent): EvidencePack {
  const stackFrames = parseStackForEvidence(event.body ?? "", event.sourceContext)

  // Merge forensic locals/closures by frame index when present.
  const forensics: ForensicsCapture | undefined = event.forensics
  const enrichedStack = stackFrames.map((frame, idx) => {
    const locals =
      forensics?.locals?.[String(idx)] !== undefined
        ? simplifyLocals(forensics.locals[String(idx)] ?? {})
        : undefined
    const closure =
      forensics?.closureChains?.[String(idx)] !== undefined
        ? simplifyLocals(forensics.closureChains[String(idx)] ?? {})
        : undefined

    const ctxFrame = (event.sourceContext ?? []).find((f) => f.frameIndex === idx)
    const source_slice = ctxFrame
      ? { before: ctxFrame.before, line: ctxFrame.line, after: ctxFrame.after }
      : undefined
    const git_blame = ctxFrame?.blame ? { ...ctxFrame.blame } : undefined

    const frameTokens = estimateTokensTiktoken({
      ...frame,
      locals,
      closure,
      source_slice,
      git_blame,
    })

    const out: EvidencePack["stack"][number] = {
      file: frame.file,
      line: frame.line,
      function: frame.function,
      tokens_estimated: frameTokens,
    }
    if (frame.col !== undefined) out.col = frame.col
    if (locals) out.locals = locals
    if (closure) out.closure = closure
    if (source_slice) out.source_slice = source_slice
    if (git_blame) out.git_blame = git_blame
    return out
  })

  const evidence: EvidencePack = {
    stack: enrichedStack,
    tokens_estimated_total: 0, // filled below
  }

  if (event.breadcrumbs?.length) evidence.breadcrumbs = event.breadcrumbs
  if (event.request) evidence.request = event.request as RequestContextV2
  if (event.expected?.contracts?.length) {
    evidence.response_expected_schema = event.expected.contracts
  }
  if (event.runtimeSnap) evidence.runtime_snap = event.runtimeSnap
  if (event.precursors?.length) evidence.precursors = event.precursors

  // Tokens total at the end so it includes its own siblings but not itself.
  evidence.tokens_estimated_total = estimateTokensTiktoken(evidence)

  return evidence
}

/**
 * Build v2 wire payload WITHOUT signing. Caller layers the signature on top
 * via `signing.ts` so the signing path stays Node-only.
 *
 * Returned object is the exact JSON the server will receive (minus the
 * `signature` block — that lives in the wrapper that calls `signPayload`).
 */
export function buildPayloadV2Unsigned(
  event: ErrorEvent,
): Omit<ErrorEventV2, "signature"> {
  const evidence = buildEvidencePack(event)

  const out: Omit<ErrorEventV2, "signature"> = {
    schema_version: "2.0",
    fingerprint: event.fingerprint,
    title: event.title,
    severity: mapSeverity(event.severity),
    timestamp: event.timestamp,
    evidence,
    hypotheses: event.hypotheses ?? [],
  }

  if (event.causalGraph) out.graph = event.causalGraph
  if (event.fleetMatch) out.fleet_match = event.fleetMatch
  if (event.body) out.body = event.body
  if (event.environment) out.environment = event.environment
  if (event.release) out.release = event.release
  if (event.runtime) out.runtime = event.runtime as ErrorEventV2["runtime"]
  if (event.user) out.user = event.user
  if (event.tags) out.tags = event.tags

  return out
}

// ───────────────────────── Helpers ─────────────────────────────────────────

function mapSeverity(s: ErrorEvent["severity"]): SeverityV2 {
  // v1 has only critical/warning/info. v2 adds "error" but we never produce
  // it here — peers can override via direct write if needed.
  return s
}

function simplifyLocals(
  locals: Record<string, import("./types.js").SerializedValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(locals)) {
    if (v.type === "primitive") out[k] = v.value
    else if (v.type === "object") {
      out[k] = { _preview: v.preview, _truncated: v.truncated }
    } else {
      out[k] = { _redacted: v.reason }
    }
  }
  return out
}

interface ParsedFrame {
  file: string
  line: number
  col?: number
  function: string
}

/**
 * Best-effort stack parser. Handles V8 ("at fn (file:line:col)") and Firefox
 * ("fn@file:line:col") formats. Accepts an optional sourceContext list — when
 * the SDK already has structured frames we skip parsing.
 *
 * Falls back to a single synthetic "<unknown>" frame if parsing finds nothing
 * (Edge / minified code without source maps). Server gates downstream
 * features on whether `evidence.stack[0].file` is "<unknown>".
 */
export function parseStackForEvidence(
  stack: string,
  sourceContext?: SourceContextFrame[],
): ParsedFrame[] {
  if (sourceContext && sourceContext.length > 0) {
    // We have structured frames already. Reconstruct minimal info.
    return sourceContext.map((f) => ({
      file: extractFileFromSlice(f) ?? "<unknown>",
      line: 0,
      function: "<unknown>",
    }))
  }

  const out: ParsedFrame[] = []
  const lines = stack.split("\n")
  for (const raw of lines) {
    const line = raw.trim()
    // V8: "at fnName (file:LINE:COL)"  or  "at file:LINE:COL"
    const v8 = /^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line)
    if (v8) {
      out.push({
        function: v8[1] ?? "<anonymous>",
        file: v8[2] ?? "<unknown>",
        line: parseInt(v8[3] ?? "0", 10),
        col: parseInt(v8[4] ?? "0", 10),
      })
      continue
    }
    // Firefox/Safari: "fnName@file:LINE:COL"
    const ff = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line)
    if (ff) {
      out.push({
        function: ff[1] || "<anonymous>",
        file: ff[2] ?? "<unknown>",
        line: parseInt(ff[3] ?? "0", 10),
        col: parseInt(ff[4] ?? "0", 10),
      })
    }
  }
  if (out.length === 0) {
    out.push({ file: "<unknown>", line: 0, function: "<unknown>" })
  }
  return out
}

function extractFileFromSlice(_f: SourceContextFrame): string | null {
  // SourceContextFrame doesn't carry the file path — `source-context.ts`
  // computes it but the public type only exposes the slice. Server
  // correlates by fingerprint instead.
  return null
}
