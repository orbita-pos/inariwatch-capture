/**
 * Environment context — captured at error time.
 * Uses Node.js built-in os + process modules (zero deps).
 */

import type { EnvironmentContext } from "./types.js"

export function getEnvironmentContext(): EnvironmentContext | undefined {
  // Bail out early in browsers and edge runtimes — `os` + `process.*` are not
  // available and Turbopack/webpack error on seeing `require("os")` in a
  // browser bundle unless we keep the reference opaque via indirect eval.
  if (typeof window !== "undefined") return undefined
  if (typeof process === "undefined" || typeof process.memoryUsage !== "function") return undefined

  try {
    // Indirect eval (`(0, eval)`) hides the Node-only identifiers from
    // bundler static analysis. Without this, Turbopack warns "A Node.js API
    // is used (process.memoryUsage) which is not supported in the Edge
    // Runtime" even though our runtime guard above ensures the code never
    // runs in edge.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (0, eval)("require") as (m: string) => any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (0, eval)("process") as any
    const os = req("os")
    const mem = proc.memoryUsage()

    return {
      node: proc.version,
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1048576),
      freeMemoryMB: Math.round(os.freemem() / 1048576),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      uptime: Math.round(proc.uptime()),
    }
  } catch {
    // Edge runtime or sandboxed context — os module not available
    return undefined
  }
}
