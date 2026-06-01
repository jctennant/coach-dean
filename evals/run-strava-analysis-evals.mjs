#!/usr/bin/env node
/**
 * Strava analysis eval runner for Coach Dean.
 *
 * Tests the handleDataAnalysis stage — the first message Dean sends after
 * an athlete's Strava account connects. Evaluates whether Dean gives a
 * specific, opinionated coaching synthesis (not a data recap) connected
 * to the athlete's race and timeline.
 *
 * Usage:
 *   node evals/run-strava-analysis-evals.mjs
 *   node evals/run-strava-analysis-evals.mjs --fixture strava-z3-heavy-half-marathon
 *   node evals/run-strava-analysis-evals.mjs --verbose
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildStravaAnalysisJudgePrompt } from "./judges/strava-analysis-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "strava-analysis");
const RESULTS_DIR = path.join(__dirname, "results");

const PROVIDER = process.env.AI_PROVIDER ?? "openai";
const DEAN_MODEL = "claude-sonnet-4-5-20250929";
const JUDGE_MODEL = "claude-opus-4-5";

const OPENAI_MODEL_MAP = {
  "claude-sonnet-4-5-20250929": "gpt-4o",
  "claude-sonnet-4-6": "gpt-4o",
  "claude-opus-4-5": "gpt-4o",
};

const client = PROVIDER === "anthropic"
  ? new Anthropic()
  : (() => {
      const oai = new OpenAI();
      return {
        messages: {
          async create({ model, max_tokens, system, messages }) {
            const oaiModel = OPENAI_MODEL_MAP[model] ?? "gpt-4o";
            const oaiMessages = [];
            if (system) oaiMessages.push({ role: "system", content: system });
            for (const m of messages) {
              oaiMessages.push({ role: m.role, content: m.content });
            }
            const resp = await oai.chat.completions.create({
              model: oaiModel,
              max_tokens: Math.min(max_tokens ?? 4096, 16384),
              messages: oaiMessages,
            });
            const text = resp.choices?.[0]?.message?.content ?? "";
            return { content: [{ type: "text", text }] };
          },
        },
      };
    })();

// ─────────────────────────────────────────────
// Mirrors buildStravaContext in onboarding/handle/route.ts
// ─────────────────────────────────────────────
function buildStravaContext(strava, goal) {
  const {
    avg_weekly_miles,
    mileage_trend,
    avg_runs_per_week,
    longest_run_miles,
    avg_elev_ft_per_run,
    recent_4_weeks,
    hr_zone_pct,
    estimated_max_hr,
    max_weekly_spike_pct,
    best_race,
  } = strava;

  const weeklyLine = avg_weekly_miles != null
    ? ` Recent avg: ~${avg_weekly_miles} mi/week${mileage_trend ? ` (${mileage_trend})` : ""}.`
    : "";
  const frequencyLine = avg_runs_per_week != null ? ` ~${avg_runs_per_week} runs/week.` : "";
  const longestLine = longest_run_miles != null ? ` Longest run (8 weeks): ${longest_run_miles} mi.` : "";
  const isTrailGoal = ["trail_race", "30k", "50k", "50mi", "100k", "100mi"].includes(goal ?? "");
  const elevLine = avg_elev_ft_per_run
    ? ` Avg elevation/run: ${avg_elev_ft_per_run} ft.`
    : isTrailGoal
      ? " Avg elevation/run: 0 ft (no vertical training in recent runs)."
      : "";
  const progressionLine = recent_4_weeks && recent_4_weeks.some((m) => m > 0)
    ? ` Weekly miles (oldest→newest): ${[...recent_4_weeks].reverse().join(", ")}.`
    : "";
  const hrZoneLine = hr_zone_pct
    ? ` HR zones (% of runs by avg HR): Z1 ${hr_zone_pct.z1}%, Z2 ${hr_zone_pct.z2}%, Z3 ${hr_zone_pct.z3}%, Z4 ${hr_zone_pct.z4}%, Z5 ${hr_zone_pct.z5}%.${estimated_max_hr ? ` Est. max HR: ${estimated_max_hr} bpm.` : ""}`
    : "";
  const spikeLine = max_weekly_spike_pct != null && max_weekly_spike_pct >= 20
    ? ` WARNING: Mileage spike detected: largest week-over-week jump in last 4 weeks was +${max_weekly_spike_pct}%.`
    : "";

  let paceNote = "";
  if (best_race) {
    paceNote = best_race.is_trail
      ? ` Note: best race is a trail race — easy pace suggestion withheld. Collect a road baseline.`
      : ` Best race for pace calibration: ${best_race.label}. Suggested easy pace: ${best_race.easy_pace}/mi.`;
  } else {
    paceNote = " No races found for VDOT calculation — training zones will be calibrated from HR data.";
  }

  return `STRAVA: Connected.${weeklyLine}${frequencyLine}${longestLine}${elevLine}${progressionLine}${hrZoneLine}${spikeLine}${paceNote}`;
}

// ─────────────────────────────────────────────
// Mirrors handleDataAnalysis system prompt in onboarding/handle/route.ts
// ─────────────────────────────────────────────
function buildDataAnalysisPrompt(fixture) {
  const { athlete, strava } = fixture;
  const firstName = athlete.name ? athlete.name.split(" ")[0] : null;
  const stravaContext = buildStravaContext(strava, athlete.goal);

  let raceContext = "";
  if (athlete.race_name && athlete.race_date) {
    raceContext = `${athlete.race_name} on ${athlete.race_date} (${athlete.weeks_until_race} week${athlete.weeks_until_race !== 1 ? "s" : ""} away)`;
  } else if (athlete.goal) {
    raceContext = athlete.goal.replace(/_/g, " ");
  }

  return `You are Coach Dean, an AI running coach. ${firstName ? firstName + "'s" : "An athlete's"} Strava just connected.

ATHLETE CONTEXT:
${raceContext ? `Race/Goal: ${raceContext}` : "Goal: general fitness"}
${stravaContext}

YOUR JOB: Give a coaching opinion on what you see — not a data summary, but an interpretation connected to their specific race and timeline. This is the moment you earn their trust.

Write 3–4 sentences:
1. One insight that connects their training data to the race timeline. Use at least 2 specific numbers from the Strava data (e.g. weekly mileage, HR zone %, longest run, weeks until race). Be direct — not "solid base" but what it means for THIS specific race. E.g. if their HR distribution is skewed hard for a climb-heavy trail race, say what that means.
2. One thing that needs attention or one adjustment. Be specific about WHY it matters for this race.
3. One forward-looking sentence about what the coaching will watch.

Then close with exactly: "Has injury ever been a factor for you, or anything you're managing right now?"

Rules:
- Do NOT ask for road race times — training zones calibrate from Strava data
- Do NOT narrate all the stats — pick 2–3 meaningful facts and make them mean something
- Avoid: "solid base", "great foundation", "exciting", "strong work", "keep it up"
- 4 sentences max before the injury question
- Plain text, no markdown
- TRAIL RACES: If "Avg elevation/run: 0 ft (no vertical training)" appears in the Strava context AND the race is a trail/mountain race, lead with the elevation gap. Include the athlete's weekly mileage AND weeks to race alongside it so the coaching read is grounded. Example: "You're building well at 38 miles/week over 5 runs, but zero elevation gain in all of it — with 10 weeks to Snowbird and ~3000ft of climbing in 8.9 miles, adding vert is now the training priority."`;
}

// ─────────────────────────────────────────────
// Main eval runner
// ─────────────────────────────────────────────
async function runFixture(fixture, verbose) {
  const systemPrompt = buildDataAnalysisPrompt(fixture);

  // Call Dean
  let deanResponse = "";
  try {
    const resp = await client.messages.create({
      model: DEAN_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: "(strava connected)" }],
    });
    deanResponse = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    return { fixture_id: fixture.id, category: fixture.category, description: fixture.description, dean_response: "", judgment: null, score: 0, flags: [], error: String(err) };
  }

  if (verbose) {
    console.log(`\n  Dean: "${deanResponse}"`);
  }

  // Judge
  const judgePrompt = buildStravaAnalysisJudgePrompt(fixture, deanResponse);
  let judgment = null;
  let score = 0;
  let flags = [];
  try {
    const judgeResp = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 600,
      system: "You are a precise evaluator. Return only valid JSON matching the schema requested.",
      messages: [{ role: "user", content: judgePrompt }],
    });
    const raw = judgeResp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      judgment = JSON.parse(jsonMatch[0]);
      score = judgment.score ?? 0;
      flags = judgment.flags ?? [];
    }
  } catch (err) {
    flags = [`judge_error: ${err}`];
  }

  return { fixture_id: fixture.id, category: fixture.category, description: fixture.description, dean_response: deanResponse, judgment, score, flags, error: null };
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureIdx = args.indexOf("--fixture");
  const fixtureArg = fixtureIdx !== -1 ? args[fixtureIdx + 1] : null;
  const verbose = args.includes("--verbose");

  // Load fixtures
  let fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8")));

  if (fixtureArg) {
    fixtures = fixtures.filter((f) => f.id === fixtureArg);
    if (fixtures.length === 0) {
      console.error(`No fixture found with id: ${fixtureArg}`);
      process.exit(1);
    }
  }

  console.log(`\nRunning ${fixtures.length} Strava analysis fixture${fixtures.length !== 1 ? "s" : ""}...\n`);

  const results = [];
  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.id} ... `);
    const result = await runFixture(fixture, verbose);
    results.push(result);

    if (result.error) {
      console.log(`✗ ERROR [response_failed]\n    Error: ${result.error}`);
    } else if (result.score >= 8) {
      console.log(`✓ ${result.score}/10`);
      if (result.judgment?.score_rationale) console.log(`    → ${result.judgment.score_rationale}`);
    } else {
      const flagStr = result.flags?.length ? result.flags.map((f) => `[${f}]`).join(" ") : "";
      console.log(`⚠ ${result.score}/10 ${flagStr}`);
      if (result.judgment?.score_rationale) console.log(`    → ${result.judgment.score_rationale}`);
    }
  }

  // Save results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(RESULTS_DIR, `strava-analysis-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ timestamp, provider: PROVIDER, results }, null, 2));

  const passed = results.filter((r) => r.score >= 8);
  const errored = results.filter((r) => r.error);
  const failed = results.filter((r) => !r.error && r.score < 8);
  const scores = results.filter((r) => !r.error).map((r) => r.score);
  const avg = scores.length ? (scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(1) : "N/A";

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Strava Analysis Evals: ${passed.length}/${results.filter((r) => !r.error).length} passed  |  avg ${avg}/10`);
  if (errored.length) console.log(`\nErrored: ${errored.map((r) => r.fixture_id).join(", ")}`);
  if (failed.length) {
    console.log(`\nFailed fixtures:`);
    for (const r of failed) console.log(`  ✗ ${r.fixture_id} (${r.score}/10): ${r.judgment?.score_rationale ?? "no rationale"}`);
  }

  console.log(`\nResults saved to ${outPath}`);
  if (failed.length || errored.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
