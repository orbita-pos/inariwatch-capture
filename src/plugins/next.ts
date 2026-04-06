/**
 * Next.js plugin — wraps your next config to enable InariWatch capture.
 * Automatically injects git context at build time as env vars.
 *
 * Usage in next.config.ts:
 *   import { withInariWatch } from "@inariwatch/capture/next"
 *   export default withInariWatch(nextConfig)
 */

import { extractGitInfo } from "../git.js"

type NextConfig = Record<string, unknown> & {
  experimental?: Record<string, unknown>
  env?: Record<string, string>
}

export function withInariWatch(nextConfig: NextConfig = {}): NextConfig {
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
