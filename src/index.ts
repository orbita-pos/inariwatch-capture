export { init, captureException, captureMessage, captureLog, flush } from "./client.js"
export { captureRequestError } from "./integrations/nextjs.js"
export { withInariWatch } from "./plugins/next.js"
export { addBreadcrumb } from "./breadcrumbs.js"
export { setUser, setTag, setRequestContext, runWithScope } from "./scope.js"

export type { CaptureConfig, ErrorEvent, ParsedDSN, SubstrateConfig, SessionConfig, SessionEvent, Breadcrumb, GitContext, EnvironmentContext } from "./types.js"
