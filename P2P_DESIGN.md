# P2P Gossip Mesh — Design Doc (Track F · Pieza 8 · Sesiones 12 + 13)

> **Status:** Sesión 13 shipped (2026-04-25): transports + in-process relay
> + Cloudflare Durable Object server + 5 e2e tests. Flag still defaults
> off; the Cloudflare Worker still needs to be deployed in Sesión 14.
> **Trigger to roll out:** >100 active workspaces (per SKYNET_MASTER_PLAN §3 piece 8).
> **Owner:** Capture SDK.

---

## 1. Context

Capture v2 wants a workspace-scoped error to reach its peers in **<1 s**. Today the only path is:

```
service A → ingest API → DB → /api/alerts poll (5–30 s) → service B
```

That's fine for a dashboard, terrible for canary signal. The SKYNET plan (piece 8) calls for a peer-to-peer gossip mesh, scoped to one workspace, so a `critical` fingerprint observed by service A reaches all other services in the same workspace before the next request hits the bad code path.

This is the design + skeleton. Sesión 13 implements the chosen transport and wires the SDK behavior.

---

## 2. Goals / Non-goals

### Goals
1. **Latency target:** p95 fan-out <1 s within a workspace, anywhere in the world.
2. **Authenticity:** every message Ed25519-signed by the emitting install. Receivers must reject anything they can't verify.
3. **Anti-abuse:** a compromised install can't flood the mesh. Rate limit + dedup + blocklist.
4. **Zero ops for the dev:** SDK starts gossiping after `INARIWATCH_P2P=true`. No infra setup on the user side.
5. **Backward compatible:** flag off → byte-identical to v0.9.x.

### Non-goals (this session)
- The actual transport implementation (Sesión 13).
- Cross-workspace gossip — explicitly out of scope; isolation is a hard boundary.
- Persistence — gossip is best-effort fire-and-forget. The DB is still the system of record.
- Discovery — peers learn the rendezvous endpoint from the workspace config, not from each other.

---

## 3. Stack decision

### 3.1 Options surveyed

| Dimension | Cloudflare Durable Objects | NATS cluster (self-host on Hetzner) |
|---|---|---|
| **Deploy model** | Serverless, geo-routed automatically | 3+ nodes for HA on Hetzner (we already pay €55/mo for inari-web) |
| **Marginal cost** | ~$5 per million messages + $0.20 per million WS messages. Idle WebSockets hibernate ($0 while idle). | $0 marginal once cluster runs; HA cluster requires +1 €55/mo machine to avoid co-locating with web. |
| **Latency to client** | Anycast — nearest edge picks up the WebSocket. p95 connect <50 ms globally. | Single geo (Helsinki) — US/Asia clients see 100–250 ms RTT just to reach NATS. |
| **Ops overhead** | Zero. CF handles upgrades, scaling, region failover. | Real. JetStream config, monitoring, version upgrades, SOPS for credentials, replication tuning. |
| **WebSocket support for SDK clients** | First-class. Browser SDK can speak it natively. | First-class via WebSocket gateway (extra config, but works). |
| **Browser SDK fit** | Native. CF Workers terminate WS at the edge. | Awkward — browser must reach Hetzner over the open internet, no edge termination. |
| **Workspace isolation** | Free — one Durable Object instance per `workspace_id` (Cloudflare guarantees single-threaded, single-region pinning per object). | Manual — subject prefixes (`workspace.<id>.events`), enforced via signed nonce per workspace. |
| **Failure mode** | CF-wide outage (~1 incident/yr) → degraded gossip, alerts still flow via DB. | Hetzner-wide outage (we already saw one at cutover) → entire web *and* gossip down. |
| **Cost at 1 k workspaces × 100 events/day** | ~3 M msgs/mo → **~$15/mo**. | **~$55/mo** fixed for the extra HA node. |
| **Cost at 100 k workspaces × 1 k events/day** | ~3 B msgs/mo → **~$15 k/mo**. | Same node count probably saturates around 50 k workspaces; would need 3 nodes → **~$170/mo** + ops. |
| **Vendor lock-in** | Yes — CF-specific API (`DurableObject`, `WebSocketHibernation`). Wrapping it costs us a few hundred lines. | No — NATS is OSS, runs anywhere. |

### 3.2 Recommendation

**Use Cloudflare Durable Objects** for v1. Switch to (or augment with) NATS only when monthly DO spend exceeds a threshold or we hit a CF lock-in we want to escape.

**Why DO wins for our shape:**

