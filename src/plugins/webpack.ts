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

type WebpackConfig = {
  externals?: unknown
  target?: string | string[] | false
  [key: string]: unknown
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

export function withInariWatchWebpack<T extends WebpackConfig>(config: T = {} as T): T {
  const gitEnv = extractGitInfo()

  // 1. Inject git env at process.env — available to anything else in the
  //    webpack config (DefinePlugin, EnvironmentPlugin, etc.).
  for (const [key, value] of Object.entries(gitEnv)) {
    if (!process.env[key]) process.env[key] = value
  }

  // 2. Only externalize capture on server builds. On client builds, capture
  //    uses the Web Crypto API fallback and bundles fine.
  if (!isNodeTarget(config.target)) {
    return config
  }

  const ourExternal = { "@inariwatch/capture": "commonjs @inariwatch/capture" }
  const existing = config.externals
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

  return { ...config, externals }
}

export default withInariWatchWebpack
