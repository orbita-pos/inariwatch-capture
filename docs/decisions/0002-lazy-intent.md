# 0002 — Lazy-load the intent contracts compiler

**Date:** 2026-05-13
**Status:** Accepted
**Owner:** Bundle budget — see `BUNDLE_BUDGET.md`.

## Context

The intent contracts compiler (`src/intent/`) is a SKYNET §3 piece-5 feature: at the moment of an exception, walk the top stack frame and ask source-of-truth schemas (TypeScript interfaces, Zod schemas, OpenAPI specs, Drizzle/Prisma ORM definitions, GraphQL schemas) what the call site **expected** at that frame. The AI uses the expected vs actual diff to localize bugs faster.

The module weighs **~30 KB minified across 6 parser implementations** (one per source language). It's the heaviest non-core module in the SDK. It's also strictly opt-in — activated only by `CAPTURE_INTENT_COMPILER=1` env var AND only fires when payload v2 is active.

Until this change, `v2-emit.ts` had:

```ts
const { extractIntentForFrame } = await import("./intent/index.js")
```

A direct dynamic import. Bundlers with code-splitting (Next.js Turbopack, Vite, Webpack with `import()`-aware chunking) emitted a separate **lazy chunk** that loaded on demand. Bundlers without splitting (`esbuild --bundle` without `--splitting`, some SSR setups, older Webpack configs) **inlined** the intent module into the parent chunk, even though no code path could reach it without the env flag.

## Decision

Apply the same string-variable indirection trick used elsewhere in `client.ts` and `v2-emit.ts` (signing module, source-context, v2-emit itself):

```ts
const intentMod = "./intent/index.js"
const { extractIntentForFrame } = await import(/* webpackIgnore: true */ intentMod)
```

The bundler sees a string variable, not a literal — it can't statically resolve the import target, so it can't emit a chunk for it. The module path is resolved at runtime against Node's filesystem (or via the Edge stub when the SDK runs in Cloudflare Workers / Vercel Edge / Next.js Edge Runtime, which point to a no-op via the `package.json` `edge-light`/`workerd` conditional).

## Measured impact

`scripts/measure-bundle.mjs` diff (esbuild 0.21.5, splitting on):

| Scenario | Before lazy-intent | After | Delta |
|---|---|---|---|
| `core` initial | 4640 B gz | 4640 B gz | ±0 (intent wasn't reachable from core) |
| `core+v2` initial | 4197 B gz | 4197 B gz | ±0 |
| `everything` initial | 7785 B gz | 7814 B gz | +29 B (noise) |
| **`everything` total** | **27022 B gz** | **18448 B gz** | **−8574 B (−32%)** |

The headline number is the **`total` reduction in `everything`**: before, the intent lazy chunk shipped (~10 KB on disk in `node_modules`, fetched by the runtime only if the env flag fired). After, intent isn't bundled at all — Node resolves it at runtime against `node_modules/@inariwatch/capture/dist/intent/index.js` only when actually used.

For users who never enable `CAPTURE_INTENT_COMPILER=1`, the entire 30 KB raw / 10 KB gzipped intent module **never enters their bundle**.

## Tradeoffs accepted

1. **Edge / browser runtimes silently skip intent**: when the SDK is loaded in Next.js Edge Runtime, Cloudflare Workers, or Vercel Edge Functions, the package.json `edge-light`/`workerd` conditional already serves a no-op `dist/edge/*.js` stub. Intent never fires there regardless. The string-indirection is harmless in that case.

2. **Bundlers that can't follow runtime-resolved imports treat intent as missing**: if a build tool aggressively bans dynamic imports with non-literal targets (none mainstream do today), users would see a runtime error when CAPTURE_INTENT_COMPILER fires. Mitigated by the surrounding `try { ... } catch {}` which silently skips intent and continues with the v2 payload. The error event is never lost.

3. **Source-map navigation in DevTools is slightly worse for intent code paths**: dynamic-imported chunks resolved at runtime don't link back to the original `.ts` files as cleanly as statically-imported ones. Only matters for SDK contributors debugging intent itself.

## Alternatives considered

- **Split intent into a separate npm package `@inariwatch/capture-intent`**: would force users to install two packages. Rejected per `feedback_no_breaking_changes.md` and the project's "zero-config" promise.
- **Move intent under `./intent` subpath only**: users would import explicitly. But the SDK's value is that it auto-fires intent when the env flag is set — making it user-imported breaks the auto-detection story.
- **Conditional require() at top of v2-emit**: Node-only, breaks Edge bundlers that don't have `require`. Dynamic `import()` works everywhere ESM does.

## How to verify

- `cd capture && npm run build && node scripts/measure-bundle.mjs --check` shows `everything` totalGz < 20000 B.
- Unit test `test/lazy-intent.test.mjs` bundles a user-style entry and asserts the intent parser markers (`zodSource`, `typescriptSource`, etc.) do NOT appear in any output chunk when CAPTURE_INTENT_COMPILER is off.
- Bundler validation: `test-bundlers/next15/` (step F) builds a Next.js app importing only `init + captureException`. `@next/bundle-analyzer` must show no chunk containing intent parser source.

## Rollback

Revert one line in `src/v2-emit.ts` — change `const intentMod = "./intent/index.js"; await import(intentMod)` back to `await import("./intent/index.js")`. No DB migration, no env var, no API change.
