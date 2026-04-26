# Payload v2 Spec

**Status:** FROZEN as of 2026-04-25 (Track A, SKYNET §3 piece 1+4+17)
**Owner:** Jesus Bernal
**Implements:** `capture/src/payload-v2.ts`, `capture/src/source-context.ts`, `capture/src/signing.ts`, `capture/src/v2-emit.ts`
**Server side:** `web/lib/services/capture-v2-verify.ts`, `web/app/api/webhooks/capture/[integrationId]/route.ts`

## Why this exists

v1 was shaped for a human dashboard. v2 is shaped for an LLM. Every field
exists because a model needs it to localize, hypothesize, or apply a fix
without a separate round-trip. v1 keeps working forever — v2 is opt-in via
`CAPTURE_PAYLOAD_VERSION=2`.

This spec is **frozen**: tracks B–H of the SKYNET plan all read/write this
shape. Additive fields are fine. Renames or removals are a major bump and
require coordinated upgrades across SDK + server + dashboard.

## Wire shape (snake_case at the boundary)

```ts
{
  schema_version: "2.0",
  fingerprint: string,                  // 64 hex
  title: string,
  severity: "critical" | "error" | "warning" | "info",
  timestamp: string,                    // ISO 8601

  evidence: {                           // see EvidencePack below
    stack: Array<StackFrame>,           // 1+ frames, each up to 20 lines source
    breadcrumbs?: Array<Breadcrumb>,    // last 30
    request?: RequestContext,
    response_expected_schema?: IntentContract[],
    deploy?: { sha, diff_urls[], risk_tags[], age_seconds },
    flags?: Record<string, string>,
    experiments?: Record<string, string>,
    runtime_snap?: { heap_mb, rss_mb, eventloop_p99_ms, open_handles },
    precursors?: Array<Precursor>,
    near_misses_last_60s?: Array<NearMiss>,
    cohort?: { users_hit, rps_delta, canary_pct },
    tokens_estimated_total: number      // sum of all per-frame + meta
  },

  hypotheses: Array<{                   // empty when capture-agent peer absent
    text: string,
    prior: number,                      // 0..1
    cites: string[],                    // dotted refs into evidence
    confidence: number,
    source: "local_agent" | "bloom_match" | "heuristic"
  }>,

  graph?: CausalGraph,                  // filled by Causal Graph Engine (track B)
  embedding_v1?: number[],              // 1024D, optional
  fleet_match?: FleetMatch,

  signature: {                          // REQUIRED when schema_version === "2.0"
    alg: "ed25519",
    pub_key_id: string,                 // SHA-256(pubkey)[:16] hex
    signer_pubkey: string,              // 32-byte raw pubkey, hex
    evidence_merkle_root: string,       // 32-byte SHA-256, hex (== receipt_id)
    sig: string,                        // 64-byte Ed25519 signature, hex
    signed_at: string                   // ISO 8601
  },

  // Legacy compat (server pulls these for v1 dashboards)
  body?: string,
  environment?: string,
  release?: string,
  runtime?: "nodejs"|"edge"|"python"|"go"|"rust"|"jvm"|"dotnet"|"browser",
  user?: { id?, role? },
  tags?: Record<string, string>
}
```

A complete JSON Schema (draft-07) lives in
`capture/src/payload-v2.ts` as `PAYLOAD_V2_JSON_SCHEMA` — exported so server
validators can lock the shape.

### StackFrame

```ts
{
  file: string,                       // absolute path, "<unknown>" if minified
  line: number,                       // 1-based, 0 if unknown
  col?: number,
  function: string,
  locals?: Record<string, unknown>,   // forensic locals, redaction-aware
  closure?: Record<string, unknown>,
  source_slice?: { before: string[]; line: string; after: string[] },
                                      // 10 before + 1 + 10 after
  git_blame?: { commit: string; author: string; date: string; message: string },
  tokens_estimated: number            // per-frame token count
}
```

