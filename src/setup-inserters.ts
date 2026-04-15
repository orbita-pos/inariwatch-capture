/**
 * Pure string-insertion helpers for the CLI framework-setup functions.
 *
 * Each function takes the raw content of a user's framework config file and
 * returns the transformed content plus a status describing what happened.
 * No file I/O — callers (`cli.ts`) wrap these in readFileSync/writeFileSync.
 *
 * Keeping these pure makes them trivially testable: see
 * `capture/test-setup/run-tests.mjs` for fixture-based validation.
 */

export type InsertStatus =
  | "inserted"
  | "already-present"
  | "no-insertion-point"
  | "new-block-inserted";

export interface InsertResult {
  content: string;
  status: InsertStatus;
}

/** Whether the content already has any @inariwatch/capture reference. */
function alreadyPresent(content: string): boolean {
  return content.includes("@inariwatch/capture");
}

/**
 * Insert `inariwatchVite()` into a vite.config file's existing `plugins: [...]`
 * array. Also prepends the import.
 *
 * Handles Vite, Remix, SvelteKit, SolidStart, Qwik — they all use vite.config.*
 */
export function insertViteConfig(content: string): InsertResult {
  if (alreadyPresent(content)) {
    return { content, status: "already-present" };
  }

  const importLine = `import { inariwatchVite } from "@inariwatch/capture/vite"\n`;
  const withImport = importLine + content;

  const pluginsRegex = /plugins\s*:\s*\[/;
  if (!pluginsRegex.test(withImport)) {
    return { content, status: "no-insertion-point" };
  }

  const newContent = withImport.replace(pluginsRegex, "plugins: [inariwatchVite(), ");
  return { content: newContent, status: "inserted" };
}

/**
 * Insert `"@inariwatch/capture/nuxt"` into a nuxt.config file's `modules: [...]`
 * array. If the config has no `modules` array, insert one inside
 * `defineNuxtConfig({ ... })`.
 */
export function insertNuxtConfig(content: string): InsertResult {
  if (alreadyPresent(content)) {
    return { content, status: "already-present" };
  }

  const modulesRegex = /modules\s*:\s*\[/;
  if (modulesRegex.test(content)) {
    return {
      content: content.replace(modulesRegex, `modules: ["@inariwatch/capture/nuxt", `),
      status: "inserted",
    };
  }

  // No modules array — inject a new one into defineNuxtConfig({ ... })
  const openBrace = /defineNuxtConfig\s*\(\s*\{/;
  if (openBrace.test(content)) {
    return {
      content: content.replace(
        openBrace,
        `defineNuxtConfig({\n  modules: ["@inariwatch/capture/nuxt"],`,
      ),
      status: "new-block-inserted",
    };
  }

  return { content, status: "no-insertion-point" };
}

/**
 * Insert `inariwatchVite()` into an astro.config file's `vite.plugins: [...]`
 * array. If there's a `vite: { ... }` block without `plugins`, inject the
 * plugins array inside it. If there's no `vite` block, bail out.
 */
export function insertAstroConfig(content: string): InsertResult {
  if (alreadyPresent(content)) {
    return { content, status: "already-present" };
  }

  const importLine = `import { inariwatchVite } from "@inariwatch/capture/vite"\n`;
  const withImport = importLine + content;

  // Path 1: vite: { plugins: [...] } already exists — inject into that array.
  const vitePluginsRegex = /vite\s*:\s*\{[^}]*plugins\s*:\s*\[/;
  if (vitePluginsRegex.test(withImport)) {
    return {
      content: withImport.replace(/plugins\s*:\s*\[/, "plugins: [inariwatchVite(), "),
      status: "inserted",
    };
  }

  // Path 2: vite: { ... } exists without plugins — inject plugins array.
  const viteRegex = /vite\s*:\s*\{/;
  if (viteRegex.test(withImport)) {
    return {
      content: withImport.replace(viteRegex, "vite: {\n    plugins: [inariwatchVite()],"),
      status: "new-block-inserted",
    };
  }

  return { content, status: "no-insertion-point" };
}

/**
 * Wrap a Next.js config file with `withInariWatch(...)`. Handles `.ts`, `.mjs`,
 * and `.js` / `.cjs` CommonJS forms.
 */
export function insertNextConfig(content: string): InsertResult {
  if (alreadyPresent(content)) {
    return { content, status: "already-present" };
  }

  // ESM form: `export default nextConfig` or `export default { ... }`
  const esmMatch = /export default (\w+)/.exec(content);
  if (esmMatch) {
    const importLine = `import { withInariWatch } from "@inariwatch/capture/next"\n`;
    const newContent = importLine + content.replace(
      /export default (\w+)/,
      "export default withInariWatch($1)",
    );
    return { content: newContent, status: "inserted" };
  }

  // CJS form: `module.exports = nextConfig` or `module.exports = { ... }`
  if (/module\.exports\s*=/.test(content)) {
    const requireLine = `const { withInariWatch } = require("@inariwatch/capture/next")\n`;
    const newContent =
      requireLine +
      content.replace(/module\.exports\s*=\s*/, "const _nextConfig = ") +
      "\nmodule.exports = withInariWatch(_nextConfig);\n";
    return { content: newContent, status: "inserted" };
  }

  return { content, status: "no-insertion-point" };
}
