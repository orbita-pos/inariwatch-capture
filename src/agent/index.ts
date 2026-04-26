// Public surface of @inariwatch/capture-agent.
// Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.

export { peerAgentIntegration } from "./integration.js"
export type { PeerAgentIntegrationConfig } from "./integration.js"

export { PeerAgent } from "./agent.js"
export type { PeerAgentConfig } from "./agent.js"

export { OpenAIClient } from "./openai.js"
export type {
  ChatMessage,
  ChatContentPart,
  ChatRequest,
  ChatResponse,
  OpenAIClientOptions,
  ToolCall,
} from "./openai.js"

export {
  TOOL_SCHEMAS,
  getLocalsAtFrame,
  evaluateInFrame,
  matchFingerprint,
  diffSinceDeploy,
} from "./tools.js"
export type {
  ToolSchema,
  ToolResult,
  GetLocalsResult,
  EvaluateInFrameResult,
  MatchFingerprintResult,
  DiffSinceDeployResult,
  ToolErrorResult,
} from "./tools.js"
