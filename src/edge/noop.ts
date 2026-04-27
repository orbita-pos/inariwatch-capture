/**
 * Shared no-op primitives for the Edge runtime stub of @inariwatch/capture.
 *
 * Why this file exists: Next.js (and other Edge-style runtimes) cannot bundle
 * `node:fs`, `node:crypto`, `node:worker_threads`, `node:child_process` or
 * synchronous `eval`/`Function`. The full SDK uses all of those for forensic
 * stack walking, git blame, Ed25519 signing, source-context fetch, and the
 * shield's PII sinks. None of that work is meaningful on Edge anyway —
 * Edge functions don't have a filesystem to inspect, can't spawn processes,
 * and serve a single request before being recycled.
 *
 * Rather than gate every Node call behind a runtime check (which still
 * forces bundlers to walk the Node imports), we ship this Edge stub at
 * `dist/edge/*` and route to it via conditional package.json exports
 * (`"edge": "./dist/edge/<path>.js"`). The stub keeps API parity with the
 * full SDK so user code (`captureException`, `init`, `captureRequestError`,
 * etc.) compiles and runs unchanged — calls just no-op silently on Edge.
 *
 * Real error capture happens on the Node side (where `instrumentation.ts`
 * runs by default for app-router server components, route handlers, etc.).
 * Edge middleware / Edge route handlers are typically a tiny part of an
 * app's surface — losing capture there is acceptable in exchange for
 * zero-config Edge build success.
 */

export const noopVoid = (..._args: unknown[]): void => {}
export const noopAsyncVoid = async (..._args: unknown[]): Promise<void> => {}
export const noopReturnArg = <T>(arg: T): T => arg
export const noopRunFn = <T>(_arg: unknown, fn: () => T): T => fn()
export const noopReturnNull = (..._args: unknown[]): null => null
export const noopReturnEmpty = (..._args: unknown[]): [] => []
export const noopReturnFalse = (..._args: unknown[]): false => false
export const noopReturnEmptyObj = (..._args: unknown[]): Record<string, never> => ({})
