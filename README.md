# @inariwatch/capture

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — zero dependencies, works everywhere Node runs.

## Quick start

```bash
npx @inariwatch/capture
```

One command. Auto-detects your framework, installs, and starts capturing errors to your terminal. No signup. No config.

When you're ready for the cloud dashboard, add one env var:

```env
INARIWATCH_DSN=https://app.inariwatch.com/api/webhooks/capture/YOUR_ID
```

## Supported frameworks

`npx @inariwatch/capture` auto-detects and configures any of these:

| Framework | Plugin | Runtime |
|---|---|---|
| Next.js | `@inariwatch/capture/next` | Node + Edge |
| Vite | `@inariwatch/capture/vite` | Node |
| Nuxt 3 | `@inariwatch/capture/nuxt` | Node |
| Remix / SvelteKit / Astro | `@inariwatch/capture/vite` | Node |
| SolidStart / Qwik | `@inariwatch/capture/vite` | Node |
| webpack (CRA, Vue CLI, Angular) | `@inariwatch/capture/webpack` | Node |
| Express / Fastify / Koa / Hono | `@inariwatch/capture/auto` | Node |
| Bun / Deno | `@inariwatch/capture/auto` | Node-compat |
| Python / Go / Rust apps with Node instrumentation | — | Parent process |

### Next.js

```typescript
// next.config.ts
import { withInariWatch } from "@inariwatch/capture/next"
export default withInariWatch(nextConfig)
```

```typescript
// instrumentation.ts
import "@inariwatch/capture/auto"
import { captureRequestError } from "@inariwatch/capture"
export const onRequestError = captureRequestError
```

### Vite (covers Vite + Remix + SvelteKit + Astro + SolidStart + Qwik)

```typescript
// vite.config.ts
import { defineConfig } from "vite"
import { inariwatchVite } from "@inariwatch/capture/vite"

export default defineConfig({
  plugins: [inariwatchVite()],
})
```

### Nuxt 3

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@inariwatch/capture/nuxt"],
})
```

### Astro (Vite under the hood)

```typescript
// astro.config.mjs
import { defineConfig } from "astro/config"
import { inariwatchVite } from "@inariwatch/capture/vite"