1. **Geo-distribution comes free, and we need it.** Browser SDKs are already global. Forcing them through Hetzner adds 100–250 ms to the very budget (1 s) we're optimizing.
2. **Idle hibernation handles our fan-in pattern.** A typical workspace has 1–10 services, most idle most of the time. NATS keeps a TCP connection open per peer, costing memory whether anything's flowing or not. DO hibernation gives us $0 idle cost.
3. **Workspace isolation is a primitive, not a config.** One Durable Object instance per workspace, addressed by `workspace_id`, single-threaded by CF. We can't accidentally cross-talk.
4. **The crossover where NATS becomes cheaper is far away.** At 100 k events/mo we're at $0.50 on DO. Cheap stuff like this isn't worth absorbing ops debt to save.
5. **We already have NATS as the escape hatch.** The protocol on the wire is plain JSON over WebSocket — porting to NATS later is a transport swap, not a rewrite. (See ADR-001 "Wire format is transport-agnostic" below.)

**Why we'd reconsider:**
- DO bill exceeds **$200/mo** sustained → revisit.
- Cloudflare adds new pricing tiers we don't like → revisit.
- We need persistence (gossip log replay) → JetStream-on-NATS is a closer fit than DO.

### 3.3 ADRs

#### ADR-001 — Wire format is transport-agnostic
**Decision:** Messages are plain JSON (`{ v, type, fingerprint, severity, ts, pubkey, sig, ... }`). Whatever transport we pick exposes a publish/subscribe surface; the SDK never sees CF/NATS-specific types.
**Why:** Lock-in is a future risk. Keeping the wire format clean means swapping transports is a 1-file change in `src/p2p/transport.ts`, not a protocol rewrite.

#### ADR-002 — Reuse the existing install keypair (`signing.ts`)
**Decision:** P2P messages are signed with the same Ed25519 keypair that already signs Payload v2 (`~/.inariwatch/keypair.json`). No new key material on disk.
**Why:** One keypair to manage = one key compromise to recover from. Same `pub_key_id` in alerts and in gossip means the server can correlate them trivially.

#### ADR-003 — Workspace gossip is fire-and-forget
**Decision:** No retries, no acks, no persistence. If a peer is offline when a message lands, it misses it.
**Why:** The DB is the system of record. Gossip is the *fast* path; the *correct* path (`/api/alerts`) still runs. Adding reliability to gossip duplicates work and complicates the protocol for diminishing returns.

#### ADR-004 — Ed25519 signature is on the canonical hash, not the JSON
**Decision:** The signed input is `SHA-256(canonical_json_without_sig_field).hex.utf8`, matching the EAP server's `verifyEd25519Signature` pattern.
**Why:** Same primitive as `signReceiptId()` already in `signing.ts`. Server-side verification reuses the existing local-verify path with no protocol fork.

#### ADR-005 — Browser SDK is a publisher-only, server-mediated participant
**Decision:** Browser clients can publish gossip messages but cannot subscribe to other peers' gossip. Subscription is Node-only.
**Why:** We don't want to leak one user's session activity to another user's browser tab. Node services have a clear trust boundary (same workspace, same operator); browsers don't. Browser-as-publisher gives us the canary signal we want without the leak surface.

---

## 4. Protocol spec

### 4.1 Message envelope (v1)

```ts
interface P2PMessage {
  /** Schema version — bump on breaking change, never silently. */
  v: 1
  /** What kind of signal this is. */
  type: "canary_error" | "fingerprint_seen"
  /** Cryptographically opaque workspace identifier. */
  workspace_id: string
  /** First 16 hex chars of SHA-256(pubkey) — same as `pub_key_id` in Payload v2. */
  peer_id: string
  /** Capture fingerprint (64-hex SHA-256). Identical algorithm to `src/fingerprint.ts`. */
  fingerprint: string
  /** Same severity scale as `ErrorEventV2`. */
  severity: "critical" | "error" | "warning" | "info"
  /** How many times this peer has observed this fingerprint in the current
   *  10-second window. Receivers can debounce: if you've already seen
   *  count≥3 from another peer this window, you can skip your own re-broadcast. */
  count: number
  /** ISO 8601 emission time on the publishing peer. */
  ts: string
  /** Raw 32-byte Ed25519 public key, hex-encoded (64 chars). */
  pubkey: string
  /** Ed25519 signature of `SHA-256(canonical_json(msg without sig and pubkey))`,
   *  hex-encoded (128 chars). */
  sig: string
}
```

**Canonicalization rule** (must match across SDK languages — same rule will live in the Python/Go/Rust ports later):

1. Drop `sig` and `pubkey`.
2. Serialize remaining fields with **sorted keys, no whitespace, UTF-8** (`JSON.stringify` after key sort).
3. The signed input is `SHA-256(<that string>).hex` interpreted as UTF-8 bytes — same convention as `signReceiptId()` in `src/signing.ts`.

This keeps signing logic uniform across Payload v2 and P2P. One verify path, one mistake surface.

