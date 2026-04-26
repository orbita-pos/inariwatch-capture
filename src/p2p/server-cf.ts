/**
 * Cloudflare Durable Object server (Track F · piece 8 · Sesión 13).
 *
 * One Durable Object instance per workspace, addressed by `workspace_id`.
 * Cloudflare guarantees single-threaded execution and single-region
 * pinning per object — workspace isolation comes free.
 *
 * Wire format and anti-abuse rules are byte-identical to `relay.ts` (the
 * in-process test backend). Both files import the same helpers from
 * `relay.ts` so the protocol can never drift between test and prod.
 *
 * Deploy: see `capture/server/wrangler.toml` (Sesión 14). This file ships
 * with the SDK so the spec is co-located with the client; it's compiled
 * out of consumer bundles by tree-shaking (no consumer imports it).
 */

import type { P2PMessage } from "./client.js"
import {
  isFreshTimestamp,
  isPeerIdConsistent,
  verifySignatureV1,
} from "./relay.js"

// ── Cloudflare runtime ambient types (subset we use) ─────────────────────────
//
// We don't pull in `@cloudflare/workers-types` because that'd be a devDep with
// no value to consumers. The shapes below are all we need.

type CfWebSocket = {
  accept(): void
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: "message",
    listener: (ev: { data: unknown }) => void,
  ): void
  addEventListener(type: "close", listener: () => void): void
}

type CfWebSocketPair = {
  0: CfWebSocket
  1: CfWebSocket
}

type CfDurableObjectState = {
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void
  getWebSockets(tag?: string): CfWebSocket[]
}

declare const WebSocketPair: { new (): CfWebSocketPair }

interface Env {
  GOSSIP_ROOMS: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(req: Request): Promise<Response> }
  }
}

const RELAY_RATE_LIMIT_PER_MINUTE = 200
const BLOCK_TRIGGER_COUNT = 3
const BLOCK_WINDOW_MS = 5 * 60 * 1000
const BLOCK_DURATION_MS = 5 * 60 * 1000

interface Bucket {
  tokens: number
  lastRefillMs: number
}

interface BlockState {
  rejections: number[]
  blockedUntilMs: number
}

interface PeerSession {
  workspaceId: string
  /** Sticky after first accepted message — prevents impersonation. */
  peerId: string | null
  pubkey: string | null
}

/** Top-level Worker entrypoint. Routes WS upgrades to the per-workspace DO. */
const worker = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const m = url.pathname.match(/^\/ws\/([^/]+)$/)
    if (!m) return new Response("not found", { status: 404 })
    const workspaceId = decodeURIComponent(m[1])
    const id = env.GOSSIP_ROOMS.idFromName(workspaceId)
    const stub = env.GOSSIP_ROOMS.get(id)
    return stub.fetch(req)
  },
}

export default worker

/**
 * Per-workspace gossip room. Holds open WebSockets via Hibernation API so we
 * pay $0 while idle. Anti-abuse state lives in-memory on the DO; CF reaps it
 * on object eviction, which is fine — blocklists are local circuit breakers,
 * not global sanctions (per ADR / §5.4).
 */
export class GossipRoom {
  private readonly registry = new Map<string, string>()
  private readonly buckets = new Map<string, Bucket>()
  private readonly blocks = new Map<string, BlockState>()
  private readonly sessions = new WeakMap<CfWebSocket, PeerSession>()

  constructor(private readonly state: CfDurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const upgrade = req.headers.get("Upgrade")
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 })
    }
    const url = new URL(req.url)
    const m = url.pathname.match(/^\/ws\/([^/]+)$/)
    if (!m) return new Response("bad path", { status: 400 })
    const workspaceId = decodeURIComponent(m[1])

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.sessions.set(server, { workspaceId, peerId: null, pubkey: null })
    this.state.acceptWebSocket(server, [workspaceId])

    return new Response(null, {
      status: 101,
      // The Workers runtime promotes the response into a WS via the
      // `webSocket` field; this matches the Hibernation API contract.
      // @ts-expect-error — `webSocket` is a CF-specific Response field.
      webSocket: client,
    })
  }

  /**
   * Hibernation API hook — runs even after the DO instance was unloaded.
   * The runtime restores the WS list via `getWebSockets()` and dispatches
   * each frame here.
   */
  async webSocketMessage(ws: CfWebSocket, data: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws)
    if (!session) {
      ws.close(1011, "no session")
      return
    }
    let parsed: P2PMessage
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data)
      parsed = JSON.parse(text) as P2PMessage
    } catch {
      return // drop malformed frames silently
    }
    this.handlePublish(session, ws, parsed)
  }

  async webSocketClose(ws: CfWebSocket): Promise<void> {
    this.sessions.delete(ws)
  }

  private handlePublish(session: PeerSession, ws: CfWebSocket, msg: P2PMessage): void {
    const nowMs = Date.now()
    if (msg.workspace_id !== session.workspaceId) return
    if (!isFreshTimestamp(msg.ts, nowMs)) return
    if (!isPeerIdConsistent(msg)) return
    if (!verifySignatureV1(msg)) return

    const known = this.registry.get(msg.peer_id)
    if (known && known !== msg.pubkey) {
      this.recordRejection(msg.peer_id, nowMs)
      return
    }
    if (this.isBlocked(msg.peer_id, nowMs)) return
    if (!this.consumeToken(msg.peer_id, nowMs)) {
      this.recordRejection(msg.peer_id, nowMs)
      return
    }

    if (session.peerId === null) {
      session.peerId = msg.peer_id
      session.pubkey = msg.pubkey
    } else if (session.peerId !== msg.peer_id) {
      return
    }
    if (!known) this.registry.set(msg.peer_id, msg.pubkey)

    const payload = JSON.stringify(msg)
    for (const peer of this.state.getWebSockets(session.workspaceId)) {
      if (peer === ws) continue
      try {
        peer.send(payload)
      } catch {
        // Sender failure is non-fatal — best-effort fan-out.
      }
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
    state.rejections = state.rejections.filter((t) => nowMs - t < BLOCK_WINDOW_MS)
    state.rejections.push(nowMs)
    if (state.rejections.length >= BLOCK_TRIGGER_COUNT) {
      state.blockedUntilMs = nowMs + BLOCK_DURATION_MS
      state.rejections = []
    }
  }
}
