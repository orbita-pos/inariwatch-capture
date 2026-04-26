/**
 * @inariwatch/capture — P2P gossip mesh client (Track F · piece 8).
 *
 * Sesión 12 shipped the design + skeleton (no transport).
 * Sesión 13 wires real transports + a server-side relay (`relay.ts` for
 * tests, `server-cf.ts` deployable to Cloudflare Durable Objects).
 *
 * Opt-in: gated by `INARIWATCH_P2P=true` env var (or `peerEnable({ enabled:
 * true })`). When the flag is off, every export here is a cheap no-op and
 * no transport module is loaded — the v0.9.x bundle stays byte-identical
 * for users who haven't opted in.
 *
 * Two surfaces ship from this file:
 *
 *   1. **Singleton API** (`peerEnable`, `peerPublish`, `peerSubscribe`,
 *      `peerAdmit`, `peerShutdown`) — convenient for SDK consumers, where
 *      one process == one install == one peer.
 *
 *   2. **Factory API** (`createPeer({ keypair, transport, ... })`) — used
 *      by tests that need multiple peers in the same process and by future
 *      multi-tenant deployments. The singleton above is itself a thin
 *      wrapper around the factory.
 *
 * See `capture/P2P_DESIGN.md` for the wire protocol, ADRs, and rollout
 * plan.
 */

import { createHash } from "node:crypto"
import {
  getOrCreateKeypair,
  signReceiptId,
  verifyReceiptIdSignature,
  type SDKKeypair,
} from "../signing.js"
import type { Transport } from "./transport.js"

/** Sliding-window length used by the dedup map. */
const DEDUP_WINDOW_MS = 10_000

/** Tokens-per-minute for the publisher and receiver buckets. */
const RATE_LIMIT_PER_MINUTE = 100

/** Drop messages from the same peer about the same fingerprint after this many in `DEDUP_WINDOW_MS`. */
const DEDUP_MAX_PER_WINDOW = 3

/** Three rate-limit rejections inside this window blocklists the peer. */
const BLOCKLIST_TRIGGER_WINDOW_MS = 5 * 60 * 1000
const BLOCKLIST_TRIGGER_COUNT = 3
const BLOCKLIST_DURATION_MS = 5 * 60 * 1000

/** Receiver-side accept window for `ts` — 30 s past, 5 s future. */
const TS_ACCEPT_PAST_MS = 30_000
const TS_ACCEPT_FUTURE_MS = 5_000

/** Wire format version. Bumping this is a breaking change. */
const WIRE_VERSION = 1 as const

/** Public message envelope — see P2P_DESIGN.md §4.1. */
export interface P2PMessage {
  v: typeof WIRE_VERSION
  type: "canary_error" | "fingerprint_seen"
  workspace_id: string
  peer_id: string
  fingerprint: string
  severity: "critical" | "error" | "warning" | "info"
  count: number
  ts: string
  pubkey: string
  sig: string
}

export interface PeerConfig {
  /** When false (default) the module is a no-op. Reads `INARIWATCH_P2P` if omitted. */
  enabled?: boolean
  /** Required to publish. Provided by the workspace's DSN at SDK init time. */
  workspaceId?: string
  /** Override the rendezvous endpoint — e.g. for tests against a local CF Workers wrangler. */
  endpoint?: string
}

export interface CreatePeerOptions extends PeerConfig {
  /**
   * Inject a keypair directly. Bypasses `getOrCreateKeypair()` and the
   * filesystem — used by tests that need 3 distinct peers in one process.
   */
  keypair?: SDKKeypair
  /**
   * Inject a transport. The factory binds the transport's incoming-message
   * stream to `peer.admit()` automatically. If omitted, `publish()` still
   * signs envelopes but they go nowhere — useful for unit tests.
   */
  transport?: Transport
}

export interface PublishInput {
  type: P2PMessage["type"]
  fingerprint: string
  severity: P2PMessage["severity"]
  count?: number
  /** Override clock for tests — defaults to Date.now(). */
  nowMs?: number
}

export interface Peer {
  readonly enabled: boolean
  readonly peerId: string | null
  /** Sign + publish (if a transport is attached). Returns the signed envelope or null. */
  publish(input: PublishInput): P2PMessage | null
  /** Register a callback for accepted incoming messages. Returns an unsubscribe handle. */
  subscribe(handler: (msg: P2PMessage) => void): () => void
  /** Admit an envelope (used by transports + tests). */
  admit(msg: P2PMessage, opts?: { nowMs?: number }): boolean
  /** Tear down — clears subscribers, disables the runtime, shuts the transport. */
  shutdown(): void
}

