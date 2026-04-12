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

type ViteUserConfig = {
  define?: Record<string, unknown>
  ssr?: {
    external?: string[] | true
    noExternal?: string[] | string | RegExp | Array<string | RegExp> | true
    [key: string]: unknown
  }
  [key: string]: unknown
}

type VitePlugin = {
  name: string
  enforce?: "pre" | "post"
  config?: (
    config: ViteUserConfig,
    env: { command: string; mode: string },
  ) => ViteUserConfig | null | undefined | void
}

export function inariwatchVite(): VitePlugin {
  return {
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
}

export default inariwatchVite
