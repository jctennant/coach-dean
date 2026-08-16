#!/usr/bin/env node
/**
 * Voice validator eval for Coach Dean.
 *
 * Answers one question: can `checkVoice` replace the maintained phrase lists in
 * coach/respond (the weekly_recap FORBIDDEN PHRASES block and the NO SIGN-OFFS /
 * NO GENERIC OPENERS lines in the three OUTPUT CONTRACTs)?
 *
 * It can only replace them if BOTH hold:
 *   - RECALL: it catches the things those lists catch, including phrasings no list
 *     contains (that's the entire argument for a semantic judge over a regex).
 *   - PRECISION: it does NOT fire on Dean's good writing. A validator that flags
 *     blunt, specific, unadorned coaching would gate real messages into blandness,
 *     which is worse than the phrase lists it replaces.
 *
 * Two modes:
 *
 *   npm run eval:voice
 *     Labeled fixtures (evals/fixtures/voice.json). Reports recall on the flagged
 *     cases, precision on the clean ones, and per-case category accuracy.
 *
 *   npm run eval:voice -- --backtest
 *     Runs the validator over REAL assistant messages from the conversations table.
 *     This is the strongest precision signal available: these messages all shipped
 *     with the phrase lists in place, so a high flag rate here means the validator
 *     is too aggressive, not that Dean is misbehaving. Requires SUPABASE_URL and
 *     SUPABASE_SERVICE_ROLE_KEY. Read-only — it never writes to the database.
 *
 * Imported, not mirrored: uses the real checkVoice from src/lib (requires tsx).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { checkVoice } from "../src/lib/voice-check.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "voice.json");
const RESULTS_DIR = path.join(__dirname, "results");

const args = process.argv.slice(2);
const BACKTEST = args.includes("--backtest");
const VERBOSE = args.includes("--verbose");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 150);
const CONCURRENCY = 6;

/** Run an async fn over items with bounded concurrency, preserving order. */
async function mapLimit(items, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
const truncate = (s, n = 100) => (s.length <= n ? s : `${s.slice(0, n)}…`);

async function runFixtures() {
  const { cases } = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  console.log(`Voice validator — ${cases.length} labeled cases\n`);

  const results = await mapLimit(cases, async (c) => {
    const result = await checkVoice(c.message, {
      humorAllowed: c.humor_allowed ?? true,
      humorSuppressionReason: c.humor_reason ?? null,
    });
    const flagged = !result.ok;
    const shouldFlag = c.expect === "flagged";
    return {
      ...c,
      flagged,
      correct: flagged === shouldFlag,
      gotCategory: result.category,
      issue: result.issue,
      categoryCorrect: !shouldFlag || !c.category || result.category === c.category,
    };
  });

  const flaggedCases = results.filter((r) => r.expect === "flagged");
  const cleanCases = results.filter((r) => r.expect === "clean");
  const recallHits = flaggedCases.filter((r) => r.flagged).length;
  const falsePositives = cleanCases.filter((r) => r.flagged).length;
  const categoryHits = flaggedCases.filter((r) => r.flagged && r.categoryCorrect).length;

  const misses = flaggedCases.filter((r) => !r.flagged);
  if (misses.length > 0) {
    console.log("MISSED (should have been flagged) — these block deleting the phrase lists:");
    for (const m of misses) console.log(`  ✗ ${m.id}\n      ${truncate(m.message)}\n      list rule: ${m.source}`);
    console.log("");
  }

  const fps = cleanCases.filter((r) => r.flagged);
  if (fps.length > 0) {
    console.log("FALSE POSITIVES (good writing flagged) — these would degrade real messages:");
    for (const f of fps) console.log(`  ✗ ${f.id} [${f.gotCategory}]\n      ${truncate(f.message)}\n      judge said: ${f.issue}`);
    console.log("");
  }

  const miscat = flaggedCases.filter((r) => r.flagged && !r.categoryCorrect);
  if (miscat.length > 0) {
    console.log("Category mismatches (caught, but labeled differently — informational only):");
    for (const m of miscat) console.log(`  · ${m.id}: expected ${m.category}, got ${m.gotCategory}`);
    console.log("");
  }

  if (VERBOSE) {
    console.log("All cases:");
    for (const r of results) {
      console.log(`  ${r.correct ? "✓" : "✗"} ${r.id} — ${r.flagged ? `flagged [${r.gotCategory}]` : "clean"}`);
      if (r.flagged && r.issue) console.log(`      ${r.issue}`);
    }
    console.log("");
  }

  console.log("─".repeat(64));
  console.log(`RECALL    ${recallHits}/${flaggedCases.length} (${pct(recallHits, flaggedCases.length)}) — catches what the phrase lists catch`);
  console.log(`PRECISION ${cleanCases.length - falsePositives}/${cleanCases.length} (${pct(cleanCases.length - falsePositives, cleanCases.length)}) — leaves good writing alone`);
  console.log(`CATEGORY  ${categoryHits}/${recallHits} correct on caught cases`);
  console.log("─".repeat(64));

  const safeToDelete = misses.length === 0 && falsePositives === 0;
  console.log(
    safeToDelete
      ? "\nVERDICT: safe to delete the phrase lists — full recall, no false positives."
      : `\nVERDICT: NOT yet safe to delete the phrase lists (${misses.length} missed, ${falsePositives} false positive(s)).`
  );

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `voice-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ mode: "fixtures", results }, null, 2));
  console.log(`\nWrote ${outPath}`);
  return safeToDelete ? 0 : 1;
}

async function runBacktest() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Backtest needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
    return 1;
  }
  const supabase = createClient(url, key);

  // Only the message types the validator actually runs on. Onboarding, Strava-connect
  // and other system-authored copy is deterministic text the coaching prompt never
  // wrote and the gate never sees — scoring it produces false positives that say
  // nothing about whether the phrase lists can be deleted.
  const GATED_TYPES = [
    "coach_response", "morning_plan", "weekly_recap", "nightly_reminder",
    "morning_reminder", "post_run",
  ];

  // Assistant messages only — these are what Dean actually sent, with the phrase
  // lists already in force, so anything flagged here is either a genuine slip the
  // lists missed or a validator false positive.
  const { data, error } = await supabase
    .from("conversations")
    .select("content, message_type, created_at")
    .eq("role", "assistant")
    .in("message_type", GATED_TYPES)
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) {
    console.error("Query failed:", error.message);
    return 1;
  }

  const messages = (data ?? [])
    .map((r) => ({ ...r, content: String(r.content ?? "").trim() }))
    .filter((r) => r.content && r.content !== "[NO_REPLY]");

  console.log(`Backtest — ${messages.length} real assistant messages\n`);

  // Humor is allowed here because the historical gate state isn't reconstructable
  // per message. That's the lenient direction: it can only UNDER-report violations,
  // never invent them, so the flag rate below is a floor.
  const results = await mapLimit(messages, async (m) => {
    const result = await checkVoice(m.content, { humorAllowed: true });
    return { ...m, flagged: !result.ok, category: result.category, issue: result.issue };
  });

  const flagged = results.filter((r) => r.flagged);
  const byCategory = {};
  const byType = {};
  for (const f of flagged) {
    byCategory[f.category ?? "unknown"] = (byCategory[f.category ?? "unknown"] ?? 0) + 1;
    byType[f.message_type ?? "unknown"] = (byType[f.message_type ?? "unknown"] ?? 0) + 1;
  }

  if (flagged.length > 0) {
    console.log("Flagged messages:");
    for (const f of flagged.slice(0, VERBOSE ? flagged.length : 15)) {
      console.log(`  [${f.category}] ${f.message_type ?? "?"} ${String(f.created_at).slice(0, 10)}`);
      console.log(`      ${truncate(f.content, 140)}`);
      console.log(`      → ${f.issue}`);
    }
    if (!VERBOSE && flagged.length > 15) console.log(`  … and ${flagged.length - 15} more (use --verbose)`);
    console.log("");
  }

  console.log("─".repeat(64));
  console.log(`FLAG RATE ${flagged.length}/${results.length} (${pct(flagged.length, results.length)}) on real shipped messages`);
  if (Object.keys(byCategory).length) console.log(`By category: ${JSON.stringify(byCategory)}`);
  if (Object.keys(byType).length) console.log(`By message_type: ${JSON.stringify(byType)}`);
  console.log("─".repeat(64));
  console.log(
    "\nThese all shipped WITH the phrase lists in place. A low rate of genuine slips is\n" +
      "expected and is the case for the validator. A high rate means it's too aggressive —\n" +
      "read the flagged text above and judge for yourself before deleting anything."
  );

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `voice-backtest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ mode: "backtest", results }, null, 2));
  console.log(`\nWrote ${outPath}`);
  return 0;
}

process.exit(await (BACKTEST ? runBacktest() : runFixtures()));
