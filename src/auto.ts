// Auto-initializing import. See README §Auto-init for env var contract.
//
// History (2026-04-26): the v2 ecosystem (agent / fleet / forensic) used to
// live in three separate npm packages and was loaded via `await import()`
// against optional peer deps. We collapsed them into this same package to
// keep the install story simple — one `npm i @inariwatch/capture` and you
// have everything. Each integration is now a direct relative import; the
// `INARIWATCH_CAPTURE_V2=true` env var still gates whether they wire up,
// so users who don't opt in pay zero runtime cost (the modules are not
// imported when the flag is off).
import type { Integration } from "./types.js"
import { init } from "./client.js"

interface Ctx { debug: boolean }

function warn(ctx: Ctx, msg: string, err?: unknown): void {
  if (!ctx.debug) return
  console.warn(`[@inariwatch/capture] ${msg}`, err instanceof Error ? err.message : err ?? "")
}

async function loadAgent(ctx: Ctx): Promise<Integration | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.INARIWATCH_PEER_AGENT_API_KEY
  if (!apiKey) { warn(ctx, "v2 agent: OPENAI_API_KEY not set, skipping"); return null }
  try {
    const mod = await import("./agent/index.js")
    return mod.peerAgentIntegration?.({
      apiKey,
      model: process.env.INARIWATCH_PEER_AGENT_MODEL,
      baseUrl: process.env.INARIWATCH_PEER_AGENT_BASE_URL,
    }) ?? null
  } catch (err) { warn(ctx, "v2 agent failed to load", err); return null }
}

async function loadFleet(ctx: Ctx): Promise<Integration | null> {
  try {
    const mod = await import("./fleet/index.js")
    return mod.fleetBloomIntegration?.({
      baseUrl: process.env.INARIWATCH_FLEET_BASE_URL,
      contribute: process.env.INARIWATCH_FLEET_CONTRIBUTE === "true",
    }) ?? null
  } catch (err) { warn(ctx, "v2 fleet failed to load", err); return null }
}

async function loadForensic(ctx: Ctx): Promise<Integration | null> {
  try {
    const mod = await import("./forensic/index.js")
    return mod.forensicIntegration?.() ?? null
  } catch (err) { warn(ctx, "v2 forensic failed to load", err); return null }
}

async function loadV2Integrations(): Promise<Integration[]> {
  const ctx: Ctx = { debug: process.env.INARIWATCH_DEBUG === "1" }
  const xs = await Promise.all([loadForensic(ctx), loadFleet(ctx), loadAgent(ctx)])
  return xs.filter((x): x is Integration => x !== null)
}

const baseConfig = {
  release: process.env.INARIWATCH_RELEASE,
  substrate: process.env.INARIWATCH_SUBSTRATE === "true",
}

const v2Flag = process.env.INARIWATCH_CAPTURE_V2
const v2Enabled = v2Flag === "true" || v2Flag === "1" || v2Flag === "yes"

let integrations: Integration[] = []
if (v2Enabled) {
  // Top-level await: the integrations are now in-package, so dynamic
  // import resolves sub-ms when the flag is on, and is never reached
  // when the flag is off — bundlers tree-shake the agent/fleet/forensic
  // dirs out entirely for non-opt-in users.
  integrations = await loadV2Integrations()
}

init({ ...baseConfig, integrations })
