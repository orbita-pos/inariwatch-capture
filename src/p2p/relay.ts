/**
 * In-process relay implementing the same semantics as the Cloudflare Durable
 * Object server (`server-cf.ts`). Used by the e2e tests; the CF Worker reuses
 * the helpers below so the two stay byte-identical.
 *
 * Server-side responsibilities (per P2P_DESIGN.md §5):
 *   1. Workspace isolation — a peer connected to workspace W only ever sees
 *      messages from other peers in W.
 *   2. Pubkey distribution — first message from a peer registers their
 *      pubkey; subsequent messages with a different pubkey for the same
 *      peer_id are rejected (forgery defense).
 *   3. Signature verification — defense in depth. The receiver verifies too,
 *      but the relay drops obvious garbage so it doesn't fan out.
 *   4. Per-peer rate limit — tokens-per-minute bucket; overflow drops.
 *   5. Blocklist — N rate-limit rejections in a 5-minute window puts the
 *      peer on a 5-minute timeout. Forgery attempts go straight to the
 *      timeout list.
 *
 * Single-process / synchronous on purpose: tests assert end-to-end latency
 * without flake, and the CF Worker's WebSocket Hibernation API has the same
 * "single-threaded per Durable Object" guarantee, so the design carries.
 */

import { createHash } from "node:crypto"
import { canonicalize, type P2PMessage } from "./client.js"
import { verifyReceiptIdSignature } from "../signing.js"
import { InMemoryTransport } from "./transport-memory.js"

/** Mirrors client RATE_LIMIT_PER_MINUTE; relay is the cap, not the throttle. */
const RELAY_RATE_LIMIT_PER_MINUTE = 200

/** N rate-limit rejections in this window blocklists the peer. */
const RELAY_BLOCKLIST_TRIGGER_COUNT = 3
const RELAY_BLOCKLIST_TRIGGER_WINDOW_MS = 5 * 60 * 1000
const RELAY_BLOCKLIST_DURATION_MS = 5 * 60 * 1000

/** Replay-window tolerance — same as the client. */
const RELAY_TS_ACCEPT_PAST_MS = 30_000
const RELAY_TS_ACCEPT_FUTURE_MS = 5_000

export interface RelayStats {
  /** Total messages successfully fanned out (sender already excluded). */
  delivered: number
  /** Messages dropped before fan-out, broken down by reason. */
  rejected: {
    workspaceMismatch: number
    badSignature: number
    pubkeyForgery: number
    rateLimited: number
    blocked: number
    replay: number
    pubkeyMismatch: number
  }
  /** Peer ids currently in the timeout list. */
  blocked: string[]
}

interface PeerEntry {
  workspaceId: string
  transport: InMemoryTransport
  /** Set on first accepted message — sticky for the connection's lifetime. */
  peerId: string | null
  pubkey: string | null
}

interface RelayBucket {
  tokens: number
  lastRefillMs: number
}

interface RelayBlockState {
  rejections: number[]
  blockedUntilMs: number
}

export class InMemoryRelay {
  private readonly entries = new Set<PeerEntry>()
  private readonly workspaces = new Map<string, Set<PeerEntry>>()
  private readonly buckets = new Map<string, RelayBucket>()
  private readonly blocks = new Map<string, RelayBlockState>()
  /** peer_id → pubkey, accumulated from first accepted message. */
  private readonly registry = new Map<string, string>()
  private readonly stats: RelayStats = {
    delivered: 0,
    rejected: {
      workspaceMismatch: 0,
      badSignature: 0,
      pubkeyForgery: 0,
      rateLimited: 0,
      blocked: 0,
      replay: 0,
      pubkeyMismatch: 0,
    },
    blocked: [],
  }

  /** Allow tests to inject `nowMs` for deterministic blocklist timing. */
  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * Register a new peer connection. The returned transport is bound to the
   * relay — `publish()` runs through the anti-abuse pipeline; the relay
   * delivers fan-out via the transport's `__deliver()` hook.
   */
  connect(workspaceId: string): InMemoryTransport {
    const transport = new InMemoryTransport()
    const entry: PeerEntry = {
      workspaceId,
      transport,
      peerId: null,
      pubkey: null,
    }
    this.entries.add(entry)
    let group = this.workspaces.get(workspaceId)
    if (!group) {
      group = new Set()
      this.workspaces.set(workspaceId, group)
    }
    group.add(entry)
    transport.__setOutgoing((msg) => this.handlePublish(entry, msg))
    return transport
  }

  /** Disconnect every peer and drop all relay state. */
  shutdown(): void {
    for (const entry of this.entries) {
      entry.transport.shutdown()
    }
    this.entries.clear()
    this.workspaces.clear()
    this.buckets.clear()
    this.blocks.clear()
    this.registry.clear()
  }

  /** Snapshot — useful for asserting in tests. */
  getStats(): RelayStats {
    return {
      delivered: this.stats.delivered,
      rejected: { ...this.stats.rejected },
      blocked: Array.from(this.blocks.entries())
        .filter(([, state]) => state.blockedUntilMs > this.clock())
        .map(([peerId]) => peerId),
    }
  }

