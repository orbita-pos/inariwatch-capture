/**
 * Tiny standalone helper for picking the active payload wire version.
 *
 * Lives in its own module so `client.ts` (which is reachable from browser +
 * Edge runtime entry points) doesn't need to import `v2-emit.ts` eagerly.
 * v2-emit transitively reaches Node-only modules (`source-context` →
 * `node:fs`, `node:child_process`) and Turbopack walks even dynamic imports
 * during static analysis, so an eager top-level import was breaking Edge +
 * browser bundles.
 *
 * Pure: reads env vars only. Safe in browser (`process` may be undefined),
 * Edge, and Node.
 */
export function resolvePayloadVersion(): "1" | "2" {
  const env =
    typeof process !== "undefined" && process.env
      ? process.env
      : ({} as Record<string, string | undefined>)
  const v =
    env.CAPTURE_PAYLOAD_VERSION ?? env.INARIWATCH_PAYLOAD_VERSION ?? "1"
  return v === "2" ? "2" : "1"
}
