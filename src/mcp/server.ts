/**
 * Stdio MCP server for `@inariwatch/capture`.
 *
 * Spec: Model Context Protocol (Anthropic, Nov 2024) — JSON-RPC 2.0 over
 * stdio. Cursor 1.0+, Claude Code, Windsurf, Copilot Agent, and Raycast
 * all consume this transport.
 *
 * What it does:
 *   The user runs `INARIWATCH_DEV_LOG=1 npm run dev`. Every error their
 *   app captures gets appended to `.inariwatch/errors.jsonl` in the
 *   project's CWD (see `transport.ts:appendDevLog`). Then the user adds
 *   four lines to their IDE's MCP config:
 *
 *     {
 *       "mcpServers": {
 *         "inariwatch": {
 *           "command": "npx",
 *           "args": ["@inariwatch/capture", "mcp"]
 *         }
 *       }
 *     }
 *
 *   The IDE's coding agent now has tools to query live prod errors
 *   without leaving the editor. Closes the loop the audit identified
 *   ("80% of the work is done — the JSONL writer exists; the missing
 *   piece is exposing it as MCP").
 *
 * Protocol notes:
 *   - JSON-RPC 2.0 framing: each request and each response is one line
 *     of JSON on stdin/stdout (newline-delimited).
 *   - stderr is the only safe place to log — anything written to stdout
 *     that isn't a JSON-RPC frame breaks the client.
 *   - Notifications (no `id` field) get no response; requests with `id`
 *     always get exactly one response.
 *   - Method errors return `{ error: { code, message } }`, not throws.
 *
 * Zero deps — only `node:fs/promises`, `node:path`, `node:readline`.
 */

import { createInterface } from "node:readline"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

// ── Protocol types ──────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "@inariwatch/capture"
// Hard-coded so test snapshots don't bind to package.json reads at runtime.
// Bump in lock-step with package.json on each release.
const SERVER_VERSION = "0.11.1"

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: unknown
}

interface JsonRpcSuccess {
  jsonrpc: "2.0"
  id: number | string | null
  result: unknown
}

interface JsonRpcError {
  jsonrpc: "2.0"
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

// JSON-RPC 2.0 standard error codes.
const ERROR_PARSE = -32700
const ERROR_INVALID_REQUEST = -32600
const ERROR_METHOD_NOT_FOUND = -32601
const ERROR_INVALID_PARAMS = -32602
const ERROR_INTERNAL = -32603

// ── Tool definitions ────────────────────────────────────────────────────

interface ToolSchema {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

const TOOLS: ToolSchema[] = [
  {
    name: "inari_recent_errors",
    description:
      "Return the N most recent errors captured by the running app. " +
      "Reads `.inariwatch/errors.jsonl` (the dev-log written when " +
      "INARIWATCH_DEV_LOG=1 is set on the user's process). Each entry " +
      "includes title, severity, timestamp, fingerprint, the first 10 " +
      "stack frames, and any breadcrumbs / request context.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Number of recent events to return (default 10, max 100).",
        },
        severity: {
          type: "string",
          enum: ["critical", "error", "warning", "info", "debug"],
          description: "Filter by severity level.",
        },
      },
    },
  },
  {
    name: "inari_get_error",
    description:
      "Look up a single captured event by fingerprint (the deterministic " +
      "SHA-256 hash of its title + body shown in the dashboard). Returns " +
      "the full event with all context — useful when the agent already " +
      "has a fingerprint from a previous `inari_recent_errors` call.",
    inputSchema: {
      type: "object",
      properties: {
        fingerprint: {
          type: "string",
          description: "Event fingerprint (16-char hex prefix or full hash).",
        },
      },
      required: ["fingerprint"],
    },
  },
  {
    name: "inari_clear_log",
    description:
      "Truncate the dev-log JSONL so the next batch of errors starts " +
      "fresh. Useful after a fix lands and the agent wants to verify the " +
      "old errors no longer recur. Returns the number of events that " +
      "were cleared.",
    inputSchema: { type: "object", properties: {} },
  },
]

// ── Dev-log file resolution ─────────────────────────────────────────────

/**
 * Mirror of `transport.ts:appendDevLog`'s path resolution. Kept in this
 * module (not imported) so the MCP server stays a self-contained binary
 * that doesn't pull the rest of the SDK into the process.
 */
export function resolveDevLogPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return env.INARIWATCH_DEV_LOG_PATH ?? join(cwd, ".inariwatch", "errors.jsonl")
}

interface CapturedEvent {
  fingerprint?: string
  title?: string
  body?: string
  severity?: string
  timestamp?: string
  context?: unknown
  breadcrumbs?: unknown
  request?: unknown
  [key: string]: unknown
}

async function readDevLog(path: string): Promise<CapturedEvent[]> {
  if (!existsSync(path)) return []
  const raw = await readFile(path, "utf8")
  const out: CapturedEvent[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // Skip corrupt line — JSONL is best-effort, never fail the read.
    }
  }
  return out
}

function trimEventForMcp(ev: CapturedEvent): CapturedEvent {
  const stack = typeof ev.body === "string"
    ? ev.body.split("\n").slice(0, 10).join("\n")
    : ev.body
  return { ...ev, body: stack }
}

// ── Tool handlers ───────────────────────────────────────────────────────

interface ToolContext {
  devLogPath: string
}

