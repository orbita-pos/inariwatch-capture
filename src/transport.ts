import type { CaptureConfig, ErrorEvent, ParsedDSN } from "./types.js"
import { isZeroRetentionEnabled, extractTombstone, persistTombstone } from "./tombstone.js"

const MAX_RETRY_BUFFER = 30

export function parseDSN(dsn: string): ParsedDSN {
  // Local mode: "http://localhost:9111/ingest"
  const parsedUrl = new URL(dsn)
  if (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1") {
    return { endpoint: dsn, secretKey: "", isLocal: true }
  }

  // Cloud mode requires HTTPS
  if (parsedUrl.protocol !== "https:") {
    console.warn("[@inariwatch/capture] DSN must use HTTPS for non-local endpoints. Events will not be sent.")
    return { endpoint: "", secretKey: "", isLocal: false }
  }

  // Cloud mode: "https://secret@app.inariwatch.com/capture/integration-id"
  const url = new URL(dsn)
  const secretKey = url.username || url.password || ""
  url.username = ""
  url.password = ""

  // Convert path /capture/xxx → /api/webhooks/capture/xxx
  const path = url.pathname
  if (path.startsWith("/capture/")) {
    url.pathname = `/api/webhooks${path}`
  }

  return { endpoint: url.toString(), secretKey, isLocal: false }
}

async function signPayload(body: string, secret: string): Promise<string> {
  // Node path first (faster + no async crypto.subtle). Skip on browsers —
  // `node:crypto` is not resolvable there.
  if (typeof window === "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pkg = "node:crypto"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeCrypto: any = await import(/* webpackIgnore: true */ pkg)
      if (nodeCrypto.createHmac) {
        return `sha256=${nodeCrypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`
      }
    } catch {
      // Fallback: Web Crypto API
    }
  }

  const encoder = new TextEncoder()
  const keyData = encoder.encode(secret)
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

export interface Transport {
  send(event: ErrorEvent): void
  flush(): Promise<void>
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "\x1b[31m",  // red
  warning: "\x1b[33m",   // yellow
  info: "\x1b[36m",      // cyan
}

// Dev-log JSONL sink (Track E pieza 9 / Sesión 10). When INARIWATCH_DEV_LOG=1
// (or INARIWATCH_DEV_LOG_PATH set), every event sent through the local
// transport is also appended as a single JSON line to a per-project file
// that `@inariwatch/capture-mcp` reads to expose `get_recent_errors` /
// `diagnose_error_id` / `get_locals_at_frame` over stdio MCP. The file is
// not rotated by us; the MCP server caps reads to the tail.
//
// Why per-project (cwd) and not ~/.inariwatch: same cwd = same project
// makes it match what Cursor/Claude Code see as the workspace root, so
// the editor's MCP client and the running app land on the same file
// without extra config. Override via INARIWATCH_DEV_LOG_PATH.
async function appendDevLog(event: ErrorEvent): Promise<void> {
  if (typeof window !== "undefined") return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process as any
  if (!proc?.env) return
  const enabled = proc.env.INARIWATCH_DEV_LOG === "1" || !!proc.env.INARIWATCH_DEV_LOG_PATH
  if (!enabled) return
  try {
    const pkg = "node:fs/promises"
    const pathPkg = "node:path"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs: any = await import(/* webpackIgnore: true */ pkg)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path: any = await import(/* webpackIgnore: true */ pathPkg)
    const filePath = proc.env.INARIWATCH_DEV_LOG_PATH ?? path.join(proc.cwd(), ".inariwatch", "errors.jsonl")
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf8")
  } catch {
    // Dev-log is best-effort — never fail the user's app for a missing
    // disk / permission error in their dev box.
  }
}

