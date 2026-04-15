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

## Environment variables

| Variable | Description |
|----------|-------------|
| `INARIWATCH_DSN` | Capture endpoint. Omit for local mode. |
| `INARIWATCH_ENVIRONMENT` | Environment tag (fallback: `NODE_ENV`) |
| `INARIWATCH_RELEASE` | Release version |
| `INARIWATCH_SUBSTRATE` | Set to `"true"` to enable I/O recording |

## Exports

| Import | Description |
|--------|-------------|
| `@inariwatch/capture` | SDK — `init`, `captureException`, `captureLog`, `addBreadcrumb`, `setUser`, `setTag`, `setRequestContext`, `flush` |
| `@inariwatch/capture/auto` | Auto-init on import — config from env vars |
| `@inariwatch/capture/browser` | Browser entry — error + unhandled rejection listeners |
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
