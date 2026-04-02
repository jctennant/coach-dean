#!/usr/bin/env node
/**
 * Coach Dean eval runner.
 *
 * For each fixture in /evals/fixtures/:
 *   1. Builds a realistic system prompt from fixture data (mirrors coach/respond logic)
 *   2. Calls Claude Sonnet (the real coaching model) with the fixture's inbound SMS
 *   3. Calls Claude Opus as the judge to evaluate factual accuracy
 *   4. Saves timestamped results to /evals/results/
 *   5. Prints a summary table and exits 1 if any fixture scores < 7
 *
 * Usage:
 *   node evals/run-evals.mjs
 *   node evals/run-evals.mjs --fixture mileage-week3-some-logged   # run a single fixture
 *   node evals/run-evals.mjs --category pace_accuracy              # run a category
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildJudgePrompt } from "./judges/factual-accuracy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const RESULTS_DIR = path.join(__dirname, "results");

const COACHING_MODEL = "claude-sonnet-4-5-20250929";
const JUDGE_MODEL = "claude-opus-4-5";

const client = new Anthropic();

// ─────────────────────────────────────────────
// VDOT pace calculations (mirrors src/lib/paces.ts)
// ─────────────────────────────────────────────

function paceAtVDOTPct(vdot, pct) {
  const targetVO2 = vdot * pct;
  const a = 0.000104, b = 0.182258, c = -(targetVO2 + 4.60);
  const v = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  const minPerMile = 1609.34 / v;
  const min = Math.floor(minPerMile);
  let sec = Math.round((minPerMile - min) * 60);
  if (sec === 60) return `${min + 1}:00/mi`;
  return `${min}:${String(sec).padStart(2, "0")}/mi`;
}

function easyPaceRange(paceStr) {
  if (!paceStr) return "TBD";
  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return paceStr;
  const totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
  const rounded = Math.round(totalSec / 5) * 5;
  const upper = rounded + 30;
  const fmt = (s) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  };
  return `${fmt(rounded)}–${fmt(upper)}/mi`;
}

function getVDOTPaces(fixture) {
  const { user } = fixture;
  // Use stored paces if available in fixture; compute from VDOT as fallback
  const easy = user.easy_pace || paceAtVDOTPct(user.vdot, 0.65);
  const tempo = user.tempo_pace || paceAtVDOTPct(user.vdot, 0.86);
  const interval = user.interval_pace || paceAtVDOTPct(user.vdot, 0.98);
  const easyRange = easyPaceRange(easy);
  return { easy, tempo, interval, easyRange };
}

// ─────────────────────────────────────────────
// System prompt construction (mirrors route.ts key sections)
// ─────────────────────────────────────────────

function buildEvalSystemPrompt(fixture) {
  const { user, trigger } = fixture;
  const tz = user.timezone || "America/Denver";
  const raceDate = user.goal_race_date;
  const todayDateStr = fixture.today ?? "2026-03-30";
  const today = new Date(todayDateStr + "T12:00:00Z");

  // Date context
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const todayStr = dateFormatter.format(today);

  // Pre-compute next 7 days (mirrors route.ts date injection so coach gets correct weekday↔date mapping)
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(today);
  const [ty, tm, td] = todayLocal.split("-").map(Number);
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" });
  const upcomingDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(ty, tm - 1, td + i + 1));
    return dayFmt.format(d);
  });
  const yesterdayStr = dayFmt.format(new Date(Date.UTC(ty, tm - 1, td - 1)));

  let dateContext = `DATE CONTEXT:\n- Today: ${todayStr}\n- Yesterday: ${yesterdayStr}\n- Tomorrow: ${upcomingDays[0]}\n- Next 7 days: ${upcomingDays.join(" | ")}\n- Timezone: ${tz}\n- For future scheduled sessions, use specific calendar dates (e.g. "Tuesday, Mar 31") rather than vague relative terms like "tomorrow" or "next Monday" — messages may be read after the day they're sent.\n- For recent past activities, you may use natural relative terms: "yesterday", "this morning", "Wednesday's run" — these are clearer than repeating calendar dates.\n`;
  let daysUntilRace = null;
  let weeksUntilRace = null;
  if (raceDate) {
    const race = new Date(raceDate + "T12:00:00Z");
    daysUntilRace = Math.ceil((race.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    weeksUntilRace = Math.round(daysUntilRace / 7);
    dateContext += `- Race date: ${raceDate} (${daysUntilRace} days / ~${weeksUntilRace} weeks away)\n`;
    dateContext += `- Always use specific calendar dates rather than relative terms like "tomorrow" or "next Monday"\n`;
  }

  // Taper block for race week
  if (daysUntilRace !== null && daysUntilRace > 0 && daysUntilRace <= 21) {
    const peakMiles = user.weekly_mileage_target ? Math.round(user.weekly_mileage_target / 0.45) : 40;
    if (daysUntilRace <= 7) {
      const raceWeekMiles = Math.round(peakMiles * 0.45);
      dateContext += `- RACE WEEK (${daysUntilRace} days out). Keep volume light: ~${raceWeekMiles}mi this week. No hard workouts — easy miles only. Final tune-up (15-30 min shakeout) is optional the day before.\n`;
      dateContext += `- Proactively address: gear check (nothing new race day), race morning routine, pacing strategy, mental preparation.\n`;
    } else if (daysUntilRace <= 14) {
      const w2Miles = Math.round(peakMiles * 0.72);
      dateContext += `- TAPER (2 weeks out, ${daysUntilRace} days). Target ~${w2Miles}mi this week. One short race-pace tune-up (2-3mi) is acceptable. Race week after this is easy miles only.\n`;
    } else {
      const w3Miles = Math.round(peakMiles * 0.88);
      dateContext += `- TAPER (3 weeks out, ${daysUntilRace} days). Target ~${w3Miles}mi this week.\n`;
    }
  }

  const paces = getVDOTPaces(fixture);
  const phase = user.current_phase || "build";
  const isDeload = user.is_deload_week || (user.current_week % 4 === 0 && phase !== "taper" && phase !== "peak");
  const weekMileageSoFar = user.miles_logged_this_week || 0;
  const weeklyTarget = user.weekly_mileage_target || 0;
  const avgWeekly = weeklyTarget || 30;

  // Activity summary
  let activitySummary = "";
  if (user.recent_activities && user.recent_activities.length > 0) {
    // Build simplified weekly summary
    const weeklyTotals = {};
    for (const a of user.recent_activities) {
      const weekKey = getWeekMonday(a.date);
      weeklyTotals[weekKey] = (weeklyTotals[weekKey] || 0) + a.distance_miles;
    }
    activitySummary = "WEEKLY MILEAGE (completed weeks, most recent first):\n";
    const thisWeekMonday = "2026-03-30";
    const sortedWeeks = Object.entries(weeklyTotals)
      .filter(([k]) => k < thisWeekMonday)
      .sort(([a], [b]) => b.localeCompare(a));
    for (const [week, miles] of sortedWeeks) {
      activitySummary += `  ${week}: ${miles.toFixed(1)} mi\n`;
    }

    activitySummary += "\nRECENT WORKOUTS (chronological, oldest first):\n";
    const sorted = [...user.recent_activities].sort((a, b) => a.date.localeCompare(b.date));
    for (const a of sorted) {
      const weekLabel = getWeekMonday(a.date) >= thisWeekMonday ? "[THIS WEEK]" : "[prior week]";
      activitySummary += `  ${weekLabel} ${a.date}: ${a.type}, ${a.distance_miles}mi${a.pace ? ` @ ${a.pace}` : ""}\n`;
    }
  } else {
    activitySummary = "No activity history available.";
  }

  // Session rows for plan
  let sessionRows = "";
  if (user.plan_sessions_remaining && user.plan_sessions_remaining.length > 0) {
    sessionRows = "\n- UPCOMING SESSIONS THIS WEEK:\n";
    for (const s of user.plan_sessions_remaining) {
      sessionRows += `${s.day} ${s.date} · ${s.label}\n`;
    }
  }

  // Recent conversation
  let conversationBlock = "";
  if (user.recent_conversation && user.recent_conversation.length > 0) {
    conversationBlock = "\nRECENT CONVERSATION (most recent at bottom):\n";
    for (const m of user.recent_conversation) {
      conversationBlock += `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}\n`;
    }
  }

  // Activity details for post_run fixtures
  let activityBlock = "";
  if (fixture.activity_details) {
    const a = fixture.activity_details;
    activityBlock = `\nACTIVITY JUST SYNCED FROM STRAVA:
- Type: ${a.type}
- Distance: ${a.distance_miles} miles
- Avg pace: ${a.pace || "unknown"}
${a.hr ? `- Avg HR: ${a.hr} bpm\n` : ""}`;
    if (a.splits_km && a.splits_km.length > 0) {
      activityBlock += `- Splits (one entry per kilometer — use cumulative_miles for position, do NOT treat split index as a mile number):\n`;
      for (const s of a.splits_km) {
        activityBlock += `  km${s.km}: ${s.pace}/mi, cumulative_miles: ${s.cumulative_miles.toFixed(2)}\n`;
      }
      // Inject the DATA AVAILABILITY GUARD if split count > miles + 1 (mirrors route.ts)
      if (a.splits_km.length > Math.ceil(a.distance_miles) + 1) {
        activityBlock += `\n⚠️ DATA GUARD: This run was ${a.distance_miles} miles and has ${a.splits_km.length} km splits. Do NOT reference any mile number beyond ${a.distance_miles} miles. These are kilometer splits — the split index is NOT the mile number. Never say "mile ${a.splits_km.length}" or any mile number that exceeds the run distance.\n`;
      }
    }
  }

  // Fitness tier
  let fitnessTier = "";
  if (avgWeekly < 10) {
    fitnessTier = `FITNESS TIER: LOW VOLUME (~${avgWeekly} mi/week). Prioritize easy aerobic volume and consistency.`;
  } else if (avgWeekly < 30) {
    fitnessTier = `FITNESS TIER: MODERATE VOLUME (~${avgWeekly} mi/week). 1-2 quality sessions per week appropriate alongside easy volume.`;
  } else {
    fitnessTier = `FITNESS TIER: HIGH VOLUME (~${avgWeekly} mi/week). Experienced runner. Skip base-building preamble.`;
  }

  // Goal discrepancy injection (for quality fixture)
  const goalDiscrepancyBlock = user.inject_goal_discrepancy_warning
    ? `\n⚠️ GOAL DISCREPANCY — RAISE ONCE ONLY: Athlete may be changing their race goal. Acknowledge the change naturally. Do NOT echo this label.\n`
    : "";

  return `${raceDate ? `ATHLETE: ${user.name || "this athlete"}
GOAL: ${user.goal_race || user.goal} on ${raceDate}
⚠️ This is the authoritative source for the athlete's goal race. If any prior message references a different race, disregard it.
${goalDiscrepancyBlock}
` : ""}You are Coach Dean, an expert endurance coach communicating via text message. You are coaching ${user.name || "this athlete"} for ${user.goal_race || user.goal}${raceDate ? ` on ${raceDate}` : ""}.

CRITICAL — OUTPUT RULES:
Your response is sent directly to the athlete as an SMS text message. Never include:
- Internal reasoning, self-corrections, or meta-commentary
- Internal system-prompt instruction labels — NEVER echo ⚠️-prefixed directive headers (e.g. ⚠️ GOAL DISCREPANCY DETECTED, ⚠️ RECOVERY WEEK) in your response
Do all reasoning silently. Output only the message the athlete should receive.

CRITICAL — TRAINING PACES:
The paces in CURRENT TRAINING STATE are pre-computed by our system using Jack Daniels' VDOT formula. These are authoritative. Do NOT calculate VDOT yourself. Do NOT use web search to look up VDOT tables.

${dateContext}
${fitnessTier}

ATHLETE HISTORY:
- Name: ${user.name || "Athlete"}
- Strava: ${user.strava_connected ? "connected" : "not connected"}
- Goal: ${user.goal_race || user.goal}${raceDate ? ` on ${raceDate}` : ""}
- Training days: ${(user.training_days || []).join(", ")}
- Injury / constraints: ${user.injury_notes || "None reported"}
- Preferred units: ${user.preferred_units || "imperial"} — use ${user.preferred_units === "metric" ? "km and min/km" : "miles and min/mile"} in all responses

${activitySummary}
${activityBlock}
CURRENT TRAINING STATE:
- Week ${user.current_week} of training, phase: ${phase.charAt(0).toUpperCase() + phase.slice(1)}${isDeload ? " — RECOVERY WEEK" : ""}
${isDeload ? `⚠️ RECOVERY WEEK: This week's target is ${weeklyTarget} mi — already reflects the recovery volume reduction. Use the stored target, do NOT compute a further reduction from recent average. No new quality sessions. Same number of runs, shorter distances.\n` : ""}
- Weekly mileage target: ${weeklyTarget ? weeklyTarget + " mi" : "TBD"}${trigger === "weekly_recap" ? `\n- Progression target for NEXT week (week ${user.current_week + 1}): ~${Math.round(avgWeekly * 1.08)} mi (8% step up from recent average — use this as the plan total, not the stored weekly target)` : ""}
⚠️ THIS WEEK'S MILEAGE — READ CAREFULLY: ${weekMileageSoFar.toFixed(1)} mi done so far this week (${user.runs_this_week || 0} run${(user.runs_this_week || 0) !== 1 ? "s" : ""}). This is the ONLY authoritative source for current week mileage — computed directly from Strava. NEVER compute week mileage yourself by summing individual run mentions. Each week resets on Monday.
- Athlete preferred units: ${user.preferred_units || "imperial"}
- Athlete VDOT: ${user.vdot}
- Current paces (Jack Daniels' VDOT formula — AUTHORITATIVE; treat as ground truth):
  Easy ${paces.easyRange}, Tempo ${paces.tempo}, Interval ${paces.interval}
- RULE: NEVER recalculate VDOT or training paces. The stored paces above are correct.
⚠️ PACE SANITY CHECK — CRITICAL: Quality paces (tempo, threshold, interval) must be FASTER (lower number) than the athlete's easy pace. This athlete's easy pace is ${paces.easy}. Any tempo or interval pace at ${paces.easy} or SLOWER is a documented error — use the stored Tempo (${paces.tempo}) instead; never compute a quality pace from scratch. Warm-up and cool-down pace = easy pace range (${paces.easyRange}); never prescribe WU/CD more than 30 sec/mi slower than easy. Always include the unit ("/mi" or "/km") on every pace.${sessionRows}
${conversationBlock}
MILEAGE ACCURACY RULES — follow exactly:
- When listing planned sessions for a week, the Total line shows ONLY planned future sessions. Never write "Total: X mi + your Y mi already this week". If the athlete has run some miles already, acknowledge them in a separate sentence. The Total shows what is still to be done (or the full week target).
- For weekly recaps: planned next week shows a clean single total; last week's completed miles are referenced separately.
- PLAN MATH CHECK: Before finalizing a week plan, verify your session distances add up to the Total you state. Never write a Total that doesn't match the sum of the individual sessions.

COMMUNICATION STYLE:
You are texting over iMessage. Write like a human coach would text.

LENGTH:
- Keep responses under 480 characters. Most replies should be a single short text.
- Split into 2-3 messages by separating with a blank line only if genuinely needed (e.g. sending a full week plan).

TONE:
- Cut filler openers. Never start with "Great job!", "Awesome!", "That's fantastic!"
- No sign-offs, no "Let me know if you have questions", no "You've got this!" at end.
- Sound like a knowledgeable friend, not a customer service bot.`;
}

function getWeekMonday(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun
  const daysBack = dow === 0 ? 6 : dow - 1;
  const monday = new Date(d.getTime() - daysBack * 86400000);
  return monday.toISOString().slice(0, 10);
}

function buildUserMessage(fixture) {
  const { trigger, user, activity_details, inbound_sms } = fixture;

  if (trigger === "post_run" && activity_details) {
    const a = activity_details;
    const weekSoFar = user.miles_logged_this_week || a.distance_miles || 0;
    let msg = `New activity synced from Strava:\n`;
    msg += `- Type: ${a.type}\n`;
    msg += `- Distance: ${a.distance_miles} miles\n`;
    msg += `- Avg pace: ${a.pace || "N/A"}\n`;
    if (a.hr) msg += `- Avg HR: ${a.hr} bpm\n`;
    msg += `\n⚠️ WEEK-TO-DATE (authoritative — from Strava, Monday through now): ${weekSoFar.toFixed(1)} mi total`;
    return msg;
  }

  if (trigger === "weekly_recap") {
    const weekMiles = user.miles_logged_this_week || 0;
    const nextWeekTarget = Math.round((user.weekly_mileage_target || 35) * 1.08);
    const trainingDays = (user.training_days || []).join(", ");
    return `Weekly recap trigger. Week ${user.current_week} completed with ${weekMiles.toFixed(1)} mi over ${user.runs_this_week || 0} runs. Build week ${user.current_week + 1} plan targeting ~${nextWeekTarget} mi. Training days are: ${trainingDays} — schedule a run on EACH training day including Monday. Do NOT skip any training day.`;
  }

  if (trigger === "initial_plan") {
    const weekMiles = user.miles_logged_this_week || 0;
    return `Initial plan trigger. Athlete has already logged ${weekMiles.toFixed(1)} mi this week. Build week 1 plan targeting ${user.weekly_mileage_target || 30} mi total. Acknowledge completed runs separately from planned sessions. Do NOT use additive total format ("Total: X + Y already").`;
  }

  if (trigger === "morning_reminder") {
    return `Morning reminder trigger. Send today's workout reminder based on the schedule and recent conversation.`;
  }

  // Default: user message
  return inbound_sms || "What's the plan?";
}

// ─────────────────────────────────────────────
// Main eval runner
// ─────────────────────────────────────────────

async function runEval(fixture) {
  const systemPrompt = buildEvalSystemPrompt(fixture);
  const userMessage = buildUserMessage(fixture);

  // Step 1: Get coaching response
  let coachResponse = null;
  let coachError = null;
  try {
    const coachMsg = await client.messages.create({
      model: COACHING_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    coachResponse = coachMsg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text.trim())
      .join("\n\n")
      .trim();
  } catch (err) {
    coachError = err.message;
  }

  if (!coachResponse) {
    return {
      fixture_id: fixture.id,
      category: fixture.category,
      description: fixture.description,
      coach_response: null,
      coach_error: coachError || "No response generated",
      judgment: null,
      score: -1,
      flags: ["coach_call_failed"],
      error: coachError,
    };
  }

  // Step 2: Judge the response
  const judgePromptStr = buildJudgePrompt(fixture, coachResponse);
  let judgment = null;
  let judgeError = null;

  try {
    const judgeMsg = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: judgePromptStr }],
    });
    const judgeText = judgeMsg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text.trim())
      .join("")
      .trim();

    // Extract JSON from response (may have markdown fences).
    // Strip code fences first, then take the outermost {...} block.
    const stripped = judgeText.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON found in judge response: ${judgeText.slice(0, 200)}`);
    judgment = JSON.parse(jsonMatch[0]);
  } catch (err) {
    judgeError = err.message;
    console.error(`[${fixture.id}] Judge error:`, err.message);
  }

  return {
    fixture_id: fixture.id,
    category: fixture.category,
    description: fixture.description,
    coach_response: coachResponse,
    judgment: judgment,
    score: judgment?.score ?? -1,
    flags: judgment?.flags ?? [],
    error: judgeError || null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureFilter = args.indexOf("--fixture") !== -1
    ? args[args.indexOf("--fixture") + 1]
    : null;
  const categoryFilter = args.indexOf("--category") !== -1
    ? args[args.indexOf("--category") + 1]
    : null;

  // Load fixtures
  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let fixtures = fixtureFiles.map((f) =>
    JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8"))
  );

  if (fixtureFilter) {
    fixtures = fixtures.filter((f) => f.id === fixtureFilter);
    if (fixtures.length === 0) {
      console.error(`No fixture found with id: ${fixtureFilter}`);
      process.exit(1);
    }
  }
  if (categoryFilter) {
    fixtures = fixtures.filter((f) => f.category === categoryFilter);
    if (fixtures.length === 0) {
      console.error(`No fixtures found in category: ${categoryFilter}`);
      process.exit(1);
    }
  }

  console.log(`\nRunning ${fixtures.length} fixture${fixtures.length !== 1 ? "s" : ""}...\n`);

  const results = [];
  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.id.padEnd(45)} `);
    const result = await runEval(fixture);
    results.push(result);

    if (result.error && result.score === -1) {
      process.stdout.write(`ERROR\n`);
    } else {
      const scoreStr = result.score >= 7 ? `\x1b[32m${result.score}/10\x1b[0m` : `\x1b[31m${result.score}/10\x1b[0m`;
      process.stdout.write(`${scoreStr}  ${result.flags.length > 0 ? result.flags.slice(0, 2).join("; ") : "ok"}\n`);
    }
  }

  // Save results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const resultFile = path.join(RESULTS_DIR, `${timestamp}.json`);
  const output = {
    timestamp: new Date().toISOString(),
    model_coaching: COACHING_MODEL,
    model_judge: JUDGE_MODEL,
    fixture_count: results.length,
    results,
  };
  fs.writeFileSync(resultFile, JSON.stringify(output, null, 2));

  // Summary
  const scored = results.filter((r) => r.score >= 0);
  const avgScore = scored.length > 0
    ? (scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(1)
    : "N/A";
  const passing = results.filter((r) => r.score >= 7).length;
  const failing = results.filter((r) => r.score >= 0 && r.score < 7).length;
  const errors = results.filter((r) => r.score === -1).length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passing} passed, ${failing} failed, ${errors} errored`);
  console.log(`Average score: ${avgScore}/10`);
  console.log(`Saved: ${resultFile}`);

  // Per-category summary
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r.score);
  }
  console.log("\nBy category:");
  for (const [cat, scores] of Object.entries(byCategory)) {
    const valid = scores.filter((s) => s >= 0);
    const avg = valid.length > 0 ? (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1) : "N/A";
    const pass = valid.filter((s) => s >= 7).length;
    console.log(`  ${cat.padEnd(35)} avg ${avg}/10  (${pass}/${valid.length} passing)`);
  }

  if (failing > 0 || errors > 0) {
    console.log("\nFailing fixtures:");
    for (const r of results.filter((r) => r.score >= 0 && r.score < 7)) {
      console.log(`  \x1b[31m${r.fixture_id}\x1b[0m (${r.score}/10): ${r.flags.join("; ") || r.judgment?.score_rationale || "see results file"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
