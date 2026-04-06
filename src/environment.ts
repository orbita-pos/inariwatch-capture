/**
 * Environment context — captured at error time.
 * Uses Node.js built-in os + process modules (zero deps).
 */

import type { EnvironmentContext } from "./types.js"

export function getEnvironmentContext(): EnvironmentContext | undefined {
  try {
    const os = require("os")
    const mem = process.memoryUsage()

    return {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1048576),
      freeMemoryMB: Math.round(os.freemem() / 1048576),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      uptime: Math.round(process.uptime()),
    }
  } catch {
    // Edge runtime — os module not available
    return undefined
  }
}
