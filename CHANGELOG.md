# Changelog — `@inariwatch/capture`

All notable changes to the SDK. Older releases pre-date this file —
see git history for `0.10.x` and earlier.

## 0.11.1 — 2026-05-05

### Added
- **MCP stdio server** (`npx @inariwatch/capture mcp`). JSON-RPC 2.0
  over stdin/stdout, conforming to the Model Context Protocol spec
  (`2024-11-05`). Cursor 1.0+, Claude Code, Windsurf, Copilot Agent,
  and Raycast all consume this transport via four lines of config.
  The server reads `.inariwatch/errors.jsonl` (the dev-log written
  when `INARIWATCH_DEV_LOG=1` is set on the running app — that file
  has existed for a while; this release exposes it). Three tools:
  - `inari_recent_errors({ limit?, severity? })` — N most recent
    events, newest first, body-stack trimmed to first 10 lines.
  - `inari_get_error({ fingerprint })` — full event by fingerprint;
    prefix match works.
  - `inari_clear_log()` — truncate the dev-log; reports the count.
  Zero deps, zero network, Node-only. Override the file path with
  `INARIWATCH_DEV_LOG_PATH`. The CLI (`npx @inariwatch/capture`)
  dispatches `mcp` to the new module; `init` (the auto-setup wizard)
  is unchanged. Setup snippet is documented in the README.

### Fixed
- Peer-agent default model changed from `gpt-5.4` to `gpt-4o-mini`.
  The previous default targeted a model that may not be available on
  every user's OpenAI account, causing the agent loop to fail on first
  use unless the caller passed an explicit `model:` override. The new
  default is the cheapest GPT-4-class model with stable tool-calling
  support, matching the web-side analysis default. Callers that already
  pass `model:` are unaffected.

### Removed
- `forensic/fork-bridge.ts` (internal). The ForensicVM Node fork was
  cancelled in 2026-04 and never had a binding shipped, so this module
  has always thrown `"fork bridge not yet implemented"` on every
  install. The inspector fallback (`node:inspector/promises`) is now
  the only forensic capture path. The public surface is preserved:
  `isForkAvailable()` still exports and now always returns `false`;
  `registerForensicHook()` keeps its `{ mode: "fork" | "inspector" }`
  return type for compatibility with exhaustive switches but only ever
  resolves to `"inspector"`; the `forceFallback` option is accepted as
  a no-op (the Python port still uses it to choose between PEP 669 and
  `settrace`).
- `src/browser.ts` (the legacy browser auto-init that wrapped the
  Node-shaped `client.ts`). Replaced with a redirect: the
  `@inariwatch/capture/browser` subpath now resolves to the lean
  `browser-v2/auto` entry. Side-effect contract is preserved —
  `import "@inariwatch/capture/browser"` still auto-initializes from
  `window.__INARIWATCH__`. New: `<meta name="inariwatch:dsn">` /
  `inariwatch:environment` / `inariwatch:release` tags are now read as
  fallback when no bundler can inject a config object. The legacy
  `session: true` default that opportunistically attached an `rrweb`
  ring buffer is gone — for full session replay use the dedicated
  `@inariwatch/capture-replay` package (this was already documented as
  the canonical path; the silent default was undocumented behavior).

### Tests
- New `test/mcp.test.mjs` (25 cases) drives `handleMessage()` with
  synthesized JSON-RPC requests against a temp dev-log JSONL — avoids
  spawning real stdio. Coverage: protocol invariants (jsonrpc field,
  id round-tripping for number/string/null, notifications get no
  reply, parse / invalid-request / method-not-found / invalid-params
  error codes); initialize handshake shape; `tools/list` returns the
  3 declared tools; `TOOL_DISPATCH` and `TOOLS` are kept in sync;
  `inari_recent_errors` limit clamping (default 10, min 1, max 100),
  severity filter, helpful empty-log message, body-stack truncation
  to first 10 lines, corrupt-line skip; `inari_get_error` full +
  prefix fingerprint match, missing-param error, not-found message;
  `inari_clear_log` truncate + count report, empty-log = 0;
  `resolveDevLogPath` env override + cwd default. End-to-end smoke
  via `node dist/cli.js mcp` confirmed initialize + tools/list
  responses match the wire spec.

- New `test/shield.test.mjs` (32 cases) covering the three pure-logic
  layers of the runtime SAST module: (a) **taint store** — markTainted
  / markObjectTainted / checkTaint / runWithTaintStore /
  AsyncLocalStorage isolation / MAX_TAINT_ENTRIES eviction (locks the
  500-entry FIFO); (b) **detection** — inspectSink classification of
  16 sink names to the right `VulnerabilityType`, default-fallback
  behavior for unknown sinks, `minInputLength` config, `blocked` flag
  reflecting `mode: "block"`, truncation invariants (taintedInput ≤
  200 chars, sinkArgument ≤ 500), buildSecurityTitle /
  buildSecurityBody output shape; (c) **sources** — shieldMiddleware
  taints `req.{query,params,body,cookies}`, the four dangerous header
  names (and ignores benign ones — `user-agent`, `accept-encoding`),
  URL path segments + raw query string with URL-decoding,
  `markRequestTainted` for Web Request objects (Next.js / Remix /
  SvelteKit / Cloudflare Workers / Deno / Bun), invalid-URL
  resilience, missing-field tolerance. Covers all 6 declared
  `VulnerabilityType` mappings. Sink monkey-patch integration tests
  (pg / mysql2 / child_process / fs) are out of scope here — they
  need real driver installs and live in out-of-band fixtures. This
  closes the largest "574 LOC of security code shipped default-on with
  zero coverage" gap the audit flagged. No production code changed.

