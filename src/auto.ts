/**
 * Auto-initializing import — just import this module and capture starts.
 *
 * Usage:
 *   import "@inariwatch/capture/auto"
 *
 * Or via CLI:
 *   node --import @inariwatch/capture/auto app.js
 *
 * Reads config from environment variables:
 *   INARIWATCH_DSN         — capture endpoint (omit for local mode)
 *   INARIWATCH_ENVIRONMENT — environment tag (fallback: NODE_ENV)
 *   INARIWATCH_RELEASE     — release version
 *   INARIWATCH_SUBSTRATE   — set to "true" to enable I/O recording
 */

import { init } from "./client.js"

init({
  release: process.env.INARIWATCH_RELEASE,
  substrate: process.env.INARIWATCH_SUBSTRATE === "true",
})