interface BucketState {
  tokens: number
  lastRefillMs: number
}

interface BlocklistState {
  /** Timestamps (ms) of recent rate-limit rejections — used to detect 3-in-5min. */
  rejections: number[]
  /** Epoch ms at which the peer becomes valid again, or 0 if not blocked. */
  blockedUntilMs: number
}

interface PeerRuntime {
  config: Required<Pick<PeerConfig, "enabled">> &
    Omit<PeerConfig, "enabled">
  keypair: SDKKeypair | null
  transport: Transport | null
  unsubscribeTransport: (() => void) | null
  /** Per-peer publish bucket (we publish as a single peer — our own peer_id). */
  publishBucket: BucketState
  /** Per-peer receive bucket, keyed by peer_id. */
  receiveBuckets: Map<string, BucketState>
  /** Sliding-window dedup, keyed by `${peer_id}|${type}|${fingerprint}` → ts list. */
  dedupWindow: Map<string, number[]>
  /** Blocklist + rejection history, keyed by peer_id. */
  blocklist: Map<string, BlocklistState>
  /** Subscriber callbacks registered via subscribe(). */
  subscribers: Set<(msg: P2PMessage) => void>
}

/** Module-level singleton runtime — used by the legacy peer*() API. */
let singleton: PeerRuntime | null = null

function envEnabled(): boolean {
  if (typeof process === "undefined" || !process.env) return false
  const flag = process.env.INARIWATCH_P2P
  return flag === "true" || flag === "1"
}

function freshRuntime(config: CreatePeerOptions): PeerRuntime {
  const enabled = config.enabled ?? envEnabled()
  return {
    config: {
      enabled,
      workspaceId: config.workspaceId,
      endpoint: config.endpoint,
    },
    keypair: null,
    transport: null,
    unsubscribeTransport: null,
    publishBucket: { tokens: RATE_LIMIT_PER_MINUTE, lastRefillMs: Date.now() },
    receiveBuckets: new Map(),
    dedupWindow: new Map(),
    blocklist: new Map(),
    subscribers: new Set(),
  }
}

function loadKeypair(rt: PeerRuntime, injected: SDKKeypair | undefined): void {
  if (injected) {
    rt.keypair = injected
    return
  }
  // Lazily resolve the keypair on enable — `getOrCreateKeypair` reads
  // `~/.inariwatch/keypair.json`, which we don't want to touch unless the
  // install actually opts in. Browser hosts will throw here; the catch
  // keeps publish in a graceful no-op state.
  try {
    rt.keypair = getOrCreateKeypair()
  } catch {
    rt.keypair = null
  }
}

function bindTransport(rt: PeerRuntime, transport: Transport | undefined): void {
  if (!transport) return
  rt.transport = transport
  rt.unsubscribeTransport = transport.onMessage((msg) => {
    admitOnRuntime(rt, msg)
  })
}

function unbindTransport(rt: PeerRuntime): void {
  rt.unsubscribeTransport?.()
  rt.unsubscribeTransport = null
  if (rt.transport) {
    try {
      void rt.transport.shutdown()
    } catch {
      // Transport blew up on close — tests don't care, prod logs it elsewhere.
    }
  }
  rt.transport = null
}

// ── Factory API ───────────────────────────────────────────────────────────────

/**
 * Construct an isolated peer instance. Multiple peers can coexist in one
 * process — useful for the 3-node e2e test and for any future multi-tenant
 * worker that brokers gossip on behalf of several workspaces.
 *
 * No-op when `enabled` is false — does not load a transport, does not hit
 * the filesystem, does not allocate a keypair.
 */
export function createPeer(options: CreatePeerOptions = {}): Peer {
  const rt = freshRuntime(options)
  if (rt.config.enabled) {
    loadKeypair(rt, options.keypair)
    bindTransport(rt, options.transport)
  }
  return {
    get enabled() {
      return rt.config.enabled
    },
    get peerId() {
      return rt.keypair?.pubKeyId ?? null
    },
    publish: (input) => publishOnRuntime(rt, input),
    subscribe: (handler) => subscribeOnRuntime(rt, handler),
    admit: (msg, opts) => admitOnRuntime(rt, msg, opts),
    shutdown: () => shutdownRuntime(rt),
  }
}