export function createLocalTransport(_config: CaptureConfig): Transport {
  return {
    send(event: ErrorEvent) {
      const color = SEVERITY_COLORS[event.severity] || "\x1b[0m"
      const reset = "\x1b[0m"
      const dim = "\x1b[2m"
      const bold = "\x1b[1m"
      const time = new Date(event.timestamp).toLocaleTimeString()

      console.log(`\n${dim}${time}${reset} ${color}${bold}[${event.severity.toUpperCase()}]${reset} ${bold}${event.title}${reset}`)

      if (event.body && event.body !== event.title) {
        // Print stack trace, dimmed
        const lines = event.body.split("\n").slice(1, 6) // first 5 lines of stack
        for (const line of lines) {
          console.log(`${dim}  ${line.trim()}${reset}`)
        }
        if (event.body.split("\n").length > 6) {
          console.log(`${dim}  ... (${event.body.split("\n").length - 6} more lines)${reset}`)
        }
      }

      if (event.context) {
        console.log(`${dim}  context: ${JSON.stringify(event.context)}${reset}`)
      }

      appendDevLog(event)
    },
    async flush() {},
  }
}

export function createTransport(config: CaptureConfig, parsed: ParsedDSN): Transport {
  const retryBuffer: ErrorEvent[] = []

  function log(msg: string) {
    if (config.silent) return
    if (config.debug) console.warn(`[@inariwatch/capture] ${msg}`)
  }

  async function sendOne(event: ErrorEvent): Promise<boolean> {
    const body = JSON.stringify(event)
    const headers: Record<string, string> = { "Content-Type": "application/json" }

    if (!parsed.isLocal && parsed.secretKey) {
      headers["x-capture-signature"] = await signPayload(body, parsed.secretKey)
    }

    // Zero-retention mode (Track E pieza 11). The flag is read once at
    // module load — see ./tombstone.ts. We add the header on every
    // request when on; the server sees it, runs the dedup+notify
    // pipeline, and returns a signed tombstone we persist locally for
    // audit. The header is harmless against an old server (it ignores
    // unknown headers), so this stays safe across SDK/server skew.
    const zeroRetention = isZeroRetentionEnabled()
    if (zeroRetention) {
      headers["X-IW-Zero-Retention"] = "1"
    }

    try {
      const res = await fetch(parsed.endpoint, { method: "POST", headers, body })
      if (res.ok) {
        if (zeroRetention) {
          // Best-effort: parse + persist the tombstone. Never blocks the
          // send result — a parse miss just means this hop didn't return
          // a tombstone (e.g. legacy server, error in tombstone signing).
          try {
            const json = await res.clone().json()
            const tombstone = extractTombstone(json)
            if (tombstone) {
              persistTombstone(tombstone).catch(() => {})
            }
          } catch {
            // Non-JSON response — fine, no tombstone to persist.
          }
        }
        return true
      }
      log(`HTTP ${res.status} from ${parsed.endpoint}`)
      return false
    } catch (err) {
      log(`Transport error: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  async function flushRetries() {
    if (retryBuffer.length === 0) return
    const batch = retryBuffer.splice(0, retryBuffer.length)
    for (let i = 0; i < batch.length; i++) {
      const ok = await sendOne(batch[i])
      if (!ok) {
        const remaining = batch.slice(i)
        for (const evt of remaining) {
          if (retryBuffer.length < MAX_RETRY_BUFFER) retryBuffer.push(evt)
        }
        break
      }
    }
  }

  const pendingSends: Promise<void>[] = []

  return {
    send(event: ErrorEvent) {
      const p = sendOne(event).then((ok) => {
        if (ok) {
          flushRetries()
        } else if (retryBuffer.length < MAX_RETRY_BUFFER) {
          // Deduplicate by fingerprint
          if (!retryBuffer.some((e) => e.fingerprint === event.fingerprint)) {
            retryBuffer.push(event)
          }
        }
      })
      pendingSends.push(p)
      p.finally(() => {
        const idx = pendingSends.indexOf(p)
        if (idx !== -1) pendingSends.splice(idx, 1)
      })
    },

    async flush(): Promise<void> {
      await Promise.allSettled(pendingSends)
      await flushRetries()
    },
  }
}
