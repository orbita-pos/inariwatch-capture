/**
 * Webpack 5 plugin that emits TC39 ecma426 debug-IDs per asset.
 *
 * Spec: https://github.com/tc39/ecma426/blob/main/proposals/debug-id.md
 *
 * Wiring: this plugin is appended to `config.plugins` automatically by
 * `withInariWatchWebpack()` (the existing webpack config wrapper) and by
 * `withInariWatch()` for Next.js (which wraps `nextConfig.webpack`).
 *
 * What it does, per JS asset emitted by the compilation:
 *   1. computeDebugId() over the asset source bytes
 *   2. Append the `//# debugId=<uuid>` magic comment
 *   3. If a sibling `.map` asset exists, also write the `debugId` field
 *      into the source map JSON
 *
 * We type the webpack compiler / compilation as `unknown` and runtime-
 * ducktype the bits we touch so capture-the-package can stay zero-deps.
 * Webpack itself is the user's dep, not ours.
 *
 * Stage: `PROCESS_ASSETS_STAGE_REPORT`. Late enough that minifiers
 * (Terser, SWC) have finished, early enough that the asset map still
 * reflects what will be written to disk.
 */

import { computeDebugId, injectDebugIdComment, injectDebugIdIntoSourceMap } from "./debug-id.js"

const PLUGIN_NAME = "InariwatchDebugIdPlugin"

interface WebpackSource {
  source(): string | Buffer
  size(): number
}

interface WebpackCompilation {
  assets: Record<string, WebpackSource>
  updateAsset(name: string, source: WebpackSource | unknown): void
  hooks: {
    processAssets: {
      tap(opts: { name: string; stage: number }, fn: (assets: Record<string, WebpackSource>) => void): void
    }
  }
  // The Compilation class hangs the asset-stage constants on its constructor.
  constructor: { PROCESS_ASSETS_STAGE_REPORT?: number }
}

interface WebpackCompiler {
  webpack?: { sources?: { RawSource?: new (value: string | Buffer) => WebpackSource } }
  hooks: {
    thisCompilation: { tap(name: string, fn: (compilation: WebpackCompilation) => void): void }
  }
}

export interface InariwatchDebugIdWebpackPluginOptions {
  /** Emit `//# debugId=...` comments + sourcemap fields. Default: true. */
  injectDebugIds?: boolean
}

export class InariwatchDebugIdWebpackPlugin {
  private readonly enabled: boolean

  constructor(opts: InariwatchDebugIdWebpackPluginOptions = {}) {
    this.enabled = opts.injectDebugIds !== false
  }

  apply(compiler: WebpackCompiler): void {
    if (!this.enabled) return

    // Resolve `RawSource` lazily through the compiler's webpack handle.
    // Webpack 5 exposes its bundled `sources` namespace as
    // `compiler.webpack.sources` so plugins don't need to import the
    // package themselves. Falls back to a minimal duck-type if the
    // handle is missing (older Webpack 5 minor versions).
    const RawSource =
      compiler.webpack?.sources?.RawSource ??
      class FallbackRawSource implements WebpackSource {
        constructor(private readonly value: string | Buffer) {}
        source() { return this.value }
        size() { return Buffer.byteLength(typeof this.value === "string" ? this.value : this.value.toString()) }
      }

    compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
      // Stage REPORT (10000) is the latest stock stage — runs after
      // minification but still during emission. Hard-code as a fallback
      // to handle compilations where the constant is missing.
      const STAGE_REPORT =
        (compilation.constructor.PROCESS_ASSETS_STAGE_REPORT as number | undefined) ?? 10000

      compilation.hooks.processAssets.tap(
        { name: PLUGIN_NAME, stage: STAGE_REPORT },
        (assets) => {
          for (const fileName of Object.keys(assets)) {
            if (!isJsAsset(fileName)) continue
            const asset = assets[fileName]
            const original = asset.source()
            const code = typeof original === "string" ? original : original.toString("utf8")
            const debugId = computeDebugId(code)
            const newCode = injectDebugIdComment(code, debugId)
            // Replace the JS asset.
            compilation.updateAsset(fileName, new RawSource(newCode))
            // Update sibling source map if present. Webpack's source-map
            // plugin emits a `.map` sibling with the same prefix.
            const mapName = `${fileName}.map`
            const mapAsset = assets[mapName]
            if (mapAsset) {
              const mapText = mapAsset.source().toString()
              const newMap = injectDebugIdIntoSourceMap(mapText, debugId)
              if (newMap !== mapText) {
                compilation.updateAsset(mapName, new RawSource(newMap))
              }
            }
          }
        },
      )
    })
  }
}

function isJsAsset(fileName: string): boolean {
  // Match .js, .mjs, .cjs at the path tail. Skip `.map` files (handled
  // alongside their JS sibling) and `.d.ts` (declaration files don't
  // carry runtime debug-ids).
  return /\.(?:m?js|cjs)(?:\?.*)?$/i.test(fileName)
}

// Test access.
export const __testing = { PLUGIN_NAME, isJsAsset }