## Crypto contract (BYTE-IDENTICAL with `web/lib/services/eap-verify-local.ts`)

```
canonical(x)    = JSON with keys sorted alphabetically, recursively
leaf            = SHA-256(canonical(evidence))
merkle_root     = SHA-256(leaf || leaf)            // single-leaf, duplicate-pad
receipt_id_hex  = hex(merkle_root)
sign_digest     = SHA-256(receipt_id_hex.utf8_bytes)
signature       = Ed25519.sign(private_key, sign_digest)
```

The SHA-256 pre-hash provides domain separation. The same algorithm is used
by the Rust EAP server (`eap/crates/receipt/src/signing.rs`), so the same
`verifyEd25519Signature` function on the server validates SDK signatures
with no protocol fork.

## Keypair lifecycle (SDK side)

- Generated lazily on first sign via `node:crypto.generateKeyPairSync('ed25519')`.
- Persisted to `~/.inariwatch/keypair.json` (PKCS#8 PEM + raw pubkey hex).
- Permissions set to 0600 on POSIX. Windows: per-user under `%USERPROFILE%`.
- Key rotation: not implemented — out of scope for Track A.
  - Future: support `KEYPAIR_ROTATE` env to force regeneration; server
    accepts both old and new pub_key_ids during a 30-day grace window.

## Server-side verification flow

`web/app/api/webhooks/capture/[integrationId]/route.ts`:

1. HMAC body signature check (existing, unchanged).
2. Parse JSON body.
3. If `event.schema_version === "2.0"`: call `verifyCaptureV2Payload`.
   - Recompute Merkle root from `event.evidence` (canonical JSON).
   - Compare to `event.signature.evidence_merkle_root`.
   - Ed25519-verify `event.signature.sig` against
     `SHA-256(evidence_merkle_root_hex.utf8)` using
     `event.signature.signer_pubkey`.
   - Confirm `event.signature.pub_key_id == SHA-256(pubkey)[:16]`.
4. Run the existing alert pipeline (createAlertIfNew, autoAnalyze, etc.).
5. **If v2 verified AND alert created**: insert an `eap_receipts` row
   with `attestor = "capture-sdk:<pub_key_id>"`. Idempotent on receipt_id.
6. Verification failures are logged (`capture_v2_verify_failed`) but do
   NOT reject the event — the HMAC body signature already provides
   transport integrity. Future phases may flip this to hard-reject.

## Backward compat

- Server accepts v1 payloads indefinitely. There is no v2-only hard cutover.
- v1 events that happen to contain v2-named fields (e.g., `forensics`,
  `hypotheses`) continue to be accepted; the assembler routes them into
  `correlationData` exactly as before.
- SDK respects `CAPTURE_PAYLOAD_VERSION` (or `INARIWATCH_PAYLOAD_VERSION`).
  Default is "1". Set to "2" to opt into v2 wire format.
- If v2 build fails on the SDK (no node:crypto, can't write to home dir,
  etc.), the SDK falls back to v1 silently. **An error event is never lost.**

## Invariants

- `signature.evidence_merkle_root` == `signature.receipt_id` (same value, two names).
- `signature.pub_key_id` == hex(SHA-256(signer_pubkey_bytes))[:16].
- A v2 payload with `signature` REMOVED can never re-derive — the server
  treats unsigned `schema_version: "2.0"` as a hard rejection at the
  signature step (currently logged, not enforced).
- Canonical JSON is the single point of truth for the merkle root.
  Adding a key, changing key order in source code, or any
  non-determinism in `canonicalJsonStringify` would break verification
  between SDK and server.

## Performance budget

- Whole `getSourceContext` call must finish in <50ms on 5-frame stacks.
  - File reads cached by mtime.
  - Git blame timeout: 500ms per call (skipped if exceeded).
  - Blame results cached by `(absPath, line, file_mtime, head_sha)`.
- Sign + verify Ed25519 in node:crypto: ~0.3ms per op.
- 5-frame v2 payload + blame + 20 lines/frame source: ≤50KB JSON.
  See `capture/test/payload-v2.test.mjs` test 1 for the assertion.

## Tokens estimator

`estimateTokensTiktoken(value)` in `payload-v2.ts`:

```
tokens ≈ ceil(char_count × 0.28)
```

Tuned against tiktoken `cl100k_base` (the GPT-4o / GPT-5 encoder). <10%
mean error across the test corpus. Pathological inputs (long single-char
runs, "aaaa…") will undershoot — real payloads don't contain those.

The chars/4 heuristic in `v2-budget.ts` (drop priority enforcement) is
left as-is — it's a budget guard, intentionally generous so we drop
fields a little eagerly rather than overshoot a model's context window.

## Example v2 payload (truncated)

```json
{
  "schema_version": "2.0",
  "fingerprint": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "title": "TypeError: Cannot read properties of undefined (reading 'id')",
  "severity": "critical",
  "timestamp": "2026-04-25T12:00:00.000Z",
  "evidence": {
    "stack": [
      {
        "file": "/app/server/handler.ts",
        "line": 142,
        "col": 18,
        "function": "handleRequest",
        "locals": { "user": null, "requestId": "req-12345" },
        "source_slice": {
          "before": ["...", "...", "  if (!user) {"],
          "line": "  return user.id;",
          "after": ["  }", "}"]
        },
        "git_blame": {
          "commit": "abc123def456",
          "author": "Jesus Bernal",
          "date": "2026-04-23T10:30:00.000Z",
          "message": "fix(server): null-check user"
        },
        "tokens_estimated": 84
      }
    ],
    "breadcrumbs": [
      {
        "timestamp": "2026-04-25T11:59:30.000Z",
        "category": "fetch",
        "message": "GET /api/users/42",
        "level": "info"
      }
    ],
    "tokens_estimated_total": 142
  },
  "hypotheses": [],
  "signature": {
    "alg": "ed25519",
    "pub_key_id": "5f3e7d8a2b1c0e4f",
    "signer_pubkey": "ab12...32 bytes hex...cd34",
    "evidence_merkle_root": "9f86...32 bytes hex...0a08",
    "sig": "12ab...64 bytes hex...cd34",
    "signed_at": "2026-04-25T12:00:00.123Z"
  },
  "body": "TypeError: Cannot read properties of undefined...",
  "environment": "production",
  "release": "v1.2.3"
}
```

## Test coverage

- `capture/test/payload-v2.test.mjs` — 6 tests:
  1. 5 frames + blame + 20 lines source ≤ 50KB
  2. Tokens estimator within 10% of tiktoken on 5 representative samples
  3. Sign + verify roundtrip + key persistence
  4. Server verification accepts SDK signatures (cross-impl symmetry)
  5. JSON schema sanity
  6. Canonical JSON key ordering equivalence

- `web/lib/services/__tests__/capture-v2-verify.test.ts` — 7 tests:
  1. Accepts well-signed payload
  2. Rejects v1 payloads
  3. Rejects payloads without signature block
  4. Rejects malformed signature shape
  5. Rejects merkle root mismatch
  6. Rejects tampered signature
  7. Rejects pub_key_id mismatch

## Open follow-ups (out of scope for Track A)

- Hard-reject v2 payloads with invalid signatures (currently log-only).
- Key rotation policy + server-side identity registry.
- Ingest path for non-Node SDKs (Python, Go, Rust, Java, C#, Browser) —
  each port reproduces the canonical JSON algo + Ed25519 protocol from
  this spec. Browser uses Web Crypto API (Ed25519 via `crypto.subtle.sign`).
- `embedding_v1` population — track G (RCA-Net) writes here.
- `graph` population — track B (Causal Graph Engine) writes here.
