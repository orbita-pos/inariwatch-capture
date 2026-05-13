import { captureLog } from "../client.js"
import type { AwakeConfig } from "../types.js"
import { NAVIGATION_EVENT } from "./spa-routing.js"

// performance.memory — Chrome only, not in TS lib
interface MemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

interface PerfWithMemory extends Performance {
  memory?: MemoryInfo
}

interface Sample {
  heapBytes: number
  domNodes: number
  ts: number
}

const MAX_SAMPLES = 12
const LEAK_WINDOW = 10
// 2% per-step tolerance — Chrome's performance.memory is quantized to
// MB and lags GC, so a tiny dip between samples is normal and shouldn't
// reset the "is growing?" flag. 10% (the previous setting) was loose
// enough that a heap going 100→90MB still reported as leaking.
const HEAP_GROWTH_TOLERANCE = 0.98
// Require an end-to-end growth of at least 5% AND 5MB across the window
// before reporting. Without this floor, normal startup growth (lazy
// chunks, image decoders) trips the detector on every long session.
const HEAP_END_GROWTH_PCT = 0.05
const HEAP_END_GROWTH_MIN_BYTES = 5 * 1024 * 1024
// DOM nodes don't have the GC quantization issue — tighten to 5% step
// tolerance and require at least 50 net new nodes by the end.
const DOM_GROWTH_TOLERANCE = 0.95
const DOM_END_GROWTH_MIN_NODES = 50

/**
 * Returns true iff each sample is at most `tolerance` smaller than the
 * previous one (i.e., the series is approximately non-decreasing).
 * Tolerance of 0.98 means each step can dip up to 2% before the chain
 * is considered broken.
 */
function isApproximatelyNonDecreasing(values: number[], tolerance: number): boolean {
  if (values.length < LEAK_WINDOW) return false
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1] * tolerance) return false
  }
  return true
}

/**
 * End-to-end growth check. Together with the non-decreasing chain above
 * this rejects "growing by GC quantization noise" and only fires when
 * the trend has real magnitude.
 */
function hasMeaningfulEndGrowth(
  values: number[],
  minPct: number,
  minAbs: number,
): boolean {
  const first = values[0] ?? 0
  const last = values[values.length - 1] ?? 0
  if (first <= 0) return false
  const delta = last - first
  return delta >= minAbs && delta / first >= minPct
}

export function installMemoryLeak(_config: AwakeConfig): void {
  if (typeof window === "undefined") return

  const perf = performance as PerfWithMemory
  const hasMemory = Boolean(perf.memory)
  const hasDomCount = true // always available

  if (!hasMemory && !hasDomCount) return

  const samples: Sample[] = []
  let leakReported = false

  function sample(): void {
    setTimeout(() => {
      const heapBytes = perf.memory?.usedJSHeapSize ?? 0
      const domNodes = document.querySelectorAll("*").length

      samples.push({ heapBytes, domNodes, ts: Date.now() })
      if (samples.length > MAX_SAMPLES) samples.shift()

      if (leakReported || samples.length < LEAK_WINDOW) return

      const heapValues = samples.map(s => s.heapBytes)
      const domValues = samples.map(s => s.domNodes)

      const heapLeaking =
        hasMemory &&
        isApproximatelyNonDecreasing(heapValues, HEAP_GROWTH_TOLERANCE) &&
        hasMeaningfulEndGrowth(heapValues, HEAP_END_GROWTH_PCT, HEAP_END_GROWTH_MIN_BYTES)
      const domLeaking =
        isApproximatelyNonDecreasing(domValues, DOM_GROWTH_TOLERANCE) &&
        ((domValues[domValues.length - 1] ?? 0) - (domValues[0] ?? 0)) >= DOM_END_GROWTH_MIN_NODES

      if (heapLeaking || domLeaking) {
        leakReported = true
        const first = samples[0]
        const last = samples[samples.length - 1]
        captureLog(
          `suspected_memory_leak: ${heapLeaking ? "heap" : ""}${heapLeaking && domLeaking ? "+" : ""}${domLeaking ? "dom" : ""} growing across ${samples.length} navigations`,
          "warn",
          {
            kind: "memory_leak",
            heapGrowthMb: hasMemory
              ? Math.round(((last?.heapBytes ?? 0) - (first?.heapBytes ?? 0)) / 1024 / 1024 * 10) / 10
              : undefined,
            domGrowth: (last?.domNodes ?? 0) - (first?.domNodes ?? 0),
            navigationCount: samples.length,
            spanMs: (last?.ts ?? 0) - (first?.ts ?? 0),
            heapLeaking,
            domLeaking,
            url: location.href,
          },
        )
      }
    }, 500) // sample after DOM has settled
  }

  // Sample on SPA navigations (dispatched by spa-routing.ts)
  window.addEventListener(NAVIGATION_EVENT, sample)
  // Sample on browser back/forward
  window.addEventListener("popstate", sample)
}
