// Edge stub — browser-v2 SDK doesn't run in Edge; no-op.
import { noopVoid, noopAsyncVoid } from "./noop.js"
export const init = noopVoid
export const captureException = noopVoid
export const captureMessage = noopVoid
export const captureLog = noopVoid
export const flush = noopAsyncVoid
export const addBreadcrumb = noopVoid
export const setTransportForTesting = noopVoid
export const resetForTesting = noopVoid