### 4.2 Trust model

- A receiver MUST verify `sig` against `pubkey` before doing anything with the message.
- A receiver MUST verify the `peer_id` matches `SHA-256(pubkey).slice(0, 16)`.
- A receiver MUST check `workspace_id` against its own — drop on mismatch (defense in depth; the transport already isolates).
- A receiver SHOULD reject `ts` more than 30 s in the past or 5 s in the future (clock skew tolerance + replay defense).

### 4.3 Delivery semantics

- **At-most-once.** No retries on send.
- **No ordering guarantee** between distinct fingerprints. Within a single fingerprint, the receiver dedups on `(peer_id, fingerprint, ts-rounded-to-1s)`, so ordering doesn't matter.
- **No persistence.** A peer that joins the mesh after a message was published does not see it. The DB still has it.

---

## 5. Anti-abuse

A compromised install with a valid keypair can sign arbitrary garbage. Even a benign install with a noisy bug can flood. Three layers:

### 5.1 Per-peer rate limit (publisher-side **and** receiver-side)

- **Publisher:** token bucket, 100 msg/min, refill 100/min. Drop locally on overflow with a `rateLimited` debug log.
- **Receiver:** independent token bucket per `peer_id`, 100 msg/min. On overflow, drop + increment a per-peer reject counter.

Rationale for both sides: publisher-side stops good citizens from melting the mesh. Receiver-side stops bad actors from ignoring the publisher rule.

### 5.2 Per-window dedup

- Keep a sliding 10-second LRU per `(peer_id, fingerprint, type)`.
- Drop messages from the same peer about the same fingerprint after the **3rd** within 10 s.
- This is intentional debouncing, not censorship: count is included in the message so the receiver knows whether to escalate without seeing each individual emission.

### 5.3 Blocklist

- A peer that gets rate-limited **3 times in 5 minutes** is added to a runtime blocklist for **5 minutes**.
- Blocklist is in-memory (per receiver process). Restart clears it. We don't try to make this distributed or persistent — it's a local circuit-breaker, not a global sanction.
- The blocklist event is emitted as a `captureException({ kind: "p2p_peer_blocked", peer_id })` so the dashboard can surface chronic offenders.

### 5.4 What we explicitly don't do

- **No proof-of-work or staking.** The cost is borne by the workspace operator who already chose to install the SDK. Adding work serves no one.
- **No global blocklist.** Cross-workspace blocklisting requires central coordination we don't want in the v1 design.
- **No payload encryption.** All gossip stays inside the workspace's CF Durable Object, which already isolates it. Adding E2E encryption complicates key rotation and gives us nothing the transport doesn't already give.

---

## 6. Implementation map

| File | Purpose | Sesión |
|---|---|---|
| `capture/P2P_DESIGN.md` | This doc. | 12 + 13 |
| `capture/src/p2p/client.ts` | Public surface — singleton API (`peerEnable`, `peerPublish`, `peerSubscribe`, `peerShutdown`, `peerAdmit`) plus the `createPeer({ keypair, transport, ... })` factory used by the e2e tests and any future multi-tenant broker. | 12 (skeleton) + 13 (factory + transport binding) |
| `capture/src/p2p/transport.ts` | The `Transport` interface — `publish`, `onMessage`, `shutdown`. Transport-agnostic per ADR-001. | 13 |
| `capture/src/p2p/transport-memory.ts` | `InMemoryTransport` — synchronous in-process transport used by tests and by `InMemoryRelay`. | 13 |
| `capture/src/p2p/transport-ws.ts` | `WebSocketTransport` — production WS client targeting the CF Durable Object. Reconnects with exponential backoff (1 s → 30 s), buffers up to 100 msgs while disconnected. | 13 |
| `capture/src/p2p/relay.ts` | `InMemoryRelay` — server-side fan-out + anti-abuse mirror of the CF Worker. Used by every e2e test. Exposes `verifySignatureV1`, `isFreshTimestamp`, `isPeerIdConsistent` so the CF Worker reuses identical helpers. | 13 |
| `capture/src/p2p/server-cf.ts` | Cloudflare Worker + `GossipRoom` Durable Object class. Implements WebSocket Hibernation, per-workspace fan-out, anti-abuse, pubkey registry. Deploy in Sesión 14. | 13 |
| `capture/src/p2p/index.ts` | Module barrel. | 12 + 13 |
| `capture/test/p2p.test.mjs` | Singleton-API contract tests. | 12 |
| `capture/test/p2p-e2e.test.mjs` | 3-node gossip demo, workspace isolation, pubkey distribution. | 13 |
| `capture/test/p2p-anti-abuse.test.mjs` | Spammer blocklist + honest-traffic-keeps-flowing + forged-pubkey rejection. | 13 |

