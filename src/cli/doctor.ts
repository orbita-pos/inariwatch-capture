/**
 * `npx @inariwatch/capture doctor` — self-diagnostic.
 *
 * Runs a series of cheap, read-only checks against the local project and
 * prints a status report. Exit 0 when no failures, exit 1 when any check
 * fails. Warnings and info notes do not affect exit code.
 *
 * Designed to answer the question a dev asks 30 seconds after running
 * `npx @inariwatch/capture init`: "is it actually working?"
 *
 * Checks (in run order):
 *   1. Node version >= 18 (the SDK's hard floor)
 *   2. package.json present + `@inariwatch/capture` declared
 *   3. Framework auto-detected
 *   4. Framework plugin wired in the right config file
 *   5. Instrumentation hook present (Next.js / Nuxt / etc.)
 *   6. INARIWATCH_DSN found in env or .env / .env.local
 *   7. DSN format parses cleanly
 *   8. DSN endpoint reachable (HEAD, 5s timeout — network)
 *   9. Dev-log JSONL state (count + age of latest entry)
 *  10. MCP server configured in the user's IDE (Cursor / Claude Code)
 *
 * Each check returns one of:
 *   "ok"   — green checkmark
 *   "info" — neutral info point (does NOT affect exit code)
 *   "warn" — yellow warning, ships a hint, does NOT affect exit code
 *   "fail" — red x, ships a hint, sets exit = 1
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ANSI — duplicated from cli.ts to keep this module standalone-importable.
const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

type Status = "ok" | "info" | "warn" | "fail"
interface CheckResult {
  status: Status
  title: string
  hint?: string
  detail?: string
}

const STATUS_GLYPH: Record<Status, string> = {
  ok: `${GREEN}✓${RESET}`,
  info: `${DIM}ℹ${RESET}`,
  warn: `${YELLOW}!${RESET}`,
  fail: `${RED}✗${RESET}`,
}

interface DoctorOptions {
  cwd?: string
  /** Skip network calls (DSN reachability). */
  offline?: boolean
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
}

/**
 * Pure runner: returns the report instead of printing. Exposed for tests.
 */
export async function runDoctorChecks(opts: DoctorOptions = {}): Promise<CheckResult[]> {
  const cwd = opts.cwd ?? process.cwd()
  const fetchImpl = opts.fetchImpl ?? fetch
  const results: CheckResult[] = []

  results.push(checkNodeVersion())

  const pkg = readPackageJson(cwd)
  results.push(checkPackageJson(pkg))
  if (!pkg) {
    return results // Without package.json the rest of the checks are meaningless.
  }

  results.push(checkCaptureInstalled(pkg))

  const framework = detectFramework(pkg)
  results.push(checkFrameworkDetected(framework))

  if (framework) {
    results.push(checkPluginWired(cwd, framework))
    if (framework === "nextjs") {
      results.push(checkNextInstrumentation(cwd))
    }
  }

  const dsnSource = findDsn(cwd)
  results.push(checkDsnFound(dsnSource))

  if (dsnSource) {
    const parsed = parseDsnSafe(dsnSource.dsn)
    results.push(checkDsnFormat(parsed))

    if (parsed && !opts.offline) {
      results.push(await checkDsnReachable(parsed, fetchImpl))
    } else if (parsed && opts.offline) {
      results.push({ status: "info", title: "DSN reachability skipped (--offline)" })
    }
  }

  results.push(checkDevLogState(cwd))
  results.push(checkMcpConfig())

  return results
}

/** Default runner — prints report, returns exit code. */
export async function runDoctor(opts: DoctorOptions = {}): Promise<0 | 1> {
  const cliVersion = readSelfVersion()
  process.stdout.write(`\n${BOLD}@inariwatch/capture${RESET} ${DIM}doctor${RESET} ${DIM}·${RESET} ${CYAN}v${cliVersion}${RESET}\n\n`)

  const results = await runDoctorChecks(opts)
  let okCount = 0
  let warnCount = 0
  let failCount = 0

  for (const r of results) {
    process.stdout.write(`  ${STATUS_GLYPH[r.status]} ${r.title}\n`)
    if (r.detail) process.stdout.write(`    ${DIM}${r.detail}${RESET}\n`)
    if (r.hint) process.stdout.write(`    ${DIM}→ ${r.hint}${RESET}\n`)
    if (r.status === "ok") okCount++
    else if (r.status === "warn") warnCount++
    else if (r.status === "fail") failCount++
  }

  process.stdout.write(`\n`)
  if (failCount === 0) {
    process.stdout.write(`${GREEN}${BOLD}All checks passed.${RESET} ${DIM}(${okCount} ok${warnCount ? `, ${warnCount} warning${warnCount === 1 ? "" : "s"}` : ""})${RESET}\n\n`)
    return 0
  }
  process.stdout.write(`${RED}${BOLD}${failCount} error${failCount === 1 ? "" : "s"}${RESET}, ${okCount} ok${warnCount ? `, ${warnCount} warning${warnCount === 1 ? "" : "s"}` : ""}.\n`)
  process.stdout.write(`${DIM}Run ${RESET}${CYAN}npx @inariwatch/capture${RESET}${DIM} to set up interactively.${RESET}\n\n`)
  return 1
}

