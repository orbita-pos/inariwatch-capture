/**
 * @inariwatch/capture — P2P gossip mesh module barrel.
 *
 * Public surface for the workspace-scoped peer-to-peer gossip protocol
 * (Track F · piece 8 from SKYNET_MASTER_PLAN). See `P2P_DESIGN.md` in the
 * package root for the protocol spec, ADRs, and rollout plan.
 *
 * Sesión 13 wires the transport + relay. The flag still defaults off
 * (`INARIWATCH_P2P=true` to opt in), and when off the bundle stays
 * byte-identical to v0.9.x — no transport module is loaded, no keypair
 * is read.
 */

export {
  // Singleton API — one peer per process.
  peerEnable,
  peerEnabled,
  peerPublish,
  peerSubscribe,
  peerShutdown,
  peerAdmit,
  // Factory API — multiple peers per process (tests, multi-tenant brokers).
  createPeer,
  // Shared helpers + types.
  canonicalize,
  __resetPeerForTesting,
  __attachTransportForTesting,
  type P2PMessage,
  type PeerConfig,
  type CreatePeerOptions,
  type Peer,
  type PublishInput,
} from "./client.js"

export { InMemoryRelay, type RelayStats } from "./relay.js"
export { InMemoryTransport } from "./transport-memory.js"
export { WebSocketTransport, type WsTransportOptions } from "./transport-ws.js"
export type { Transport } from "./transport.js"
