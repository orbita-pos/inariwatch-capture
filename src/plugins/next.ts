/**
 * Next.js plugin — wraps your next config to enable InariWatch capture.
 * Automatically injects git context at build time as env vars + emits
 * TC39 ecma426 debug-IDs into client bundles.
 *
 * Usage in next.config.ts:
 *   import { withInariWatch } from "@inariwatch/capture/next"
 *   export default withInariWatch(nextConfig)
 */

import { extractGitInfo } from "../git.js"
import { InariwatchDebugIdWebpackPlugin } from "./webpack-debug-id-plugin.js"

type NextConfig = {
  experimental?: Record<string, unknown>
  turbopack?: Record<string, unknown>
  env?: Record<string, string>
  serverExternalPackages?: string[]
  webpack?: (config: unknown, ctx: { isServer: boolean; dev: boolean; nextRuntime?: string }) => unknown
  [key: string]: unknown
}

export interface WithInariWatchOptions {
  /**
   * Emit TC39 ecma426 debug-id magic comments + sourcemap fields per
   * client JS chunk. Default: true. Disable if you have a custom
   * symbolicator that breaks on the trailing magic comment.
   *
   * Note: requires the webpack bundler. When the user runs Next 15+
   * with Turbopack (the new default), this option is silently ignored
   * — Turbopack's plugin API is not webpack-compatible. A native
   * Turbopack hook is tracked as a follow-up.
   */
  injectDebugIds?: boolean
}

export function withInariWatch<T extends NextConfig>(
  nextConfig: T = {} as T,
  opts: WithInariWatchOptions = {},
): T {
  const gitEnv = extractGitInfo()
  const existingExternals = nextConfig.serverExternalPackages ?? []
  const serverExternalPackages = existingExternals.includes("@inariwatch/capture")
    ? existingExternals
    : [...existingExternals, "@inariwatch/capture"]

  const debugIdsEnabled = opts.injectDebugIds !== false
  const usingTurbopack = !!nextConfig.turbopack || !!nextConfig.experimental?.turbo

  // Wrap the user's webpack hook (if any) to push the debug-id plugin
  // into the client compilation. We MUST NOT touch the server compilation
  // — debug-IDs are a browser-symbolication concern and the server-side
  // JS goes through Node directly.
  const userWebpack = nextConfig.webpack
  const wrappedWebpack: NextConfig["webpack"] | undefined = debugIdsEnabled && !usingTurbopack
    ? (config, ctx) => {
        const out = (userWebpack ? userWebpack(config, ctx) : config) as { plugins?: unknown[] } & Record<string, unknown>
        if (!ctx.isServer) {
          const plugins = Array.isArray(out.plugins) ? out.plugins : []
          out.plugins = [...plugins, new InariwatchDebugIdWebpackPlugin()]
        }
        return out
      }
    : userWebpack

  return {
    ...nextConfig,
    env: {
      ...nextConfig.env,
      ...gitEnv,
    },
    serverExternalPackages,
    ...(wrappedWebpack ? { webpack: wrappedWebpack } : {}),
  }
}
