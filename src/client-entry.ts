/**
 * Browser-safe subset of @inariwatch/capture. Exports only what a client
 * component can safely import without pulling in Node-only modules like
 * `child_process` (git), `os` (environment), or `mysql2` (shield sinks).
 *
 * Usage from React client components:
 *   import { init } from "@inariwatch/capture/client"
 *   import { replayIntegration } from "@inariwatch/capture-replay"
 *   init({ dsn: "...", integrations: [replayIntegration()] })
 *
 * Server-side code (Next.js instrumentation.ts, API routes) keeps using
 * the main `@inariwatch/capture` entry which exposes `withInariWatch`,
 * `captureRequestError`, and the shield.
 */

export { init, captureException, captureMessage, captureLog, flush } from "./client.js"
export { addBreadcrumb } from "./breadcrumbs.js"
export { setUser, setTag, setRequestContext, runWithScope } from "./scope.js"
export type {
  CaptureConfig,
  ErrorEvent,
  SubstrateConfig,
  SessionConfig,
  SessionEvent,
  Integration,
  Breadcrumb,
} from "./types.js"
