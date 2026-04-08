#!/usr/bin/env node
/**
 * Extraction eval runner for plan session updates.
 *
 * Tests whether the Haiku extraction prompt in maybeUpdatePlanSessions()
 * correctly parses Dean's coach responses into the right session JSON.
 * This is the layer between "Dean said the right thing in SMS" and
 * "the dashboard actually shows the correct updated plan."
 *
 * Usage:
 *   node evals/run-extraction-evals.mjs
 *   node evals/run-extraction-evals.mjs --fixture extract-reschedule-long-run
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures/extraction");
const RESULTS_DIR = path.join(__dirname, "results");

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

const client = new Anthropic();

// ─────────────────────────────────────────────
// Exact prompt from maybeUpdatePlanSessions in route.ts
// Keep in sync with src/app/api/coach/respond/route.ts
// ─────────────────────────────────────────────

function buildExtractionPrompt(currentSessions) {
  return `You are checking whether a conversation exchange changed any planned training sessions for the week.

Current planned sessions (JSON):
${JSON.stringify(currentSessions)}

The athlete sent a message and the coach responded. Determine if any sessions were changed (different day, different distance, cancelled, added, or replaced).

If NO changes were made, return exactly: {"changed": false}
If changes WERE made, return the full updated sessions list AND the new key workout for the plan arc:
{"changed": true, "sessions": [{"day": "Mon"|"Tue"|..., "date": "M/D", "label": "..."}], "key_workout": "brief label for the defining quality session this week, e.g. '6×800m @ 5K pace' or '4mi tempo'. Null if no quality session was added or changed."}

Rules:
- Mark changed=true if the coach agreed to a session change — explicit past-tense ("Done — moved strength to Sunday", "I've moved...", "Switched...") OR explicit future-tense confirmation ("Moving strength to Sunday", "I'll put the easy 3mi on Tuesday instead", "Sure — strength goes to Sunday"). Do NOT require "I've updated" specifically.
- Mark changed=false if the coach only gave general advice, asked a clarifying question, or suggested a change without agreeing to it.
- For day swaps: update BOTH the "day" field AND the "date" field. The date for each session should match the calendar date of its new day. Infer dates from the existing sessions (e.g. if Mon is "4/7" and Tue is "4/8", Sun would be "4/13").
- Preserve all unchanged sessions exactly as-is
- If a session was cancelled with no replacement, omit it from the list
- key_workout: pick the most quality-focused session that changed (intervals, tempo, race-specific work). If only easy runs changed, set to null.
- Return ONLY valid JSON, no other text`;
}

// ─────────────────────────────────────────────
// Assertion helpers
// ─────────────────────────────────────────────

/**
 * Compare extracted sessions against expected.
 * Returns array of failure strings (empty = pass).
 */
