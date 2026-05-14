#!/usr/bin/env node
/**
 * Render a markdown diff between two `bundle-size.json` files.
 *
 * Used by `.github/workflows/bundle-size.yml` to post a sticky PR
 * comment showing how each scenario's bundle changed vs `main`.
 * The comment is purely informational — the actual budget gate is
 * `measure-bundle.mjs --check`.
 *
 * Usage:  node scripts/render-bundle-diff.mjs <baseline.json> <pr.json>
 *   - baseline.json: main's committed `ci/bundle-size.json` (or `{}` if
 *     the PR introduces the file for the first time).
 *   - pr.json:       PR's freshly-measured `ci/bundle-size.json`.
 *
 * Output: markdown table on stdout. Includes a 🟢 / 🟡 / 🔴 indicator
 * per row based on diff magnitude (in gzipped bytes):
 *   🟢   ≤ +50 B           noise
 *   🟡   +51 to +250 B     review attention
 *   🔴   > +250 B          regression — explain in PR description
 */

import { readFileSync } from "node:fs";

const [, , baselinePath, prPath] = process.argv;
if (!baselinePath || !prPath) {
  console.error("usage: render-bundle-diff.mjs <baseline.json> <pr.json>");
  process.exit(2);
}

function loadOrEmpty(p) {
  try {
    const raw = readFileSync(p, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const baseline = loadOrEmpty(baselinePath);
const pr = loadOrEmpty(prPath);

const baselineByName = new Map(
  (baseline.scenarios ?? []).map((s) => [s.name, s]),
);
const prScenarios = pr.scenarios ?? [];

function fmtBytes(n) {
  if (n == null) return "—";
  return `${n.toLocaleString("en-US")} B`;
}

function fmtDelta(prVal, baseVal) {
  if (prVal == null || baseVal == null) return "—";
  const delta = prVal - baseVal;
  if (delta === 0) return "±0";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toLocaleString("en-US")} B`;
}

function indicator(prVal, baseVal) {
  if (prVal == null || baseVal == null) return "🆕";
  const delta = prVal - baseVal;
  if (delta <= 50) return "🟢";
  if (delta <= 250) return "🟡";
  return "🔴";
}

const lines = [];
lines.push("## Bundle size — `@inariwatch/capture`");
lines.push("");
lines.push(
  `Measured with esbuild ${pr.esbuild ?? "?"} on Node ${pr.node ?? "?"} at ${pr.measuredAt ?? "?"}.`,
);
lines.push("");
lines.push("| Scenario | Initial gz | Δ vs main | Total gz | Δ vs main |");
lines.push("|---|---|---|---|---|");

for (const s of prScenarios) {
  const base = baselineByName.get(s.name);
  const indI = indicator(s.initialGz, base?.initialGz);
  const indT = indicator(s.totalGz, base?.totalGz);
  lines.push(
    `| \`${s.name}\` | ${fmtBytes(s.initialGz)} ${indI} | ${fmtDelta(s.initialGz, base?.initialGz)} | ${fmtBytes(s.totalGz)} ${indT} | ${fmtDelta(s.totalGz, base?.totalGz)} |`,
  );
}

// Scenarios removed in this PR (in baseline but not pr) — surface them
// so reviewers know coverage shrank.
const removed = [...baselineByName.keys()].filter(
  (n) => !prScenarios.some((s) => s.name === n),
);
if (removed.length > 0) {
  lines.push("");
  lines.push(`> ⚠️ Removed scenarios: ${removed.map((n) => `\`${n}\``).join(", ")}`);
}

lines.push("");
lines.push("---");
lines.push(
  "🟢 ≤ +50 B noise · 🟡 +51 to +250 B review · 🔴 > +250 B regression — see `BUNDLE_BUDGET.md`.",
);

process.stdout.write(lines.join("\n") + "\n");
