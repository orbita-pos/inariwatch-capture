// Public surface of @inariwatch/capture-fleet.
// Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.

export { fleetBloomIntegration } from "./integration.js"
export type { FleetBloomIntegrationConfig } from "./integration.js"

export {
  FleetBloomClient,
  contributeFingerprint,
  __resetContributionsForTesting,
} from "./client.js"
export type { FleetBloomClientOptions, FleetBloomMeta } from "./client.js"

export { deserialize, has } from "./bloom.js"
export type { BloomFilter } from "./bloom.js"
