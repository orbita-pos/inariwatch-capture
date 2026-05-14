# Changelog — `@inariwatch/capture`

All notable changes to the SDK. Older releases pre-date this file —
see git history for `0.10.x` and earlier.

## 0.14.0 — 2026-05-13

### Performance — bundle-size diet

Two lazy-load refactors trim the SDK's default initial bundle by 23%
and the worst-case total bundle by 32%, with zero API changes.

| Scenario | Before (0.13.1) | After (0.14.0) | Δ |
|---|---|---|---|
| `core` (init + captureException + flush) | 6,018 B gz | **4,640 B gz** | **−1,378 B (−23%)** |
| `core+breadcrumbs+scope` | 6,107 B gz | **4,729 B gz** | **−1,378 B (−23%)** |
| `everything` initial | 7,785 B gz | 7,814 B gz | +29 B (noise) |
| `everything` total (all chunks) | 27,022 B gz | **18,448 B gz** | **−8,574 B (−32%)** |

Measured with esbuild 0.21.5 on Node 22 with `--splitting` on (matches
how Next.js Turbopack / Vite / Webpack actually emit chunks for ESM
dynamic imports). See `BUNDLE_BUDGET.md` for the full methodology and
the CI gate that enforces the new ceiling.

### What changed

- **`redact` lazy-loaded.** The full redactor (`patterns.ts`, `keys.ts`,
  `hash.ts`, `luhn.ts`) is now dynamic-imported on the first send AFTER
  `init({ redact: true })` instead of being static-imported at module
  load. Users who don't enable redaction never pay for the module.
  `resolveRedactConfig` moved to a tiny `redact/config.js` slice that
  `client.ts` still static-imports — sub-1 KB, zero deps on the heavy
  patterns. See `docs/decisions/0001-lazy-redact.md`.

- **`intent` runtime-resolved.** The intent contracts compiler
  (`intent/index.ts` + 6 source parsers for TS / Zod / OpenAPI /
  Drizzle / Prisma / GraphQL — ~30 KB raw) now loads at runtime via
  string-variable indirection in the dynamic import. Bundlers without
  code-splitting no longer inline it; bundlers with splitting (which
  used to ship a 10 KB lazy chunk on disk) no longer emit one at all.
  See `docs/decisions/0002-lazy-intent.md`.

### Added (infrastructure, not user API)

- **`scripts/measure-bundle.mjs`** — reproducible measurement harness.
  Bundles 7 scenarios with esbuild, emits structured JSON to
  `ci/bundle-size.json`. Run with `--check` to enforce limits from
  `BUNDLE_BUDGET.md`.
- **`BUNDLE_BUDGET.md`** — hard-limit budget table the CI gate parses.
  Raising a limit requires a PR with justification.
- **`.github/workflows/bundle-size.yml`** — CI gate on every PR
  touching `capture/`. Runs the measurement, posts a markdown diff
  comment on the PR with 🟢 / 🟡 / 🔴 indicators per scenario, fails
  the build if any scenario exceeds its budget. Also builds the
  `test-bundlers/next15/` app and scans `.next/**/*.js` for heavy-
  module marker strings — catches Turbopack-specific regressions that
  esbuild-based tests miss.
- **`test-bundlers/next15/`** — production-bundler validation app.
  Minimal Next.js 15 page that imports the SDK as a real user would;
  the verify-bundle scanner asserts no heavy-module markers leak.
- **`test/lazy-redact.test.mjs`** — 6 tests verifying the redact
  config / payload split, including bundle-shape scans.
- **`test/lazy-intent.test.mjs`** — 3 tests verifying intent stays
  runtime-resolved when not explicitly imported.
- **`docs/decisions/0001-lazy-redact.md`** and
  **`0002-lazy-intent.md`** — design docs documenting context,
  alternatives, and tradeoffs for each refactor.

### Backward compatibility

Fully backward-compatible. Every public export from previous versions
still resolves to the same function (`resolveRedactConfig` is now
re-exported from `redact/index.js`, pointing at the new
`redact/config.js` slice; identity preserved). No breaking changes,
no migration required. Existing apps upgrade with `npm update
@inariwatch/capture`.

### Latency tradeoff

First send AFTER `init({ redact: true })` adds ~5–20 ms cold start
while the redactor module resolves. Subsequent sends are identical
to the previous static-import baseline (cached at module scope).
`init()` itself remains synchronous — no perceived startup delay.

---

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
