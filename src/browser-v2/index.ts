export {
  init,
  captureException,
  captureMessage,
  captureLog,
  flush,
  addBreadcrumb,
  setTransportForTesting,
  resetForTesting,
} from "./client.js";

export { computeErrorFingerprint } from "./fingerprint.js";
export { parseDsn, type ParsedDsn } from "./dsn.js";
export {
  setUser,
  setTag,
  setRequestContext,
  getUser,
  getTags,
  getRequestContext,
  getBreadcrumbs,
  clearScope,
  withScope,
  scrubUrl,
  scrubSecrets,
  redactBody,
} from "./scope.js";
export { ensureSessionId, getSessionId } from "./session.js";
export type { Config, ErrorEvent, Breadcrumb, RequestContext } from "./types.js";