// ── Individual checks ──────────────────────────────────────────────────

function checkNodeVersion(): CheckResult {
  const major = parseInt(process.versions.node.split(".")[0] ?? "0", 10)
  if (major >= 18) {
    return { status: "ok", title: `Node ${process.versions.node} ${DIM}(>=18 required)${RESET}` }
  }
  return {
    status: "fail",
    title: `Node ${process.versions.node} is below the supported floor`,
    hint: "Upgrade to Node 18 LTS or later. Capture uses native fetch / WebCrypto.",
  }
}

interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPackageJson(cwd: string): PackageJson | null {
  const path = join(cwd, "package.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson
  } catch {
    return null
  }
}

function checkPackageJson(pkg: PackageJson | null): CheckResult {
  if (!pkg) {
    return {
      status: "fail",
      title: "No package.json found",
      hint: "Run `doctor` from your project root, where package.json lives.",
    }
  }
  return { status: "ok", title: `package.json found ${DIM}(${pkg.name ?? "unnamed"})${RESET}` }
}

function checkCaptureInstalled(pkg: PackageJson): CheckResult {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  const installed = allDeps["@inariwatch/capture"]
  if (installed) {
    return { status: "ok", title: `@inariwatch/capture installed ${DIM}(${installed})${RESET}` }
  }
  return {
    status: "fail",
    title: "@inariwatch/capture is not in dependencies",
    hint: "npm install @inariwatch/capture",
  }
}

type Framework =
  | "nextjs" | "nuxt" | "remix" | "sveltekit" | "astro" | "vite"
  | "express" | "fastify" | "hono" | "node"

function detectFramework(pkg: PackageJson): Framework | null {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (allDeps["next"]) return "nextjs"
  if (allDeps["nuxt"] || allDeps["nuxt3"]) return "nuxt"
  if (allDeps["@remix-run/react"] || allDeps["@remix-run/node"]) return "remix"
  if (allDeps["@sveltejs/kit"]) return "sveltekit"
  if (allDeps["astro"]) return "astro"
  if (allDeps["fastify"]) return "fastify"
  if (allDeps["hono"]) return "hono"
  if (allDeps["express"]) return "express"
  if (allDeps["vite"]) return "vite"
  return "node"
}

function checkFrameworkDetected(framework: Framework | null): CheckResult {
  if (!framework) {
    return { status: "info", title: "Framework: not detected (treating as plain Node)" }
  }
  return { status: "ok", title: `Framework: ${BOLD}${framework}${RESET}` }
}

