#!/usr/bin/env node
/**
 * Score report / diff tool for Coach Dean eval results.
 *
 * Compares two result files and shows:
 *   - Which fixtures improved
 *   - Which fixtures regressed
 *   - Overall score change
 *
 * Usage:
 *   node evals/score-report.mjs results/2026-03-30T10-00.json results/2026-03-31T10-00.json
 *   node evals/score-report.mjs            # compares the two most recent result files
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");

function loadResult(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const byId = {};
  for (const r of data.results) {
    byId[r.fixture_id] = r;
  }
  return { meta: data, byId };
}

function colorScore(score) {
  if (score < 0) return `\x1b[33mERR\x1b[0m`;
  if (score >= 7) return `\x1b[32m${score}/10\x1b[0m`;
  return `\x1b[31m${score}/10\x1b[0m`;
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  let fileA, fileB;
  if (args.length >= 2) {
    fileA = path.isAbsolute(args[0]) ? args[0] : path.join(RESULTS_DIR, args[0]);
    fileB = path.isAbsolute(args[1]) ? args[1] : path.join(RESULTS_DIR, args[1]);
  } else {
    // Auto-find the two most recent result files
    if (!fs.existsSync(RESULTS_DIR)) {
      console.error("No results directory found. Run evals first.");
      process.exit(1);
    }
    const files = fs
      .readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length < 2) {
      console.error("Need at least 2 result files to compare. Run evals more than once.");
      process.exit(1);
    }
    fileB = path.join(RESULTS_DIR, files[0]); // newer
    fileA = path.join(RESULTS_DIR, files[1]); // older
    console.log(`Comparing:\n  A (baseline): ${files[1]}\n  B (new):      ${files[0]}\n`);
  }

  const a = loadResult(fileA);
  const b = loadResult(fileB);

  // Compute overall averages
  const avgA = computeAvg(Object.values(a.byId));
  const avgB = computeAvg(Object.values(b.byId));
  const delta = avgB - avgA;
  const deltaStr = delta > 0 ? `\x1b[32m+${delta.toFixed(1)}\x1b[0m` : delta < 0 ? `\x1b[31m${delta.toFixed(1)}\x1b[0m` : "0.0";

  console.log(`Overall: ${avgA.toFixed(1)} → ${avgB.toFixed(1)} (${deltaStr})\n`);

  // All fixture IDs across both runs
  const allIds = new Set([...Object.keys(a.byId), ...Object.keys(b.byId)]);
  const improved = [];
  const regressed = [];
  const unchanged = [];
  const newFixtures = [];
  const removedFixtures = [];

  for (const id of [...allIds].sort()) {
    const ra = a.byId[id];
    const rb = b.byId[id];

    if (!ra) {
      newFixtures.push({ id, score: rb.score, flags: rb.flags });
      continue;
    }
    if (!rb) {
      removedFixtures.push({ id, score: ra.score });
      continue;
    }

    const diff = rb.score - ra.score;
    if (diff > 0) improved.push({ id, before: ra.score, after: rb.score, diff, flags: rb.flags });
    else if (diff < 0) regressed.push({ id, before: ra.score, after: rb.score, diff, flags: rb.flags });
    else unchanged.push({ id, score: ra.score });
  }

  // Print regressions first (most important)
  if (regressed.length > 0) {
    console.log(`\x1b[31mREGRESSED (${regressed.length}):\x1b[0m`);
    for (const r of regressed.sort((a, b) => a.diff - b.diff)) {
      const flagStr = r.flags.length > 0 ? `  ← ${r.flags.slice(0, 2).join("; ")}` : "";
      console.log(`  ${r.id.padEnd(45)} ${colorScore(r.before)} → ${colorScore(r.after)}${flagStr}`);
    }
  }

  // Improvements
  if (improved.length > 0) {
    console.log(`\n\x1b[32mIMPROVED (${improved.length}):\x1b[0m`);
    for (const r of improved.sort((a, b) => b.diff - a.diff)) {
      console.log(`  ${r.id.padEnd(45)} ${colorScore(r.before)} → ${colorScore(r.after)}`);
    }
  }

  // New fixtures
  if (newFixtures.length > 0) {
    console.log(`\nNEW FIXTURES (${newFixtures.length}):`);
    for (const r of newFixtures) {
      console.log(`  ${r.id.padEnd(45)} ${colorScore(r.score)} (new)`);
    }
  }

  // Unchanged
  if (unchanged.length > 0) {
    const passing = unchanged.filter((r) => r.score >= 7).length;
    const failing = unchanged.filter((r) => r.score >= 0 && r.score < 7).length;
    console.log(`\nUNCHANGED: ${unchanged.length} (${passing} passing, ${failing} still failing)`);
    const stillFailing = unchanged.filter((r) => r.score >= 0 && r.score < 7);
    for (const r of stillFailing) {
      console.log(`  \x1b[31m${r.id}\x1b[0m (${r.score}/10)`);
    }
  }

  // Per-category breakdown
  const catA = computeByCategory(Object.values(a.byId));
  const catB = computeByCategory(Object.values(b.byId));
  const allCats = new Set([...Object.keys(catA), ...Object.keys(catB)]);

  console.log("\nBy category:");
  for (const cat of [...allCats].sort()) {
    const avgBefore = catA[cat] ?? null;
    const avgAfter = catB[cat] ?? null;
    if (avgBefore === null || avgAfter === null) continue;
    const diff = avgAfter - avgBefore;
    const diffStr = diff > 0 ? `\x1b[32m(+${diff.toFixed(1)})\x1b[0m` : diff < 0 ? `\x1b[31m(${diff.toFixed(1)})\x1b[0m` : "(=)";
    console.log(`  ${cat.padEnd(35)} ${avgBefore.toFixed(1)} → ${avgAfter.toFixed(1)} ${diffStr}`);
  }

  // Exit 1 if regressions exist
  if (regressed.length > 0) {
    console.log("\n\x1b[31mRegressions detected.\x1b[0m");
    process.exit(1);
  }
}

function computeAvg(results) {
  const valid = results.filter((r) => r.score >= 0);
  if (valid.length === 0) return 0;
  return valid.reduce((s, r) => s + r.score, 0) / valid.length;
}

function computeByCategory(results) {
  const cats = {};
  for (const r of results) {
    if (r.score < 0) continue;
    if (!cats[r.category]) cats[r.category] = [];
    cats[r.category].push(r.score);
  }
  const out = {};
  for (const [cat, scores] of Object.entries(cats)) {
    out[cat] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  return out;
}

main();
