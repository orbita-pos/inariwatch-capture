import { captureException } from "../client.js"

/**
 * Drop-in replacement for Sentry.captureRequestError.
 *
 * Usage in instrumentation.ts:
 *   import { captureRequestError } from "@inariwatch/capture"
 *   export { captureRequestError as onRequestError }
 */
export const captureRequestError = async (
  err: { digest: string } & Error,
  request: { path: string; method: string; headers: Record<string, string> },
  context: {
    routerKind: "Pages Router" | "App Router"
    routePath: string
    routeType: "page" | "route" | "middleware"
  },
): Promise<void> => {
  captureException(err, {
    request: { method: request.method, url: request.path },
    runtime: "nodejs",
    routePath: context.routePath,
    routeType: context.routeType,
  })
}
