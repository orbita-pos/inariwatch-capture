/**
 * Source snippets + git blame for stack frames (Track A piece 4).
 *
 * For every frame in the error stack, this reads the surrounding source
 * (10 lines before, the offending line, 10 lines after) and runs `git blame`
 * per line so the AI sees who last touched the code and when.
 *
 * Zero deps — uses `node:fs`, `node:path`, `node:child_process` only.
 *
 * Performance:
 *   - File reads cached by `(absPath, mtimeMs)` for the lifetime of the process.
 *   - Blame results cached by `(absPath, line, file_mtimeMs, head_sha)` —
 *     blame doesn't change unless the file or HEAD does.
 *   - All git invocations use `spawnSync` with a 500ms timeout. Slow repos
 *     simply skip blame instead of stalling the error path.
 *
 * Skip rules:
 *   - Browser builds: this module is Node-only. The dynamic import in
 *     `client.ts` swallows the error.
 *   - Node_modules: blame is skipped for any path containing `/node_modules/`.
 *   - Outside repo: if the file isn't tracked by git, blame is silently dropped.
 *   - Stack frame with `<unknown>` file or non-positive line: skipped.
 */

import {
  readFileSync,
  statSync,
  existsSync,
} from "node:fs"
import { resolve, dirname, sep } from "node:path"
import { spawnSync } from "node:child_process"
import type { SourceContextFrame } from "./types.js"
import { parseStackForEvidence } from "./payload-v2.js"

const SLICE_BEFORE = 10
const SLICE_AFTER = 10
const GIT_TIMEOUT_MS = 500
const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5MB — refuse to slice giant generated files

interface FileCacheEntry {
  mtimeMs: number
  lines: string[]
}

interface BlameCacheEntry {
  fileMtimeMs: number
  headSha: string | null
  blame: { commit: string; author: string; date: string; message: string }
}

// Process-lifetime caches. Bounded by the number of unique file paths the SDK
// observes during a single Node process — typically <100 even on noisy apps.
const fileCache = new Map<string, FileCacheEntry>()
const blameCache = new Map<string, BlameCacheEntry>()
const repoHeadCache = new Map<string, { mtimeMs: number; sha: string }>()

/**
 * Build per-frame source context for the given stack. Returns one entry per
 * frame that resolved to a readable file. Frames that can't be resolved
 * (synthetic, minified without sources, third-party JIT) are skipped — the
 * caller can still render the original text stack.
 */
export function getSourceContext(stack: string): SourceContextFrame[] {
  const frames = parseStackForEvidence(stack)
  const out: SourceContextFrame[] = []

  for (let idx = 0; idx < frames.length; idx++) {
    const f = frames[idx]!
    if (!f.file || f.file === "<unknown>" || f.line <= 0) continue
    const absPath = resolveFramePath(f.file)
    if (!absPath) continue
    if (absPath.includes(`${sep}node_modules${sep}`)) continue

    const slice = readSourceSlice(absPath, f.line)
    if (!slice) continue

    const blame = getBlame(absPath, f.line)
    out.push({
      frameIndex: idx,
      before: slice.before,
      line: slice.line,
      after: slice.after,
      ...(blame ? { blame } : {}),
    })
  }
  return out
}

// ───────────────────── Path resolution ─────────────────────────────────────

/**
 * `at fn (file://...)` and `at fn (/abs/path)` both appear in stacks. We
 * normalize to an absolute filesystem path. Relative paths are resolved
 * against `process.cwd()` — most Node frameworks (Next.js, Vite SSR) emit
 * cwd-relative paths in production builds.
 */
function resolveFramePath(rawFile: string): string | null {
  let p = rawFile
  // Strip column markers that some parsers leave behind
  p = p.replace(/:(\d+)(:\d+)?$/, "")
  // file:// URLs
  if (p.startsWith("file://")) {
    try {
      // Cross-platform conversion — file:///C:/... on Windows
      const url = new URL(p)
      p = decodeURIComponent(url.pathname)
      if (process.platform === "win32" && p.startsWith("/")) {
        p = p.slice(1)
      }
    } catch {
      return null
    }
  }
  if (!p) return null
  const abs = resolve(p)
  try {
    if (!existsSync(abs)) return null
  } catch {
    return null
  }
  return abs
}

// ───────────────────── Source slice ────────────────────────────────────────

interface SliceResult {
  before: string[]
  line: string
  after: string[]
}

function readSourceSlice(absPath: string, lineNum: number): SliceResult | null {
  const cached = readFileLines(absPath)
  if (!cached) return null
  const { lines } = cached
  if (lineNum > lines.length) return null

  const idx = lineNum - 1 // 1-indexed → 0-indexed
  const beforeStart = Math.max(0, idx - SLICE_BEFORE)
  const afterEnd = Math.min(lines.length, idx + SLICE_AFTER + 1)
  return {
    before: lines.slice(beforeStart, idx),
    line: lines[idx] ?? "",
    after: lines.slice(idx + 1, afterEnd),
  }
}