function checkPluginWired(cwd: string, framework: Framework): CheckResult {
  const checks: Record<Framework, { files: string[]; pattern: RegExp; pluginName: string }> = {
    nextjs: {
      files: ["next.config.ts", "next.config.mjs", "next.config.js"],
      pattern: /withInariWatch\s*\(/,
      pluginName: "withInariWatch",
    },
    nuxt: {
      files: ["nuxt.config.ts", "nuxt.config.js"],
      pattern: /["']@inariwatch\/capture\/nuxt["']/,
      pluginName: "@inariwatch/capture/nuxt",
    },
    vite: {
      files: ["vite.config.ts", "vite.config.js", "vite.config.mts"],
      pattern: /inariwatchVite\s*\(/,
      pluginName: "inariwatchVite",
    },
    remix: {
      files: ["vite.config.ts", "vite.config.js"],
      pattern: /inariwatchVite\s*\(/,
      pluginName: "inariwatchVite",
    },
    sveltekit: {
      files: ["vite.config.ts", "vite.config.js"],
      pattern: /inariwatchVite\s*\(/,
      pluginName: "inariwatchVite",
    },
    astro: {
      files: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
      pattern: /inariwatchVite\s*\(/,
      pluginName: "inariwatchVite",
    },
    express: { files: ["package.json"], pattern: /@inariwatch\/capture\/auto/, pluginName: "--import @inariwatch/capture/auto" },
    fastify: { files: ["package.json"], pattern: /@inariwatch\/capture\/auto/, pluginName: "--import @inariwatch/capture/auto" },
    hono: { files: ["package.json"], pattern: /@inariwatch\/capture\/auto/, pluginName: "--import @inariwatch/capture/auto" },
    node: { files: ["package.json"], pattern: /@inariwatch\/capture\/auto/, pluginName: "--import @inariwatch/capture/auto" },
  }
  const cfg = checks[framework]
  for (const file of cfg.files) {
    const path = join(cwd, file)
    if (!existsSync(path)) continue
    const contents = safeRead(path)
    if (!contents) continue
    if (cfg.pattern.test(contents)) {
      return { status: "ok", title: `Plugin wired: ${BOLD}${cfg.pluginName}${RESET} ${DIM}in ${file}${RESET}` }
    }
  }
  return {
    status: "fail",
    title: `Plugin not found: ${cfg.pluginName}`,
    hint: framework === "node" || framework === "express" || framework === "fastify" || framework === "hono"
      ? `Add the \`--import @inariwatch/capture/auto\` flag to your start script, or run \`npx @inariwatch/capture\`.`
      : `Run \`npx @inariwatch/capture\` to wire it automatically.`,
  }
}

function checkNextInstrumentation(cwd: string): CheckResult {
  const candidates = [
    "instrumentation.ts", "instrumentation.js",
    "src/instrumentation.ts", "src/instrumentation.js",
  ]
  for (const rel of candidates) {
    const path = join(cwd, rel)
    if (!existsSync(path)) continue
    const contents = safeRead(path) ?? ""
    const hasImport = /["']@inariwatch\/capture\/auto["']/.test(contents)
    const hasOnRequestError = /onRequestError\s*[:=]|export\s+const\s+onRequestError/.test(contents)
    if (hasImport && hasOnRequestError) {
      return { status: "ok", title: `instrumentation.ts wired ${DIM}(${rel})${RESET}` }
    }
    if (hasImport && !hasOnRequestError) {
      return {
        status: "warn",
        title: `${rel} imports capture/auto but doesn't export onRequestError`,
        hint: `Add: import { captureRequestError } from "@inariwatch/capture"; export const onRequestError = captureRequestError`,
      }
    }
    return {
      status: "fail",
      title: `${rel} found but not wired to capture`,
      hint: `Add: import "@inariwatch/capture/auto" + export const onRequestError = captureRequestError`,
    }
  }
  return {
    status: "warn",
    title: "instrumentation.ts not found",
    hint: "Next.js needs instrumentation.ts at the project root for runtime errors. Run `npx @inariwatch/capture`.",
  }
}

interface DsnSource {
  dsn: string
  origin: string
}

function findDsn(cwd: string): DsnSource | null {
  if (process.env.INARIWATCH_DSN) {
    return { dsn: process.env.INARIWATCH_DSN, origin: "process.env" }
  }
  for (const file of [".env.local", ".env"]) {
    const path = join(cwd, file)
    if (!existsSync(path)) continue
    const contents = safeRead(path) ?? ""
    const match = contents.match(/^INARIWATCH_DSN\s*=\s*['"]?([^'"\n]+)['"]?$/m)
    if (match) return { dsn: match[1].trim(), origin: file }
  }
  return null
}

function checkDsnFound(src: DsnSource | null): CheckResult {
  if (src) {
    return { status: "ok", title: `INARIWATCH_DSN found ${DIM}(${src.origin})${RESET}` }
  }
  return {
    status: "warn",
    title: "INARIWATCH_DSN not set — local mode only",
    hint: "Errors will print to terminal. Add INARIWATCH_DSN to send to the cloud dashboard.",
  }
}

interface ParsedDsn {
  hostname: string
  pathname: string
  endpoint: string
}

function parseDsnSafe(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    return { hostname: u.hostname, pathname: u.pathname, endpoint: u.origin + u.pathname }
  } catch {
    return null
  }
}

function checkDsnFormat(parsed: ParsedDsn | null): CheckResult {
  if (!parsed) {
    return {
      status: "fail",
      title: "DSN is not a valid URL",
      hint: "Expected format: https://<secret>@app.inariwatch.com/capture/<integration-id>",
    }
  }
  return { status: "ok", title: `DSN format valid ${DIM}(${parsed.hostname})${RESET}` }
}

async function checkDsnReachable(parsed: ParsedDsn, fetchImpl: typeof fetch): Promise<CheckResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  const start = Date.now()
  try {
    // HEAD against the endpoint root, NOT the DSN secret-bearing URL — we
    // don't want to leak the integration secret in case the endpoint is a
    // shared logging proxy.
    const probeUrl = `https://${parsed.hostname}/`
    const res = await fetchImpl(probeUrl, { method: "HEAD", signal: ctrl.signal })
    const ms = Date.now() - start
    if (res.status >= 500) {
      return {
        status: "warn",
        title: `DSN endpoint reached but returned HTTP ${res.status} ${DIM}(${ms}ms)${RESET}`,
        hint: "Check status.inariwatch.com — the dashboard may be down.",
      }
    }
    return { status: "ok", title: `DSN endpoint reachable ${DIM}(HTTP ${res.status}, ${ms}ms)${RESET}` }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return {
        status: "warn",
        title: `DSN endpoint timed out (>5s)`,
        hint: "Network or firewall may be blocking outbound HTTPS to the dashboard.",
      }
    }
    return {
      status: "warn",
      title: `DSN endpoint unreachable: ${(err as Error).message.slice(0, 80)}`,
      hint: "Verify your DSN URL and network connectivity.",
    }
  } finally {
    clearTimeout(timer)
  }
}

function checkDevLogState(cwd: string): CheckResult {
  const enabled = process.env.INARIWATCH_DEV_LOG === "1" || !!process.env.INARIWATCH_DEV_LOG_PATH
  const path = process.env.INARIWATCH_DEV_LOG_PATH ?? join(cwd, ".inariwatch", "errors.jsonl")
  if (!existsSync(path)) {
    if (enabled) {
      return {
        status: "info",
        title: `Dev-log mode ON but no events captured yet ${DIM}(${path})${RESET}`,
        hint: "Trigger an error in your app to populate the file.",
      }
    }
    return {
      status: "info",
      title: "Dev-log mode off (INARIWATCH_DEV_LOG not set)",
      hint: "Set INARIWATCH_DEV_LOG=1 to populate .inariwatch/errors.jsonl for the MCP server.",
    }
  }
  const lines = (safeRead(path) ?? "").split("\n").filter(Boolean)
  let lastTs: string | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]) as { timestamp?: string }
      if (typeof ev.timestamp === "string") { lastTs = ev.timestamp; break }
    } catch { /* keep walking */ }
  }
  const ageStr = lastTs ? ` ${DIM}(latest ${describeAge(lastTs)})${RESET}` : ""
  return { status: "ok", title: `Dev-log: ${lines.length} event${lines.length === 1 ? "" : "s"}${ageStr}` }
}