// ── Singleton API (backward-compatible with Sesión 12) ───────────────────────

export function peerEnable(config: PeerConfig = {}): void {
  if (singleton) shutdownRuntime(singleton)
  singleton = freshRuntime(config)
  if (!singleton.config.enabled) return
  loadKeypair(singleton, undefined)
}

export function peerEnabled(): boolean {
  return singleton?.config.enabled === true
}

export function peerPublish(input: PublishInput): P2PMessage | null {
  if (!singleton) return null
  return publishOnRuntime(singleton, input)
}

export function peerSubscribe(handler: (msg: P2PMessage) => void): () => void {
  if (!singleton) return () => {}
  return subscribeOnRuntime(singleton, handler)
}

export function peerShutdown(): void {
  if (!singleton) return
  shutdownRuntime(singleton)
}

export function peerAdmit(msg: P2PMessage, opts: { nowMs?: number } = {}): boolean {
  if (!singleton) return false
  return admitOnRuntime(singleton, msg, opts)
}

/** Test seam — clear singleton so tests can re-initialize cleanly. */
export function __resetPeerForTesting(): void {
  if (singleton) shutdownRuntime(singleton)
  singleton = null
}

/** Test seam — attach a transport to the singleton (used by p2p.test.mjs). */
export function __attachTransportForTesting(transport: Transport): void {
  if (!singleton || !singleton.config.enabled) return
  bindTransport(singleton, transport)
}

// ── Runtime operations (shared by both APIs) ─────────────────────────────────

function publishOnRuntime(rt: PeerRuntime, input: PublishInput): P2PMessage | null {
  if (!rt.config.enabled) return null
  if (!rt.config.workspaceId) return null
  if (!rt.keypair) return null

  const nowMs = input.nowMs ?? Date.now()
  if (!consumeToken(rt.publishBucket, nowMs)) return null

  const unsigned = {
    v: WIRE_VERSION,
    type: input.type,
    workspace_id: rt.config.workspaceId,
    peer_id: rt.keypair.pubKeyId,
    fingerprint: input.fingerprint,
    severity: input.severity,
    count: input.count ?? 1,
    ts: new Date(nowMs).toISOString(),
  }
  const sigInput = canonicalize(unsigned)
  const digest = createHash("sha256").update(sigInput, "utf8").digest("hex")
  const sig = signReceiptId(digest, rt.keypair)

  const signed: P2PMessage = {
    ...unsigned,
    pubkey: rt.keypair.publicKeyHex,
    sig,
  }

  if (rt.transport) {
    try {
      void rt.transport.publish(signed)
    } catch {
      // Transport failure must not crash captureException paths.
    }
  }
  return signed
}

function subscribeOnRuntime(
  rt: PeerRuntime,
  handler: (msg: P2PMessage) => void,
): () => void {
  if (!rt.config.enabled) return () => {}
  rt.subscribers.add(handler)
  return () => {
    rt.subscribers.delete(handler)
  }
}

function admitOnRuntime(
  rt: PeerRuntime,
  msg: P2PMessage,
  opts: { nowMs?: number } = {},
): boolean {
  if (!rt.config.enabled) return false
  if (msg.v !== WIRE_VERSION) return false
  if (msg.workspace_id !== rt.config.workspaceId) return false

  const nowMs = opts.nowMs ?? Date.now()

  if (!isFreshTimestamp(msg.ts, nowMs)) return false
  if (!isPeerIdConsistent(msg)) return false
  if (!verifySignature(msg)) return false

  if (isBlocked(rt.blocklist, msg.peer_id, nowMs)) return false

  const bucket = getOrCreateBucket(rt.receiveBuckets, msg.peer_id, nowMs)
  if (!consumeToken(bucket, nowMs)) {
    recordRejection(rt.blocklist, msg.peer_id, nowMs)
    return false
  }

  if (isDuplicate(rt.dedupWindow, msg, nowMs)) return false

  for (const handler of rt.subscribers) {
    try {
      handler(msg)
    } catch {
      // Subscriber threw — silently swallow. A bad handler must not poison
      // the gossip path for the others.
    }
  }
  return true
}

