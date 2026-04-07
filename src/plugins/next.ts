/**
 * Next.js plugin — wraps your next config to enable InariWatch capture.
 * Automatically injects git context at build time as env vars.
 *
 * Usage in next.config.ts:
 *   import { withInariWatch } from "@inariwatch/capture/next"
 *   export default withInariWatch(nextConfig)
 */

import { extractGitInfo } from "../git.js"

type NextConfig = {
  experimental?: Record<string, unknown>
  env?: Record<string, string>
  [key: string]: unknown
}

export function withInariWatch<T extends NextConfig>(nextConfig: T = {} as T): T {
  const gitEnv = extractGitInfo()

  return {
    ...nextConfig,
    env: {
      ...nextConfig.env,
      ...gitEnv,
    },
    experimental: {
      ...nextConfig.experimental,
      instrumentationHook: true,
    },
  }
}
