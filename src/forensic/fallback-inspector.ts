import { Session } from "node:inspector/promises"
import { threadId } from "node:worker_threads"
import type { ForensicCapture, ForensicHook, ForensicOptions, ForensicValue, FrameSnapshot } from "./types.js"
import { DEFAULT_OPTIONS } from "./types.js"

/**
 * Fallback forensic capture on stock Node.
 *
 * Uses `inspector.Session` + the CDP `Debugger.paused` event. Enabling the
 * Debugger domain puts V8 into "slow path" momentarily while we walk scopes,
 * so this path does NOT meet the fork's <1ms p50 budget. Expect 2-6ms p50
 * depending on frame count and scope depth. The ForensicVM fork is the path
 * that honors the headline overhead number.
 *
 * Enablement cost (`Debugger.enable` + `setPauseOnExceptions: "uncaught"`)
 * is paid once at `install()` time. From then on, every uncaught throw
 * synchronously fires `Debugger.paused`; we read scopes, build a
 * `FrameSnapshot[]`, resume, and invoke the user hook asynchronously.
 *
 * Nothing here is exported beyond `install`/`uninstall` — the barrel
 * (`./index`) is the public surface.
 */

let session: Session | null = null
let activeHook: ForensicHook | null = null
let activeOptions: Required<ForensicOptions> = DEFAULT_OPTIONS

interface CdpScope {
  type: string
  object: { objectId?: string }
}

interface CdpCallFrame {
  callFrameId: string
  functionName: string
  location: { scriptId: string; lineNumber: number; columnNumber?: number }
  url?: string
  scopeChain: CdpScope[]
  this: { objectId?: string; type: string; className?: string; description?: string }
}

interface CdpPaused {
  callFrames: CdpCallFrame[]
  reason: string
  data?: { description?: string; objectId?: string }
}

interface CdpPropertyDescriptor {
  name: string
  value?: { type: string; subtype?: string; value?: unknown; description?: string; objectId?: string; className?: string }
  get?: unknown
  set?: unknown
}

/**
 * Best-effort CDP RemoteObject → primitive/string. We don't recursively call
 * `Runtime.getProperties` here — that would multiply round-trips and blow the
 * budget. Deep object walking is the fork's job; in fallback we emit a
 * 1-level preview and mark truncated.
 */
function remoteObjectToValue(name: string, desc: CdpPropertyDescriptor): ForensicValue {
  const v = desc.value
  if (!v) {
    return { name, repr: "<accessor>", kind: "accessor", truncated: true }
  }
  const kind = v.subtype ? `${v.type}:${v.subtype}` : v.type
  if (v.type === "undefined") return { name, repr: "undefined", kind: "undefined" }
  if (v.type === "string") return { name, repr: JSON.stringify(v.value as string), kind: "string" }
  if (v.type === "number" || v.type === "boolean") return { name, repr: String(v.value), kind: v.type }
  if (v.type === "bigint") return { name, repr: v.description ?? String(v.value), kind: "bigint" }
  if (v.type === "symbol") return { name, repr: v.description ?? "Symbol()", kind: "symbol" }
  if (v.type === "function") {
    const fn = v.description ?? "[Function]"
    return { name, repr: fn.length > 120 ? fn.slice(0, 120) + "…" : fn, kind: "function" }
  }
  if (v.type === "object") {
    if (v.subtype === "null") return { name, repr: "null", kind: "null" }
    const repr = v.description ?? `[${v.className ?? "Object"}]`
    return { name, repr, kind, truncated: true }
  }
  return { name, repr: v.description ?? "<unknown>", kind, truncated: true }
}

async function readScopeProps(
  s: Session,
  objectId: string,
  limit: number,
  deadline: number,
): Promise<ForensicValue[]> {
  if (Date.now() > deadline) return []
  const { result } = await s.post("Runtime.getProperties", {
    objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
    generatePreview: false,
  }) as { result: CdpPropertyDescriptor[] }
  const out: ForensicValue[] = []
  for (const d of result) {
    if (out.length >= limit) break
    if (d.name === "this" || d.name === "__proto__") continue
    out.push(remoteObjectToValue(d.name, d))
  }
  return out
}

async function readThis(
  s: Session,
  frame: CdpCallFrame,
  deadline: number,
): Promise<ForensicValue | undefined> {
  const t = frame.this
  if (!t || t.type === "undefined") return undefined
  if (Date.now() > deadline) return { name: "this", repr: "<budget>", kind: "object", truncated: true }
  return remoteObjectToValue("this", { name: "this", value: t })
}