function shutdownRuntime(rt: PeerRuntime): void {
  unbindTransport(rt)
  rt.subscribers.clear()
  rt.dedupWindow.clear()
  rt.receiveBuckets.clear()
  rt.blocklist.clear()
  rt.keypair = null
  rt.config.enabled = false
}

// ── Internal helpers (exported only for tests) ────────────────────────────────

/**
 * Stable JSON serialization — sorted keys, no whitespace, UTF-8. Must match
 * the algorithm spelled out in P2P_DESIGN.md §4.1 step 2 so signature
 * verification is uniform across SDK languages.
 */
export function canonicalize(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`)
  return `{${parts.join(",")}}`
}

function consumeToken(bucket: BucketState, nowMs: number): boolean {
  refillBucket(bucket, nowMs)
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

function refillBucket(bucket: BucketState, nowMs: number): void {
  const elapsed = nowMs - bucket.lastRefillMs
  if (elapsed <= 0) return
  const refill = (elapsed / 60_000) * RATE_LIMIT_PER_MINUTE
  bucket.tokens = Math.min(RATE_LIMIT_PER_MINUTE, bucket.tokens + refill)
  bucket.lastRefillMs = nowMs
}

function getOrCreateBucket(
  store: Map<string, BucketState>,
  peerId: string,
  nowMs: number,
): BucketState {
  let bucket = store.get(peerId)
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_PER_MINUTE, lastRefillMs: nowMs }
    store.set(peerId, bucket)
  }
  return bucket
}

function isDuplicate(
  store: Map<string, number[]>,
  msg: P2PMessage,
  nowMs: number,
): boolean {
  const key = `${msg.peer_id}|${msg.type}|${msg.fingerprint}`
  const seen = store.get(key) ?? []
  // Drop entries that fell out of the window.
  const fresh = seen.filter((t) => nowMs - t < DEDUP_WINDOW_MS)
  fresh.push(nowMs)
  store.set(key, fresh)
  // The 4th-and-onward identical message inside the window is dropped —
  // receivers can already infer escalation from `count`, so sending more is
  // just noise.
  return fresh.length > DEDUP_MAX_PER_WINDOW
}

function isBlocked(
  store: Map<string, BlocklistState>,
  peerId: string,
  nowMs: number,
): boolean {
  const state = store.get(peerId)
  if (!state) return false
  return state.blockedUntilMs > nowMs
}

function recordRejection(
  store: Map<string, BlocklistState>,
  peerId: string,
  nowMs: number,
): void {
  let state = store.get(peerId)
  if (!state) {
    state = { rejections: [], blockedUntilMs: 0 }
    store.set(peerId, state)
  }
  state.rejections = state.rejections.filter(
    (t) => nowMs - t < BLOCKLIST_TRIGGER_WINDOW_MS,
  )
  state.rejections.push(nowMs)
  if (state.rejections.length >= BLOCKLIST_TRIGGER_COUNT) {
    state.blockedUntilMs = nowMs + BLOCKLIST_DURATION_MS
    state.rejections = []
  }
}

function isFreshTimestamp(tsIso: string, nowMs: number): boolean {
  const ts = Date.parse(tsIso)
  if (Number.isNaN(ts)) return false
  if (ts > nowMs + TS_ACCEPT_FUTURE_MS) return false
  if (ts < nowMs - TS_ACCEPT_PAST_MS) return false
  return true
}

function isPeerIdConsistent(msg: P2PMessage): boolean {
  try {
    const pubBytes = Buffer.from(msg.pubkey, "hex")
    if (pubBytes.length !== 32) return false
    const derived = createHash("sha256").update(pubBytes).digest("hex").slice(0, 16)
    return derived === msg.peer_id
  } catch {
    return false
  }
}

function verifySignature(msg: P2PMessage): boolean {
  // Pull only the canonicalized fields — sig and pubkey are excluded by spec.
  const { sig: _sig, pubkey: _pubkey, ...rest } = msg
  void _sig
  void _pubkey
  const sigInput = canonicalize(rest as Record<string, unknown>)
  const digest = createHash("sha256").update(sigInput, "utf8").digest("hex")
  // Reuse the existing signing module's verifier so the protocol stays in
  // lock-step with Payload v2's signing layer.
  return verifyReceiptIdSignature(digest, msg.sig, msg.pubkey)
}