function readFileLines(absPath: string): FileCacheEntry | null {
  let stat
  try {
    stat = statSync(absPath)
  } catch {
    return null
  }
  if (stat.size > MAX_FILE_BYTES) return null

  const cached = fileCache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached

  let contents: string
  try {
    contents = readFileSync(absPath, "utf8")
  } catch {
    return null
  }
  const entry: FileCacheEntry = {
    mtimeMs: stat.mtimeMs,
    lines: contents.split(/\r?\n/),
  }
  fileCache.set(absPath, entry)
  return entry
}

// ───────────────────── Git blame ───────────────────────────────────────────

function getBlame(
  absPath: string,
  line: number,
): { commit: string; author: string; date: string; message: string } | null {
  const stat = safeStat(absPath)
  if (!stat) return null

  const repoRoot = findRepoRoot(absPath)
  if (!repoRoot) return null
  const headSha = getHeadSha(repoRoot)

  const cacheKey = `${absPath}:${line}:${stat.mtimeMs}:${headSha ?? "no-head"}`
  const cached = blameCache.get(cacheKey)
  if (cached) return cached.blame

  const result = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "blame",
      "--porcelain",
      "-L",
      `${line},${line}`,
      "--",
      absPath,
    ],
    {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  )
  if (result.status !== 0 || !result.stdout) return null

  const parsed = parsePorcelainBlame(result.stdout)
  if (!parsed) return null
  blameCache.set(cacheKey, {
    fileMtimeMs: stat.mtimeMs,
    headSha,
    blame: parsed,
  })
  return parsed
}

function safeStat(p: string): { mtimeMs: number } | null {
  try {
    const s = statSync(p)
    return { mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Walks up from `start` looking for a `.git` directory. Caches per directory
 * so we don't re-walk for every blame call in the same module file.
 */
const repoRootCache = new Map<string, string | null>()
function findRepoRoot(start: string): string | null {
  let dir = dirname(start)
  const seen: string[] = []
  while (dir) {
    const cached = repoRootCache.get(dir)
    if (cached !== undefined) {
      // Backfill seen dirs with the same answer for cheaper future lookups.
      for (const s of seen) repoRootCache.set(s, cached)
      return cached
    }
    seen.push(dir)
    if (existsSync(`${dir}${sep}.git`)) {
      for (const s of seen) repoRootCache.set(s, dir)
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break // reached fs root
    dir = parent
  }
  for (const s of seen) repoRootCache.set(s, null)
  return null
}

function getHeadSha(repoRoot: string): string | null {
  // HEAD changes infrequently; cache for the process lifetime keyed by the
  // mtime of `.git/HEAD` so checkouts during long-running dev servers refresh.
  let mtimeMs: number
  try {
    mtimeMs = statSync(`${repoRoot}${sep}.git${sep}HEAD`).mtimeMs
  } catch {
    return null
  }
  const cached = repoHeadCache.get(repoRoot)
  if (cached && cached.mtimeMs === mtimeMs) return cached.sha

  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout) return null
  const sha = result.stdout.trim()
  repoHeadCache.set(repoRoot, { mtimeMs, sha })
  return sha
}

/**
 * Parse `git blame --porcelain` output. We only request a single line so the
 * format is a tight header block + one tab-prefixed source line. We extract
 * the first commit line, author, author-time, summary.
 */
function parsePorcelainBlame(
  stdout: string,
): { commit: string; author: string; date: string; message: string } | null {
  const lines = stdout.split(/\r?\n/)
  let commit: string | null = null
  let author = ""
  let authorTime = 0
  let summary = ""

  for (const line of lines) {
    if (!commit) {
      const m = /^([0-9a-f]{40})\s/.exec(line)
      if (m) {
        commit = m[1] ?? null
        continue
      }
    }
    if (line.startsWith("author ")) {
      author = line.slice(7)
    } else if (line.startsWith("author-time ")) {
      authorTime = parseInt(line.slice(12), 10)
    } else if (line.startsWith("summary ")) {
      summary = line.slice(8)
    }
  }

  if (!commit) return null
  const date = authorTime > 0 ? new Date(authorTime * 1000).toISOString() : ""
  return {
    commit: commit.slice(0, 12),
    author,
    date,
    message: summary,
  }
}

/** Test-only: drop all caches so unit tests can re-exercise the lookup paths. */
export function __resetSourceContextCachesForTesting(): void {
  fileCache.clear()
  blameCache.clear()
  repoHeadCache.clear()
  repoRootCache.clear()
}