export default defineConfig({
  vite: { plugins: [inariwatchVite()] },
})
```

### webpack (CRA, Vue CLI, Angular, raw webpack)

```javascript
// webpack.config.js
const { withInariWatchWebpack } = require("@inariwatch/capture/webpack")
module.exports = withInariWatchWebpack({
  // your existing webpack config
})
```

### Express / Fastify / Koa / Hono / any Node.js app

```bash
node --import @inariwatch/capture/auto app.js
```

Or in package.json:

```json
{ "scripts": { "start": "node --import @inariwatch/capture/auto src/index.js" } }
```

All framework plugins inject git context (commit, branch, message) at build time and mark capture as external on server bundles so its `node:` builtin imports don't leak into client or edge chunks.

## Automatic context

Every error includes rich context automatically — no code changes needed:

| Context | How | What the AI sees |
|---------|-----|-----------------|
| **Git** | Injected at build time by `withInariWatch` | `commit f5eface on main — "refactor session handling"` |
| **Breadcrumbs** | Auto-intercepts `console.log` + `fetch` | Last 30 actions before the crash |
| **Environment** | Reads `process` + `os` at crash time | Node version, memory, CPU, uptime |
| **Request** | Set via middleware or `setRequestContext()` | Method, URL, headers, body (redacted) |
| **User** | Set via `setUser()` | User ID + role (email stripped) |
| **Tags** | Set via `setTag()` | Custom key-value pairs |

Sensitive data is scrubbed automatically: Bearer tokens, JWTs, passwords, API keys, credit card numbers, connection strings, and auth headers are all redacted before leaving your app.

## API

### `init(config?)`

Initialize the SDK. Call once at app startup. All options are optional — config is read from env vars.

| Option | Type | Description |
|--------|------|-------------|
| `dsn` | `string` | Capture endpoint (default: `INARIWATCH_DSN` env var) |
| `environment` | `string` | Environment tag (default: `INARIWATCH_ENVIRONMENT` or `NODE_ENV`) |
| `release` | `string` | Release version — also triggers a deploy marker |
| `substrate` | `boolean \| object` | Enable I/O recording (requires `@inariwatch/substrate-agent`) |
| `redact` | `boolean \| RedactConfig` | Opt-in in-process PII / secret scrub. See [PII redaction](#pii-redaction-in-process-opt-in). |
| `debug` | `boolean` | Log transport errors to console |
| `silent` | `boolean` | Suppress all console output |
| `beforeSend` | `(event) => event \| null` | Transform or drop events before sending |

### `captureException(error, context?)`

```typescript
try {
  await riskyOperation();
} catch (err) {
  captureException(err as Error);
}
```

### `captureLog(message, level?, metadata?)`

```typescript
captureLog("DB timeout", "error", { host: "db.example.com", latency: 5200 });
```

### `captureMessage(message, level?)`

```typescript
captureMessage("Deploy started", "info");
```

### `addBreadcrumb({ message, category?, level?, data? })`

```typescript
addBreadcrumb({ category: "auth", message: "User logged in", data: { userId: "123" } });
```

Console and fetch breadcrumbs are captured automatically.

### `setUser({ id?, role? })`

```typescript
setUser({ id: "user_456", role: "admin" });
```

Email is stripped by default for privacy.

### `setTag(key, value)`

```typescript
setTag("feature", "checkout");
```

### `setRequestContext({ method, url, headers?, body? })`

```typescript
setRequestContext({ method: "POST", url: "/api/users", body: req.body });
```

Headers with tokens/keys/secrets are redacted automatically. Body fields like `password`, `credit_card`, `ssn` are scrubbed.

### `flush()`

Wait for pending events before process exit.

```typescript
await flush();
```

## Substrate (full I/O recording)

Capture every HTTP call, DB query, and file operation alongside your errors:

```bash
npm install @inariwatch/substrate-agent
```

```env
INARIWATCH_SUBSTRATE=true
```

When `captureException()` fires, the last 60 seconds of I/O are uploaded with the error.

## PII redaction (in-process, opt-in)

Scrub emails, phone numbers, credit cards, JWTs, and API keys from the outgoing payload **before it leaves your process** — InariWatch's cloud never sees them.

```typescript
init({ redact: true })
```

Or via env var (works with `import "@inariwatch/capture/auto"`):

```env
INARIWATCH_REDACT=true
```

Regex-based, deterministic, zero new deps. No ML model is bundled — patterns are auditable in `src/redact/patterns.ts`.

**What's scrubbed by default:**

| Pattern | Example match | Replacement |
|---------|---------------|-------------|
| Email | `user@example.com` | `[REDACTED_EMAIL]` |
| Phone | `(415) 555-1234` / `+52 555 123 4567` | `[REDACTED_PHONE]` |
| US SSN | `123-45-6789` | `[REDACTED_SSN]` |
| Credit card | `4111 1111 1111 1111` (Luhn-validated) | `[REDACTED_CREDIT_CARD]` |
| JWT | `eyJ…⁠.…⁠.…` | `[REDACTED_JWT]` |
| OpenAI key | `sk-proj-…` | `[REDACTED_OPENAI_KEY]` |
| Stripe key | `sk_live_…` / `pk_live_…` | `[REDACTED_STRIPE_KEY]` |
| GitHub token | `ghp_…` / `gho_…` / `ghs_…` | `[REDACTED_GITHUB_TOKEN]` |
| AWS access key | `AKIA…` | `[REDACTED_AWS_ACCESS_KEY]` |
| Google API key | `AIza…` | `[REDACTED_GOOGLE_API_KEY]` |
| Slack token | `xoxb-…` / `xoxp-…` | `[REDACTED_SLACK_TOKEN]` |
| Sensitive object keys | `{ password, token, api_key, authorization, cookie, … }` | whole value → `[REDACTED_VALUE]` |

**Off by default** (toggle on if your compliance posture requires it):

| Option | Why off | Toggle |
|--------|---------|--------|
| IPv4 addresses | Most users want IPs visible for routing/abuse debugging | `redact: { redactIPs: true }` |
| AWS secret-shape (40-char base64) | Collides with paths and binary blobs | `redact: { redactAwsSecrets: true }` |

**Configuration:**

```typescript
init({
  redact: {
    // Skip redaction at these dot-paths even if the value matches.
    allowlist: ["request.headers.user-agent", "metadata.publicId"],
    // Append project-specific patterns.
    customPatterns: [
      { label: "EMPLOYEE_ID", regex: /EMP-\d{5,}/g },
    ],
    // Hash mode — append an FNV-1a fingerprint so you can correlate the
    // same redacted value across events without exposing it:
    //   "[REDACTED_EMAIL:a1b2c3d4]"
    hashMode: true,
  },
})
```

**Performance:** ~0.5ms p95 on a 5KB payload (well under the 5ms hot-path budget). Redacted events are tagged with `_meta.redact_applied: true` so server-side enrichment can skip paths that would re-derive PII.

**Disclaimer:** regex-based detection is high-precision but not exhaustive. For ML-grade entity detection, pair this with cloud-side redaction post-ingest. The trade-off this SDK makes is *zero new dependencies and full local control*.

## Environment variables

| Variable | Description |
|----------|-------------|
| `INARIWATCH_DSN` | Capture endpoint. Omit for local mode. |
| `INARIWATCH_ENVIRONMENT` | Environment tag (fallback: `NODE_ENV`) |
| `INARIWATCH_RELEASE` | Release version |
| `INARIWATCH_SUBSTRATE` | Set to `"true"` to enable I/O recording |
| `INARIWATCH_REDACT` | Set to `"true"` to enable in-process PII redaction |

## Source-map debug IDs (TC39 ecma426)

All four bundler plugins (Vite, Webpack, Next.js, Nuxt) emit TC39
[debug-id](https://github.com/tc39/ecma426/blob/main/proposals/debug-id.md)
magic comments + sourcemap fields per chunk by default. A debug ID is a
deterministic UUIDv5 computed from the chunk's content, so the SDK's
runtime + the symbolicator both arrive at the same ID without any
release-version coordination — and it survives file renames,
hash-suffixed asset paths, and CDN cache busts.

Opt out per-plugin if your custom symbolicator can't tolerate the
trailing magic comment:

```typescript
// Vite
inariwatchVite({ injectDebugIds: false })

