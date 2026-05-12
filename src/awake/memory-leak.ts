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
const HEAP_GROWTH_TOLERANCE = 0.9 // allow 10% shrinkage between samples

function isMonotonicallyGrowing(values: number[]): boolean {
  if (values.length < LEAK_WINDOW) return false
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1] * HEAP_GROWTH_TOLERANCE) return false
  }
  return true
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

      const heapLeaking = hasMemory && isMonotonicallyGrowing(heapValues)
      const domLeaking = isMonotonicallyGrowing(domValues)

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