  /** Pubkey distribution: lookup the registered pubkey for a peer_id. */
  getPubkey(peerId: string): string | null {
    return this.registry.get(peerId) ?? null
  }

  private handlePublish(entry: PeerEntry, msg: P2PMessage): void {
    const nowMs = this.clock()

    // Workspace isolation: a connection bound to workspace W must never
    // emit anything for another workspace, even if the envelope claims so.
    if (msg.workspace_id !== entry.workspaceId) {
      this.stats.rejected.workspaceMismatch++
      return
    }

    if (!isFreshTimestamp(msg.ts, nowMs)) {
      this.stats.rejected.replay++
      return
    }

    if (!isPeerIdConsistent(msg)) {
      this.stats.rejected.badSignature++
      return
    }

    if (!verifySignatureV1(msg)) {
      this.stats.rejected.badSignature++
      return
    }

    // Pubkey forgery: same peer_id, different pubkey than what we registered.
    // Goes straight to the blocklist — there is no innocent reason for this.
    const known = this.registry.get(msg.peer_id)
    if (known && known !== msg.pubkey) {
      this.stats.rejected.pubkeyForgery++
      this.recordRejection(msg.peer_id, nowMs)
      return
    }

    if (this.isBlocked(msg.peer_id, nowMs)) {
      this.stats.rejected.blocked++
      return
    }

    if (!this.consumeToken(msg.peer_id, nowMs)) {
      this.stats.rejected.rateLimited++
      this.recordRejection(msg.peer_id, nowMs)
      return
    }

    // Connection ↔ peer_id binding: once a connection has sent a message as
    // peer X, it can't switch to peer Y. Blocks a compromised connection
    // from impersonating a sibling peer in the same workspace.
    if (entry.peerId === null) {
      entry.peerId = msg.peer_id
      entry.pubkey = msg.pubkey
    } else if (entry.peerId !== msg.peer_id) {
      this.stats.rejected.pubkeyMismatch++
      return
    }

    if (!known) {
      this.registry.set(msg.peer_id, msg.pubkey)
    }

    // Fan out to every other peer in the same workspace. The publisher does
    // not echo to itself — clients rely on local state for that.
    const group = this.workspaces.get(entry.workspaceId)
    if (!group) return
    for (const other of group) {
      if (other === entry) continue
      other.transport.__deliver(msg)
      this.stats.delivered++
    }
  }

  private consumeToken(peerId: string, nowMs: number): boolean {
    let bucket = this.buckets.get(peerId)
    if (!bucket) {
      bucket = { tokens: RELAY_RATE_LIMIT_PER_MINUTE, lastRefillMs: nowMs }
      this.buckets.set(peerId, bucket)
    }
    const elapsed = nowMs - bucket.lastRefillMs
    if (elapsed > 0) {
      const refill = (elapsed / 60_000) * RELAY_RATE_LIMIT_PER_MINUTE
      bucket.tokens = Math.min(RELAY_RATE_LIMIT_PER_MINUTE, bucket.tokens + refill)
      bucket.lastRefillMs = nowMs
    }
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  private isBlocked(peerId: string, nowMs: number): boolean {
    const state = this.blocks.get(peerId)
    if (!state) return false
    return state.blockedUntilMs > nowMs
  }

  private recordRejection(peerId: string, nowMs: number): void {
    let state = this.blocks.get(peerId)
    if (!state) {
      state = { rejections: [], blockedUntilMs: 0 }
      this.blocks.set(peerId, state)
    }
    state.rejections = state.rejections.filter(
      (t) => nowMs - t < RELAY_BLOCKLIST_TRIGGER_WINDOW_MS,
    )
    state.rejections.push(nowMs)
    if (state.rejections.length >= RELAY_BLOCKLIST_TRIGGER_COUNT) {
      state.blockedUntilMs = nowMs + RELAY_BLOCKLIST_DURATION_MS
      state.rejections = []
    }
  }
}

// ── Helpers shared with `server-cf.ts` ───────────────────────────────────────

export function isFreshTimestamp(tsIso: string, nowMs: number): boolean {
  const ts = Date.parse(tsIso)
  if (Number.isNaN(ts)) return false
  if (ts > nowMs + RELAY_TS_ACCEPT_FUTURE_MS) return false
  if (ts < nowMs - RELAY_TS_ACCEPT_PAST_MS) return false
  return true
}

export function isPeerIdConsistent(msg: P2PMessage): boolean {
  try {
    const pubBytes = Buffer.from(msg.pubkey, "hex")
    if (pubBytes.length !== 32) return false
    const derived = createHash("sha256").update(pubBytes).digest("hex").slice(0, 16)
    return derived === msg.peer_id
  } catch {
    return false
  }
}

export function verifySignatureV1(msg: P2PMessage): boolean {
  const { sig: _sig, pubkey: _pubkey, ...rest } = msg
  void _sig
  void _pubkey
  const sigInput = canonicalize(rest as Record<string, unknown>)
  const digest = createHash("sha256").update(sigInput, "utf8").digest("hex")
  return verifyReceiptIdSignature(digest, msg.sig, msg.pubkey)
}