// Webpack
withInariWatchWebpack(config, { injectDebugIds: false })

// Next.js
withInariWatch(nextConfig, { injectDebugIds: false })
```

Next 15+ Turbopack: detected automatically; the debug-id step is a
no-op there (Turbopack's plugin API isn't webpack-compatible). The
rest of the plugin's work — git env injection, SSR external marking —
continues to function. A native Turbopack hook is on the roadmap.

## Wire compression (opt-in)

Set `INARIWATCH_COMPRESSION=br` (or `init({ compression: "br" })`) to
brotli-compress payloads ≥ 1 KB before the POST. Saves 70-85% of
bandwidth on large events (Substrate-attached crashes, big
breadcrumb timelines). Below the threshold, or when compression
wouldn't beat raw JSON by ≥ 10%, the SDK skips compression
automatically. Browser + edge runtimes silently skip too (no
`node:zlib`). The InariWatch dashboard endpoint understands
`Content-Encoding: br` as of v0.12.0 — for self-hosted ingest
endpoints, verify yours decompresses before flipping the flag.

## Diagnose your install

```bash
npx @inariwatch/capture doctor
```

Runs ten read-only checks against your project — Node version, framework
detection, plugin wired, `instrumentation.ts` set up, `INARIWATCH_DSN`
resolved, DSN endpoint reachable, dev-log state, MCP IDE config. Each
result is `ok` / `info` / `warn` / `fail` with a one-line hint when
something is off. Exits `1` on failures, `0` otherwise — safe to wire
into CI:

```bash
npx @inariwatch/capture doctor --offline    # skip the network probe
```

## IDE integration via MCP (Cursor / Claude Code / Windsurf / Copilot Agent)

Run your app with the dev log on:

```bash
INARIWATCH_DEV_LOG=1 npm run dev
```

Every captured error is appended to `.inariwatch/errors.jsonl` in the
project root. Then point your editor's MCP client at the SDK's stdio
server. For Cursor (`~/.cursor/mcp.json`) or Claude Code:

```json
{
  "mcpServers": {
    "inariwatch": {
      "command": "npx",
      "args": ["@inariwatch/capture", "mcp"]
    }
  }
}
```

The agent now has three tools:

- `inari_recent_errors({ limit?, severity? })` — newest events first.
- `inari_get_error({ fingerprint })` — full event by fingerprint (prefix
  match works).
- `inari_clear_log()` — truncate the JSONL after a fix lands.

Zero deps, zero network — the MCP server reads the same JSONL file the
SDK writes locally. Override the path with `INARIWATCH_DEV_LOG_PATH`.

## Exports

| Import | Description |
|--------|-------------|
| `@inariwatch/capture` | SDK — `init`, `captureException`, `captureLog`, `addBreadcrumb`, `setUser`, `setTag`, `setRequestContext`, `flush` |
| `@inariwatch/capture/auto` | Auto-init on import — config from env vars |
| `@inariwatch/capture/browser` | Browser auto-init (side-effect import). Reads config from `window.__INARIWATCH__` and `<meta name="inariwatch:*">` tags. Lean v2 client, fetch + XHR breadcrumbs, FullTrace session header. |
| `@inariwatch/capture/shield` | Runtime security — source-to-sink attack detection |
| `@inariwatch/capture/next` | Next.js plugin — `withInariWatch()` |
| `@inariwatch/capture/vite` | Vite plugin — `inariwatchVite()` (covers Nuxt/Remix/SvelteKit/Astro/SolidStart/Qwik) |
| `@inariwatch/capture/webpack` | webpack wrapper — `withInariWatchWebpack()` (covers CRA/Vue CLI/Angular) |
| `@inariwatch/capture/nuxt` | Nuxt 3 module — add to `modules: []` |

## Features

- **Zero config** — `npx @inariwatch/capture` and you're done
- **Zero dependencies** — just `fetch` (Node 18+)
- **Works with every major framework** — Next, Vite, Nuxt, Remix, SvelteKit, Astro, webpack, Express, Fastify, Node
- **Automatic context** — git, breadcrumbs, environment, request, user, tags
- **Privacy by default** — secrets, PII, and auth headers scrubbed automatically
- **Env var driven** — no DSN in source code, `INARIWATCH_DSN` from env
- **Local mode** — works without signup, errors print to terminal
- **Substrate** — full I/O recording with one env var
- **Deploy markers** — setting `release` sends a deploy event
- **Retry buffer** — failed events retry automatically
- **HMAC signing** — events signed for webhook verification

## Session replay

Session replay lives in a separate package so the core SDK stays lean (~32 KB gzipped). Install only when you need it:

```bash
npm install @inariwatch/capture-replay
```

Or let the CLI do it interactively:

```bash
npx @inariwatch/capture init
# → "Enable session replay? [y/N]"
```

### Usage (Next.js App Router)

```tsx
// app/capture-init.tsx
"use client"
import { useEffect } from "react"