### What Sesión 13 deliberately did not do

- **CF Worker is not deployed yet.** `server-cf.ts` is the source code but it lives inside the SDK package; spinning up `wrangler.toml`, the `GOSSIP_ROOMS` namespace, and a hostname is a Sesión 14 ops task. No SDK behavior depends on it.
- **`captureException` is not wired to publish gossip yet.** That hook lives in `client.ts` (the SDK error-capture client, not the gossip client) and adds a fingerprint-extraction step we want to validate against real production traffic first. The `peerPublish` API is ready for the consumer.
- **Browser publishing is still skipped.** Per ADR-005, browsers can sign + publish but currently lack a per-session keypair bootstrap. Tracked in §8 open question.

### Empirical numbers (Sesión 13 e2e suite, in-process transport)

```
3-node gossip latency: B=5.374 ms, C=5.745 ms     (target <1000 ms — 175× headroom)
spammer rate-limited 3x, blocked 27x; honest peer delivered 101 messages during timeout
forged-pubkey attack rejected: badSignature=4
```

The in-process transport is synchronous, so these numbers measure the
sign + verify + canonicalization budget. Add the WS round-trip on top
(<50 ms p95 for Cloudflare anycast) and we're still ~10× under the SKYNET
budget.

---

## 7. Sesión 14 TODOs

1. Stand up the CF Worker (`server-cf.ts`) — `wrangler.toml`, `GOSSIP_ROOMS` namespace binding, hostname routing.
2. Wire `peerPublish` into `client.ts → captureException()` post-hook for `severity ∈ {critical, error}`. Behind `INARIWATCH_P2P=true`.
3. Add a default `peerSubscribe` consumer that lights up `aiReasoning` with a "seen on N peers" badge.
4. End-to-end shadow test: 2 Node processes in the same workspace, one throws, the other receives the gossip in <1 s — over real CF, not the in-process relay.
5. Publish empirical CF round-trip p95; if >1 s, revisit transport.
6. Add a startup warning when `INARIWATCH_P2P=true` and `globalThis.WebSocket` is unavailable (Node < 22).

---

## 8. Open questions

- **Browser publisher auth.** Browser clients don't have access to `node:fs`, so they can't read the same `~/.inariwatch/keypair.json`. Options: (a) generate an ephemeral browser keypair per session and trust it transitively via the DSN, (b) skip browser publishing in v1 and revisit. **Default for v1: (b).** Cleaner, defers the trust-bootstrap question.
- **Replay attack window.** Choosing 30 s past + 5 s future as the accept window. Tighten if we see false positives in shadow mode.
- **Blocklist tuning.** 3 rate-limits in 5 min may be too tight or too loose. Make it env-tunable, default the values listed above, log the events so we can tune from data.

---

## 9. Sign-off checklist for Sesión 12

- [x] ADRs documented (5 ADRs above).
- [x] Stack decision with reasoning (CF Durable Objects).
- [x] Wire protocol spec (envelope + canonicalization + trust rules).
- [x] Anti-abuse rules (rate limit, dedup, blocklist).
- [x] Skeleton compiles with `npm run typecheck`.
- [x] Test stubs exist and pass (`npm test`).
- [x] Flag-off path is byte-identical to v0.9.x — `INARIWATCH_P2P` defaults to false, and the module never imports a transport when disabled.

## 10. Sign-off checklist for Sesión 13

- [x] `Transport` interface lives in its own file (`transport.ts`) — protocol-agnostic per ADR-001.
- [x] `InMemoryTransport` + `InMemoryRelay` for tests (`transport-memory.ts`, `relay.ts`).
- [x] `WebSocketTransport` production client (`transport-ws.ts`) — reconnect with backoff, bounded queue.
- [x] Cloudflare Worker / Durable Object server (`server-cf.ts`) sharing helpers with `relay.ts` so the protocol cannot drift between test and prod.
- [x] `createPeer({ keypair, transport, ... })` factory — tests can run N peers in one process.
- [x] Pubkey distribution: relay registers pubkey on first message and exposes `getPubkey(peerId)`. Forged pubkey for an existing peer is rejected.
- [x] Server-side anti-abuse active — rate limit (200/min), 3-rejections-in-5-min blocklist, 5-min timeout, replay window.
- [x] E2E demo: 3-node gossip — peer A's canary reaches B and C in single-digit milliseconds.
- [x] E2E demo: anti-abuse — spammer blocklisted; honest peer delivers 101 messages during the timeout.
- [x] Flag-off path still byte-identical to v0.9.x — `freshRuntime` returns a disabled runtime, transport never imported, keypair never read from disk.
- [x] Full `npm test` green (117 tests, 114 pass + 3 skipped, 0 failures).
