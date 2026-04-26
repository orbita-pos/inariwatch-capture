/**
 * Precursor stream — SKYNET §3 piece 3 (Track B).
 *
 * Why: at the moment of throw, stack + locals tell the AI WHAT failed.
 * Precursors tell it WHY NOW. A 30-second 1Hz ring buffer of event loop p99,
 * RSS trajectory, active handles, and near-miss counters. Snapshotted at
 * error flush time and attached to `evidence.precursors[]` of payload v2.
 *
 * Sources:
 *   - eventloop p99: `perf_hooks.monitorEventLoopDelay({ resolution: 10 })`,
 *     read + reset every second so each sample reflects the prior 1s slice.
 *   - rss: `process.memoryUsage().rss`.
 *   - active handles: `process._getActiveHandles().length` (private API,
 *     guarded — silently 0 if Node yanks it).
 *   - near-misses: `process.on('rejectionHandled')` increments a counter
 *     (a rejection that was unhandled at first tick but caught later).
 *   - retries: `node:diagnostics_channel` `undici:request:error` if undici is
 *     in use. opossum / axios callers can drive the counter manually via
 *     `recordRetry()` / `recordCircuitBreakerTrip()`.
 *
 * Graceful degradation:
 *   - Browser / Edge / sandboxed Node: `node:perf_hooks` import fails →
 *     fall back to a setTimeout(1) jitter probe. p99 becomes "max scheduling
 *     lag observed in window" — coarser but still useful and never throws.
 *   - `process._getActiveHandles` missing → handles=0.
 *   - undici / opossum not installed → manual counters still work.
 *
 * Overhead budget (verified in test/precursors.test.mjs):
 *   - <1% CPU on a 1000 ops/s synthetic baseline.
 *   - <2 MB RAM (30 samples × ~80 bytes + monitor histogram).
 *
 * Zero deps.
 */

import type { Precursor } from "./types.js"

const WINDOW_SECONDS = 30
const SAMPLE_INTERVAL_MS = 1000
const RESOLUTION_MS = 10
// A signal must move at least this much vs early-window baseline before we
// emit a Precursor entry. Keeps the wire small when nothing interesting
// happened in the last 30s.
const MIN_DELTA_PCT = 5

interface Sample {
  t: number
  eventloopP99Ms: number
  rssMb: number
  activeHandles: number
  nearMisses: number
  retries: number
  circuitBreakerTrips: number
}

interface PerfMonitor {
  enable: () => void
  disable: () => void
  reset: () => void
  // Returns nanoseconds.
  percentile: (p: number) => number
}

interface State {
  ring: Sample[]
  capacity: number
  size: number
  head: number
  timer: ReturnType<typeof setInterval> | null
  monitor: PerfMonitor | null
  jitterTimer: ReturnType<typeof setTimeout> | null
  jitterScheduledAt: number
  jitterMaxMs: number
  counters: { nearMisses: number; retries: number; circuitBreakerTrips: number }
  cleanups: Array<() => void>
}

let state: State | null = null

/**
 * Start the 1Hz sampler + counter hooks. Idempotent — second call is a no-op.
 * Cheap to call from `init()`; the timer is `unref`'d so it never holds a
 * Node process open by itself.
 */
export function initPrecursors(): void {
  if (state) return

  const s: State = {
    ring: [],
    capacity: WINDOW_SECONDS,
    size: 0,
    head: 0,
    timer: null,
    monitor: null,
    jitterTimer: null,
    jitterScheduledAt: 0,
    jitterMaxMs: 0,
    counters: { nearMisses: 0, retries: 0, circuitBreakerTrips: 0 },
    cleanups: [],
  }
  state = s

  tryAttachPerfHooks(s)
  // Jitter fallback runs immediately so the first sample isn't blank while
  // the dynamic import settles. tryAttachPerfHooks tears it down once the
  // histogram is live — both never run at the same time.
  startJitterFallback(s)
  tryAttachRejectionHandled(s)
  tryAttachUndiciChannel(s)

  if (typeof setInterval === "undefined") return
  const timer = setInterval(() => {
    if (state === s) sample(s)
  }, SAMPLE_INTERVAL_MS)
  unref(timer)
  s.timer = timer
}

/** Stop sampling and detach all hooks. Safe to call when not initialized. */
export function stopPrecursors(): void {
  if (!state) return
  if (state.timer) clearInterval(state.timer)
  if (state.jitterTimer) clearTimeout(state.jitterTimer)
  for (const cleanup of state.cleanups) {
    try {
      cleanup()
    } catch {
      // best-effort
    }
  }
  state = null
}