- New `test/signing.test.mjs` (24 cases) targeting the gaps left by
  `payload-v2.test.mjs`'s happy-path signing coverage. New checks:
  Ed25519 determinism (RFC 8032 invariant); rejection of signatures
  signed by a stranger keypair; malformed signature / pubkey rejection
  (length, charset); `verifyReceiptIdSignature` never throws on
  garbage input (hot-path safety guarantee); corrupted-file recovery
  paths (regenerate when JSON is invalid, the persisted shape is
  wrong, or `pub_key_id` length is off); ephemeral
  `__createInMemoryKeypair` does not touch disk; cache behavior;
  POSIX `0o600` perms on the persisted file (skipped on Windows);
  pub_key_id derivation invariant (first 16 hex of SHA-256 of raw
  pubkey bytes); plus a hardcoded **golden vector** (PKCS#8 PEM +
  receipt → expected signature) that locks the signing protocol
  byte-for-byte so a future refactor that swaps the algorithm,
  pre-hash, or encoding fails loudly. The golden vector is also
  cross-checked against an inline `Ed25519(SHA-256(receipt_id_utf8))`
  recomputation. No production code changed.

### Changed
- Sensitive-field name list consolidated. `scope.ts` previously kept its
  own `REDACT_BODY_FIELDS` literal in parallel with `redact/keys.ts`'s
  `SENSITIVE_KEYS` set, and the two had drifted: `credit_card`,
  `card_number`, `cvv`, `cvc`, `ssn`, and `social_security` were
  scrubbed by the always-on baseline in `setRequestContext()` but NOT
  by the opt-in `redact: true` pipeline. Both layers now share
  `SENSITIVE_KEYS`. As a consequence:
  - **`redact: true` users** now get those financial-PII field names
    wholesale-redacted across the entire event (previously only the
    request body's keys were caught — and only because `scope.ts` had
    its own list). Card numbers were already content-redacted by the
    `CREDIT_CARD` regex (Luhn-validated); this catches the case where
    the value was mangled (spaces / dashes stripped).
  - **All users** get a strictly broader baseline scrub at
    `setRequestContext()`. Field names like `aws_secret_access_key`,
    `aws_access_key_id`, `client_secret`, `id_token`, `private_key`,
    `pwd`, `apikey`, `api-key`, `credentials`, `set-cookie`,
    `x-api-key`, `x-auth-token`, `x-access-token`, `x-csrf-token`,
    `sessionid`, `cookie`, and `session` are now whole-value redacted
    in request bodies — previously only matched in headers. This is
    a privacy improvement, not a behavior loss.
  - The literal `pass` field-name (8 chars, false-positive prone — it
    matched `passport`, `passing`, `pass_through`) is no longer in the
    list. `password` / `passwd` / `pwd` cover the real cases without
    the false positives.
  Layering is now documented in `scope.ts` header: scope runs an
  always-on baseline scrub of the request context; `redact/` runs the
  full opt-in regex + key scrub of the entire payload at send time.

## 0.11.0 — 2026-05-02

### Added
- **In-process PII / secret redaction** (opt-in). Pass `redact: true` to
  `init()` or set `INARIWATCH_REDACT=true` to scrub the outgoing payload
  *inside the user's process* before it reaches the InariWatch cloud.
  Regex-based, deterministic, zero new dependencies — no ML model is
  bundled. Default pattern set covers email, phone, SSN, credit-card
  (Luhn-validated), JWT, OpenAI / Stripe / GitHub / AWS access /
  Google / Slack tokens, and sensitive object keys (`password`,
  `authorization`, `cookie`, `api_key`, …). IPv4 and the 40-char AWS
  secret shape are off by default to avoid false positives — opt in
  via `redact: { redactIPs: true }` / `redactAwsSecrets: true`.
- `RedactConfig.allowlist` (dot-path strings) lets callers exempt
  specific paths like `request.headers.user-agent` from redaction.
- `RedactConfig.customPatterns` lets callers append project-specific
  shapes (employee IDs, license keys, …).
- `RedactConfig.hashMode` emits stable FNV-1a fingerprints alongside
  the redaction tag (`[REDACTED_EMAIL:a1b2c3d4]`) so engineers can
  correlate the same redacted value across events without exposing it.
- `_meta.redact_applied: true` is set on every event the redactor
  processed, so server-side enrichment can skip paths that would
  re-derive PII.
- Public exports: `redactPayload`, `resolveRedactConfig`, types
  `RedactConfig` and `RedactPattern`.

### Performance
- Redactor adds ~0.5ms p95 to a 5KB payload (10× under the 5ms hot-path
  budget). Benchmarked in `test/redact.test.mjs`.

### Notes
- Back-compat: redaction is **off by default**. Existing installs see
  zero behavior change until they opt in.
