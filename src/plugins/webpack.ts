/**
 * Webpack config wrapper — enables InariWatch capture in any webpack project.
 * Covers Create React App, Vue CLI, Angular, raw webpack, Craco, and legacy
 * Next.js (before the App Router).
 *
 * Usage in webpack.config.js:
 *   const { withInariWatchWebpack } = require("@inariwatch/capture/webpack")
 *   module.exports = withInariWatchWebpack({
 *     // your existing webpack config
 *   })
 *
 * What it does:
 *  1. Extracts git commit, branch, and message at build time.
 *  2. Exposes them via process.env.INARIWATCH_GIT_* so DefinePlugin users,
 *     and any code that reads process.env at build time, pick them up.
 *  3. If the target is Node (server-side build), marks @inariwatch/capture as
 *     an external so its node: builtin imports don't get bundled.
 */

import { extractGitInfo } from "../git.js"
import { InariwatchDebugIdWebpackPlugin } from "./webpack-debug-id-plugin.js"

type WebpackConfig = {
  externals?: unknown
  target?: string | string[] | false
  plugins?: unknown[]
  [key: string]: unknown
}

export interface WithInariWatchWebpackOptions {
  /**
   * Emit TC39 ecma426 debug-id magic comments + sourcemap fields per
   * JS asset. Default: true. Disable if you have a custom symbolicator
   * that breaks on the trailing magic comment.
   */
  injectDebugIds?: boolean
}

function isNodeTarget(target: WebpackConfig["target"]): boolean {
  if (target === undefined || target === false) return false
  if (typeof target === "string") {
    return target === "node" || target.startsWith("node") || target === "electron-main"
  }
  if (Array.isArray(target)) {
    return target.some((t) => isNodeTarget(t))
  }
  return false
}

export function withInariWatchWebpack<T extends WebpackConfig>(
  config: T = {} as T,
  opts: WithInariWatchWebpackOptions = {},
): T {
  const gitEnv = extractGitInfo()

  // 1. Inject git env at process.env — available to anything else in the
  //    webpack config (DefinePlugin, EnvironmentPlugin, etc.).
  for (const [key, value] of Object.entries(gitEnv)) {
    if (!process.env[key]) process.env[key] = value
  }

  // 2. Append the debug-id plugin to the user's plugin chain. Runs late
  //    in the asset pipeline (PROCESS_ASSETS_STAGE_REPORT) so minifiers
  //    have already finished. Skipped on Node-target builds — debug IDs
  //    are a client-side symbolication concern, irrelevant to server JS.
  const debugIdsEnabled = opts.injectDebugIds !== false
  let configWithPlugin: T = config
  if (debugIdsEnabled && !isNodeTarget(config.target)) {
    const existingPlugins = Array.isArray(config.plugins) ? config.plugins : []
    configWithPlugin = {
      ...config,
      plugins: [...existingPlugins, new InariwatchDebugIdWebpackPlugin()],
    }
  }

  // 3. Only externalize capture on server builds. On client builds, capture
  //    uses the Web Crypto API fallback and bundles fine.
  if (!isNodeTarget(configWithPlugin.target)) {
    return configWithPlugin
  }

  const ourExternal = { "@inariwatch/capture": "commonjs @inariwatch/capture" }
  const existing = configWithPlugin.externals
  let externals: unknown

  if (existing === undefined || existing === null) {
    externals = ourExternal
  } else if (Array.isArray(existing)) {
    externals = [...existing, ourExternal]
  } else if (typeof existing === "object") {
    externals = { ...(existing as Record<string, unknown>), ...ourExternal }
  } else {
    // function, regex, or string — wrap as array so we don't clobber it
    externals = [existing, ourExternal]
  }

  return { ...configWithPlugin, externals }
}

export default withInariWatchWebpack
