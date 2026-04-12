/**
 * Nuxt 3 module — enables InariWatch capture in any Nuxt 3 app.
 *
 * Usage in nuxt.config.ts:
 *   export default defineNuxtConfig({
 *     modules: ["@inariwatch/capture/nuxt"],
 *   })
 *
 * What it does:
 *  1. Extracts git commit, branch, and message at build time.
 *  2. Exposes them via process.env.INARIWATCH_GIT_* and Nuxt runtime config.
 *  3. Marks @inariwatch/capture as a Nitro external so node: builtin imports
 *     don't get bundled into Nitro's edge build output.
 *
 * Shape: Nuxt's loader (`@nuxt/kit/dist/index.mjs` -> loadNuxtModuleInstance)
 * requires the default export to be a FUNCTION — objects are rejected with
 * "Nuxt module should be a function". @nuxt/kit's `defineNuxtModule` wraps
 * its object argument in a function internally; we do the same by hand to
 * avoid taking @nuxt/kit as a dependency.
 */

import { extractGitInfo } from "../git.js"

type NuxtRuntimeConfig = {
  public?: Record<string, unknown>
  [key: string]: unknown
}

type NuxtNitroConfig = {
  externals?: {
    external?: string[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

type NuxtOptions = {
  runtimeConfig?: NuxtRuntimeConfig
  nitro?: NuxtNitroConfig
  [key: string]: unknown
}

type NuxtInstance = {
  options: NuxtOptions
  [key: string]: unknown
}

type NuxtModuleMeta = {
  name: string
  configKey?: string
  version?: string
}

type NuxtModule = {
  (inlineOptions: Record<string, unknown> | undefined, nuxt: NuxtInstance): void | Promise<void>
  getMeta?: () => Promise<NuxtModuleMeta>
}

const META: NuxtModuleMeta = {
  name: "@inariwatch/capture",
  configKey: "inariwatch",
  version: "0.6.1",
}

const inariwatchNuxt: NuxtModule = async function (_options, nuxt) {
  const gitEnv = extractGitInfo()

  // 1. Populate process.env so capture's runtime code sees git context.
  for (const [key, value] of Object.entries(gitEnv)) {
    if (!process.env[key]) process.env[key] = value
  }

  // 2. Expose via Nuxt's runtimeConfig (not public — git info is sensitive).
  nuxt.options.runtimeConfig = nuxt.options.runtimeConfig ?? {}
  nuxt.options.runtimeConfig.inariwatch = { git: gitEnv }

  // 3. Mark capture as a Nitro external so its node: builtin dynamic imports
  //    don't get bundled. Nitro builds for various server targets (node,
  //    cloudflare, vercel edge, etc.) — excluding capture keeps it safe.
  nuxt.options.nitro = nuxt.options.nitro ?? {}
  nuxt.options.nitro.externals = nuxt.options.nitro.externals ?? {}
  const externals = nuxt.options.nitro.externals
  externals.external = externals.external ?? []
  if (!externals.external.includes("@inariwatch/capture")) {
    externals.external.push("@inariwatch/capture")
  }
}

// Nuxt uses `getMeta()` for module metadata lookup during module ordering.
inariwatchNuxt.getMeta = async () => META

export default inariwatchNuxt