function assertResult(fixture, extracted) {
  const failures = [];
  const expected = fixture.expected;

  // changed flag
  if (extracted.changed !== expected.changed) {
    failures.push(`changed: got ${extracted.changed}, expected ${expected.changed}`);
    return failures; // if wrong direction, remaining assertions don't apply
  }

  if (!expected.changed) return failures; // no-change case — just needed changed: false

  // Sessions present
  if (!Array.isArray(extracted.sessions)) {
    failures.push("sessions: missing or not an array");
    return failures;
  }

  // Session count
  if (extracted.sessions.length !== expected.sessions.length) {
    failures.push(
      `sessions count: got ${extracted.sessions.length}, expected ${expected.sessions.length} ` +
      `(got days: ${extracted.sessions.map(s => s.day).join(",")} — expected: ${expected.sessions.map(s => s.day).join(",")})`
    );
  }

  // Each expected session should exist in extracted with matching day, date, and roughly matching label
  for (const exp of expected.sessions) {
    const match = extracted.sessions.find(s => s.day === exp.day);
    if (!match) {
      failures.push(`missing session on ${exp.day} (expected: "${exp.label}")`);
      continue;
    }
    if (match.date !== exp.date) {
      failures.push(`${exp.day} date: got "${match.date}", expected "${exp.date}"`);
    }
    // Label: check key words rather than exact match (Haiku may rephrase slightly)
    const expWords = exp.label.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const gotWords = match.label.toLowerCase();
    const missingWords = expWords.filter(w => !gotWords.includes(w));
    if (missingWords.length > expWords.length * 0.4) {
      failures.push(`${exp.day} label mismatch: got "${match.label}", expected "${exp.label}"`);
    }
  }

  // No extra sessions that shouldn't be there
  for (const got of extracted.sessions) {
    if (!expected.sessions.find(s => s.day === got.day)) {
      failures.push(`unexpected session on ${got.day}: "${got.label}"`);
    }
  }

  // key_workout check — skip if fixture marks it as nullable (either null or a value is fine)
  if (!expected.key_workout_nullable) {
    if (expected.key_workout === null) {
      if (extracted.key_workout !== null && extracted.key_workout !== undefined) {
        failures.push(`key_workout: expected null, got "${extracted.key_workout}"`);
      }
    } else if (expected.key_workout !== undefined) {
      if (!extracted.key_workout) {
        failures.push(`key_workout: expected "${expected.key_workout}", got null/undefined`);
      }
      // Just check it's non-null — don't require exact match
    }
  }

  return failures;
}

// ─────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────

async function runExtraction(fixture) {
  const systemPrompt = buildExtractionPrompt(fixture.current_sessions);
  const userContent = `Athlete: ${fixture.user_message}\n\nCoach: ${fixture.coach_response}`;

  let extracted = null;
  let error = null;

  try {
    const msg = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (err) {
    error = err.message;
  }

  if (!extracted) {
    return {
      id: fixture.id,
      pass: false,
      failures: [error || "no JSON returned"],
      extracted: null,
      expected: fixture.expected,
    };
  }

  const failures = assertResult(fixture, extracted);

  return {
    id: fixture.id,
    description: fixture.description,
    pass: failures.length === 0,
    failures,
    extracted,
    expected: fixture.expected,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureFilter = args.indexOf("--fixture") !== -1
    ? args[args.indexOf("--fixture") + 1]
    : null;

  const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".json")).sort();
  let fixtures = fixtureFiles.map(f => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8")));

  if (fixtureFilter) {
    fixtures = fixtures.filter(f => f.id === fixtureFilter);
    if (fixtures.length === 0) {
      console.error(`No fixture found with id: ${fixtureFilter}`);
      process.exit(1);
    }
  }

  console.log(`\nRunning ${fixtures.length} extraction fixture${fixtures.length !== 1 ? "s" : ""}...\n`);

  const results = [];
  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.id.padEnd(40)} `);
    const result = await runExtraction(fixture);
    results.push(result);

    if (result.pass) {
      process.stdout.write(`\x1b[32mPASS\x1b[0m\n`);
    } else {
      process.stdout.write(`\x1b[31mFAIL\x1b[0m  ${result.failures[0]}\n`);
      for (const f of result.failures.slice(1)) {
        process.stdout.write(`         ${" ".repeat(40)} ${f}\n`);
      }
    }
  }

  // Save results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultFile = path.join(RESULTS_DIR, `extraction-${timestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({ timestamp: new Date().toISOString(), model: EXTRACTION_MODEL, results }, null, 2));

  const passing = results.filter(r => r.pass).length;
  const failing = results.filter(r => !r.pass).length;

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Results: ${passing} passed, ${failing} failed`);
  console.log(`Saved: ${resultFile}`);

  if (failing > 0) {
    console.log(`\nFailing fixtures:`);
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  \x1b[31m${r.id}\x1b[0m`);
      for (const f of r.failures) console.log(`    - ${f}`);
      if (r.extracted) console.log(`    Extracted: ${JSON.stringify(r.extracted)}`);
    }
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
