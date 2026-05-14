# Bundle budget — `@inariwatch/capture`

Single source of truth for the SDK's bundle-size limits. The CI gate
in `.github/workflows/bundle-size.yml` parses the table below and
fails any PR that pushes a scenario over its hard limit.

If you need to raise a limit, do it deliberately:
1. Edit the row here.
2. Update `ci/bundle-size.json` with `node scripts/measure-bundle.mjs`.
3. Justify in the PR description (which user-facing capability landed
   in exchange for the bigger bundle).

The methodology and measurement command live at the bottom of this
file — re-read them before debating numbers.

## Hard limits (CI fails if exceeded)

Each row is `| scenario | max bytes | metric |`. Metric is one of
`initialGz` (gzipped main chunk a user pays on first paint),
`totalGz` (initial + all lazy chunks gzipped), `initialMin`, `totalMin`.

The scenario name must match exactly with the `name` field in
`scripts/measure-bundle.mjs`.

| scenario | max | metric |
|---|---|---|
| core | 6500 | initialGz |
| core+breadcrumbs+scope | 6500 | initialGz |
| core+fulltrace | 4500 | initialGz |
| core+redact | 6000 | initialGz |
| core+v2 | 5500 | initialGz |
| core+causal | 5500 | initialGz |
| everything | 8500 | initialGz |
| everything | 28000 | totalGz |

## Why these numbers

The `core` scenario — `init + captureException + captureMessage + flush` —
is what 90% of users invoke after `npm install`. It must stay under
**6.5 KB gzipped initial chunk**. For context:

| SDK | Initial bundle (gzipped) |
|---|---|
| **`@inariwatch/capture` (core)** | **~6.0 KB** ← target |
| `@sentry/browser` v8 | ~26 KB |
| `bugsnag-js` | ~22 KB |
| `@datadog/browser-rum` | ~30 KB |
| `@sentry/nextjs` | ~55 KB |

The 6.5 KB ceiling leaves a 500-byte headroom for typical PR work
(adding a tag, a new init flag) without immediately blowing the
budget. Bigger wins (new features) earn their own PR with an
explicit budget bump.

The `everything` worst-case stays under **8.5 KB initial / 28 KB total**.
The `total` metric exists to catch lazy-chunk regressions even when
the initial chunk is fine — adding a 50 KB module to `precursors.js`
wouldn't show up in `initialGz` but would push `totalGz` over.

## Soft targets (no CI fail, review attention)

When you change anything in the SDK, also keep an eye on:

- **First-capture latency** — lazy-loaded modules add roundtrip time
  on first activation (~5–20 ms cold start). Don't lazy-load
  modules that run during request hot paths.
- **Cold init time** — `init()` must return synchronously (or at
  most one microtask). No `await` inside it.
- **`peerDependencies`** — `rrweb` and `web-vitals` are optional
  peers; never make them required.

## How to measure

```bash
# From capture/ directory:
npm run build                          # tsc emits dist/
node scripts/measure-bundle.mjs        # measures + writes ci/bundle-size.json
node scripts/measure-bundle.mjs --check  # exit 1 if any scenario over budget
```

Each scenario is bundled with esbuild in **two modes**:

1. **`--splitting`** (default for Next.js Turbopack, Vite, Webpack
   when handling ESM dynamic imports). The script measures the
   initial main chunk + the total of all lazy chunks.
2. **No splitting** (single inlined bundle — esbuild's `--bundle`
   default). Tracked as `monoMin` / `monoGz` for SSR / older
   bundler scenarios.

The CI gate uses the **splitting numbers** because they match what
end users actually load. The mono numbers are tracked for
informational regressions only.

## When to bump the limits

Acceptable reasons to raise a budget row:
- New core capability lands (added a public API the docs reference).
- A required dependency upstream grew (e.g., `web-vitals` v5).
- A bundler-fingerprint change in esbuild itself (the script logs
  the esbuild version it ran against).

Not acceptable:
- "It just creeped up over time."
- "The CI was annoying."

If you find yourself needing more than 500 bytes for a single
non-feature change, something has likely been static-imported that
should be dynamic. See `docs/decisions/0001-lazy-redact.md` for the
pattern.

## Last measured

See `ci/bundle-size.json` — committed each release. Includes
`measuredAt`, `captureVersion`, `node`, `esbuild` version, and full
per-scenario numbers. PRs that change bundle sizes must update this
file in the same commit (CI enforces).
