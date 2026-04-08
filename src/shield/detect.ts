/**
 * Vulnerability detection — when a tainted input reaches a sink,
 * classify the vulnerability and report it via captureException.
 */

import type { SecurityContext, VulnerabilityType, ShieldConfig } from "../types.js"
import { checkTaint } from "./taint.js"

const SINK_VULNERABILITY_MAP: Record<string, VulnerabilityType> = {
  "pg.query": "sql_injection",
  "pg.Pool.query": "sql_injection",
  "mysql2.query": "sql_injection",
  "mysql2.execute": "sql_injection",
  "sqlite.prepare": "sql_injection",
  "sqlite.exec": "sql_injection",
  "child_process.exec": "command_injection",
  "child_process.execSync": "command_injection",
  "child_process.spawn": "command_injection",
  "child_process.spawnSync": "command_injection",
  "fs.readFile": "path_traversal",
  "fs.readFileSync": "path_traversal",
  "fs.writeFile": "path_traversal",
  "fs.writeFileSync": "path_traversal",
  "fetch": "ssrf",
  "http.request": "ssrf",
}

/** Extract file and line from stack trace where the sink was called. */
function extractCallsite(): { file?: string; line?: number } {
  const stack = new Error().stack
  if (!stack) return {}

  const lines = stack.split("\n")
  // Skip: Error, detect.ts, sinks.ts, the hook wrapper — find the first user code frame
  for (const line of lines.slice(3)) {
    const match = line.match(/at\s+.+\((.+):(\d+):\d+\)/) || line.match(/at\s+(.+):(\d+):\d+/)
    if (match) {
      const file = match[1]
      // Skip node_modules and internal files
      if (!file.includes("node_modules") && !file.includes("shield/")) {
        return { file, line: parseInt(match[2], 10) }
      }
    }
  }
  return {}
}

/** Check a sink argument for tainted input and report if found. */
export function inspectSink(
  sinkName: string,
  args: unknown[],
  config: ShieldConfig,
): SecurityContext | null {
  const minLength = config.minInputLength ?? 3

  for (const arg of args) {
    if (typeof arg !== "string") continue

    const match = checkTaint(arg, minLength)
    if (!match) continue

    // For SQL sinks, skip parameterized queries (safe usage)
    if (sinkName.includes("query") || sinkName.includes("execute")) {
      // If the query uses $1, $2, ?, :name placeholders AND the tainted input
      // is NOT in the query string itself (it's in a separate params array),
      // then it's parameterized and safe.
      // We only flag when tainted input is embedded IN the query string.
      const hasPlaceholders = /(\$\d+|\?|:\w+)/.test(arg)
      if (hasPlaceholders) {
        // Check if the tainted input is literally in the query string
        // If it is, the parameterization is broken (concatenation + placeholders)
        // If it's not, the user might be using it correctly in a params array
        // This is the string we're checking — if tainted input is here, it's bad
      }
    }

    const callsite = extractCallsite()

    return {
      vulnerability: SINK_VULNERABILITY_MAP[sinkName] ?? "sql_injection",
      sink: sinkName,
      sinkModule: sinkName.split(".")[0],
      sinkFile: callsite.file,
      sinkLine: callsite.line,
      source: match.source.label,
      taintedInput: match.tainted.slice(0, 200),
      sinkArgument: arg.slice(0, 500),
      blocked: config.mode === "block",
    }
  }

  return null
}

/** Build an error title for a security event. */
export function buildSecurityTitle(ctx: SecurityContext): string {
  const vuln = ctx.vulnerability.replace(/_/g, " ")
  return `[Security] ${vuln} detected in ${ctx.sink}`
}

/** Build the error body with full context. */
export function buildSecurityBody(ctx: SecurityContext): string {
  const lines = [
    `Vulnerability: ${ctx.vulnerability}`,
    `Sink: ${ctx.sink}${ctx.sinkFile ? ` at ${ctx.sinkFile}:${ctx.sinkLine}` : ""}`,
    `Source: ${ctx.source}`,
    `Tainted input: "${ctx.taintedInput}"`,
    `Sink argument (truncated): "${ctx.sinkArgument}"`,
    `Blocked: ${ctx.blocked}`,
  ]
  return lines.join("\n")
}
