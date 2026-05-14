#!/usr/bin/env node
/**
 * Bundle-size measurement harness for @inariwatch/capture.
 *
 * Measures the gzipped bundle size of the SDK in several realistic
 * import scenarios, against an esbuild simulation of what bundlers
 * like Next.js Turbopack / Vite / Webpack would produce when
 * `--splitting` is enabled (which they all do by default for ESM
 * dynamic imports).
 *
 * Output schema (ci/bundle-size.json):
 *
 *   {
 *     "measuredAt":    ISO-8601 timestamp
 *     "captureVersion": "0.13.1"
 *     "node":           "v24.x"
 *     "esbuild":        version
 *     "scenarios": [
 *       {
 *         "name":      "core" | "core+redact" | "core+v2" | ...
 *         "imports":   short description of what's imported
 *         "initialMin": initial main chunk minified bytes
 *         "initialGz":  initial main chunk gzipped bytes
 *         "totalMin":   all chunks (incl. lazy) minified bytes
 *         "totalGz":    all chunks (incl. lazy) gzipped bytes
 *       }
 *     ]
 *   }
 *
 * The CI gate (`.github/workflows/bundle-size.yml`) reads
 * `BUNDLE_BUDGET.md` for the limits and fails the PR if any scenario
 * exceeds them. The committed `ci/bundle-size.json` is the baseline a
 * PR's measurement is compared against — large jumps in non-budgeted
 * scenarios also surface as PR comments.
 *
 * Run: `node scripts/measure-bundle.mjs`
 *      `node scripts/measure-bundle.mjs --json` (machine-readable only)
 *      `node scripts/measure-bundle.mjs --check` (exit 1 if any scenario
 *        exceeds the hard limit declared in BUNDLE_BUDGET.md)
 */

import { execSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const TMP = join(ROOT, ".bundle-measure-tmp");
const OUTPUT = join(ROOT, "ci", "bundle-size.json");

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios — keep tightly scoped to "what users actually do"
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Array<{name: string, imports: string, code: string, platform?: string}>} */
const SCENARIOS = [
  {
    name: "core",
    imports: "init + captureException + captureMessage + flush",
    code: `
      import { init, captureException, captureMessage, flush } from "${DIST.replace(/\\/g, "/")}/index.js";
      init({ dsn: "https://example.com" });
      captureException(new Error("test"));
      captureMessage("m");
      await flush();
    `,
  },
  {
    name: "core+breadcrumbs+scope",
    imports: "core + addBreadcrumb + setUser + setTag + runWithScope",
    code: `
      import { init, captureException, flush, addBreadcrumb, setUser, setTag, runWithScope } from "${DIST.replace(/\\/g, "/")}/index.js";
      init({ dsn: "https://example.com" });
      addBreadcrumb({ category: "ui", message: "click" });
      setUser({ id: "u1" });
      setTag("env", "prod");
      runWithScope(() => captureException(new Error("e")));
      await flush();
    `,
  },
  {
    name: "core+fulltrace",
    imports: "core + initFullTrace + getSessionId + injectSessionHeader",
    code: `
      import { init, flush } from "${DIST.replace(/\\/g, "/")}/index.js";
      import { initFullTrace, getSessionId, injectSessionHeader } from "${DIST.replace(/\\/g, "/")}/index.js";
      init({ dsn: "https://example.com" });
      initFullTrace();
      const id = getSessionId();
      const h = injectSessionHeader({});
      console.log(id, h);
      await flush();
    `,
  },
  {
    name: "core+redact",
    imports: "core + redactPayload + resolveRedactConfig (PII redactor)",
    code: `
      import { init, flush, redactPayload, resolveRedactConfig } from "${DIST.replace(/\\/g, "/")}/index.js";
      init({ dsn: "https://example.com" });
      const cfg = resolveRedactConfig(true);
      const out = redactPayload({ user: { email: "x@y.com" } }, cfg);
      console.log(out);
      await flush();
    `,
  },
  {
    name: "core+v2",
    imports: "core + payload v2 builders + budget (Merkle, JCS, evidence pack)",
    code: `
      import { init, flush } from "${DIST.replace(/\\/g, "/")}/index.js";
      import { buildPayloadV2Unsigned, buildEvidencePack, computeEvidenceMerkleRootSync, canonicalJsonStringify } from "${DIST.replace(/\\/g, "/")}/index.js";
      import { applyTokenBudget } from "${DIST.replace(/\\/g, "/")}/index.js";
      init({ dsn: "https://example.com" });
      const ev = buildEvidencePack({});
      const root = computeEvidenceMerkleRootSync(ev);
      const j = canonicalJsonStringify({});
      const p = buildPayloadV2Unsigned({});
      const b = applyTokenBudget(p, 100000);
      console.log(root, j, b);
      await flush();
    `,
  },
  {
    name: "core+causal",
    imports: "core + causal graph engine (full hook set)",
    code: `
      import { init, flush } from "${DIST.replace(/\\/g, "/")}/index.js";
      import { initCausalGraph, runWithRoot, recordOp, installAllHooks } from "${DIST.replace(/\\/g, "/")}/index.js";
      init({ dsn: "https://example.com" });
      initCausalGraph();
      installAllHooks();
      runWithRoot("req", () => recordOp("db", { q: "SELECT 1" }));
      await flush();
    `,
  },
  {
    name: "everything",
    imports: "every public export used (worst case)",
    code: `
      import * as C from "${DIST.replace(/\\/g, "/")}/index.js";
      C.init({ dsn: "x" });
      C.captureException(new Error("e"));
      C.captureMessage("m");
      C.captureLog("l");
      C.addBreadcrumb({ category: "c", message: "m" });
      C.setUser({ id: "u" });
      C.setTag("k", "v");
      C.setRequestContext({ method: "GET" });
      C.runWithScope(() => {});
      C.initFullTrace();
      C.getSessionId();
      C.setSessionId("x");
      C.injectSessionHeader({});
      C.redactPayload({}, C.resolveRedactConfig(true));
      C.applyTokenBudget({}, 100);
      C.estimateTokens({});
      C.buildPayloadV2Unsigned({});
      C.buildEvidencePack({});
      C.computeEvidenceMerkleRootSync({});
      C.canonicalJsonStringify({});
      C.parseStackForEvidence("e");
      C.prepareV2Payload({}, {});
      C.resolvePayloadVersion({});
      C.initPrecursors();
      C.recordNearMiss({});
      C.snapshotPrecursors();
      C.initCausalGraph();
      C.installAllHooks();
      C.runWithRoot("x", () => C.recordOp("op", {}));
      C.persistTombstone({});
      C.isZeroRetentionEnabled();
      await C.flush();
    `,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Measurement
// ─────────────────────────────────────────────────────────────────────────────

function ensureClean() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function getEsbuildVersion() {
  try {
    const out = execSync("npx esbuild --version", { cwd: ROOT, encoding: "utf8" });
    return out.trim();
  } catch {
    return "unknown";
  }
}

function getCaptureVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

/**
 * Bundle one scenario in two modes:
 *  1. `--splitting` (real-world: Next.js / Vite / Webpack with code-splitting)
 *     → measures initial chunk size + total
 *  2. No splitting (worst case for SSR or older bundlers)
 *     → measures the single-file inlined bundle
 */
function measureScenario(scenario) {
  const slug = scenario.name.replace(/[^a-z0-9]+/gi, "-");
  const entryFile = join(TMP, `${slug}.mjs`);
  writeFileSync(entryFile, scenario.code, "utf8");

  // Mode 1 — with splitting (real-world Next/Vite/Webpack default for dynamic
  // imports). We measure only the main chunk size + total of all chunks.
  const splitDir = join(TMP, `${slug}-split`);
  mkdirSync(splitDir, { recursive: true });
  execSync(
    `npx esbuild --bundle --minify --splitting --platform=node --format=esm --target=node18 --packages=external --outdir="${splitDir}" "${entryFile}"`,
    { cwd: ROOT, stdio: "pipe" },
  );

  // The main chunk is the one named after the entry file
  const mainChunk = join(splitDir, `${slug}.js`);
  const mainBytes = readFileSync(mainChunk);
  const initialMin = mainBytes.length;
  const initialGz = gzipSync(mainBytes, { level: 9 }).length;

  // Total = sum of all chunks
  let totalMin = 0;
  const all = execSync(`ls "${splitDir}"`, { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter((f) => f.endsWith(".js"));
  const totalParts = [];
  for (const f of all) {
    const b = readFileSync(join(splitDir, f));
    totalMin += b.length;
    totalParts.push(b);
  }
  const totalGz = gzipSync(Buffer.concat(totalParts), { level: 9 }).length;

  // Mode 2 — without splitting (single-file, esbuild's `--bundle` default).
  // This is the "worst case for SSR with a bundler that inlines dynamic
  // imports". We track it as a secondary metric so we notice if it
  // grows unexpectedly even though the splitting number is what users see.
  const monoOut = join(TMP, `${slug}-mono.js`);
  execSync(
    `npx esbuild --bundle --minify --platform=node --format=esm --target=node18 --packages=external --outfile="${monoOut}" "${entryFile}"`,
    { cwd: ROOT, stdio: "pipe" },
  );
  const monoBytes = readFileSync(monoOut);
  const monoMin = monoBytes.length;
  const monoGz = gzipSync(monoBytes, { level: 9 }).length;

  return {
    name: scenario.name,
    imports: scenario.imports,
    initialMin,
    initialGz,
    totalMin,
    totalGz,
    monoMin, // no-splitting (single chunk inline) baseline
    monoGz,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = new Set(process.argv.slice(2));
  const jsonOnly = args.has("--json");
  const check = args.has("--check");

  if (!existsSync(DIST)) {
    console.error("dist/ not found — run `npm run build` first.");
    process.exit(1);
  }

  ensureClean();

  if (!jsonOnly) {
    console.error("Measuring bundle scenarios — this takes ~30s...");
  }

  const scenarios = [];
  for (const s of SCENARIOS) {
    try {
      const r = measureScenario(s);
      scenarios.push(r);
      if (!jsonOnly) {
        console.error(
          `  ${s.name.padEnd(28)}  initial: ${String(r.initialMin).padStart(6)} B / ${String(r.initialGz).padStart(5)} gz   total: ${String(r.totalMin).padStart(6)} B / ${String(r.totalGz).padStart(5)} gz`,
        );
      }
    } catch (err) {
      console.error(`  ${s.name}: FAILED — ${err.message}`);
      throw err;
    }
  }

  const result = {
    measuredAt: new Date().toISOString(),
    captureVersion: getCaptureVersion(),
    node: process.version,
    esbuild: getEsbuildVersion(),
    scenarios,
  };

  // Write JSON output to ci/bundle-size.json (committed baseline)
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.error(`\n  wrote ${OUTPUT}`);
  }

  rmSync(TMP, { recursive: true, force: true });

  if (check) {
    runBudgetCheck(result);
  }
}

/**
 * Hard-limit budget check. Reads thresholds from BUNDLE_BUDGET.md
 * via a tiny parser — keeps the budget single-source-of-truth.
 * Exit code: 0 = all green, 1 = at least one scenario over budget.
 */
function runBudgetCheck(result) {
  const budgetPath = join(ROOT, "BUNDLE_BUDGET.md");
  if (!existsSync(budgetPath)) {
    console.error("BUNDLE_BUDGET.md missing — cannot --check");
    process.exit(1);
  }
  const md = readFileSync(budgetPath, "utf8");

  // Format expected in BUNDLE_BUDGET.md:
  //   | core | 7500 | initialGz |
  //   | core+redact | 10000 | initialGz |
  // Parser is line-based, tolerant of extra columns. Same scenario
  // can appear on multiple rows with different metrics (e.g.,
  // initialGz + totalGz both budgeted) — all rows are enforced.
  const rules = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([a-z0-9+_-]+)\s*\|\s*(\d+)\s*\|\s*(initialGz|totalGz|initialMin|totalMin)\s*\|/i);
    if (m) rules.push({ name: m[1], max: Number(m[2]), metric: m[3] });
  }
  if (rules.length === 0) {
    console.error("No budget rows parsed from BUNDLE_BUDGET.md (looking for `| name | max | metric |` rows).");
    process.exit(1);
  }

  const byName = new Map();
  for (const s of result.scenarios) byName.set(s.name, s);

  let failed = 0;
  for (const rule of rules) {
    const s = byName.get(rule.name);
    if (!s) {
      console.error(`  WARN  budget rule for unknown scenario \`${rule.name}\` — fix BUNDLE_BUDGET.md`);
      continue;
    }
    const actual = s[rule.metric];
    const status = actual <= rule.max ? "OK " : "OVER";
    if (actual > rule.max) failed++;
    console.error(`  ${status}  ${rule.name.padEnd(28)} ${rule.metric.padEnd(10)} ${actual} B  (limit ${rule.max} B)`);
  }
  if (failed > 0) {
    console.error(`\n  ${failed} scenario/metric combination(s) exceeded budget — see BUNDLE_BUDGET.md.`);
    process.exit(1);
  }
  console.error(`\n  All ${rules.length} budgeted rules within limits.`);
}

main();