async function toolRecentErrors(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const limit = clampInt(args.limit, 1, 100, 10)
  const severityFilter = typeof args.severity === "string" ? args.severity : undefined

  const events = await readDevLog(ctx.devLogPath)
  let filtered = events
  if (severityFilter) {
    filtered = filtered.filter((e) => e.severity === severityFilter)
  }
  const recent = filtered.slice(-limit).reverse().map(trimEventForMcp)

  if (recent.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: filtered === events
            ? `No errors captured yet. Set INARIWATCH_DEV_LOG=1 in the running app and re-run to populate ${ctx.devLogPath}.`
            : `No errors matched severity=${severityFilter}.`,
        },
      ],
    }
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ count: recent.length, events: recent }, null, 2),
      },
    ],
  }
}

async function toolGetError(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const fp = typeof args.fingerprint === "string" ? args.fingerprint : ""
  if (!fp) {
    throw new RpcMethodError(ERROR_INVALID_PARAMS, "fingerprint is required (string)")
  }
  const events = await readDevLog(ctx.devLogPath)
  const match = events.find(
    (e) => typeof e.fingerprint === "string" && (e.fingerprint === fp || e.fingerprint.startsWith(fp)),
  )
  if (!match) {
    return {
      content: [{ type: "text", text: `No event found with fingerprint matching "${fp}".` }],
    }
  }
  return {
    content: [{ type: "text", text: JSON.stringify(match, null, 2) }],
  }
}

async function toolClearLog(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const events = await readDevLog(ctx.devLogPath)
  await mkdir(ctx.devLogPath.replace(/[\\/][^\\/]+$/, ""), { recursive: true }).catch(() => {})
  await writeFile(ctx.devLogPath, "", "utf8")
  return {
    content: [{ type: "text", text: `Cleared ${events.length} event${events.length === 1 ? "" : "s"} from ${ctx.devLogPath}.` }],
  }
}

const TOOL_DISPATCH: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
> = {
  inari_recent_errors: toolRecentErrors,
  inari_get_error: toolGetError,
  inari_clear_log: toolClearLog,
}

// ── JSON-RPC handlers ──────────────────────────────────────────────────

class RpcMethodError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message)
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/**
 * Pure handler: takes a parsed JSON-RPC request and returns the response
 * (or `null` for notifications). Exported so tests can drive it without
 * spinning up actual stdio.
 */
export async function handleMessage(
  msg: JsonRpcRequest,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  // Notifications have no `id` member (per JSON-RPC 2.0 §4.1) and get no
  // response. `id: null` is a valid request — the spec allows null when
  // the caller doesn't need to correlate — and gets a response with id=null.
  const isNotification = msg.id === undefined
  const id = isNotification ? null : (msg.id as number | string | null)

  try {
    if (msg.jsonrpc !== "2.0") {
      throw new RpcMethodError(ERROR_INVALID_REQUEST, 'jsonrpc must be "2.0"')
    }
    if (typeof msg.method !== "string") {
      throw new RpcMethodError(ERROR_INVALID_REQUEST, "method must be a string")
    }

    switch (msg.method) {
      case "initialize": {
        if (isNotification) return null
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
          },
        }
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        // Ack-only.
        return null

      case "tools/list": {
        if (isNotification) return null
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } }
      }

      case "tools/call": {
        if (isNotification) return null
        const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
        if (typeof params.name !== "string") {
          throw new RpcMethodError(ERROR_INVALID_PARAMS, "tools/call: name is required")
        }
        const fn = TOOL_DISPATCH[params.name]
        if (!fn) {
          throw new RpcMethodError(ERROR_METHOD_NOT_FOUND, `tools/call: unknown tool "${params.name}"`)
        }
        const argsObj = (params.arguments ?? {}) as Record<string, unknown>
        const result = await fn(argsObj, ctx)
        return { jsonrpc: "2.0", id, result }
      }

      default:
        throw new RpcMethodError(ERROR_METHOD_NOT_FOUND, `unknown method "${msg.method}"`)
    }
  } catch (err) {
    if (isNotification) return null
    if (err instanceof RpcMethodError) {
      return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message, data: err.data } }
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: ERROR_INTERNAL, message: err instanceof Error ? err.message : String(err) },
    }
  }
}

// ── stdio runner ───────────────────────────────────────────────────────

/**
 * Bind to stdin/stdout and run the JSON-RPC loop. Returns when stdin
 * closes (the IDE has disconnected).
 */
export async function runMcpServer(opts: { devLogPath?: string } = {}): Promise<void> {
  const ctx: ToolContext = { devLogPath: opts.devLogPath ?? resolveDevLogPath() }

  // ALL logging goes to stderr — anything on stdout that isn't a
  // JSON-RPC frame breaks the protocol.
  const log = (msg: string) => {
    process.stderr.write(`[capture-mcp] ${msg}\n`)
  }

  log(`server started; reading dev log from ${ctx.devLogPath}`)

  const rl = createInterface({ input: process.stdin, terminal: false })

  for await (const line of rl) {
    if (!line.trim()) continue
    let parsed: JsonRpcRequest
    try {
      parsed = JSON.parse(line) as JsonRpcRequest
    } catch (err) {
      const errResp: JsonRpcError = {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERROR_PARSE, message: `parse error: ${err instanceof Error ? err.message : String(err)}` },
      }
      process.stdout.write(JSON.stringify(errResp) + "\n")
      continue
    }
    const response = await handleMessage(parsed, ctx)
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n")
    }
  }

  log("stdin closed; shutting down")
}

// Test-only access to the tool dispatch table + protocol constants.
export const __testing = {
  TOOLS,
  TOOL_DISPATCH,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  readDevLog,
  trimEventForMcp,
  RpcMethodError,
  ERROR_PARSE,
  ERROR_INVALID_REQUEST,
  ERROR_METHOD_NOT_FOUND,
  ERROR_INVALID_PARAMS,
  ERROR_INTERNAL,
}
