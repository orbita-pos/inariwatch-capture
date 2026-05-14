# 0001 — Lazy-load the redact module

**Date:** 2026-05-13
**Status:** Accepted
**Owner:** Bundle budget — see `BUNDLE_BUDGET.md`.

## Context

Until v0.13.1, `client.ts` static-imported the full redactor:

```ts
import { redactPayload, resolveRedactConfig, type RedactConfig } from "./redact/index.js"
```

`redact/index.ts` pulls in `patterns.ts` (130 lines of compiled regex + Luhn), `keys.ts` (sensitive-key list), `hash.ts` (FNV-1a32), and 200+ lines of traversal logic. The compiled weight is ~7 KB minified / ~3 KB gzipped.

The default user — `init({ dsn }) + captureException` with no `redact: true` — never executes any of that code. They still paid for it in their bundle. For 90% of users this is dead weight.

## Decision

Split the redact surface so the **static-imported part is ~200 bytes** and the **heavy redactor is dynamic-imported only when activated**:

1. Move `RedactConfig` interface and `resolveRedactConfig()` to `src/redact/config.ts` (sub-1 KB, zero runtime deps on patterns/keys/hash).
2. `src/redact/index.ts` re-exports both for backward-compat — public API unchanged.
3. `client.ts` static-imports only from `./redact/config.js`. The full `redactPayload` is loaded via `await import("./redact/index.js")` inside `sendWithHooks`, cached at module scope so the first redacted send pays the import cost once.

The dynamic-import is gated by `resolvedRedactConfig.enabled`. When `redact: false` or omitted, the dynamic-import never fires and the entire `redact/index.js`, `patterns.js`, `keys.js`, `hash.js`, and `luhn.js` module graph is **excluded** from the initial bundle by code-splitting bundlers (Next.js Turbopack, Vite, Webpack, esbuild `--splitting`).

## Measured impact

`scripts/measure-bundle.mjs` baseline diff (esbuild 0.21.5, Node 22, splitting on):

| Scenario | Before (v0.13.1) | After | Delta |
|---|---|---|---|
| `core` (init + capture + flush) | 6018 B gz | **4640 B gz** | **−1378 B (−23%)** |
| `core+breadcrumbs+scope` | 6107 B gz | **4729 B gz** | **−1378 B (−23%)** |
| `core+redact` (active) | 5086 B gz | 5083 B gz | ±0 (caching neutral) |
| `everything` initial | 7785 B gz | 7819 B gz | +34 B (one new closure for the cache) |

The +34 B in `everything` is the cost of the cache wrapper. Acceptable because `everything` represents the worst-case all-features-active scenario; users hitting it are already paying for the full redactor.

## Tradeoffs accepted

1. **First-send-with-redact-enabled latency**: ~5–20 ms added on the very first `captureException()` after `init({ redact: true })`. Measured on Node 22 / esbuild on a modest laptop — the dynamic import resolves a single ESM chunk, no network. Subsequent sends are identical to the static-import baseline. Acceptable because:
   - `init()` itself returns synchronously — no perceived delay at startup.
   - Error capture is by definition async (transport.send is non-blocking).
   - The added latency is microtask-level, not network-level.

2. **`sendWithHooks` is now `async` end-to-end where it was partly sync**: it always was async in the v2 path; we now also `await` in the v1+redact branch. Callers (`captureException`, `captureMessage`, etc.) already awaited send, so this is invisible.

3. **`cachedRedactPayload` is module-scope mutable**: one cache per process. Multi-tenant servers running the SDK twice will share the cache, which is correct — the redactor is stateless.

## Alternatives considered

- **`export *` re-export with /* @__PURE__ */ annotations**: Doesn't move the needle. Tree-shakers see the re-export but still walk the source file to confirm purity, pulling patterns/keys.
- **Move `redactPayload` to a separate package**: would force users to install a second package and add an import. Breaking change rejected per `feedback_no_breaking_changes.md`.
- **Conditional `if (redact) require()`**: Node-only, breaks Edge/browser bundlers. Dynamic `import()` works everywhere ESM does.

## How to verify

- `cd capture && npm run build && node scripts/measure-bundle.mjs --check` shows `core` initialGz ≤ 5000 B.
- Unit test `test/lazy-redact.test.mjs` exercises the cache path + asserts the module loads exactly once across N captures.
- Bundler validation: `test-bundlers/next15/` (added in F) builds a Next.js app importing only `init + captureException`. Bundle-analyzer must show no chunk containing the strings `DEFAULT_PATTERNS` or `SENSITIVE_KEYS`.

## Rollback

Revert `src/redact/config.ts` creation and restore the static import in `client.ts`. The change is contained to two files (`client.ts`, `redact/index.ts`) plus the new `redact/config.ts`. No DB migration, no env var, no API change.