/**
 * Compress the ring buffer into the sparse `Precursor[]` wire shape. Only
 * signals that meaningfully moved during the window are emitted; quiet
 * windows return `[]` so the payload stays small.
 *
 * Window seconds is computed from the first/last sample timestamps rather
 * than the constant — under load the sampler can drift a few hundred ms,
 * and the AI cares about real elapsed time, not the nominal cap.
 */
export function snapshotPrecursors(): Precursor[] {
  if (!state) return []
  const samples = readRingOrdered(state)
  if (samples.length < 2) return []

  const out: Precursor[] = []
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const windowSeconds = Math.max(1, Math.round((last.t - first.t) / 1000))

  // Event loop: max p99 in window vs early-window baseline (first 1/3 of
  // samples). Comparing peak vs baseline catches transient spikes that mean
  // averaging would mask.
  const baselineEnd = Math.max(1, Math.floor(samples.length / 3))
  const baselineP99 = avg(samples.slice(0, baselineEnd).map((s) => s.eventloopP99Ms))
  const peakP99 = max(samples.map((s) => s.eventloopP99Ms))
  if (peakP99 > 0) {
    const deltaPct =
      baselineP99 > 0 ? ((peakP99 - baselineP99) / baselineP99) * 100 : peakP99 * 100
    if (Math.abs(deltaPct) >= MIN_DELTA_PCT) {
      out.push({ signal: "eventloop_p99", deltaPct: round2(deltaPct), windowSeconds })
    }
  }

  // RSS: percent change first → last. Catches climbing leaks.
  if (first.rssMb > 0) {
    const deltaPct = ((last.rssMb - first.rssMb) / first.rssMb) * 100
    if (Math.abs(deltaPct) >= MIN_DELTA_PCT) {
      out.push({ signal: "rss_trend", deltaPct: round2(deltaPct), windowSeconds })
    }
  }

  // Counters: total events in window. The wire field is `deltaPct` for
  // every signal — for counters it carries raw count, not a percentage.
  // Documented in payload-v2 spec; consumers branch on `signal`.
  const retriesDelta = last.retries - first.retries
  if (retriesDelta > 0) {
    out.push({ signal: "retry_burst", deltaPct: retriesDelta, windowSeconds })
  }
  const nearMissDelta = last.nearMisses - first.nearMisses
  if (nearMissDelta > 0) {
    out.push({ signal: "near_miss_rejection", deltaPct: nearMissDelta, windowSeconds })
  }
  const cbDelta = last.circuitBreakerTrips - first.circuitBreakerTrips
  if (cbDelta > 0) {
    out.push({ signal: "circuit_breaker_trip", deltaPct: cbDelta, windowSeconds })
  }

  return out
}

/** Public counter hooks for callers that wrap their own retry / breaker code. */
export function recordNearMiss(): void {
  if (state) state.counters.nearMisses++
}
export function recordRetry(): void {
  if (state) state.counters.retries++
}
export function recordCircuitBreakerTrip(): void {
  if (state) state.counters.circuitBreakerTrips++
}

// ───────────────────────── Internals ───────────────────────────────────────

function tryAttachPerfHooks(s: State): void {
  if (typeof process === "undefined") return
  // Dynamic import keeps `node:perf_hooks` out of the browser bundle. The
  // webpackIgnore comment matches the pattern used in payload-v2.ts /
  // v2-emit.ts so bundlers don't try to resolve it at build time.
  const pkg = "node:perf_hooks"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  import(/* webpackIgnore: true */ pkg)
    .then((ph: any) => {
      if (state !== s) return
      if (typeof ph?.monitorEventLoopDelay !== "function") return
      try {
        const monitor: PerfMonitor = ph.monitorEventLoopDelay({
          resolution: RESOLUTION_MS,
        })
        monitor.enable()
        s.monitor = monitor
        // Histogram is live — kill the jitter probe to avoid double sampling.
        if (s.jitterTimer) {
          clearTimeout(s.jitterTimer)
          s.jitterTimer = null
        }
        s.cleanups.push(() => {
          try {
            monitor.disable()
          } catch {
            // best-effort
          }
        })
      } catch {
        // Older Node without histogram support — keep jitter fallback.
      }
    })
    .catch(() => {
      // Browser / Edge / sandboxed runtime — keep jitter fallback.
    })
}

