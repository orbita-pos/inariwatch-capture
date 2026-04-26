/**
 * @inariwatch/capture — P2P transport interface (Track F · piece 8 · Sesión 13).
 *
 * Per ADR-001 in `P2P_DESIGN.md`, the wire format is transport-agnostic. The
 * SDK only knows about this interface; concrete implementations are:
 *
 *   - `transport-memory.ts` — in-process fan-out used by the e2e test suite
 *     and by single-process integration tests.
 *   - `transport-ws.ts`     — WebSocket client for the Cloudflare Durable
 *     Object relay (`server-cf.ts`). Production path.
 *
 * Keep this file dependency-free so swapping transports later (e.g. NATS,
 * libp2p) is a single new file plus a wiring change, not a protocol fork.
 */

import type { P2PMessage } from "./client.js"

export interface Transport {
  /** Send a signed envelope to the relay. Best-effort, fire-and-forget. */
  publish(msg: P2PMessage): void | Promise<void>
  /** Subscribe to incoming envelopes. Returns an unsubscribe handle. */
  onMessage(handler: (msg: P2PMessage) => void): () => void
  /** Close the underlying connection and drop subscribers. */
  shutdown(): void | Promise<void>
}
