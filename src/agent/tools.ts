/**
 * Local tools the peer agent can invoke at diagnose time.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.
 *
 * All tools are in-process (no network) so the agent loop stays under the
 * 1.5s deadline. Network-bound work (OpenAI call) lives in `agent.ts`.
 *
 * The 4 tools mirror the SKYNET_MASTER_PLAN §3 spec:
 *   1. getLocalsAtFrame      — pulls locals out of `event.forensics`
 *   2. evaluateInFrame       — sandboxed `inspector.Session` post-mortem eval
 *   3. matchFingerprint      — checks the SDK's local SQLite cache (or
 *                              event.fleetMatch when bloom integration ran)
 *   4. diffSinceDeploy       — emits `git log` between `event.git.commit`
 *                              and the prior deploy SHA stored in env
 */

import type { ErrorEvent, SerializedValue } from "../types.js"

// ── Tool result types ─────────────────────────────────────────────────────

export interface ToolErrorResult {
  ok: false
  error: string
}

export interface GetLocalsResult {
  ok: true
  frameIndex: number
  locals: Record<string, SerializedValue>
}

export interface EvaluateInFrameResult {
  ok: true
  frameIndex: number
  expression: string
  value: SerializedValue
}

export interface MatchFingerprintResult {
  ok: true
  fingerprint: string
  match: {
    bloomHit: boolean
    communityFixId?: string
    teamsHit?: number
  } | null
}

export interface DiffSinceDeployResult {
  ok: true
  fromSha: string
  toSha: string | null
  diff: string
}

export type ToolResult =
  | GetLocalsResult
  | EvaluateInFrameResult
  | MatchFingerprintResult
  | DiffSinceDeployResult
  | ToolErrorResult

// ── Tool implementations ──────────────────────────────────────────────────

export function getLocalsAtFrame(
  event: ErrorEvent,
  frameIndex: number,
): GetLocalsResult | ToolErrorResult {
  const locals = event.forensics?.locals?.[String(frameIndex)]
  if (!locals) {
    return {
      ok: false,
      error: `no locals captured for frame ${frameIndex} (forensics integration may not be installed)`,
    }
  }
  return { ok: true, frameIndex, locals }
}

/**
 * Sandboxed eval against an inspector.Session-captured frame.
 *
 * This is intentionally a stub in the v0.1 release: the underlying
 * post-mortem eval requires the `@inariwatch/node-forensic` package's
 * Session to still be attached when the tool fires, which only holds when
 * the agent runs synchronously after the throw. Async agent loops that
 * cross task boundaries lose the stack frames.
 *
 * For v0.1 we surface a structured "unsupported" result so the agent
 * learns not to call this tool, instead of throwing. The stub will be
 * replaced with the real impl when capture-forensic ships its
 * `evalInFrame()` export. Tracked under SKYNET_MASTER_PLAN §3 #2.
 */
export function evaluateInFrame(
  _event: ErrorEvent,
  _frameIndex: number,
  _expression: string,
): EvaluateInFrameResult | ToolErrorResult {
  return {
    ok: false,
    error:
      "evaluateInFrame: inspector.Session post-mortem eval not yet wired (see capture-forensic). Available in capture-agent >= 0.2.0.",
  }
}

export function matchFingerprint(
  event: ErrorEvent,
  fingerprint: string,
): MatchFingerprintResult {
  // If the bloom-filter integration (Q5.4) already ran, surface its result.
  // Otherwise return null — the caller may still consult community fixes
  // server-side after egress.
  if (event.fleetMatch && event.fingerprint === fingerprint) {
    return {
      ok: true,
      fingerprint,
      match: {
        bloomHit: event.fleetMatch.bloomHit,
        communityFixId: event.fleetMatch.communityFixId,
        teamsHit: event.fleetMatch.teamsHit,
      },
    }
  }
  return { ok: true, fingerprint, match: null }
}

/**
 * Emits a compact summary of git activity between the deploy that's
 * throwing and the prior known-good deploy. Source-of-truth for the prior
 * SHA is the `INARIWATCH_PRIOR_DEPLOY_SHA` env var, written by the deploy
 * script (e.g. Vercel's `pre-deploy` hook). Without it, we return a
 * structured "unknown" result rather than guessing.
 *
 * This deliberately does NOT shell out to `git log` from the SDK — most
 * production processes don't have a repo on disk. Instead, we rely on
 * `event.git.commit` (sent by the SDK, populated at build time) and the
 * env hint. Server-side enrichers can fetch the actual diff later.
 */
export function diffSinceDeploy(
  event: ErrorEvent,
): DiffSinceDeployResult | ToolErrorResult {
  const fromSha = event.git?.commit
  if (!fromSha) {
    return {
      ok: false,
      error: "diffSinceDeploy: no git.commit on event (capture/git.ts may have skipped collection)",
    }
  }
  const priorSha = process.env.INARIWATCH_PRIOR_DEPLOY_SHA ?? null
  if (!priorSha) {
    return {
      ok: true,
      fromSha,
      toSha: null,
      diff: "(prior deploy SHA unknown; set INARIWATCH_PRIOR_DEPLOY_SHA in your deploy hook to enable diff)",
    }
  }
  return {
    ok: true,
    fromSha,
    toSha: priorSha,
    diff: `(server-side enrichment will fetch ${priorSha}..${fromSha} from origin; SDK does not shell out)`,
  }
}

// ── Tool registry ──────────────────────────────────────────────────────────

/** OpenAI-style tool schema descriptor. */
export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "getLocalsAtFrame",
    description:
      "Return the captured local variables at a specific stack frame. Use this when a hypothesis depends on the value of a local variable at throw time.",
    parameters: {
      type: "object",
      properties: {
        frameIndex: { type: "integer", description: "Stack frame index, 0 = throwing frame" },
      },
      required: ["frameIndex"],
    },
  },
  {
    name: "evaluateInFrame",
    description:
      "Evaluate an arbitrary JavaScript expression against the captured frame state. Use sparingly — only when locals alone are insufficient.",
    parameters: {
      type: "object",
      properties: {
        frameIndex: { type: "integer", description: "Stack frame index" },
        expression: { type: "string", description: "JavaScript expression to evaluate" },
      },
      required: ["frameIndex", "expression"],
    },
  },
  {
    name: "matchFingerprint",
    description:
      "Check whether other workspaces have hit this exact error fingerprint and have a community fix recorded.",
    parameters: {
      type: "object",
      properties: {
        fingerprint: { type: "string", description: "SHA-256 error fingerprint" },
      },
      required: ["fingerprint"],
    },
  },
  {
    name: "diffSinceDeploy",
    description:
      "Get a summary of git changes between the failing deploy and the prior known-good deploy. Useful for hypothesizing regressions.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
]