export function CaptureInit() {
  useEffect(() => {
    void (async () => {
      const [{ init }, { replayIntegration }] = await Promise.all([
        import("@inariwatch/capture"),
        import("@inariwatch/capture-replay"),
      ])
      init({
        dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
        projectId: process.env.NEXT_PUBLIC_INARIWATCH_PROJECT_ID,
        integrations: [replayIntegration()],
      })
    })()
  }, [])
  return null
}
```

```tsx
// app/layout.tsx
import { CaptureInit } from "./capture-init"

export default function RootLayout({ children }) {
  return <html><body><CaptureInit />{children}</body></html>
}
```

See [@inariwatch/capture-replay](https://www.npmjs.com/package/@inariwatch/capture-replay) for the full options list (PII classifier, block duration, mask selectors).

## Integration pattern

The `integrations: [...]` array in `init()` is how plugin-style extensions hook into capture. Any package exporting an `Integration`-shaped object can be registered:

```ts
import { init } from "@inariwatch/capture"
import { replayIntegration } from "@inariwatch/capture-replay"

init({
  dsn: "...",
  integrations: [
    replayIntegration({ piiClassifier: "ai" }),
    // future: performanceIntegration(), feedbackIntegration(), ...
  ],
})
```

Core capture has zero knowledge of replay or any future integration — each lives in its own package and pays zero bundle cost for users who don't opt in.

## License

MIT