function describeAge(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "unknown age"
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function checkMcpConfig(): CheckResult {
  const candidates: string[] = [
    join(homedir(), ".cursor", "mcp.json"),
    join(homedir(), ".config", "claude", "mcp.json"),
    join(homedir(), ".claude", "mcp.json"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const contents = safeRead(path) ?? ""
    if (/inariwatch/i.test(contents) && /capture/i.test(contents)) {
      const tool = path.includes(".cursor") ? "Cursor" : "Claude Code"
      return { status: "ok", title: `MCP server registered in ${tool}` }
    }
  }
  return {
    status: "info",
    title: "MCP server not found in Cursor / Claude Code config",
    hint: `Add: { "mcpServers": { "inariwatch": { "command": "npx", "args": ["@inariwatch/capture", "mcp"] } } }`,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf8") } catch { return null }
}

function readSelfVersion(): string {
  // Walk up from this file's location to find OUR package.json.
  // dist/cli/doctor.js → dist/cli → dist → package root
  // src/cli/doctor.ts → src/cli → src → package root
  // (Tests may also import from dist; either path works.)
  let dir = __dirname
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string }
        if (pkg.name === "@inariwatch/capture" && typeof pkg.version === "string") return pkg.version
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return "unknown"
}

// Test-only access.
export const __testing = {
  STATUS_GLYPH,
  describeAge,
  parseDsnSafe,
  detectFramework,
  findDsn,
}

// Avoid "declared but unused" when stat'ing in future — keep import live.
void statSync