function startJitterFallback(s: State): void {
  if (typeof setTimeout === "undefined") return
  // Schedule a 1ms timer; on fire, measure how late it actually ran. The max
  // lag observed inside the current 1s window becomes the "p99" surrogate.
  const tick = (): void => {
    if (state !== s) return
    const expected = s.jitterScheduledAt + 1
    const actual = nowMs()
    const lag = actual - expected
    if (lag > s.jitterMaxMs) s.jitterMaxMs = lag
    s.jitterScheduledAt = actual
    s.jitterTimer = setTimeout(tick, 1)
    unref(s.jitterTimer)
  }
  s.jitterScheduledAt = nowMs()
  s.jitterTimer = setTimeout(tick, 1)
  unref(s.jitterTimer)
}

function tryAttachRejectionHandled(s: State): void {
  if (typeof process === "undefined" || typeof process.on !== "function") return
  const handler = (): void => {
    s.counters.nearMisses++
  }
  try {
    process.on("rejectionHandled", handler)
    s.cleanups.push(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process as any).off?.("rejectionHandled", handler)
      } catch {
        // best-effort
      }
    })
  } catch {
    // Some hosts (Edge) disallow process listeners.
  }
}

function tryAttachUndiciChannel(s: State): void {
  if (typeof process === "undefined") return
  const pkg = "node:diagnostics_channel"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  import(/* webpackIgnore: true */ pkg)
    .then((dc: any) => {
      if (state !== s) return
      if (typeof dc?.subscribe !== "function") return
      const handler = (): void => {
        s.counters.retries++
      }
      try {
        dc.subscribe("undici:request:error", handler)
        s.cleanups.push(() => {
          try {
            dc.unsubscribe?.("undici:request:error", handler)
          } catch {
            // best-effort
          }
        })
      } catch {
        // Channel not registered — fine, manual recordRetry() still works.
      }
    })
    .catch(() => {
      // diagnostics_channel unavailable — silent.
    })
}

function sample(s: State): void {
  const now = nowMs()
  let p99Ms = 0
  if (s.monitor) {
    try {
      p99Ms = s.monitor.percentile(99) / 1e6
      s.monitor.reset()
    } catch {
      p99Ms = 0
    }
  } else {
    p99Ms = s.jitterMaxMs
    s.jitterMaxMs = 0
  }

  let rssMb = 0
  let activeHandles = 0
  if (typeof process !== "undefined") {
    try {
      rssMb = process.memoryUsage().rss / 1024 / 1024
    } catch {
      // memoryUsage unavailable on some runtimes.
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (process as any)._getActiveHandles
      activeHandles = typeof fn === "function" ? fn.call(process).length : 0
    } catch {
      activeHandles = 0
    }
  }

  pushSample(s, {
    t: now,
    eventloopP99Ms: p99Ms,
    rssMb,
    activeHandles,
    nearMisses: s.counters.nearMisses,
    retries: s.counters.retries,
    circuitBreakerTrips: s.counters.circuitBreakerTrips,
  })
}

function pushSample(s: State, entry: Sample): void {
  if (s.size < s.capacity) {
    s.ring.push(entry)
    s.size++
  } else {
    s.ring[s.head] = entry
  }
  s.head = (s.head + 1) % s.capacity
}

function readRingOrdered(s: State): Sample[] {
  if (s.size < s.capacity) return s.ring.slice()
  return [...s.ring.slice(s.head), ...s.ring.slice(0, s.head)]
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  let sum = 0
  for (const n of arr) sum += n
  return sum / arr.length
}

function max(arr: number[]): number {
  let m = 0
  for (const n of arr) if (n > m) m = n
  return m
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unref(handle: any): void {
  if (handle && typeof handle.unref === "function") handle.unref()
}

// ───────────────────────── Test helpers ────────────────────────────────────
// Exposed for `test/precursors.test.mjs`. Not part of the public API; the
// `__` prefix matches the convention used in `signing.ts` /
// `fulltrace.ts`.

export function __resetPrecursorsForTesting(): void {
  stopPrecursors()
}

export function __forceSampleForTesting(): void {
  if (state) sample(state)
}

export function __isPerfHooksActiveForTesting(): boolean {
  return !!state?.monitor
}

export async function __waitForPerfHooksReadyForTesting(timeoutMs = 1000): Promise<boolean> {
  const start = nowMs()
  while (nowMs() - start < timeoutMs) {
    if (state?.monitor) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return !!state?.monitor
}

export function __getRingForTesting(): ReadonlyArray<Readonly<Sample>> | null {
  return state ? readRingOrdered(state) : null
}
