/**
 * Vite plugin — enables InariWatch capture in any Vite-based project.
 * Covers Vite, Nuxt (when used via vite build), Remix, SvelteKit, Astro,
 * SolidStart, Qwik, and any other framework that builds with Vite.
 *
 * Usage in vite.config.ts:
 *   import { inariwatchVite } from "@inariwatch/capture/vite"
 *   export default defineConfig({
 *     plugins: [inariwatchVite()],
 *   })
 *
 * What it does:
 *  1. Extracts git commit, branch, and message at build time.
 *  2. Exposes them as process.env.INARIWATCH_GIT_* both at build and runtime.
 *  3. Marks @inariwatch/capture as SSR-external so Node internals (node:crypto,
 *     etc.) don't get bundled into client code.
 */

import { extractGitInfo } from "../git.js"
import { computeDebugId, injectDebugIdComment, injectDebugIdIntoSourceMap } from "./debug-id.js"

type ViteUserConfig = {
  define?: Record<string, unknown>
  ssr?: {
    external?: string[] | true
    noExternal?: string[] | string | RegExp | Array<string | RegExp> | true
    [key: string]: unknown
  }
  [key: string]: unknown
}

type RenderedChunk = {
  fileName: string
  type: "chunk" | "asset"
  code?: string
  map?: { toString(): string } | null
}

type VitePlugin = {
  name: string
  enforce?: "pre" | "post"
  config?: (
    config: ViteUserConfig,
    env: { command: string; mode: string },
  ) => ViteUserConfig | null | undefined | void
  /**
   * Rollup `renderChunk` hook (Vite, Rollup, esbuild-via-Vite all honor
   * this). Runs after the chunk is rendered, before write. We inject the
   * TC39-spec debug-id magic comment + sourcemap field here.
   */
  renderChunk?: (
    code: string,
    chunk: RenderedChunk,
  ) => { code: string; map?: string | null } | null | undefined
}

export interface InariwatchViteOptions {
  /**
   * Emit TC39 ecma426 debug-id comments + sourcemap fields per chunk.
   * Default: true. Disable if you have a custom symbolicator that breaks
   * on the trailing magic comment.
   */
  injectDebugIds?: boolean
}

export function inariwatchVite(opts: InariwatchViteOptions = {}): VitePlugin {
  const debugIdsEnabled = opts.injectDebugIds !== false

  const plugin: VitePlugin = {
    name: "inariwatch-capture",
    enforce: "pre",
    config(userConfig) {
      const gitEnv = extractGitInfo()

      // 1. Populate process.env so capture's runtime code can read git context.
      for (const [key, value] of Object.entries(gitEnv)) {
        if (!process.env[key]) process.env[key] = value
      }

      // 2. Inject git env as compile-time define for any bundled `process.env.*`
      //    references in user code.
      const define: Record<string, string> = {}
      for (const [key, value] of Object.entries(gitEnv)) {
        define[`process.env.${key}`] = JSON.stringify(value)
      }

      // 3. Mark @inariwatch/capture as SSR-external so it stays Node-runtime
      //    and never gets bundled into client/edge chunks.
      const currentExternal = userConfig.ssr?.external
      let nextExternal: string[] | true
      if (currentExternal === true) {
        nextExternal = true
      } else if (Array.isArray(currentExternal)) {
        nextExternal = currentExternal.includes("@inariwatch/capture")
          ? currentExternal
          : [...currentExternal, "@inariwatch/capture"]
      } else {
        nextExternal = ["@inariwatch/capture"]
      }

      return {
        define: { ...userConfig.define, ...define },
        ssr: { ...userConfig.ssr, external: nextExternal },
      }
    },
  }

  if (debugIdsEnabled) {
    plugin.renderChunk = function (code, chunk) {
      // Only transform JS chunks. Assets (images, css extracted via plugins,
      // etc.) come through here too on some Rollup configurations — skip.
      if (chunk.type !== "chunk") return null
      const debugId = computeDebugId(code)
      const newCode = injectDebugIdComment(code, debugId)
      // Vite/Rollup will write the sourcemap separately; if it's already
      // attached as an object on the chunk, mutate the JSON we'll return
      // so the bundler emits the updated map. Otherwise return null and
      // let the bundler handle the map (the magic comment alone gives
      // tools a debug-id pointer).
      if (chunk.map) {
        const mapText = chunk.map.toString()
        const newMap = injectDebugIdIntoSourceMap(mapText, debugId)
        return { code: newCode, map: newMap }
      }
      return { code: newCode }
    }
  }

  return plugin
}

export default inariwatchVite
