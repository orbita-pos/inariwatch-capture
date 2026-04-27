// Edge stub — re-exports the same surface as ../client-entry.ts but no-op.
import { noopVoid, noopAsyncVoid, noopRunFn, noopReturnEmptyObj } from "./noop.js"

export const init = noopVoid
export const captureException = noopVoid
export const captureMessage = noopVoid
export const captureLog = noopVoid
export const flush = noopAsyncVoid
export const addBreadcrumb = noopVoid
export const setUser = noopVoid
export const setTag = noopVoid
export const setRequestContext = noopVoid
export const runWithScope = noopRunFn
export const initFullTrace = noopVoid
export const getSessionId = (): null => null
export const setSessionId = noopVoid
export const injectSessionHeader = noopReturnEmptyObj

export type {
  CaptureConfig, ErrorEvent, Breadcrumb,
  Integration, FullTraceConfig, SessionConfig, SubstrateConfig,
} from "../types.js"
