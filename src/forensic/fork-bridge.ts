import type { ForensicHook, ForensicOptions } from "./types.js"

/**
 * Bridge to the ForensicVM fork's N-API module.
 *
 * When the user runs the `@inariwatch/node-forensic` binary distribution
 * (forked Node with v8::forensics compiled in), `process.versions.iw_forensic`
 * is set and a native module is exposed at `process.binding("iw_forensic")`
 * (or via `node:inariwatch-forensic` later — TBD with Node core patch).
 *
 * On stock Node this file always reports unavailable so the caller falls
 * back. Once the fork lands, replace the body with the real binding —
 * the public contract (`isAvailable` / `install` / `uninstall`) doesn't
 * change, so `./index.ts` keeps working.
 */

interface ForkBinding {
  register(cb: (payload: Uint8Array) => void, opts: unknown): void
  unregister(): void
}

function getBinding(): ForkBinding | null {
  const versions = process.versions as Record<string, string | undefined>
  if (!versions.iw_forensic) return null
  // Not wired on stock Node. Real implementation lands with the fork patch.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const binding = (process as unknown as { binding?: (name: string) => unknown }).binding?.("iw_forensic")
  return (binding as ForkBinding | null) ?? null
}

export function isAvailable(): boolean {
  return getBinding() !== null
}

export async function install(_hook: ForensicHook, _options: ForensicOptions): Promise<void> {
  if (!isAvailable()) {
    throw new Error("@inariwatch/node-forensic: fork bridge not available on this runtime")
  }
  // Placeholder. Fork integration lands in a follow-up once the V8 patch
  // compiles and the N-API shim is published.
  throw new Error("@inariwatch/node-forensic: fork bridge not yet implemented — use fallback")
}

export async function uninstall(): Promise<void> {
  // No-op until the fork bridge is wired.
}
