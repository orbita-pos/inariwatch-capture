/**
 * Fleet bloom client — fetches the public bloom, holds in memory, exposes
 * `hasAnyoneElseHit(fingerprint)` synchronously.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 */

import { deserialize, has, type BloomFilter } from "./bloom.js"

export interface FleetBloomClientOptions {
  /** Base URL of an InariWatch server. Defaults to https://app.inariwatch.com */
  baseUrl?: string
  /** Soft deadline on the initial fetch. Default: 200ms (Q5.4 acceptance). */
  initTimeoutMs?: number
  /** Periodic refresh interval. Default: 86400 (24h). 0 disables refresh. */
  refreshSeconds?: number
  /** Optional debug logger. */
  debug?: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface FleetBloomMeta {
  versionTag: string
  count: number
  fpr: number
  builtAt: string
  byteSize: number
}

export class FleetBloomClient {
  private bloom: BloomFilter | null = null
  private meta: FleetBloomMeta | null = null
  private etag: string | null = null
  private readonly baseUrl: string
  private readonly initTimeoutMs: number
  private readonly refreshSeconds: number
  private readonly debug?: FleetBloomClientOptions["debug"]
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: FleetBloomClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://app.inariwatch.com").replace(/\/$/, "")
    this.initTimeoutMs = opts.initTimeoutMs ?? 200
    this.refreshSeconds = opts.refreshSeconds ?? 86_400
    this.debug = opts.debug
  }

  /**
   * Fetch the bloom now. Resolves when loaded (or skipped). NEVER throws —
   * a slow/down server must not block SDK init.
   */
  async init(): Promise<void> {
    await this.fetchOnce(this.initTimeoutMs)
    if (this.refreshSeconds > 0) {
      this.refreshTimer = setInterval(() => {
        // Background refresh — no deadline. If it fails, last good copy stays.
        this.fetchOnce(30_000).catch(() => {})
      }, this.refreshSeconds * 1000)
      // Don't keep the event loop alive just for refresh.
      this.refreshTimer.unref?.()
    }
  }

  /** Stop the background refresh. */
  close(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  /**
   * Synchronous bloom membership check. Returns false when the bloom isn't
   * loaded (yet) — never blocks. Sub-microsecond lookup.
   */
  hasAnyoneElseHit(fingerprint: string): boolean {
    if (!this.bloom) return false
    return has(this.bloom, fingerprint)
  }

  /** Current loaded bloom metadata, or null if not loaded. */
  getMeta(): FleetBloomMeta | null {
    return this.meta
  }

  /** Force a refresh outside the timer. Returns whether it loaded fresh data. */
  async refresh(): Promise<boolean> {
    return this.fetchOnce(30_000)
  }

  private async fetchOnce(timeoutMs: number): Promise<boolean> {
    const url = `${this.baseUrl}/api/fleet/bloom/latest`
    try {
      const headers: Record<string, string> = { accept: "application/octet-stream" }
      if (this.etag) headers["if-none-match"] = `"${this.etag}"`
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 304) {
        this.debug?.("fleet-bloom: 304 not modified", { versionTag: this.etag })
        return false
      }
      if (res.status === 503) {
        this.debug?.("fleet-bloom: 503 — server has no bloom yet")
        return false
      }
      if (!res.ok) {
        this.debug?.("fleet-bloom: fetch failed", { status: res.status })
        return false
      }
      const ab = await res.arrayBuffer()
      const buf = Buffer.from(ab)
      const bloom = deserialize(buf)
      this.bloom = bloom
      const versionTag = res.headers.get("x-bloom-version") ?? ""
      this.etag = versionTag
      this.meta = {
        versionTag,
        count: Number(res.headers.get("x-bloom-count") ?? bloom.count),
        fpr: Number(res.headers.get("x-bloom-fpr") ?? 0),
        builtAt: res.headers.get("x-bloom-built-at") ?? "",
        byteSize: buf.byteLength,
      }
      this.debug?.("fleet-bloom: loaded", { ...this.meta })
      return true
    } catch (err) {
      this.debug?.("fleet-bloom: fetch threw", {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }
}

/**
 * Best-effort live observation: when the SDK sees an error not covered by
 * the bloom, POST the fingerprint to the public observe endpoint so the
 * next bloom build picks it up. Caps at one POST per process per
 * fingerprint via an in-memory Set.
 */
export async function contributeFingerprint(
  baseUrl: string,
  fingerprint: string,
  meta?: { framework?: string; language?: string },
): Promise<boolean> {
  if (!fingerprint) return false
  if (_seenContributions.has(fingerprint)) return false
  _seenContributions.add(fingerprint)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/fleet/bloom/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint, ...meta }),
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

const _seenContributions = new Set<string>()

/** Test-only: clear the in-process contribution dedup set. */
export function __resetContributionsForTesting(): void {
  _seenContributions.clear()
}
