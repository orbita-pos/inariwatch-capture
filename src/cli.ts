#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "fs"
import { execSync, exec } from "child_process"
import { join, basename } from "path"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const cwd = process.cwd()
const args = process.argv.slice(2)
const command = args[0] || "init"

function log(msg: string) { console.log(msg) }
function success(msg: string) { log(`${GREEN}+${RESET} ${msg}`) }
function warn(msg: string) { log(`${YELLOW}!${RESET} ${msg}`) }
function info(msg: string) { log(`${DIM}  ${msg}${RESET}`) }

// --- Framework detection ---

type Framework = "nextjs" | "express" | "node"

interface DetectedProject {
  framework: Framework
  usesTypescript: boolean
  hasSrcDir: boolean
  packageManager: string
}

function detectProject(): DetectedProject {
  const pkgPath = join(cwd, "package.json")
  if (!existsSync(pkgPath)) {
    log(`${YELLOW}No package.json found.${RESET} Run this inside a Node.js project.`)
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  const usesTypescript = !!allDeps["typescript"] || existsSync(join(cwd, "tsconfig.json"))
  const hasSrcDir = existsSync(join(cwd, "src"))

  let framework: Framework = "node"
  if (allDeps["next"]) framework = "nextjs"
  else if (allDeps["express"]) framework = "express"

  let packageManager = "npm"
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm"
  else if (existsSync(join(cwd, "yarn.lock"))) packageManager = "yarn"
  else if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) packageManager = "bun"

  return { framework, usesTypescript, hasSrcDir, packageManager }
}

// --- Install dependency ---

function installDep(project: DetectedProject) {
  const pkgPath = join(cwd, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  if (pkg.dependencies?.["@inariwatch/capture"]) {
    info("@inariwatch/capture already in dependencies")
    return
  }

  const cmd = project.packageManager === "yarn"
    ? "yarn add @inariwatch/capture"
    : `${project.packageManager} install @inariwatch/capture`

  log(`\n${DIM}$ ${cmd}${RESET}`)
  try {
    execSync(cmd, { cwd, stdio: "inherit" })
    success("Installed @inariwatch/capture")
  } catch {
    warn(`Could not auto-install. Run: ${cmd}`)
  }
}

// --- Next.js setup ---

function setupNextjs(project: DetectedProject) {
  // 1. Add withInariWatch to next.config
  const configFiles = ["next.config.ts", "next.config.mjs", "next.config.js"]
  let configPath: string | null = null
  let configContent: string | null = null

  for (const f of configFiles) {
    const p = join(cwd, f)
    if (existsSync(p)) {
      configPath = p
      configContent = readFileSync(p, "utf-8")
      break
    }
  }

  if (!configPath || !configContent) {
    warn("No next.config found. Create one first.")
    return
  }

  if (configContent.includes("@inariwatch/capture")) {
    info("next.config already has @inariwatch/capture")
  } else {
    // Add import at top
    const importLine = `import { withInariWatch } from "@inariwatch/capture/next"\n`
    let newContent = importLine + configContent

    // Wrap the default export
    // Match: export default { ... }
    newContent = newContent.replace(
      /export default (\w+)/,
      "export default withInariWatch($1)"
    )

    writeFileSync(configPath, newContent)
    success(`Updated ${configPath.replace(cwd, ".")} — added withInariWatch()`)
  }

  // 2. Create or update instrumentation file
  const ext = project.usesTypescript ? "ts" : "js"
  const instrDir = project.hasSrcDir ? join(cwd, "src") : cwd
  const instrPath = join(instrDir, `instrumentation.${ext}`)

  if (existsSync(instrPath)) {
    const content = readFileSync(instrPath, "utf-8")
    if (content.includes("@inariwatch/capture")) {
      info("instrumentation file already has @inariwatch/capture")
      return
    }
    // Prepend auto import
    writeFileSync(instrPath, `import "@inariwatch/capture/auto"\n\n${content}`)
    success(`Updated instrumentation.${ext} — added auto import`)
  } else {
    writeFileSync(instrPath, [
      `import "@inariwatch/capture/auto"`,
      `import { captureRequestError } from "@inariwatch/capture"`,
      ``,
      `export const onRequestError = captureRequestError`,
      ``,
    ].join("\n"))
    success(`Created instrumentation.${ext}`)
  }
}

// --- Express / Node setup ---

function setupNode(project: DetectedProject) {
  // Find entry file
  const pkgPath = join(cwd, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const mainFile = pkg.main || "index.js"

  const entryPath = join(cwd, mainFile)
  if (existsSync(entryPath)) {
    const content = readFileSync(entryPath, "utf-8")
    if (content.includes("@inariwatch/capture")) {
      info(`${mainFile} already has @inariwatch/capture`)
      return
    }
    // Prepend auto import
    writeFileSync(entryPath, `import "@inariwatch/capture/auto"\n\n${content}`)
    success(`Updated ${mainFile} — added auto import`)
    return
  }

  // Fallback: suggest --import flag
  log(`\n${BOLD}Add to your start script:${RESET}`)
  log(`  node --import @inariwatch/capture/auto ${mainFile}`)
  log(`\n${DIM}Or add to package.json scripts:${RESET}`)
  log(`  "start": "node --import @inariwatch/capture/auto ${mainFile}"`)
}

// --- DSN setup (device flow) ---

const API_BASE = process.env.INARIWATCH_API_URL ?? "https://app.inariwatch.com"

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, () => {})
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pollForToken(code: string): Promise<string | null> {
  for (let i = 0; i < 60; i++) { // 60 × 2s = 2 min
    await sleep(2000)
    try {
      const res = await fetch(`${API_BASE}/api/cli/auth/poll?code=${code}`)
      const data = await res.json() as { status: string; apiToken?: string }
      if (data.status === "approved" && data.apiToken) return data.apiToken
      if (data.status === "expired") { warn("Authorization expired. Run again."); return null }
    } catch { /* network blip, keep trying */ }
  }
  warn("Authorization timed out. Run again.")
  return null
}

async function fetchDsn(apiToken: string, projectName: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/cli/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
      body: JSON.stringify({ projectName }),
    })
    if (!res.ok) return null
    const data = await res.json() as { dsn?: string }
    return data.dsn ?? null
  } catch { return null }
}

