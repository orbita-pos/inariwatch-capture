export { init, captureException, captureMessage, captureLog, flush } from "./client.js"
export { captureRequestError } from "./integrations/nextjs.js"
export { withInariWatch } from "./plugins/next.js"
export { addBreadcrumb } from "./breadcrumbs.js"
export { setUser, setTag, setRequestContext, runWithScope } from "./scope.js"
export { initFullTrace, getSessionId, setSessionId, injectSessionHeader, __resetFullTraceForTesting } from "./fulltrace.js"

export type { CaptureConfig, ErrorEvent, ParsedDSN, SubstrateConfig, SessionConfig, SessionEvent, FullTraceConfig, Integration, Breadcrumb, GitContext, EnvironmentContext, SecurityContext, VulnerabilityType, ShieldConfig } from "./types.js"
