/**
 * SDK ↔ eBPF agent session-id stitching.
 *
 * The InariWatch eBPF agent writes runtime-exception events to its
 * cloud endpoint with PID + TID + nanosecond timestamp.  The forensic
 * SDK captures the *contents* of the throw (frame locals, closures,
 * receiver) in-process.  A correlation id is needed for the cloud-side
 * stitcher to join them — that id is the FullTrace `sessionId`.
 *
 * Because the eBPF probe runs in the kernel, it cannot reach into the
 * Node process to read the JS-side session id.  We bridge the two
 * worlds with a tiny per-process file:
 *
 *     /run/inariwatch/agents/{PID}.sess
 *
 * Schema (`iw.session.v1`):
 *
 *     {
 *       "schema":     "iw.session.v1",
 *       "session_id": "<uuid v4>",
 *       "pid":        <int>,
 *       "updated_ns": <bigint as integer>,
 *       "request_id": "<optional>",
 *       "user_id":    "<optional>"
 *     }
 *
 * The agent reads this file on the slow path (cached for 5s) when it
 * processes a `runtime_exception` event for the same PID.
 *
 * Operational notes:
 *   - Linux only.  On other platforms the install is a no-op so SDK
 *     code can call `installSessionFile` unconditionally.
 *   - Best-effort: any failure (permission denied on `/run`, ENOSPC,
 *     etc.) is swallowed.  Stitching is enrichment, never a hard
 *     dependency for capture or for the user's app.
 *   - Atomic writes: we write to `{PID}.sess.tmp` then `rename(2)` so
 *     the agent never sees a half-written file.
 *   - Cleanup: an `exit` listener removes the file on graceful
 *     shutdown.  On a hard crash the agent treats the orphan as stale
 *     via the `MAX_RECORD_AGE` window.
 *
 * Privacy:
 *   - The SDK is responsible for redaction.  Anything passed in
 *     `requestId` / `userId` lands in the file as-is.  Hash or
 *     pseudonymise before calling if your policy requires it.
 */

import * as fs from "node:fs"
import * as path from "node:path"

const SCHEMA_V1 = "iw.session.v1"

/**
 * Default session directory.  Overridable for tests.
 */
const DEFAULT_SESSION_DIR = "/run/inariwatch/agents"

export interface SessionContext {
  /** FullTrace session id.  Required. */
  sessionId: string
  /** Optional active request id.  Refresh via `updateRequestContext`. */
  requestId?: string
  /** Optional authenticated user id. */
  userId?: string
}

interface InstalledHandle {
  /** Absolute path to the session file.  Used by tests + uninstall. */
  filePath: string
  /** Whether the install actually wrote a file (false on non-Linux). */
  active: boolean
}

let current: InstalledHandle | null = null
let exitListener: (() => void) | null = null

/** Override the session directory.  Tests only. */
let overrideDir: string | null = null

/**
 * Internal hook for tests.  Pass `null` to clear.
 *
 * @internal
 */
export function __setSessionDirForTest(dir: string | null): void {
  overrideDir = dir
}

function sessionDir(): string {
  return overrideDir ?? DEFAULT_SESSION_DIR
}

function sessionFilePath(pid: number): string {
  return path.join(sessionDir(), `${pid}.sess`)
}

function nowNs(): bigint {
  return process.hrtime.bigint()
}

function isLinux(): boolean {
  return process.platform === "linux"
}

/**
 * Atomically write a single-line JSON payload.  We deliberately keep the
 * shape minimal so the agent's parser stays trivial and the file size
 * stays well under one filesystem block.
 */
function writeSessionFile(pid: number, ctx: SessionContext): boolean {
  const dir = sessionDir()
  const finalPath = sessionFilePath(pid)
  const tmpPath = `${finalPath}.tmp`

  const payload: Record<string, unknown> = {
    schema: SCHEMA_V1,
    session_id: ctx.sessionId,
    pid,
    // bigint can't go through JSON.stringify directly; serialise as
    // a Number when it fits (always, until 2262 AD), else as string
    // (which the agent's serde decoder also accepts via custom deser).
    updated_ns: Number(nowNs()),
  }
  if (ctx.requestId !== undefined) payload.request_id = ctx.requestId
  if (ctx.userId !== undefined) payload.user_id = ctx.userId

  try {
    fs.mkdirSync(dir, { recursive: true })
    // 0o644 — agent runs as root, app runs as whatever, fine to be world-readable
    // because the file content is the SDK's session id, not a credential.
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o644 })
    fs.renameSync(tmpPath, finalPath)
    return true
  } catch {
    // Best effort.  Try to remove a half-written tmp file but don't
    // throw if even that fails — the SDK must not crash the host app.
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
    return false
  }
}

function removeSessionFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch {
    /* ignore — file may already be gone */
  }
}

/**
 * Publish the SDK's session context so the eBPF agent can correlate
 * its kernel-captured throws with the in-process forensic capture.
 *
 * Idempotent across calls: a second `installSessionFile` updates the
 * file in place rather than installing a second exit listener.
 *
 * @returns the absolute file path that was written, or `null` when no
 *          file was written (non-Linux, IO failure).
 */
export function installSessionFile(ctx: SessionContext): string | null {
  if (!ctx.sessionId) {
    throw new Error(
      "installSessionFile: sessionId is required (the agent uses it as the correlation key)",
    )
  }

  const pid = process.pid

  if (!isLinux()) {
    // Track install for symmetry — uninstall() should still succeed.
    current = { filePath: sessionFilePath(pid), active: false }
    return null
  }

  const written = writeSessionFile(pid, ctx)
  const filePath = sessionFilePath(pid)
  current = { filePath, active: written }

  if (written && exitListener === null) {
    const handler = (): void => {
      if (current && current.active) {
        removeSessionFile(current.filePath)
      }
    }
    exitListener = handler
    // `exit` fires on normal process completion, not on SIGKILL — for
    // SIGKILL the agent's stale-record check catches the orphan.
    process.on("exit", handler)
  }

  return written ? filePath : null
}

/**
 * Update the request context inside the active session.  Useful when
 * the host app wraps every HTTP handler with AsyncLocalStorage and
 * wants the agent to know which request a throw belongs to.
 *
 * Calling without a prior `installSessionFile` is a no-op.
 */
export function updateRequestContext(opts: {
  requestId?: string
  userId?: string
}): boolean {
  if (current === null || !current.active) {
    return false
  }
  if (!isLinux()) {
    return false
  }
  // Read the existing file to preserve session_id, then overwrite.
  let existing: Record<string, unknown>
  try {
    const raw = fs.readFileSync(current.filePath, "utf8")
    existing = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return false
  }
  const sessionId = existing.session_id
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return false
  }

  const next: SessionContext = { sessionId }
  if (opts.requestId !== undefined) next.requestId = opts.requestId
  if (opts.userId !== undefined) next.userId = opts.userId
  return writeSessionFile(process.pid, next)
}

/**
 * Remove the session file and detach the exit listener.  Safe to call
 * even when nothing is installed.
 */
export function uninstallSessionFile(): void {
  if (current === null) {
    return
  }
  if (current.active) {
    removeSessionFile(current.filePath)
  }
  if (exitListener !== null) {
    process.removeListener("exit", exitListener)
    exitListener = null
  }
  current = null
}

/**
 * Inspect whether a session file is currently installed.  Tests + debugging.
 *
 * @internal
 */
export function __sessionFileState(): InstalledHandle | null {
  return current
}
