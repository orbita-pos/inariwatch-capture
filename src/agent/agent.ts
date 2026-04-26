/**
 * Peer agent orchestrator.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.
 *
 * Flow:
 *   1. Build system + user prompts. The system prompt + tool schemas form
 *      the cache prefix (cache_control: ephemeral). Per-event content goes
 *      after the breakpoint so cache hit rate stays high (~95% expected).
 *   2. Single tool-use loop, max 4 iterations or `deadlineMs`, whichever
 *      hits first. Each iteration:
 *        a. Send messages to OpenAI.
 *        b. If choice.finish_reason === "tool_calls", run them (in-process,
 *           ~1ms each), feed results back as tool messages, repeat.
 *        c. If finish_reason === "stop", parse hypotheses out of the final
 *           assistant message and return.
 *   3. On deadline, return partial hypotheses (or empty array) — never
 *      throw. The peer is best-effort by design (Q5.3 acceptance).
 */

import type { ErrorEvent, Hypothesis } from "../types.js"
import {
  TOOL_SCHEMAS,
  diffSinceDeploy,
  evaluateInFrame,
  getLocalsAtFrame,
  matchFingerprint,
  type ToolResult,
} from "./tools.js"
import {
  OpenAIClient,
  type ChatMessage,
  type ChatContentPart,
  type ToolCall,
} from "./openai.js"

const MAX_TOOL_ITERATIONS = 4
const SYSTEM_PROMPT =
  `You are a forensic error-diagnosis assistant embedded in a Node.js process.
You see ONE error event at a time. Use the available tools to inspect locals,
match against community-known errors, and check what changed in the last
deploy. Then produce up to 3 ranked hypotheses for the root cause.

Output format (strict): a JSON array of objects with these fields, NOTHING else:
  [
    {
      "text": string,            // 1 sentence root-cause hypothesis
      "prior": number,           // 0..1 — your prior probability
      "cites": string[],         // JSONPaths into the event you used as evidence
      "confidence": number,      // 0..1 — confidence after tool use
      "source": "local_agent"
    },
    ...
  ]

Constraints:
  - Do NOT include any prose outside the JSON array.
  - Order by prior * confidence descending.
  - At most 3 entries.
  - cites must be real JSONPaths that exist in the event you were given.
  - If you can't form a hypothesis with reasonable confidence, return [].`

export interface PeerAgentConfig {
  /** OpenAI API key — required. */
  apiKey: string
  /** Model override. Default: gpt-5.4. */
  model?: string
  /** OpenAI base URL override (Azure / proxy). */
  baseUrl?: string
  /** Hard deadline for the entire diagnose call. Default: 1500ms. */
  deadlineMs?: number
  /** Optional debug logger; called with structured events. */
  debug?: (msg: string, ctx?: Record<string, unknown>) => void
}

export class PeerAgent {
  private readonly client: OpenAIClient
  private readonly deadlineMs: number
  private readonly debug?: PeerAgentConfig["debug"]

  constructor(opts: PeerAgentConfig) {
    this.client = new OpenAIClient({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      deadlineMs: opts.deadlineMs,
    })
    this.deadlineMs = opts.deadlineMs ?? 1500
    this.debug = opts.debug
  }

  /**
   * Diagnose an event. Returns a hypotheses array (possibly empty) within
   * the deadline. Never throws — all errors are swallowed and logged via
   * the optional debug callback.
   */
  async diagnose(event: ErrorEvent): Promise<Hypothesis[]> {
    const t0 = Date.now()
    const remaining = (): number => Math.max(0, this.deadlineMs - (Date.now() - t0))

    try {
      const messages: ChatMessage[] = buildInitialMessages(event)
      let hypotheses: Hypothesis[] = []

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        if (remaining() < 100) {
          this.debug?.("peer-agent: deadline exceeded mid-loop", { iteration: i })
          break
        }

        const res = await this.client.chat({
          messages,
          tools: TOOL_SCHEMAS.map((s) => ({
            type: "function" as const,
            function: { name: s.name, description: s.description, parameters: s.parameters },
          })),
        })

        const choice = res.choices[0]
        if (!choice) break
        const msg = choice.message

        if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
          messages.push({
            role: "assistant",
            content: msg.content ?? "",
            tool_calls: msg.tool_calls,
          })
          for (const call of msg.tool_calls) {
            const result = runTool(event, call)
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result),
            })
          }
          continue
        }

        // finish_reason === "stop" or unexpected — try to parse and exit
        if (typeof msg.content === "string") {
          hypotheses = parseHypotheses(msg.content)
        }
        break
      }

      this.debug?.("peer-agent: diagnose complete", {
        durationMs: Date.now() - t0,
        hypothesisCount: hypotheses.length,
      })
      return hypotheses
    } catch (err) {
      this.debug?.("peer-agent: diagnose failed", {
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }
}

function buildInitialMessages(event: ErrorEvent): ChatMessage[] {
  // System prompt + tool schemas → cached prefix.
  // Event payload → after the breakpoint, so each error pays only the
  // delta tokens.
  const cachedPrefix: ChatContentPart[] = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ]
  return [
    { role: "system", content: cachedPrefix },
    { role: "user", content: serializeEventForPrompt(event) },
  ]
}

function serializeEventForPrompt(event: ErrorEvent): string {
  // Strip rrweb / substrate binary blobs — they're useless to the prompt
  // and balloon token count.
  const slim: Record<string, unknown> = {
    title: event.title,
    body: event.body?.slice(0, 4000),
    fingerprint: event.fingerprint,
    severity: event.severity,
    runtime: event.runtime,
    routePath: event.routePath,
    git: event.git,
    breadcrumbs: event.breadcrumbs?.slice(-15),
    request: event.request,
    runtimeSnap: event.runtimeSnap,
    precursors: event.precursors,
    forensics: event.forensics,
    sourceContext: event.sourceContext,
    fleetMatch: event.fleetMatch,
  }
  return `Diagnose this error event:\n\n${JSON.stringify(slim, null, 2)}`
}

function runTool(event: ErrorEvent, call: ToolCall): ToolResult {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch {
    return { ok: false, error: `tool args were not valid JSON: ${call.function.arguments.slice(0, 80)}` }
  }
  switch (call.function.name) {
    case "getLocalsAtFrame":
      return getLocalsAtFrame(event, Number(args.frameIndex ?? 0))
    case "evaluateInFrame":
      return evaluateInFrame(event, Number(args.frameIndex ?? 0), String(args.expression ?? ""))
    case "matchFingerprint":
      return matchFingerprint(event, String(args.fingerprint ?? event.fingerprint))
    case "diffSinceDeploy":
      return diffSinceDeploy(event)
    default:
      return { ok: false, error: `unknown tool: ${call.function.name}` }
  }
}

function parseHypotheses(raw: string): Hypothesis[] {
  // The model is instructed to return strict JSON, but defensive parsing
  // anyway — wrap in regex extract for the common case where it adds a
  // ```json fence.
  const stripped = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Hypothesis[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    if (typeof e.text !== "string") continue
    const prior = clamp01(toNumber(e.prior))
    const confidence = clamp01(toNumber(e.confidence))
    if (prior === null || confidence === null) continue
    const cites = Array.isArray(e.cites)
      ? e.cites.filter((c): c is string => typeof c === "string")
      : []
    out.push({
      text: e.text,
      prior,
      confidence,
      cites,
      source: "local_agent",
    })
    if (out.length >= 3) break
  }
  return out
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function clamp01(v: number | null): number | null {
  if (v === null) return null
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}