function writeDsnToEnv(dsn: string) {
  for (const envFile of [".env.local", ".env"]) {
    const envPath = join(cwd, envFile)
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8")
      if (content.includes("INARIWATCH_DSN")) {
        info(`INARIWATCH_DSN already in ${envFile} — skipping`)
        return
      }
      const base = content.endsWith("\n") ? content : content + "\n"
      writeFileSync(envPath, `${base}INARIWATCH_DSN=${dsn}\n`)
      success(`Written INARIWATCH_DSN to ${envFile}`)
      return
    }
  }
  writeFileSync(join(cwd, ".env"), `INARIWATCH_DSN=${dsn}\n`)
  success("Created .env with INARIWATCH_DSN")
}

async function setupDsn(projectName: string) {
  // Skip if DSN already configured
  for (const envFile of [".env.local", ".env"]) {
    const envPath = join(cwd, envFile)
    if (existsSync(envPath) && readFileSync(envPath, "utf-8").includes("INARIWATCH_DSN")) {
      info("INARIWATCH_DSN already configured")
      return
    }
  }

  log(`\n${DIM}Connecting to InariWatch...${RESET}`)

  let startData: { code: string; verifyUrl: string }
  try {
    const res = await fetch(`${API_BASE}/api/cli/auth/start`, { method: "POST" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    startData = await res.json() as { code: string; verifyUrl: string }
  } catch {
    warn(`Could not reach InariWatch. Set ${CYAN}INARIWATCH_DSN${RESET} manually.`)
    return
  }

  log(`\n${BOLD}Open this URL to authorize:${RESET}`)
  log(`  ${CYAN}${startData.verifyUrl}${RESET}\n`)
  openBrowser(startData.verifyUrl)

  log(`${DIM}Waiting for authorization in browser...${RESET}`)
  const apiToken = await pollForToken(startData.code)
  if (!apiToken) return

  const dsn = await fetchDsn(apiToken, projectName)
  if (!dsn) { warn("Could not create project. Set INARIWATCH_DSN manually."); return }

  writeDsnToEnv(dsn)
  success(`Connected to InariWatch (project: ${projectName})`)
}

// --- Print results ---

function printDone(dsnConfigured: boolean) {
  log(`\n${GREEN}${BOLD}Done.${RESET} InariWatch is active.\n`)
  if (!dsnConfigured) {
    log(`${DIM}Cloud mode:${RESET} Set ${CYAN}INARIWATCH_DSN${RESET} env var to send errors to your dashboard.`)
    log(``)
  }
}

// --- Main ---

async function main() {
  log(`\n${BOLD}@inariwatch/capture${RESET}\n`)

  if (command !== "init") {
    log(`${BOLD}Usage:${RESET}`)
    log(`  npx @inariwatch/capture   ${DIM}# Auto-setup in your project${RESET}`)
    log(``)
    return
  }

  const project = detectProject()
  log(`${DIM}Detected:${RESET} ${BOLD}${project.framework}${RESET} ${project.usesTypescript ? "(TypeScript)" : "(JavaScript)"} ${DIM}via ${project.packageManager}${RESET}\n`)

  installDep(project)
  log("")

  switch (project.framework) {
    case "nextjs": setupNextjs(project); break
    default:       setupNode(project)
  }

  const projectName = basename(cwd)
  await setupDsn(projectName)

  const hasDsn = [".env.local", ".env"].some(f => {
    const p = join(cwd, f)
    return existsSync(p) && readFileSync(p, "utf-8").includes("INARIWATCH_DSN")
  })
  printDone(hasDsn)
}

main().catch(console.error)