async function buildFrames(
  s: Session,
  event: CdpPaused,
  opts: Required<ForensicOptions>,
  deadline: number,
): Promise<FrameSnapshot[]> {
  const frames: FrameSnapshot[] = []
  const slice = event.callFrames.slice(0, opts.maxFrames)
  for (let i = 0; i < slice.length; i++) {
    if (Date.now() > deadline) {
      // Budget blown — emit a truncated marker frame so consumers can tell.
      frames.push({
        index: i,
        functionName: "<budget-exceeded>",
        locals: [],
        closure: [],
        partial: true,
      })
      break
    }
    const cf = slice[i]!
    const locals: ForensicValue[] = []
    const closure: ForensicValue[] = []
    for (const scope of cf.scopeChain) {
      if (scope.type === "global" || scope.type === "script" || scope.type === "module") continue
      if (!scope.object.objectId) continue
      const remaining = Math.max(0, opts.maxLocalsPerFrame - locals.length - closure.length)
      if (remaining === 0) break
      const props = await readScopeProps(s, scope.object.objectId, remaining, deadline)
      if (scope.type === "local" || scope.type === "catch" || scope.type === "block" || scope.type === "with") {
        locals.push(...props)
      } else if (scope.type === "closure") {
        closure.push(...props)
      }
    }
    const receiver = await readThis(s, cf, deadline)
    const snap: FrameSnapshot = {
      index: i,
      functionName: cf.functionName || "<anonymous>",
      locals,
      closure,
    }
    if (cf.url) snap.sourceUrl = cf.url
    if (cf.location?.lineNumber !== undefined) snap.line = cf.location.lineNumber + 1
    if (cf.location?.columnNumber !== undefined) snap.column = cf.location.columnNumber + 1
    if (receiver) snap.receiver = receiver
    frames.push(snap)
  }
  return frames
}

export async function install(hook: ForensicHook, options: ForensicOptions = {}): Promise<void> {
  if (session) {
    throw new Error("@inariwatch/node-forensic: fallback already installed")
  }
  activeOptions = { ...DEFAULT_OPTIONS, ...options }
  activeHook = hook
  const s = new Session()
  s.connect()
  await s.post("Debugger.enable")
  await s.post("Debugger.setPauseOnExceptions", { state: "uncaught" })

  s.on("Debugger.paused", (msg: { params: CdpPaused }) => {
    void handlePaused(s, msg.params)
  })

  session = s
}

async function handlePaused(s: Session, event: CdpPaused): Promise<void> {
  const startNs = process.hrtime.bigint()
  const startMs = Date.now()
  const opts = activeOptions
  const deadline = startMs + opts.captureBudgetMs
  let frames: FrameSnapshot[] = []
  let errorObj: Error
  try {
    frames = await buildFrames(s, event, opts, deadline)
  } catch (err) {
    frames = [{ index: 0, functionName: "<capture-failed>", locals: [], closure: [], partial: true }]
    errorObj = err instanceof Error ? err : new Error(String(err))
  } finally {
    try {
      await s.post("Debugger.resume")
    } catch {
      // Session may have been torn down mid-capture; nothing to do.
    }
  }

  // Extract the thrown object from CDP. `data.objectId` points at the Error.
  // We don't round-trip `Runtime.callFunctionOn` to materialize — the hook
  // gets a placeholder Error with the CDP description so downstream wiring
  // isn't null. The real Error reference is only available inside the
  // throwing VM anyway.
  const description = event.data?.description ?? "Unknown"
  const synthetic = new Error(description)
  synthetic.name = "ForensicCapturedException"
  errorObj ??= synthetic

  const endNs = process.hrtime.bigint()
  const capture: ForensicCapture = {
    frames,
    error: errorObj,
    pid: process.pid,
    tid: threadId,
    tsNs: startNs,
    source: "inspector",
    captureDurationMs: Number(endNs - startNs) / 1_000_000,
  }

  try {
    activeHook?.(capture)
  } catch (hookErr) {
    if (activeOptions.rethrowHookErrors) throw hookErr
  }
}

export async function uninstall(): Promise<void> {
  if (!session) return
  try {
    await session.post("Debugger.disable")
  } catch {
    // ignore — best effort
  }
  session.disconnect()
  session = null
  activeHook = null
  activeOptions = DEFAULT_OPTIONS
}

/** Escape hatch for tests that need to know whether the fallback is live. */
export function __isInstalled(): boolean {
  return session !== null
}
