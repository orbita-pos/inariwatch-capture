/**
 * Minimal OpenAI client for the local peer agent.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.
 *
 * Why a hand-rolled fetch instead of the official SDK:
 *   - The official `openai` npm pkg is ~6 MB and pulls Node-specific deps
 *     that bloat the SDK install for end users who never opt in to the peer.
 *   - We need exactly one endpoint (chat completions w/ tools) and the
 *     prompt-cache breakpoint header. Hand-rolled keeps capture-agent at
 *     ~30 KB total.
 *   - Mirrors the prompt-caching pattern used in
 *     `web/lib/ai/remediate.ts` (commit `d5ea113`) — same breakpoint
 *     placement so the user's account benefits from the cache on the
 *     server side too.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_MODEL = "gpt-5.4"
const DEFAULT_DEADLINE_MS = 1500

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ChatContentPart[]
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: ToolCall[]
  /** Present on tool messages — links the result to the call that asked. */
  tool_call_id?: string
}

export interface ChatContentPart {
  type: "text"
  text: string
  /**
   * OpenAI-compatible prompt-cache breakpoint marker. Mirrors Anthropic's
   * `cache_control: { type: "ephemeral" }`. The server caches the prefix up
   * to and including the marked content part; subsequent calls reuse it.
   */
  cache_control?: { type: "ephemeral" }
}

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: Array<{
    type: "function"
    function: { name: string; description: string; parameters: unknown }
  }>
  /** 0..2 — diagnostic prompts work best at low temperature. */
  temperature?: number
  /** Hard cap so the agent never burns budget on a runaway response. */
  max_tokens?: number
}

export interface ChatChoice {
  index: number
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
  message: {
    role: "assistant"
    content: string | null
    tool_calls?: ToolCall[]
  }
}

export interface ChatResponse {
  id: string
  model: string
  choices: ChatChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens: number }
  }
}

export interface OpenAIClientOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  /** Hard deadline for the entire request. Default: 1500ms (Q5.3 acceptance). */
  deadlineMs?: number
}

export class OpenAIClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly model: string
  private readonly deadlineMs: number

  constructor(opts: OpenAIClientOptions) {
    if (!opts.apiKey) throw new Error("OpenAIClient: apiKey is required")
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.model = opts.model ?? DEFAULT_MODEL
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  }

  /** Make a single chat request. Throws on HTTP error or deadline. */
  async chat(req: Omit<ChatRequest, "model"> & { model?: string }): Promise<ChatResponse> {
    const body: ChatRequest = {
      model: req.model ?? this.model,
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.max_tokens ?? 600,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.deadlineMs),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`)
    }
    return (await res.json()) as ChatResponse
  }

  /** Default deadline (test introspection). */
  get deadline(): number {
    return this.deadlineMs
  }
}
