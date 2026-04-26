/**
 * Zero-retention tombstone storage — Track E pieza 11.
 *
 * When `INARIWATCH_ZERO_RETENTION=true` the SDK adds the
 * `X-IW-Zero-Retention: 1` header to every transport request. The server
 * never persists the event; instead it returns a signed tombstone:
 *
 *   {
 *     v: 1,
 *     ts: "2026-04-25T...",
 *     fingerprint_hash: "<sha256 of fingerprint>",
 *     processed_actions: ["analyzed", "deduplicated", "notified"],
 *     integration_id: "<uuid>",
 *     key_id: "<16 hex>",
 *     tombstone_id: "<64 hex>",
 *     sig: "ed25519:<128 hex>",
 *     pubkey: "<64 hex>"
 *   }
 *
 * We append each tombstone to `~/.inariwatch/tombstones.jsonl` so a
 * compliance auditor can replay and verify them later via
 * `POST /api/eap/verify/tombstone/:hash`.
 *
 * Browser/edge: silently no-op — the spec only makes sense in Node, and
 * compliance clients always run their backends on Node/Python anyway.
 */

export interface SignedTombstone {
  v: 1
  ts: string
  fingerprint_hash: string
  processed_actions: string[]
  integration_id: string
  key_id: string
  tombstone_id: string
  sig: string
  pubkey: string
}

/** Read once at module load — the env var only matters to a long-running
 *  Node process, and re-reading on every send wastes cycles. Tests that
 *  flip the flag at runtime can override it via `setZeroRetentionForTesting`. */
let zeroRetentionEnabled: boolean = (() => {
  if (typeof process === "undefined" || !process.env) return false
  const flag = process.env.INARIWATCH_ZERO_RETENTION
  return flag === "true" || flag === "1"
})()

export function isZeroRetentionEnabled(): boolean {
  return zeroRetentionEnabled
}

/** Test seam — let unit tests flip the flag without setenv. */
export function setZeroRetentionForTesting(value: boolean): void {
  zeroRetentionEnabled = value
}

/**
 * Append a tombstone to the local audit log. Best-effort: we never throw
 * out of this — the SDK should never crash because a tombstone failed to
 * persist (the original error already failed, that's enough).
 *
 * Browser hosts: no-op (no fs).
 */
export async function persistTombstone(tombstone: SignedTombstone): Promise<void> {
  // Skip when running in a browser or non-Node runtime — fs is unavailable.
  if (typeof window !== "undefined") return
  if (typeof process === "undefined") return

  try {
    // Dynamic imports keep `node:fs`/`node:path`/`node:os` out of
    // browser bundles. Bundlers tree-shake the entire branch when this
    // helper is unreachable, but explicit dynamic import guarantees it
    // even with naive bundlers (e.g. Vite SSR).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fsPkg = "node:fs"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pathPkg = "node:path"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const osPkg = "node:os"
    const [fs, path, os] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import(/* webpackIgnore: true */ fsPkg) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import(/* webpackIgnore: true */ pathPkg) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      import(/* webpackIgnore: true */ osPkg) as Promise<any>,
    ])

    const dir =
      process.env.INARIWATCH_TOMBSTONE_DIR ?? path.join(os.homedir(), ".inariwatch")
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })

    const file = path.join(dir, "tombstones.jsonl")
    const line = JSON.stringify(tombstone) + "\n"
    await fs.promises.appendFile(file, line, { encoding: "utf8", mode: 0o600 })
  } catch {
    // Swallow: persistence is best-effort.
  }
}

/**
 * Try to extract a SignedTombstone from a webhook response body. Returns
 * null when the response shape doesn't match (legacy server, error, etc.).
 *
 * The transport calls this on every successful send; null returns mean
 * "this server didn't tombstone the event" — no further action needed.
 */
export function extractTombstone(json: unknown): SignedTombstone | null {
  if (!json || typeof json !== "object") return null
  const obj = json as Record<string, unknown>
  if (obj.mode !== "zero-retention") return null
  const t = obj.tombstone
  if (!t || typeof t !== "object") return null
  const candidate = t as Record<string, unknown>
  if (
    candidate.v !== 1 ||
    typeof candidate.ts !== "string" ||
    typeof candidate.fingerprint_hash !== "string" ||
    !Array.isArray(candidate.processed_actions) ||
    typeof candidate.integration_id !== "string" ||
    typeof candidate.key_id !== "string" ||
    typeof candidate.tombstone_id !== "string" ||
    typeof candidate.sig !== "string" ||
    typeof candidate.pubkey !== "string"
  ) {
    return null
  }
  return candidate as unknown as SignedTombstone
}
