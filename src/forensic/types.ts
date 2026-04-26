/**
 * Stable shape exposed to `@inariwatch/capture` and (later) to the
 * ForensicVM fork. The fork serializes frames to MessagePack, the peer
 * decodes into this same shape so core SDK code never knows which path
 * produced the capture.
 */

/** A single local, closure, or receiver slot read from a frame. */
export interface ForensicValue {
  /** Variable name as it appears in source (for closures: the captured identifier). */
  name: string
  /**
   * Serialized representation. `repr` is always a string — primitives are stringified,
   * objects get a bounded JSON-ish preview. `truncated` signals we hit a budget.
   */
  repr: string
  /** JS typeof, or "object:<constructor>" / "array" / "function" / "promise" / "error". */
  kind: string
  /** True when the serializer hit depth / size / time budget and stopped walking. */
  truncated?: boolean
}

/** One frame in the stack, richer than the plain Error.stack string. */
export interface FrameSnapshot {
  /** 0 = innermost (throw site). */
  index: number
  /** Function name or "<anonymous>". */
  functionName: string
  /** Absolute file URL as V8 reports it (file://… or node:…). */
  sourceUrl?: string
  /** 1-based line number. */
  line?: number
  /** 1-based column. */
  column?: number
  /** Local variables visible in this frame's scope. */
  locals: ForensicValue[]
  /** Variables captured by closure, innermost-first. */
  closure: ForensicValue[]
  /** The `this` binding of the frame, if not undefined/null. */
  receiver?: ForensicValue
  /** Set when we couldn't read part of the frame (e.g. optimized-out var). */
  partial?: boolean
}

/** Payload handed to the user's hook when an uncaught / captured throw fires. */
export interface ForensicCapture {
  /** Frames innermost-first. Length capped by maxFrames option. */
  frames: FrameSnapshot[]
  /** The original Error object. Not serialized — the hook consumer decides. */
  error: Error
  /**
   * FullTrace session id when known. Lets the stitching layer (eBPF agent,
   * Replay viewer, server ingest) correlate forensic frames with request /
   * session boundaries. Resolved lazily by the hook owner.
   */
  sessionId?: string
  /** OS process id. Same value the eBPF uprobe emits. */
  pid: number
  /** worker_threads.threadId (0 on the main thread). */
  tid: number
  /** process.hrtime.bigint() at capture time — monotonic, nanoseconds. */
  tsNs: bigint
  /** "fork" when served by ForensicVM, "inspector" when by the fallback path. */
  source: "fork" | "inspector"
  /** Wall-clock ms the capture itself took. Useful for budget regression tests. */
  captureDurationMs: number
}

export type ForensicHook = (capture: ForensicCapture) => void

export interface ForensicOptions {
  /** Max frames walked. Default 32. Throws with &gt;32 frames get the innermost 32. */
  maxFrames?: number
  /** Max locals serialized per frame. Default 50. */
  maxLocalsPerFrame?: number
  /** Per-value serialization object depth. Default 2. */
  maxValueDepth?: number
  /** Per-value serialization byte cap. Default 1024. */
  maxValueBytes?: number
  /** Hard wall on one capture before we bail out and mark frames truncated. Default 5ms. */
  captureBudgetMs?: number
  /**
   * When true, force the inspector.Session fallback even if the ForensicVM
   * fork API is present. Useful for benchmarking the two paths side by side.
   */
  forceFallback?: boolean
  /** Throws/rejections triggered inside the hook itself are swallowed by default. */
  rethrowHookErrors?: boolean
}

export const DEFAULT_OPTIONS: Required<ForensicOptions> = {
  maxFrames: 32,
  maxLocalsPerFrame: 50,
  maxValueDepth: 2,
  maxValueBytes: 1024,
  captureBudgetMs: 5,
  forceFallback: false,
  rethrowHookErrors: false,
}
