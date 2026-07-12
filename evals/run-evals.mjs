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
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildJudgePrompt } from "./judges/factual-accuracy.mjs";
import { buildPlanJudgePrompt } from "./judges/plan-quality.mjs";
import { buildPlanUpdateJudgePrompt } from "./judges/plan-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const RESULTS_DIR = path.join(__dirname, "results");

const PROVIDER = process.env.AI_PROVIDER ?? "anthropic";

// Mirrors the production shim in src/lib/anthropic.ts: when running on OpenAI,
// map Claude IDs to OpenAI models so eval-mode and prod use the same models.
const OPENAI_MODEL_MAP = {
  "claude-haiku-4-5-20251001": "gpt-4o-mini",
  "claude-sonnet-4-5-20250929": "gpt-4o",
  "claude-sonnet-4-6": "gpt-4o",
  "claude-opus-4-5": "gpt-4o", // judge — use gpt-4o for parity (no o1 in shim)
};

const COACHING_MODEL = "claude-sonnet-4-5-20250929";
const JUDGE_MODEL = "claude-opus-4-5";

// Anthropic-shaped client. When AI_PROVIDER=openai, we use a tiny shim that
// returns { content: [{ type: "text", text }] } from OpenAI chat completions
// so the rest of the runner is unchanged.
const client = PROVIDER === "anthropic"
  ? new Anthropic()
  : (() => {
      const oai = new OpenAI();
      return {
        messages: {
          async create({ model, max_tokens, system, messages }) {
            const oaiMessages = [];
            if (system) oaiMessages.push({ role: "system", content: system });
            for (const m of messages) {
              oaiMessages.push({ role: m.role, content: typeof m.content === "string" ? m.content : m.content });
            }
            const resp = await oai.chat.completions.create({
              model: OPENAI_MODEL_MAP[model] ?? "gpt-4o",
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

function easyPaceRange(paceStr, useMetric = false) {
  if (!paceStr) return "TBD";
  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return paceStr;
  const totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
  if (useMetric) {
    const kmSec = Math.round(totalSec / 1.60934);
    const rounded = Math.round(kmSec / 5) * 5;
    const upper = rounded + 30;
    const fmt = (s) => {
      const min = Math.floor(s / 60);
      const sec = s % 60;
      return `${min}:${String(sec).padStart(2, "0")}`;
    };
    return `${fmt(rounded)}–${fmt(upper)}/km`;
  }
  const rounded = Math.round(totalSec / 5) * 5;
  const upper = rounded + 30;
  const fmt = (s) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${String(sec).padStart(2, "0")}`;
  };
  return `${fmt(rounded)}–${fmt(upper)}/mi`;
}

function miPaceToKm(paceStr) {
  if (!paceStr) return "TBD";
  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return paceStr;
  const totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
  const kmSec = Math.round(totalSec / 1.60934);
  const min = Math.floor(kmSec / 60);
  const sec = kmSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}/km`;
}

function getVDOTPaces(fixture) {
  const { user } = fixture;
  const useMetric = user.preferred_units === "metric";
  // Use stored paces if available in fixture; compute from VDOT as fallback
  const easyMi = user.easy_pace || paceAtVDOTPct(user.vdot, 0.65);
  const tempoMi = user.tempo_pace || paceAtVDOTPct(user.vdot, 0.86);
  const intervalMi = user.interval_pace || paceAtVDOTPct(user.vdot, 0.98);
  const easy = useMetric ? miPaceToKm(easyMi) : easyMi;
  const tempo = useMetric ? miPaceToKm(tempoMi) : tempoMi;
  const interval = useMetric ? miPaceToKm(intervalMi) : intervalMi;
  const easyRange = easyPaceRange(easyMi, useMetric);
  return { easy, tempo, interval, easyRange };
}

// ─────────────────────────────────────────────
// Injury body-part exercises (mirrors BODY_PART_EXERCISES in route.ts)
// ─────────────────────────────────────────────

const BODY_PART_EXERCISES = {
  it_band:      ["Hip abductor clamshells 3×15", "Lateral band walks 2×20 steps each way", "Foam roll TFL and outer glute — NOT the IT band itself (rolling the IT band directly irritates it)", "Hip flexor stretch in lunge position 3×30s each side"],
  hamstring:    ["Eccentric Nordic hamstring curls 3×8 (use a towel under knees)", "Romanian single-leg deadlifts 3×10 each", "Prone hamstring raises 3×12", "Glute bridges with 2-second hold 3×15"],
  knee:         ["VMO quad sets 3×15 (sit, tighten quad isometrically, hold 5sec)", "Terminal knee extensions (TKEs) with band 3×15", "Step-downs from 6-inch step, slow 3-second descent 3×10 each", "Straight-leg raises 3×15"],
  shin:         ["Eccentric calf raises off a step (straight knee) 3×15", "Tibialis anterior raises: stand with back to wall, lift toes 3×15", "Calf stretching bent + straight knee 3×30s each", "Slow toe taps on a stair 2×20"],
  achilles:     ["Eccentric heel drops off step — straight knee 3×15, bent knee 3×15", "Standing single-leg calf raises 3×20", "Soleus stretch (bent knee, heel on step) 3×30s hold", "Ankle alphabet 2×10 each direction"],
  calf:         ["Eccentric heel drops off step — straight knee 3×15, bent knee 3×15", "Standing calf raises (single-leg) 3×20", "Soleus stretch (bent knee) 3×30s hold", "Ankle circles 2×10 each direction"],
  foot:         ["Frozen water bottle rolling under arch 2 min each foot", "Towel toe curls 3×15", "Eccentric calf raises 3×15", "Short-foot arch activation 3×10"],
  plantar:      ["Frozen water bottle rolling under arch 2 min each foot (morning, before first step)", "Calf stretches — gastrocnemius (straight knee) + soleus (bent knee) 3×30s each, lying in bed before getting up", "Towel toe curls 3×15", "Short-foot arch activation 3×10"],
  hip:          ["Hip flexor stretch in lunge position 3×30s each", "Glute bridges 3×15", "Lateral band walks 2×20 steps", "Pigeon pose 2×60s each side"],
  back:         ["Cat-cow 10 slow reps", "Bird-dog 3×10 each side", "Child's pose 2×60s", "Dead bug 3×8 each side"],
  ankle:        ["Eccentric calf raises off step 3×15", "Single-leg balance on unstable surface 3×30s", "Resistance band dorsiflexion 3×15", "Ankle alphabet (draw A–Z slowly with foot)"],
};

function getBodyPartExercisesEval(bodyPart) {
  if (!bodyPart) return "";
  const key = bodyPart.toLowerCase().replace(/\s+/g, "_").replace("it band", "it_band").replace("patellofemoral", "knee");
  const exercises = BODY_PART_EXERCISES[key];
  if (!exercises) return "";
  return `\n  Targeted exercises for ${bodyPart.replace(/_/g, " ")}: ${exercises.join(" | ")}`;
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
  // timeZone: "UTC" here, not tz — ty/tm/td are already the correct local calendar
  // date; reformatting the Date.UTC-reconstructed values through tz again would
  // re-apply the offset a second time and roll the result back a day for any
  // timezone behind UTC (mirrors the route.ts fix — see CHANGELOG 2026-07-12).
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
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
      dateContext += `- RACE WEEK (${daysUntilRace} days out). Keep volume light: ~${raceWeekMiles}mi this week. No hard workouts — easy miles only. Final tune-up (15-30 min shakeout) is optional the day before — place it ONLY on a confirmed running day, NOT on a gym-only or cross-training day.\n`;
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
  // Only mark deload if fixture explicitly sets is_deload_week — don't infer from week % 4
  // since fixtures are the authoritative source for what week type it is.
  const isDeload = user.is_deload_week === true;
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
    const thisWeekMonday = getWeekMonday(todayDateStr);
    const sortedWeeks = Object.entries(weeklyTotals)
      .filter(([k]) => k < thisWeekMonday)
      .sort(([a], [b]) => b.localeCompare(a));
    for (const [week, miles] of sortedWeeks) {
      activitySummary += `  ${week}: ${miles.toFixed(1)} mi\n`;
    }

    activitySummary += "\nRECENT WORKOUTS (chronological, oldest first):\n";
    const sorted = [...user.recent_activities].sort((a, b) => a.date.localeCompare(b.date));
    const [todayY, todayM, todayD] = todayDateStr.split("-").map(Number);
    const todayMs = Date.UTC(todayY, todayM - 1, todayD);
    for (const a of sorted) {
      const weekLabel = getWeekMonday(a.date) >= thisWeekMonday ? "[THIS WEEK]" : "[prior week]";
      const [ay, am, ad] = a.date.split("-").map(Number);
      const daysAgo = Math.round((todayMs - Date.UTC(ay, am - 1, ad)) / 86400000);
      const relLabel = daysAgo === 0 ? " (today)" : daysAgo === 1 ? " (yesterday)" : daysAgo <= 13 ? ` (${daysAgo} days ago)` : "";
      const dayName = new Date(a.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      activitySummary += `  ${weekLabel} ${dayName}${relLabel}: ${a.type}, ${a.distance_miles}mi${a.pace ? ` @ ${a.pace}` : ""}\n`;
    }
  } else {
    activitySummary = "No activity history available.";
  }

  // Session rows for plan — mirror production route's today/future classification
  let sessionRows = "";
  let remainingPlanLine = "";
  if (user.plan_sessions_remaining && user.plan_sessions_remaining.length > 0) {
    const [todayY, todayM, todayD] = todayDateStr.split("-").map(Number);
    const localTodayUTC = new Date(Date.UTC(todayY, todayM - 1, todayD));
    const dayOfWeekToday = localTodayUTC.getUTCDay();
    const daysToSunday = dayOfWeekToday === 0 ? 0 : 7 - dayOfWeekToday;
    const endOfWeekMs = Date.UTC(todayY, todayM - 1, todayD + daysToSunday);

    const parseSessionMiles = (s) => {
      const explicitTotal = s.label.match(/[≈~=]\s*(\d+(?:\.\d+)?)\s*mi(?!n)/i) || s.label.match(/\((\d+(?:\.\d+)?)\s*mi(?!n)(?:\s+total)?\)/i);
      const firstMi = s.label.match(/(\d+(?:\.\d+)?)\s*mi(?!n)/i);
      const mMatch = explicitTotal || firstMi;
      return mMatch ? parseFloat(mMatch[1]) : 0;
    };

    const sessions = user.plan_sessions_remaining;
    const todaySessions = sessions.filter(s => {
      const [m, d] = s.date.split("/").map(Number);
      if (isNaN(m) || isNaN(d)) return false;
      return new Date(Date.UTC(todayY, m - 1, d)).getTime() === localTodayUTC.getTime();
    });
    const futureSessions = sessions.filter(s => {
      const [m, d] = s.date.split("/").map(Number);
      if (isNaN(m) || isNaN(d)) return true;
      return new Date(Date.UTC(todayY, m - 1, d)) > localTodayUTC;
    });

    const trigger = fixture.trigger;
    if (todaySessions.length > 0) {
      const todayLabel = trigger === "post_run"
        ? `TODAY'S PLANNED SESSION (COMPLETED — already included in week-to-date above; do NOT add this distance again)`
        : `TODAY'S PLANNED SESSION (may already be completed — check conversation history before giving future-tense advice)`;
      sessionRows += `\n- ${todayLabel}:\n${todaySessions.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n")}\n`;
    }
    if (futureSessions.length > 0) {
      const thisWeekFuture = futureSessions.filter(s => {
        const [mm, dd] = s.date.split("/").map(Number);
        if (isNaN(mm) || isNaN(dd)) return true;
        return new Date(Date.UTC(todayY, mm - 1, dd)).getTime() <= endOfWeekMs;
      });
      const nextWeekFuture = futureSessions.filter(s => {
        const [mm, dd] = s.date.split("/").map(Number);
        if (isNaN(mm) || isNaN(dd)) return false;
        return new Date(Date.UTC(todayY, mm - 1, dd)).getTime() > endOfWeekMs;
      });
      if (thisWeekFuture.length > 0) {
        sessionRows += `\n- UPCOMING SESSIONS THIS WEEK (week ends Sunday):\n${thisWeekFuture.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n")}\n`;
      }
      if (nextWeekFuture.length > 0) {
        sessionRows += `\n- NEXT WEEK'S PLANNED SESSIONS (starts Monday — do NOT count these as part of this week's mileage or day count):\n${nextWeekFuture.map(s => `${s.day} ${s.date} · ${s.label}`).join("\n")}\n`;
      }
    }

    // Pre-computed remaining miles fact — mirrors production route
    if (trigger !== "post_run") {
      const todayMiles = todaySessions.reduce((sum, s) => sum + parseSessionMiles(s), 0);
      const futureMiles = futureSessions.reduce((sum, s) => sum + parseSessionMiles(s), 0);
      const totalRemaining = todayMiles + futureMiles;
      const weeklyMilesDone = user.miles_logged_this_week ?? 0;
      if (totalRemaining > 0) {
        const thisWeekRemaining = [
          ...todaySessions,
          ...futureSessions.filter(s => {
            const [mm, dd] = s.date.split("/").map(Number);
            if (isNaN(mm) || isNaN(dd)) return true;
            return new Date(Date.UTC(todayY, mm - 1, dd)).getTime() <= endOfWeekMs;
          }),
        ];
        const breakdown = thisWeekRemaining.map(s => {
          const [m, d] = s.date.split("/").map(Number);
          const isToday = !isNaN(m) && !isNaN(d) && new Date(Date.UTC(todayY, m - 1, d)).getTime() === localTodayUTC.getTime();
          return `${isToday ? "today's" : `${s.day} ${s.date}`} ${s.label}`;
        }).join(" + ");
        const projTotal = (weeklyMilesDone + totalRemaining).toFixed(1);
        remainingPlanLine = `\n- MILES REMAINING IN PLAN THIS WEEK: ${totalRemaining.toFixed(1)}mi across ${thisWeekRemaining.length} session${thisWeekRemaining.length !== 1 ? "s" : ""} (${breakdown}) → projected week total: ${projTotal}mi`;
      }
    }
  }

  // Recent conversation
  let conversationBlock = "";
  if (user.recent_conversation && user.recent_conversation.length > 0) {
    conversationBlock = "\nRECENT CONVERSATION (most recent at bottom):\n";
    for (const m of user.recent_conversation) {
      const dateLabel = m.date ? `[${m.date}] ` : "";
      conversationBlock += `${dateLabel}${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}\n`;
    }
    // If the fixture has forbidden phrases, inject an explicit correction rule after the conversation
    // to prevent the model from repeating prior errors that the athlete has already corrected.
    if (fixture.ground_truth?.forbidden_phrases && fixture.ground_truth.forbidden_phrases.length > 0) {
      conversationBlock += `\n<rule>AVOID THESE PHRASES — the athlete has pushed back on prior messages that used language like these, and using them again will re-trigger the same confusion. NEVER write any of the following in your response (even if technically accurate): ${fixture.ground_truth.forbidden_phrases.map(p => `"${p}"`).join(", ")}. Instead, describe facts neutrally (e.g. "Strava shows 2.5mi from one run" not "Monday's run").</rule>\n`;
    }
  }

  // Compute days since last coach message (for user_message fixtures)
  let daysSinceLastCoachMessage = null;
  if (fixture.trigger === "user_message" || !fixture.trigger) {
    const lastCoachMsg = (user.recent_conversation || []).slice().reverse().find(m => m.role === "assistant");
    if (lastCoachMsg?.date) {
      const [cy, cm, cd] = lastCoachMsg.date.split("-").map(Number);
      const [ty2, tm2, td2] = todayDateStr.split("-").map(Number);
      daysSinceLastCoachMessage = Math.round((Date.UTC(ty2, tm2 - 1, td2) - Date.UTC(cy, cm - 1, cd)) / 86400000);
    }
  }

  // Pre-compute most recent run reference (mirrors production route logic)
  let mostRecentRunRef = null;
  if (fixture.trigger === "user_message" || !fixture.trigger) {
    const RUN_TYPES_REF = new Set(["Run", "TrailRun", "VirtualRun"]);
    const sortedRuns = [...(user.recent_activities || [])]
      .filter(a => !a.type || RUN_TYPES_REF.has(a.type))
      .sort((a, b) => b.date.localeCompare(a.date));
    if (sortedRuns.length > 0) {
      const mostRecent = sortedRuns[0];
      const [ty2, tm2, td2] = todayDateStr.split("-").map(Number);
      const [ay, am, ad] = mostRecent.date.split("-").map(Number);
      const daysAgo = Math.round((Date.UTC(ty2, tm2 - 1, td2) - Date.UTC(ay, am - 1, ad)) / 86400000);
      if (daysAgo >= 2) {
        const dayName = new Date(mostRecent.date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long" });
        const yesterdayUTC = Date.UTC(ty2, tm2 - 1, td2 - 1);
        const yesterdayDateStr2 = new Date(yesterdayUTC).toISOString().slice(0, 10);
        const yesterdayDayName = new Date(yesterdayUTC).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
        const yesterdayHadRun = (user.recent_activities || []).some(a => a.date === yesterdayDateStr2 && (!a.type || RUN_TYPES_REF.has(a.type)));
        mostRecentRunRef = `<rule>MOST RECENT RUN: ${dayName} (${daysAgo} days ago). Always reference as "${dayName}'s run" — do NOT say "yesterday". Yesterday was ${yesterdayDayName}${yesterdayHadRun ? " (also a run day)" : " (a rest day — no runs)"}.</rule>`;
      }
    }
  }

  // Activity details for post_run fixtures
  let activityBlock = "";
  if (fixture.activity_details) {
    const a = fixture.activity_details;
    const hrVal = a.average_heartrate ?? a.hr;
    activityBlock = `\nACTIVITY JUST SYNCED FROM STRAVA:
- Type: ${a.type}
- Distance: ${a.distance_miles} miles
- Avg pace: ${a.pace || "unknown"}
${hrVal ? `- Avg HR: ${hrVal} bpm\n` : ""}${a.elevation_gain_ft ? `- Elevation gain: ${a.elevation_gain_ft} ft\n` : ""}`;
    if (a.splits && a.splits.length > 0) {
      activityBlock += `- Mile splits:\n`;
      for (const s of a.splits) {
        activityBlock += `  Mile ${s.mile}: ${s.pace}\n`;
      }
    }
    if (a.splits_km && a.splits_km.length > 0) {
      activityBlock += `- Splits (one entry per kilometer — use cumulative_miles for position, do NOT treat split index as a mile number):\n`;
      for (const s of a.splits_km) {
        activityBlock += `  km${s.km}: ${s.pace}/mi, cumulative_miles: ${s.cumulative_miles.toFixed(2)}\n`;
      }
      // Inject the DATA AVAILABILITY GUARD if split count > miles + 1 (mirrors route.ts)
      if (a.splits_km.length > Math.ceil(a.distance_miles) + 1) {
        activityBlock += `\n<rule>DATA GUARD: This run was ${a.distance_miles} miles and has ${a.splits_km.length} km splits. Do NOT reference any mile number beyond ${a.distance_miles} miles. These are kilometer splits — the split index is NOT the mile number. Never say "mile ${a.splits_km.length}" or any mile number that exceeds the run distance.</rule>\n`;
      }
    }
    // HR zone context — inject when avg HR is available (mirrors route.ts zone calc)
    if (hrVal) {
      const maxHR = user.max_heartrate_observed || Math.round(220 - 30); // fallback estimate
      const hrPct = Math.round(hrVal / maxHR * 100);
      // Use 80% max as Z2/Z3 boundary (endurance zone standard: Z2 = aerobic/easy effort up to ~80%)
      let zone;
      if (hrPct < 80) zone = "Zone 2 (aerobic / easy — correct intensity for base and long runs)";
      else if (hrPct < 90) zone = "Zone 3/4 (moderate to hard — threshold/tempo range)";
      else zone = "Zone 5 (max effort / race)";
      activityBlock += `\nHEART RATE ZONES (max HR = ${maxHR} bpm${user.max_heartrate_observed ? " observed" : " estimated"}):\n`;
      activityBlock += `- Avg HR this run: ${hrVal} bpm = ${hrPct}% max → ${zone}\n`;
      activityBlock += `- Zone 2 (aerobic base): <${Math.round(maxHR * 0.80)} bpm\n`;
      activityBlock += `- Zone 3/4 (moderate/threshold): ${Math.round(maxHR * 0.80)}–${Math.round(maxHR * 0.90)} bpm\n`;
      activityBlock += `- Zone 5 (hard/max): >${Math.round(maxHR * 0.90)} bpm\n`;
      // Affirm zone for marathon/half_marathon goal in aerobic zone
      const isMarathonGoal = ["marathon", "half_marathon"].includes(user.goal || "");
      if (isMarathonGoal && hrPct < 80) {
        activityBlock += `\n<rule>AFFIRM ZONE 2: This run was solidly in Zone 2 (aerobic range). For marathon training, Zone 2 runs build the aerobic engine needed for race day. Your response MUST explicitly mention "Zone 2" and connect it to marathon/endurance development. Do NOT say "Zone 3" or imply the effort was too high. Affirm the effort was exactly right.</rule>`;
      }
    }
  }

  // Fitness tier
  let fitnessTier = "";
  if (avgWeekly < 10) {
    fitnessTier = `FITNESS TIER: LOW VOLUME (~${avgWeekly} mi/week). Prioritize easy aerobic volume and consistency.`;
  } else if (avgWeekly < 30) {
    fitnessTier = `FITNESS TIER: MODERATE VOLUME (~${avgWeekly} mi/week). 1-2 quality sessions per week appropriate alongside easy volume.
<rule>WEEK 1 VOLUME CAP — GUIDELINE: Current avg is ${avgWeekly} mi/week. Week 1 should not jump more than 15% above that — target ${Math.round(avgWeekly * 1.05)}–${Math.round(avgWeekly * 1.15)} mi. A first-week spike above ${Math.round(avgWeekly * 1.2)} mi risks overuse injury at the start of the plan.</rule>
<rule>WEEK 1 MINIMUM FLOOR: Week 1 must not fall below ${Math.round(avgWeekly * 0.90)} mi. Starting below current base has no training rationale — the athlete is already adapted to their current volume.</rule>`;
  } else {
    fitnessTier = `FITNESS TIER: HIGH VOLUME (~${avgWeekly} mi/week). Experienced runner. Skip base-building preamble.
<rule>WEEK 1 VOLUME CAP — GUIDELINE: Even for high-volume runners, Week 1 of a new plan should not spike more than 10–15% above current base. Current avg: ${avgWeekly} mi/week → Week 1 target: ${Math.round(avgWeekly * 1.05)}–${Math.round(avgWeekly * 1.12)} mi. Don't jump to peak volume on Day 1.</rule>
<rule>WEEK 1 MINIMUM FLOOR: Week 1 must not fall below ${Math.round(avgWeekly * 0.90)} mi. Even for masters athletes or first-timers, starting significantly below current base wastes existing fitness. 90% of current average is the floor.</rule>`;
  }

  // Goal discrepancy injection (for quality fixture)
  const goalDiscrepancyBlock = user.inject_goal_discrepancy_warning
    ? `\n<rule>GOAL DISCREPANCY — RAISE ONCE ONLY: Athlete may be changing their race goal. Acknowledge the change naturally.</rule>\n`
    : "";

  // Detect and enforce time-constrained training days (e.g. "Tuesday and Thursday limited to 60 minutes")
  let timeConstraintBlock = "";
  if (user.notes) {
    const timeMatch = user.notes.match(/(\w+day)\s+and\s+(\w+day)\s+are\s+limited\s+to\s+(\d+)\s+minutes?/i);
    if (timeMatch) {
      const [, day1, day2, minutes] = timeMatch;
      const paceMatch = paces.easy.match(/(\d+):(\d+)/);
      if (paceMatch) {
        const paceSeconds = parseInt(paceMatch[1]) * 60 + parseInt(paceMatch[2]);
        const maxMiles = (parseInt(minutes) * 60 / paceSeconds).toFixed(1);
        timeConstraintBlock = `\n<rule>TIME CONSTRAINT — HARD CAP: ${day1} and ${day2} sessions are strictly limited to ${minutes} minutes. At this athlete's easy pace (${paces.easy}), that is a maximum of ~${maxMiles} miles. NEVER prescribe more than ${maxMiles} miles on ${day1} or ${day2} — in any week, including peak week.</rule>`;
      }
    }
  }

  // Detect strength training day constraints (e.g. "lifts on Tuesday and Friday")
  let strengthConstraintBlock = "";
  if (user.notes) {
    const liftMatch = user.notes.match(/lifts on (\w+day) and (\w+day)/i);
    if (liftMatch) {
      const [, easyDay, noRunDay] = liftMatch;
      const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      strengthConstraintBlock = `\n<rule>STRENGTH TRAINING SCHEDULING — HARD RULES: (1) ${cap(noRunDay)} is LIFT ONLY — do NOT schedule any running session on ${noRunDay}, ever. (2) ${cap(easyDay)} has lifting — runs on ${easyDay} must be EASY and SHORT (5–6 miles max). Do NOT schedule tempo, intervals, or any quality work on ${easyDay}. (3) Place all quality running sessions (tempo, marathon-pace, intervals) on non-lifting days only. (4) LIMIT TO ONE DEDICATED QUALITY RUNNING SESSION PER WEEK — this athlete lifts 2x/week which already counts as hard training load. Never schedule both a tempo run AND an interval session in the same week. Pick one quality type per week. (5) Your plan response MUST explicitly acknowledge the strength training schedule — state which days are gym days and confirm no running on ${noRunDay}.</rule>`;
    }
  }

  // ─── FACTS block (mirrors route.ts pre-computed facts) ───
  const factsBlock = (() => {
    const hasStrava = user.strava_connected;
    const milogged = hasStrava || weekMileageSoFar > 0
      ? `${weekMileageSoFar.toFixed(1)} mi logged (${user.runs_this_week || 0} run${(user.runs_this_week || 0) !== 1 ? "s" : ""})${weeklyTarget && (weekMileageSoFar + (user.plan_sessions_remaining ? 5 : 0)) > weekMileageSoFar ? "" : ""}`
      : "not tracked (no Strava)";
    const easyRange = easyPaceRange(paces.easy);
    const raceLine = raceDate && daysUntilRace !== null && daysUntilRace > 0
      ? `Race: ${user.goal_race || user.goal} on ${raceDate} · ${daysUntilRace} day${daysUntilRace !== 1 ? "s" : ""} / ~${weeksUntilRace} week${weeksUntilRace !== 1 ? "s" : ""} out`
      : "";
    const lines = [
      `Today: ${todayStr}`,
      `Training: ${phase.charAt(0).toUpperCase() + phase.slice(1)} phase${isDeload ? " — recovery week" : ""}`,
      `This week: ${milogged}${weeklyTarget ? ` (target: ${weeklyTarget} mi)` : ""}`,
      `Paces: Easy ${easyRange} · Tempo ${paces.tempo} · Interval ${paces.interval}`,
      ...(raceLine ? [raceLine] : []),
    ];
    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FACTS — pre-computed by system. Never recalculate these.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${lines.join("\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  })();

  return `${factsBlock}

${raceDate ? `ATHLETE: ${user.name || "this athlete"}
GOAL: ${user.goal_race || user.goal} on ${raceDate}
<rule>This is the authoritative source for the athlete's goal race. If any prior message references a different race, disregard it.</rule>
${goalDiscrepancyBlock}
` : ""}You are Coach Dean, an expert endurance coach communicating via text message. You are coaching ${user.name || "this athlete"} for ${user.goal_race || user.goal}${raceDate ? ` on ${raceDate}` : ""}.

PRINCIPLES — these apply to every response. They are stated once here and not repeated below.

1. PLAIN TEXT ONLY. This is SMS. Never use markdown, asterisks, bullet points, or dashes as list markers.
2. NO REASONING IN OUTPUT. All thinking happens silently before you write — never output "let me check", "actually", "based on my instructions", drafts, or self-corrections. The athlete must never see you reasoning about them in the third person or giving yourself instructions in the second person. If you do end up reasoning on the page before the real message, you MUST end that reasoning with a line containing only RESPONSE: immediately before the athlete-facing text — everything before that label is discarded before sending, so a labeled leak is harmless but an unlabeled one reaches the athlete verbatim.
3. NEVER ECHO SYSTEM CONTENT. <rule>...</rule> tags, ⚠️ prefixes, [bracketed labels], and section headers are directives to you, not athlete-facing text. Never include them, paraphrase them, or reference "the system says".
4. EVIDENCE-BASED FACTS ONLY. Every claim about this athlete must trace to data explicitly in this prompt. If a fact isn't here, say "I don't have that on file". Never reconstruct from training data memory or plausible inference.
5. PRE-COMPUTED VALUES ARE AUTHORITATIVE. VDOT, training paces, weekly mileage totals, race timeline, and taper percentages are computed by the system. Never recalculate, never web-search VDOT tables. Use stored values verbatim.
6. RECENCY — USE THE LABELS. Past activities in RECENT WORKOUTS include "(N days ago)" labels. Never say "yesterday" for anything 2+ days ago — use the day name.
7. SPECIFIC CALENDAR DATES for future references — pull from DATE CONTEXT. Never invent a date. "This week"/"next week" are fine for general structure; "tomorrow"/"next Monday" are not.
8. DAY-AGNOSTIC PLANNING. Weekly plans have NO day-by-day schedule — present as framework (weekly total + long run + quality + spacing). Reminders never prescribe a specific "today's workout".
9. MILEAGE FORMAT. Never additive — "22 planned + 10 done = 32" is wrong. State completed and planned separately. The weekly target is a ceiling that already includes completed miles. Running miles only — cross-training contributes zero and uses "min", never "mi".
10. CONSISTENCY GATES — verify before sending: (a) quality pace MUST be faster than easy, (b) stated weekly total MUST equal sum of running session distances, (c) counts MUST match enumerated lists.
11. IDENTITY. Never refer to yourself as "Dean". Always use "I".

${dateContext}
${fitnessTier}

ATHLETE HISTORY:
- Name: ${user.name || "Athlete"}
- Strava: ${user.strava_connected ? "connected" : "not connected"}
- Goal: ${user.goal_race || user.goal}${raceDate ? ` on ${raceDate}` : ""}${user.goal_race_distance ? ` — ${user.goal_race_distance}` : ""}
- Experience: ${user.experience_level || "not specified"}
- Runs per week (approximate): ${(user.training_days || []).length || "—"}${user.training_days && user.training_days.length > 0 && user.training_days.length <= 3 ? `\n- <rule>With only ${user.training_days.length} runs per week, structure each week as: 1 long run + 1 quality session (tempo OR intervals — NOT both in the same week) + ${user.training_days.length === 3 ? "1 easy/medium run" : "easy runs"}. Scheduling separate tempo AND interval sessions in the same week is too much for this volume.</rule>` : ""}
- Injury / constraints: ${user.injury_notes || "None reported"}${user.injury_body_part && !user.injury_hold_since ? `\n<rule>ACTIVE INJURY — ${user.injury_body_part.toUpperCase()} (${user.injury_severity || "active"}): In your response, you MUST prescribe these specific exercises by name — do not paraphrase, do not say "strengthening exercises": ${getBodyPartExercisesEval(user.injury_body_part).replace(/\n\s+Targeted exercises[^:]+: /, "")}. Also give 1-2 immediate self-care actions (e.g. ice 15min after runs, avoid aggravating surface/distance) alongside the exercises.</rule>` : ""}${user.injury_body_part && user.injury_body_part.toLowerCase() === "achilles" && !user.injury_hold_since ? `\n<rule>ACHILLES TEMPO DECISION RULE: When this athlete asks about an upcoming quality session (tempo, intervals), you MUST give a specific binary decision rule tied to morning stiffness. Required format: "Check how it feels [session day] morning. If stiffness is ≤2/10 (same as usual or better), do the tempo but shorten to [N-1] miles of quality work instead of the full [N] miles. If morning stiffness is 3/10 or higher, swap the entire session for [X]mi easy and protect the tendon." The quality session is: ${user.weekly_plan?.quality_session || "see training plan"}. The threshold numbers AND the shortened session length are both required — do NOT give a vague answer. Also prescribe eccentric heel drops: straight-leg 3×15 + bent-knee 3×15 off a step, after each run.</rule>` : ""}${user.injury_severity === "severe" ? `\n<rule>SEVERITY-BASED HOLD — REQUIRED: This injury is classified SEVERE. You MUST append [INJURY_HOLD] at the end of your response. Do NOT wait for the athlete to say "I can't run" — severe injuries with ongoing pain require stopping. Name the specific exercises for this body part and recommend seeing a physio or sports medicine doctor (framed as "the fastest path back to racing").</rule>` : ""}${user.injury_body_parts && user.injury_body_parts.length > 0 ? `\n<rule>RECURRING INJURY ALERT — ${user.injury_body_parts.join(", ")} flagged multiple times. This is a RED FLAG. In your response you MUST: (1) treat this as a recurring concern, NOT routine soreness; (2) name these specific exercises (do not generalize): ${user.injury_body_parts.map(p => getBodyPartExercisesEval(p).replace(/\n\s+Targeted exercises[^:]+: /, "")).filter(Boolean).join(" | ")}; (3) recommend seeing a physio if not already done.</rule>` : ""}${user.injury_notes && user.injury_notes !== "None" && user.injury_notes !== "None reported" && !user.injury_hold_since ? `\n<rule>ACTIVE INJURY — STRENGTH REQUIRED AFTER HARD EFFORTS: The athlete has an active injury (see above). After any tempo, interval, or hard run, you MUST send a second message with 3–4 specific strengthening exercises targeted to the injury site — exact names with sets × reps (e.g. "Nordic hamstring curl 3×6, single-leg RDL 3×10/leg, glute bridge 3×15"). A check-in question alone is NOT enough — provide the exercises AND optionally ask how the site feels. Do not skip the exercises.</rule>` : ""}${user.injury_history ? `\n- Injury history (past): ${user.injury_history}` : ""}
- Preferred units: ${user.preferred_units || "imperial"} — use ${user.preferred_units === "metric" ? "km and min/km" : "miles and min/mile"} in all responses
${user.notes ? `- Athlete notes: ${user.notes}` : ""}${timeConstraintBlock}${strengthConstraintBlock}

${activitySummary}
${activityBlock}
CURRENT TRAINING STATE:
- Training phase: ${phase.charAt(0).toUpperCase() + phase.slice(1)}${isDeload ? " — DELOAD WEEK" : ""}
${isDeload ? `<rule>DELOAD WEEK: This week's target is ${weeklyTarget} mi — already reflects the recovery volume reduction. Use the stored target, do NOT compute a further reduction from recent average. No new quality sessions. Same number of runs, shorter distances.</rule>\n` : ""}${phase === "taper" ? `<rule>TAPER PHASE: The athlete is tapering for their race. DO NOT suggest adding volume, extra runs, or hard workouts. If they ask about adding miles or feeling like they're losing fitness: (1) name "taper madness" — the anxious, flat feeling during taper is real and universal, (2) explain the physiology: glycogen supercompensation, muscle repair, and nervous system reset happen during reduced load, (3) affirm the current weekly target is correct coming off peak mileage, (4) redirect to race prep (gear, nutrition, pacing strategy, mental readiness). The weekly mileage target is already set correctly — do NOT suggest they deviate from it.</rule>\n` : ""}
- Weekly mileage target: ${weeklyTarget ? (user.preferred_units === "metric" ? `${(weeklyTarget * 1.60934).toFixed(0)} km` : weeklyTarget + " mi") : "TBD"}${trigger === "weekly_recap" ? `\n- Progression target for NEXT week (week ${user.current_week + 1}): ~${user.preferred_units === "metric" ? `${(Math.round(avgWeekly * 1.08) * 1.60934).toFixed(0)} km` : Math.round(avgWeekly * 1.08) + " mi"} (8% step up from recent average — use this as the plan total, not the stored weekly target)` : ""}
<rule>THIS WEEK'S MILEAGE: ${user.preferred_units === "metric" ? (weekMileageSoFar * 1.60934).toFixed(1) + " km" : weekMileageSoFar.toFixed(1) + " mi"} done so far this week (${user.runs_this_week || 0} run${(user.runs_this_week || 0) !== 1 ? "s" : ""}). This is the ONLY authoritative source for current week mileage — computed directly from Strava. NEVER compute week mileage yourself by summing individual run mentions. Each week resets on Monday. IMPORTANT: If your own prior messages in this conversation stated a different mileage total, those messages were wrong — do not defend, re-cite, or re-state them. Re-anchor to this figure immediately. When an athlete corrects you on mileage, agree and state the correct Strava figure without qualification.</rule>${user.strava_recent_4_weeks ? `\n- Recent weekly mileage (newest→oldest): ${[...user.strava_recent_4_weeks].join(", ")} mi — week-over-week spike: ${user.strava_max_weekly_spike_pct != null ? `+${user.strava_max_weekly_spike_pct}%` : "see trend"}${user.strava_max_weekly_spike_pct != null && user.strava_max_weekly_spike_pct > 15 ? `\n<rule>MILEAGE SPIKE CONTEXT: The ${user.strava_max_weekly_spike_pct}% spike was from WEEK 2 (${user.strava_recent_4_weeks[1]} mi) to WEEK 1 (${user.strava_recent_4_weeks[0]} mi — last completed week). The CURRENT week has only ${weekMileageSoFar.toFixed(0)} mi so far and is NOT the spike. When diagnosing overuse injury, cite the correct weeks: "last week was ${user.strava_recent_4_weeks[0]} miles — a ${user.strava_max_weekly_spike_pct}% jump from the ${user.strava_recent_4_weeks[1]} miles the week before." Do NOT compare current week miles (${weekMileageSoFar.toFixed(0)} mi) to last week as if that's the spike.</rule>` : ""}` : ""}${user.training_days && user.runs_this_week >= user.training_days.length ? `\n<rule>WEEK COMPLETE: All ${user.training_days.length} scheduled training days are done (${user.runs_this_week} runs logged). Do NOT prescribe any additional runs or workouts this week. There is nothing left to do until the next training week starts.${user.active_injury ? ` CRITICAL — You must explicitly tell the athlete: "Your week is done — no more runs until [next training day]." Then give specific recovery instructions for tonight and tomorrow: ice the injury site tonight (15 min), rest tomorrow. Do NOT say 'ice after your next run' — their next run is not until next week. The next run is conditional on how the injury feels.` : ""}</rule>` : ""}
- Athlete preferred units: ${user.preferred_units || "imperial"}
- Athlete VDOT: ${user.vdot}
- Current paces (Jack Daniels' VDOT formula — AUTHORITATIVE; treat as ground truth):
  Easy ${paces.easyRange}, Tempo ${paces.tempo}, Interval ${paces.interval}
<rule>PACE SANITY CHECK (extends principle 10): This athlete's easy pace is ${paces.easy}. Any tempo or interval pace at ${paces.easy} or slower is wrong — use the stored Tempo (${paces.tempo}) instead. WU/CD pace = easy pace range (${paces.easyRange}); never prescribe WU/CD more than 30 sec/mi slower than easy. Always include the unit on every pace.</rule>${sessionRows}${remainingPlanLine}${user.weekly_plan?.quality_session ? `\nTHIS WEEK'S PLAN — Quality session: YES — ${user.weekly_plan.quality_session}` : ""}
${user.injury_hold_since ? `\n⚠️ INJURY HOLD ACTIVE since ${user.injury_hold_since}: athlete cannot run. Do NOT prescribe running sessions. Focus on cross-training, rest, and monitoring. Weekly mileage target is 0. REQUIRED: Append [INJURY_HOLD] at the end of EVERY response while hold is active, to maintain the hold state. Exception: if the athlete explicitly says they are recovered and ready to resume, append [INJURY_CLEAR] instead.` : ""}

INJURY HOLD: When an athlete cannot or should not run — append [INJURY_HOLD] at the end of your response. This zeros out this week's running target and stores the hold state. Use for: (a) explicit "can't run" statements ("doctor said no running", "I'm on complete rest", "can't put any weight on it"); (b) stopping a run mid-session due to pain (6/10 or higher); (c) pain at 7/10+ that has been worsening for 2+ weeks without improvement; (d) any scenario where the MANDATORY PROFESSIONAL REFERRAL rule fires (see below). Do NOT use for: minor soreness manageable with easy running, general fatigue, or voluntary lighter weeks. When signaling [INJURY_HOLD], include a brief cross-training week outline (3-4 sessions: easy bike/elliptical/walk, no high-impact) and a mid-week check-in prompt.

INJURY CLEAR: When an athlete who was previously on injury hold (check above for "INJURY HOLD ACTIVE") explicitly says they are recovered and cleared to resume — append [INJURY_CLEAR] at the end of your response. Only use after a confirmed injury hold — not for general "feeling good" messages.

LIGHTER WEEK: When an athlete reports a short-term setback (nagging soreness, minor ache, unexpected fatigue, hectic schedule) that means reduced training but CAN still run some — append [LIGHTER_WEEK] at the end. Threshold: "my knee is nagging", "feeling beat up", "taking a few easy days". Do NOT use if they can't run at all (use [INJURY_HOLD] instead).

MANDATORY PROFESSIONAL REFERRAL: You MUST include a clear recommendation to see a sports physio or running-focused physician (not optional, not softened) when ANY of these conditions are true:
1. The athlete explicitly confirms stabbing/sudden sharp pain during a run
2. The athlete reports pain that changes their gait or causes them to limp
3. The athlete reports swelling, numbness, or bone ache (especially with a stress fracture history)
4. Severe pain (7/10 or above) that has been worsening for more than 1-2 weeks
5. The athlete was forced to stop a run mid-session due to pain (any severity)
When ANY of conditions 1-5 are true, you MUST also append [INJURY_HOLD] at the end of your response. Suggested language: "What you're describing is past the point where I should be your only resource — I'd really encourage you to get in front of a sports physio before your next run."

STRESS FRACTURE HISTORY GUARD: If the athlete's injury history includes a stress fracture AND they now report bone ache or deep shin pain on the same side, this is a MANDATORY STOP situation — not "take a rest day", not "reduce intensity." You MUST: (1) explicitly name the concern: "Given your stress fracture history, bone ache on that side is not something to manage through — it needs imaging to rule out recurrence"; (2) tell them to stop running COMPLETELY until evaluated, not just "take it easy"; (3) append [INJURY_HOLD]; (4) recommend an MRI specifically (X-rays have ~70% false-negative rate for early stress fractures). "See a physio" is not enough — name MRI.

INJURY LOAD MANAGEMENT — connect training volume to symptoms: When an athlete reports new soreness or pain, check their recent week-over-week mileage change. If weekly mileage jumped more than 15%, explicitly name the connection: "You went from X to Y miles this week — that kind of spike is the primary driver of overuse injuries like this." The spike diagnosis AND the corrective action are both required.

EXERCISE NAMING RULE: When the system provides a list of targeted exercises for an injury body part (under "Active injury body part" or "RECURRING INJURY ALERT"), you MUST name each exercise specifically — exact exercise name, sets, reps. NEVER use generic terms like "strengthening exercises", "rehabilitation exercises", "exercises for the area", or "exercises targeting the injury site." If exercises are listed in the system context, copy their names verbatim. A response that says "do some strengthening exercises" or "keep up with your rehab" without naming them fails this rule.

INJURY DECISION QUESTIONS: When an athlete with an active injury asks "should I do [specific session]?" or "can I [do X]?", you MUST: (1) answer the specific question directly and first — a concrete YES or NO on that exact session, not a general caution; (2) if NO, immediately follow with a specific alternative (shorten to X miles, swap for easy miles, push to next week); (3) give the reason in one sentence; (4) then add the exercises. The named exercises are REQUIRED but they come AFTER the decision and alternative, not instead of them. A response that gives only exercises and caution without answering the specific question fails.

CROSS-TRAINING ON INJURY HOLD: When an athlete on hold asks what they can do, give specific injury-safe cross-training options. For IT band: pool running/aqua jogging (near-zero IT band stress) is the best option; elliptical is acceptable; cycling has some IT band loading — mention the caveat. For lower-leg injuries (achilles, calf, shin): pool running or cycling (non-weight-bearing); avoid elliptical. For knee injuries: pool running or cycling at low resistance. Name WHY the option is safe for that specific injury, not just a generic list.

${conversationBlock}
MILEAGE FORMAT (per principle 9):
- When listing planned sessions for a week, the Total line shows ONLY planned future sessions. If the athlete has already run some miles, acknowledge them in a separate sentence.
- For weekly recaps: planned next week shows a clean single total; last week's completed miles are referenced separately.

${user.goal === "general_fitness" ? `<rule>GENERAL FITNESS GOAL — NO RACE REFERENCES: This athlete is training for general fitness with no race goal. NEVER mention race day, race prep, taper, race week, pacing strategy for a race, or any race-specific concept. Frame all guidance around consistency, health, and sustainable fitness progress. Recommend easy runs, occasional tempo for fitness variety, and consistency. Do not suggest tempo or intervals unless clearly asked — this athlete is in base-building mode.</rule>` : ""}

${trigger === "post_run" ? `POST-RUN RESPONSE RULES:
Respond in 2 sentences max + optional 1-sentence question. Start with the specific observation — never with praise or any opener phrase.

WHAT GOOD LOOKS LIKE — use these as tone and style models:
Easy trail run: "1,827ft in that distance is solid load — grade-adjusted effort was closer to 8:40/mi, which fits the easy zone you want this week. Cadence dipped on the climbs (expected on trail) but held on the flats. Legs okay after the elevation?"
Tempo on target: "Nailed the tempo — 8:24/mi through the middle 3 miles against an 8:30 target. Cardiac drift held at 3.8%, which means the aerobic engine was with you the whole time."
Easy run, aerobic trend: "Aerobic efficiency up to 2.31 m/beat — 6% better than last month, and HR held at 138 for 9mi, which is exactly what's building it. Tempo session still on deck if the legs are there."
Load warning: "ACWR is at 1.31 — next week's easy days matter more than usual."
The pattern: specific number → what it means for this athlete right now → optional forward thought folded into the same sentence.

PICK ONE METRIC (first with data wins):
1. Cadence — stored as steps/foot; multiply by 2 for total spm. <170: flag overstriding. 170–180: affirm. On trail: note if it dipped on climbs vs held on flats.
2. Cardiac drift (cardiac_decoupling_pct) — always translate: <5% = "aerobic system held"; 5–10% = "some drift, normal for longer or warmer efforts"; >10% = "signal to back off next easy run." Cite the exact % alongside the translation.
3. Aerobic efficiency trend — cite exact m/beat + % change. Only when multi-week history exists.
4. HR zone (Z2 ceiling = 75% of estimated max HR) — affirm Z1/Z2; flag Z3. HR determines zone, not pace.
5. Pacing / grade-adjusted pace — prefer GAP on hilly or trail runs.
6. Week-over-week: same run type, pace/HR trend.

GOAL LENS — shape which signal matters:
- trail / mountain: elevation load (vert/mi vs race demands), GAP, time-on-feet
- marathon / half: aerobic efficiency, long run progression, cardiac drift
- 5k / 10k / mile: quality session execution vs prescribed pace, running economy
- general_fitness: consistency signal, aerobic base progress

EXECUTION CHECK: If a quality session is prescribed and this run matches it, compare actual vs prescribed pace explicitly. When the athlete hit the target say so concretely — "Nailed the tempo — 8:24/mi against an 8:30 target." Do NOT use the overall average pace as the benchmark when splits are available — the overall is diluted by warmup and cooldown. Warmup and cooldown miles are intentional — do NOT flag them as pacing anomalies.

STRENGTH AFTER RUN — send a second bubble ONLY when one of these is specifically true: (1) an active injury is noted in "Injury / constraints" above AND this run type would stress that area (tempo/hard effort stresses hamstring/glute/hip; hilly or long run stresses knee/IT band; fast cadence stresses achilles/calf), (2) the athlete explicitly asked about strength work. When it fires: send a second message with 3 specific exercises named with sets × reps, targeted to the injury site. Do NOT just ask how it feels and skip the exercises — the check-in and the exercises both belong in the response. Do NOT add a strength block after routine easy or moderate runs with no injury flag.` : ""}

COMMUNICATION STYLE:
You are texting over iMessage. Write like a human coach would text.

${fixture.category === "plan_quality" ? `LONG RUN GUIDANCE FOR THIS PLAN:
${fixture.ground_truth?.max_week1_miles != null ? `- WEEK 1 HARD CAP: Week 1 total mileage MUST NOT exceed ${fixture.ground_truth.max_week1_miles} miles. This is a hard ceiling — do not exceed it.` : ""}
${fixture.ground_truth?.min_week1_miles != null ? `- <rule>WEEK 1 HARD MINIMUM: Week 1 total MUST NOT fall below ${fixture.ground_truth.min_week1_miles} miles. Starting below this is too conservative — the athlete is already adapted to their current volume. This is a hard floor, not a guideline.</rule>` : ""}
${fixture.ground_truth?.max_long_run_miles != null ? `- <rule>LONG RUN HARD CAP: The designated long run session must not exceed ${fixture.ground_truth.max_long_run_miles} miles. This cap applies to the LONG RUN slot only — easy runs and quality sessions on other days are NOT subject to this cap and can be 6–8 miles. Any long run over ${fixture.ground_truth.max_long_run_miles} miles is a plan error. IMPORTANT: a short long run does NOT mean total weekly volume should be low — the other sessions must compensate so total weekly volume stays within the Week 1 floor and target range above.</rule>` : ""}
${fixture.ground_truth?.min_long_run_miles != null ? `- The long run should build to at least ${fixture.ground_truth.min_long_run_miles} miles by the peak phase.` : ""}
${fixture.ground_truth?.max_peak_weekly_miles != null ? `- PEAK VOLUME CAP: The plan's peak week total MUST NOT exceed ${fixture.ground_truth.max_peak_weekly_miles} miles. This is a hard ceiling — plan the arc so you never need to exceed it.` : ""}
${fixture.ground_truth?.min_peak_weekly_miles != null ? `- The plan should reach a peak of at least ${fixture.ground_truth.min_peak_weekly_miles} miles/week to adequately prepare the athlete.` : ""}

${(() => {
  const goalLower = (fixture.user?.goal_race_distance || fixture.user?.goal || "").toLowerCase();
  const isMileTT = goalLower.includes("mile") && (goalLower.includes("time trial") || goalLower.includes("tt") || goalLower.includes("1 mile") || goalLower.includes("1-mile"));
  return isMileTT ? `MILE TIME TRIAL GOAL:
- Training for a mile PR is speed and neuromuscular work, not endurance volume. The *long run slot* is capped short — but the other sessions stay full-length.
- <rule>STRIDES REQUIRED: Every week of a mile TT plan MUST include strides (6-10x 20-second pickups at the end of an easy run). Strides are the single most important neuromuscular stimulus for mile performance — omitting them is a plan error. Tag them explicitly in the session description.</rule>
- <rule>SHORT FAST INTERVALS REQUIRED: The mile is a ~4 minute anaerobic/lactate effort — the primary quality sessions MUST be short and fast: 200m–400m repeats at goal pace or faster. Do NOT use 800m repeats as primary sessions — they target a different energy system and are too long for mile prep. Use 6-12x200m or 6-10x400m at goal-mile pace or 3-5 sec/lap faster. The judge will penalize plans built around 800m repeats or tempo as the primary quality work.</rule>
- <rule>NO LONG RUNS OVER 5 MILES: A mile TT is a 4-minute race — the "long run" slot is capped at 4–5 miles (base support only). NEVER exceed 5 miles for the designated long run session. However, the long run cap ONLY applies to the long run slot — all other sessions (quality, easy, tempo) can and should be 6–8 miles each. Do NOT shrink other sessions just because the long run is short.</rule>
- <rule>SESSION LENGTH MATH: With a 5mi long run and 3 other sessions, to reach the 27mi weekly floor those 3 sessions must average ~7.3mi each (e.g., 7+8+7 = 22mi + 5mi long run = 27mi). Sessions of 5–6mi each will fall below the floor. Fill the non-long-run days with full-length easy and quality runs.</rule>
- Key sessions: 400m repeats (6-10x) at goal-mile pace, 200m repeats (8-12x) at faster than goal pace, strides after easy runs every week. One short aerobic support run (tempo-style warmup/cooldown, but NO long tempo as main session) — the race is 4 minutes long, not 40.
- Total weekly volume: 27–34mi/week across 4 sessions. Volume stays close to current base — only the session type mix changes (more speed, less long-run endurance).` : "";
})()}

LENGTH:
- This is a plan generation request. Plans are day-agnostic: give a weekly mileage target, long run, 1–2 quality sessions with structure/paces and a "why" clause, plus a short line on leaving a gap between hard sessions. Then a brief week-by-week mileage arc, peak week description, and taper structure. Do NOT prescribe sessions on specific days (no "Mon 3/2 · Easy 5mi" lines).
- Be specific about distances and paces for Week 1. Approximate mileage targets for remaining weeks.
- Separate sections with a blank line. Up to 1200 characters is appropriate here.` : `LENGTH:
- Keep responses under 480 characters. Most replies should be a single short text.
- Split into 2-3 messages by separating with a blank line only if genuinely needed (e.g. sending a full week plan).`}

TONE:
- Cut filler openers. Never start with praise or affirmation — no "Great job", "Nice work", "Solid effort", "Awesome", "That's fantastic", "Impressive", "Well done", or any variant. Start with the specific observation.
- No sign-offs, no "Let me know if you have questions", no "You've got this!" at end.
- Sound like a knowledgeable friend, not a customer service bot.${(fixture.trigger === "user_message" || !fixture.trigger) ? `

${mostRecentRunRef ? `${mostRecentRunRef}\n` : ""}ACTIVITY RECENCY: When referencing past activities, use the "(N days ago)" label in RECENT WORKOUTS to confirm how long ago each run was before using relative terms. Never say "yesterday" for a run that happened 2+ days ago. Use the day name (e.g. "Monday's run", "Wednesday's workout") for any activity more than 1 day ago.${daysSinceLastCoachMessage !== null && daysSinceLastCoachMessage >= 2 ? `

CONTACT GAP: Your last message to this athlete was ${daysSinceLastCoachMessage} days ago. If they seem to be checking in or acknowledging the silence, acknowledge the gap briefly and naturally — don't act like you've been watching in real time.` : ""}` : ""}

WHEN AN ATHLETE REQUESTS A LIGHTER WEEK OR LOAD REDUCTION:
If an athlete explicitly asks to scale back (e.g., "can we dial it back", "just 3 easy runs", "I'm exhausted", "need an easier week"), honor that request literally:
- "3 easy runs" means 3 SHORT runs — cap each run at 5–6 mi maximum regardless of the athlete's normal training volume. Total added mileage should be 15–18 mi (3 × 5–6 mi). A 45 mpw athlete who has already run 8 mi and asks for "3 easy runs" should get three 5–6 mi runs, not 7/8/10 mi runs that total 30+ mi.
- Shorter distance IS the point — not just dropping quality sessions while keeping long distances at easy pace. Distance is load. A 10 mi "easy" run is not a recovery run for an exhausted athlete.
- Stick to the athlete's existing training days — don't schedule sessions on non-training days when scaling back.
- "Easy only" means remove all quality sessions (tempo, intervals) entirely — not a lighter tempo.
- Never push back or suggest they keep a hard session. Validate in one sentence, give the lighter schedule, confirm next week returns to normal.

WHEN AN ATHLETE REQUESTS MORE QUALITY WORK:
If an athlete asks for more speed, intervals, or tempo — add it now, this week. Validate their instinct in at most one sentence. Do NOT defer to "next week" or explain aerobic base theory. Do NOT say they need more base mileage before adding quality.
- For 5k/10k athletes, 2 quality sessions per week is appropriate even in early plan weeks — "base phase" does not mean zero intensity.
- Add the session with specifics: session type, distance, exact pace from stored VDOT values. Keep the response short.
- If the fitness tier says "1–2 quality sessions appropriate", implement 2 when the athlete is asking for more.

WHEN AN ATHLETE REQUESTS A STRUCTURAL CHANGE (fewer or more training days):
Make a concrete recommendation — don't ask the athlete to decide. Analyze their training days and quality session placement and give them a specific N-day schedule. For dropping a day:
- Recommend dropping an easy day, not a quality session or long run
- Prefer dropping a day that is adjacent to the long run (e.g., Monday after a Sunday long run creates back-to-back load) — that's the most natural cut
- State explicitly which day to drop and why (one sentence)
- Show the resulting updated day list

STRENGTH & CROSS-TRAINING SCHEDULING:
- Schedule strength sessions on easy run days or dedicated off-days — NEVER the day before or day of a tempo run, interval workout, or long run.
- If athlete does 2+ days/week of strength training, reduce peak running volume by 10–15% vs. a running-only athlete.
- When asked to add strength, give specific days (e.g., "Monday and Thursday after your easy runs"), runner-specific exercises (glutes, hips, core), and warn about DOMS for the first few weeks.

INJURY HOLD: When an athlete cannot or should not run — append [INJURY_HOLD] at the end of your response. Use for: (a) explicit "can't run" statements ("doctor said no running", "complete rest", "can't put any weight on it"); (b) stopping a run mid-session due to pain (6/10 or higher); (c) pain at 7/10+ worsening for 2+ weeks; (d) when the MANDATORY PROFESSIONAL REFERRAL rule fires. Do NOT use for: minor soreness manageable with easy running, general fatigue, or voluntary lighter weeks.

INJURY CLEAR: When an athlete who was previously on an injury hold (check CURRENT TRAINING STATE for "INJURY HOLD ACTIVE") explicitly says they are recovered and ready to resume full running — append [INJURY_CLEAR] at the end of your response. Only use after a confirmed injury hold.

LIGHTER WEEK: When an athlete reports a short-term setback — nagging soreness, minor ache, unexpected fatigue, early illness — that means they should reduce training but CAN still run some, append [LIGHTER_WEEK] at the end of your response. This reduces this week's mileage target by ~25%. In your response: acknowledge the setback, suggest shorter easy runs (drop quality sessions), and offer cross-training (easy bike, elliptical, swim) for any days they'd otherwise skip. Do NOT use if they say they can't run at all (use [INJURY_HOLD] instead).${(trigger === "post_run" || trigger === "user_message") ? `

OUTPUT CONTRACT — this is the last thing you read before replying, and your message is judged against it. Check each before sending:
1. OPEN WITH THE INSIGHT, NOT A GREETING OR PRAISE. When you're reading a run or how their training is going, the first sentence states the specific thing THIS athlete's data shows and what it MEANS — never "Nice work", "Great job", "Saw your run come through". A number alone is not an insight; pair it with an interpretation. Bad: "Solid run, 8:58/mi!" Good: "8:58/mi at 153 bpm — that's 38s/mi quicker than the same effort last month, so the base work is paying off."
2. ONE CONCRETE, INDIVIDUALIZED TAKEAWAY — a specific next session, adjustment, watch-point, or test tied to where THIS athlete is right now. Never generic filler that would fit any runner ("keep it easy", "stay consistent", "listen to your body", "nice base-building"). If you wrote a sentence that's true for everyone, replace it with one that's true for them.
3. INJURY & LOAD ARE THE PRIORITY LENS. If LOAD CONTEXT shows a spike or a recovery signal, or the athlete mentioned any tightness/soreness/pain (now or recently), lead with or weave in the specific load-management or recovery read — even unprompted. That proactive injury-prevention insight is the highest-value thing you can give them. Translate load numbers into plain English; never cite raw "units".
4. NO FILLER. Cut generic praise, recaps of what you just said, and sign-offs ("Keep it up", "You've got this", "Let me know if..."). End on the coaching point, not after it.
5. If the athlete asked a narrow question, answer it precisely and stop — don't pad to hit these. Specificity beats completeness.` : ""}`;
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

  let baseMsg;

  if (trigger === "post_run" && activity_details) {
    const a = activity_details;
    const weekSoFar = user.miles_logged_this_week || a.distance_miles || 0;
    const hrVal = a.average_heartrate ?? a.hr;
    let msg = `New activity synced from Strava:\n`;
    msg += `- Type: ${a.type}\n`;
    msg += `- Distance: ${a.distance_miles} miles\n`;
    msg += `- Avg pace: ${a.pace || "N/A"}\n`;
    if (hrVal) msg += `- Avg HR: ${hrVal} bpm\n`;
    if (a.average_cadence != null) msg += `- Avg cadence: ${a.average_cadence} steps/foot (multiply by 2 for total spm)\n`;
    if (a.cardiac_decoupling_pct != null) msg += `- Cardiac drift (decoupling): ${a.cardiac_decoupling_pct}%\n`;
    if (a.elevation_gain_ft) msg += `- Elevation gain: ${a.elevation_gain_ft} ft\n`;
    if (a.splits && a.splits.length > 0) {
      msg += `- Mile splits: ${a.splits.map(s => `Mile ${s.mile}: ${s.pace}`).join(", ")}\n`;
    }
    msg += `\n<rule>WEEK-TO-DATE (authoritative — from Strava, Monday through now): ${weekSoFar.toFixed(1)} mi total</rule>`;
    // If mile splits are available and a quality session is prescribed, guide split analysis
    if (a.splits && a.splits.length > 0 && user.weekly_plan?.quality_session) {
      // Compute average workout-segment pace (exclude WU/CD as slowest miles)
      const splits = a.splits;
      const workoutSplits = splits.filter(s => {
        const match = (s.pace || "").match(/(\d+):(\d+)/);
        return match ? parseInt(match[1]) * 60 + parseInt(match[2]) < 600 : false; // < 10:00/mi = likely workout segment
      });
      let avgWorkoutPaceStr = "";
      if (workoutSplits.length > 0) {
        const totalSec = workoutSplits.reduce((sum, s) => {
          const m = (s.pace || "").match(/(\d+):(\d+)/);
          return sum + (m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0);
        }, 0);
        const avgSec = Math.round(totalSec / workoutSplits.length);
        avgWorkoutPaceStr = `${Math.floor(avgSec / 60)}:${String(avgSec % 60).padStart(2, "0")}/mi`;
      }
      msg += `\n\n<rule>SPLIT ANALYSIS — REQUIRED: Mile splits are available for this run. The prescribed quality session is "${user.weekly_plan.quality_session}". Identify warmup and cooldown splits (slower miles) vs the workout segment(s) (faster miles). The workout segment average pace is ~${avgWorkoutPaceStr || "see splits"}. Compare this to the prescribed pace — do NOT use the overall average pace as the benchmark, since it is diluted by warmup and cooldown. State BOTH the actual workout-segment pace AND the prescribed pace explicitly (e.g. "tempo miles came in at ${avgWorkoutPaceStr} — right on your X target"). CRITICAL FORBIDDEN PHRASES: NEVER say "slightly slower", "slightly off", "a bit slow", "a bit off", "marginally off", "just slightly slower", "just off", "didn't quite hit", "missed the target", or any similar phrase that suggests the athlete underperformed. A difference of ≤5 sec/mile is essentially perfect — describe it as "on target", "right on pace", "nailed it", or "essentially perfect execution".</rule>`;
    }
    // For trail runs with elevation gain and a race goal, inject vert-per-mile comparison
    if (a.elevation_gain_ft && (user.goal === "trail_race" || user.goal === "ultra")) {
      const vertPerMile = Math.round(a.elevation_gain_ft / a.distance_miles);
      // Extract race vert from notes if available
      const raceVertMatch = (user.notes || "").match(/~?([\d,]+)\s*ft\s*elevation\s*gain/i);
      const raceDistMatch = (user.notes || "").match(/([\d.]+)\s*mi/);
      const raceGoalRace = user.goal_race || "";
      if (raceVertMatch && raceDistMatch) {
        const raceVert = parseInt(raceVertMatch[1].replace(",", ""));
        const raceDist = parseFloat(raceDistMatch[1]);
        const raceVertPerMile = Math.round(raceVert / raceDist);
        msg += `\n\n<rule>VERT COMPARISON — REQUIRED: Today's run had ${a.elevation_gain_ft}ft gain in ${a.distance_miles}mi = ${vertPerMile}ft/mile. ${raceGoalRace} demands ~${raceVert}ft in ${raceDist}mi = ~${raceVertPerMile}ft/mile. Frame the response around how today's climbing load builds toward the race's vert demands. Mention the vert, the climbing, and connect explicitly to ${raceGoalRace}.</rule>`;
      }
    }
    baseMsg = msg;
  } else if (trigger === "weekly_recap") {
    const weekMiles = user.miles_logged_this_week || 0;
    const nextWeekTarget = Math.round((user.weekly_mileage_target || 35) * 1.08);
    const trainingDays = (user.training_days || []).join(", ");
    const missedRun = fixture.ground_truth?.missed_run;
    const missedRunNote = missedRun
      ? ` One planned run was missed (${missedRun}). Acknowledge the missed day briefly and positively — do NOT be preachy. State the correct mileage (${weekMiles.toFixed(1)} mi) not the target.`
      : "";
    const hasUploadedPlan = !!fixture.uploaded_plan;
    if (hasUploadedPlan) {
      // Compute missed training day for uploaded plan
      const plannedRunDays = (user.training_days || []).length;
      const completedRuns = user.runs_this_week || 0;
      const uploadedMissedNote = completedRuns < plannedRunDays
        ? ` They missed ${plannedRunDays - completedRuns} planned run(s) this week — acknowledge briefly and positively, then move on.`
        : "";
      // Use target range from current week in uploaded plan if available
      const allWeeks = fixture.uploaded_plan?.all_weeks || [];
      const currentPlanWeek = allWeeks.find(w => w.week_number === user.current_week);
      const weekTargetStr = currentPlanWeek?.total_miles_min != null && currentPlanWeek?.total_miles_max != null
        ? `${currentPlanWeek.total_miles_min}–${currentPlanWeek.total_miles_max} mi`
        : currentPlanWeek?.total_miles != null ? `~${currentPlanWeek.total_miles} mi` : `~${user.weekly_mileage_target} mi`;
      baseMsg = `Weekly recap trigger. Week ${user.current_week} is complete. The athlete logged ${weekMiles.toFixed(1)} mi across ${completedRuns} runs this week (plan target range was ${weekTargetStr}).${uploadedMissedNote} First: briefly recap week ${user.current_week} (mention the ${weekMiles.toFixed(1)} mi they logged — do NOT state the exact target as a single number if it's a range). Then: describe week ${user.current_week + 1} sessions from the uploaded plan block below. The athlete is following an UPLOADED TRAINING PLAN — reference the specific workouts listed (intervals, long run, etc.) exactly as prescribed. Do NOT generate different sessions.`;
    } else {
      baseMsg = `Weekly recap trigger. Week ${user.current_week} completed with ${weekMiles.toFixed(1)} mi over ${user.runs_this_week || 0} runs.${missedRunNote} Build week ${user.current_week + 1} plan targeting ~${nextWeekTarget} mi. Training days are: ${trainingDays} — schedule a run on EACH training day including Monday. Do NOT skip any training day.`;
    }
  } else if (trigger === "initial_plan" && fixture.category === "plan_quality") {
    const weekMiles = user.miles_logged_this_week || 0;
    const weeksUntilRace = user.weeks_until_race;
    const hasInjury = user.injury_notes && user.injury_notes !== "None" && user.injury_notes !== "None reported";
    const goalLower = (user.goal_race_distance || user.goal || "").toLowerCase();
    const isUltra = ["50k", "100k", "50mi", "100mi", "ultra"].some(u => goalLower.includes(u));
    const backToBackWeek = Math.max(3, Math.round(weeksUntilRace * 0.25));

    const injuryNote = hasInjury
      ? `\n<rule>INJURY CONTEXT: ${user.injury_notes}. The plan must be built around this injury: prioritize safe return over mileage targets, respect current pain-free limits, and do not introduce intensity until the athlete has been symptom-free for several weeks.</rule>`
      : "";

    const trainingDaysForUltra = user.training_days || [];
    const WEEKDAY_ORDER = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
    const sortedDays = [...trainingDaysForUltra].map(d => d.toLowerCase()).sort((a, b) => (WEEKDAY_ORDER[a] || 0) - (WEEKDAY_ORDER[b] || 0));
    const capDay = d => d.charAt(0).toUpperCase() + d.slice(1, 3);
    const bbDay1 = sortedDays.length >= 2 ? capDay(sortedDays[sortedDays.length - 2]) : "Sat";
    const bbDay2 = sortedDays.length >= 1 ? capDay(sortedDays[sortedDays.length - 1]) : "Sun";
    const ultraNote = isUltra
      ? `\nULTRA-SPECIFIC REQUIREMENTS:\n- Introduce back-to-back long runs (${bbDay1} long + ${bbDay2} medium-long) by Week ${backToBackWeek} at the latest — this is the central ultra training stimulus, not a late-plan addition. Use the athlete's actual training days — do NOT hardcode Saturday/Sunday.\n- Include trail-specific guidance from Week 1: hiking steep uphills (power-hiking is faster than running them in ultras), running by time-on-feet rather than strict pace, elevation management`
      : "";

    baseMsg = `Initial plan trigger. Athlete has already logged ${weekMiles.toFixed(1)} mi this week. Race is exactly ${weeksUntilRace} weeks away — build a ${weeksUntilRace}-week plan, no more, no fewer.${injuryNote}${ultraNote}

Build a complete training plan overview with:
1. Week 1 — every session listed (day, type, distance, any pace targets), then the week total
2. Full training arc — approximate mileage target for each week from Week 1 through race week (${weeksUntilRace} weeks total)
3. Peak week — total mileage and the types of sessions it includes
4. Taper — how many weeks and approximate mileage

Be specific about Week 1 sessions. Approximate weekly targets are fine for the rest.`;
  } else if (trigger === "initial_plan") {
    const weekMiles = user.miles_logged_this_week || 0;
    baseMsg = `Initial plan trigger. Athlete has already logged ${weekMiles.toFixed(1)} mi this week. Build week 1 plan targeting ${user.weekly_mileage_target || 30} mi total. Acknowledge completed runs separately from planned sessions. Do NOT use additive total format ("Total: X + Y already").

DELOAD WEEKS — REQUIRED:
Whenever base and build phases together span 5+ consecutive weeks, MUST include at least one deload week. DELOAD DEPTH: ~70% of the prior build week — a REAL 25-30% volume cut, not a 1-2mi step-back. If Week 3 is 20mi, Week 4 deload must be ~14mi. A plan where Week 4 is 18mi or 22mi when Week 3 was 20mi has NO deload and is a safety failure. When presenting the arc summary, explicitly mark deload weeks — e.g., "Weeks 1–3 (build): 17, 18, 20mi; Week 4 (recovery): 14mi; Weeks 5–7 (build): 22, 24, 26mi..."

DATE BOUNDARY: Every session date must fall within the week header you stated. If you write "Week 1: Apr 3–9", every session must have a date between Apr 3 and Apr 9 inclusive. No session may have a date of Apr 10 or later in that block.`;
  } else if (trigger === "morning_reminder") {
    baseMsg = `Morning reminder trigger. Send today's workout reminder based on the schedule and recent conversation.`;
  } else if (trigger === "nightly_reminder") {
    // Mirror the nightlyNoSessions detection in route.ts:
    // If plan_sessions_remaining is empty or all session dates are before today, inject the guard.
    const sessions = user.plan_sessions_remaining || [];
    const todayStr = fixture.today || new Date().toISOString().slice(0, 10);
    const [ty, tm, td] = todayStr.split("-").map(Number);
    const localTodayUTC = new Date(Date.UTC(ty, tm - 1, td));
    const hasActiveSessions = sessions.some(s => {
      const [m, d] = (s.date || "").split("/").map(Number);
      if (isNaN(m) || isNaN(d)) return false;
      return new Date(Date.UTC(ty, m - 1, d)) >= localTodayUTC;
    });
    if (!hasActiveSessions) {
      const weekMiStr = `${(user.miles_logged_this_week || 0).toFixed(1)} miles`;
      baseMsg = `The athlete's training week is complete — all stored sessions for this week are in the past. The weekly recap and next-week plan will be sent shortly tonight.

Send a brief end-of-week check-in message (under 200 characters). You MUST include BOTH of:
1. A clear statement that this week is DONE or COMPLETE, optionally mentioning their ${weekMiStr} this week.
2. A clear statement that their next week's plan is coming tonight (e.g. "sending your plan tonight", "plan coming tonight", "new plan on its way tonight").

Example structure: "Week is done — [X miles] in the books. New plan coming tonight."

CRITICAL: Do NOT mention any specific workout distance, pace, or session type. Do NOT say "tomorrow" followed by a workout. The stored plan sessions are all completed — treat them as history only. Never say "long run tomorrow", "easy run tomorrow", or reference any specific miles or paces from prior sessions. No markdown.`;
    } else {
      baseMsg = `Nightly reminder trigger. Send a brief reminder of tomorrow's workout based on the stored sessions and recent conversation.`;
    }
  } else {
    // Default: user message
    baseMsg = inbound_sms || "What's the plan?";
    // Silence gap + projection accuracy rules for user_message context
    baseMsg += `

SILENCE GAPS: If the athlete notes you've been out of touch, do not invent an excuse (e.g. "I've been traveling", "been following along in the background"). Own the gap directly and catch up on their recent runs.

WEEKLY PROJECTION ACCURACY: When stating "on track for X mi", X must equal miles already done PLUS remaining planned session distances. Do not quote the stored weekly target if remaining sessions sum to a different total.`;
  }

  // Uploaded plan injection — mirrors coach/respond route.ts logic.
  // When a fixture has an uploaded_plan field, append the <uploaded_plan_next_week> block
  // to the user message for weekly_recap and user_message triggers.
  if (fixture.uploaded_plan && (trigger === "weekly_recap" || trigger === "user_message" || !trigger)) {
    const { all_weeks, next_week_num, is_week_sync, is_next_week } = fixture.uploaded_plan;
    const nextWeekNum = next_week_num ?? (user.current_week + 1);
    const totalWeekCount = all_weeks.length;
    const uploadedNextWeek = all_weeks.find(w => w.week_number === nextWeekNum);
    if (uploadedNextWeek) {
      const mileageRange = uploadedNextWeek.total_miles_min != null && uploadedNextWeek.total_miles_max != null
        ? `${uploadedNextWeek.total_miles_min}–${uploadedNextWeek.total_miles_max}mi`
        : `~${uploadedNextWeek.total_miles}mi`;
      const sessionLines = uploadedNextWeek.sessions
        .filter(s => s.type !== "off")
        .map(s => {
          const distPart = s.targetDistanceMilesMin != null && s.targetDistanceMilesMax != null
            ? ` (${s.targetDistanceMilesMin}–${s.targetDistanceMilesMax}mi)`
            : s.targetDistanceMiles != null ? ` (${s.targetDistanceMiles}mi)` : "";
          const pacePart = s.targetPace ? ` @ ${s.targetPace}` : "";
          return `${s.dayOfWeek}: ${s.description}${distPart}${pacePart}`;
        })
        .join("\n");
      const weekLabel = is_week_sync
        ? `UPLOADED PLAN — WEEK ${nextWeekNum} OF ${totalWeekCount} (athlete is starting ${is_next_week ? "next week" : "now"}):\nThe athlete just confirmed they are starting week ${nextWeekNum}${is_next_week ? " next week" : ""}. Acknowledge you have the plan and these sessions, and briefly describe what week ${nextWeekNum} looks like. ${is_next_week ? "Mention the start date (next Monday)." : ""}`
        : `UPLOADED PLAN — WEEK ${nextWeekNum} OF ${totalWeekCount}:\nThe athlete is following an external training plan. These are the prescribed sessions for next week. Use these as the plan — don't replace them with different sessions. You may suggest working within the low end of any ranges if the athlete had a hard week, or the high end if they're feeling strong.`;
      baseMsg += `\n\n<uploaded_plan_next_week>\n${weekLabel}\n${sessionLines}\nWeekly total: ${mileageRange}\n</uploaded_plan_next_week>`;
    }
  }

  return baseMsg;
}

// ─────────────────────────────────────────────
// Mirrors stripReasoningPreamble() from route.ts
// so the eval sees what users actually receive.
// ─────────────────────────────────────────────

function stripReasoningPreamble(text) {
  // Strip any <rule>...</rule> blocks that leaked into the output
  const cleaned = text.replace(/<rule>[\s\S]*?<\/rule>/gi, "").trim();
  if (cleaned) text = cleaned;

  // Pattern 0: "RESPONSE:" separator
  const responseLabelMatch = text.match(/^RESPONSE:\s*/im);
  if (responseLabelMatch && responseLabelMatch.index !== undefined) {
    const afterLabel = text.slice(responseLabelMatch.index + responseLabelMatch[0].length).trim();
    if (afterLabel) return afterLabel;
  }

  const reasoningMarkers = [
    /^⚠️/,
    /^<rule>/i,
    /^The athlete is (asking|looking|trying|requesting|wondering)/im,
    /^I should (keep|answer|respond|address|be|make)/im,
    /^Key considerations:/im,
    /^This is a (training|general|coaching|question|philosophy)/im,
    /^(Let me|I'll|I need to) (think|answer|address|keep|make|write)/im,
    /^Based on (the|this|their|what the athlete)/im,
  ];

  // Pattern 1: preamble + "---" separator
  const sepIdx = text.indexOf("\n---\n");
  if (sepIdx !== -1) {
    const preamble = text.slice(0, sepIdx);
    if (reasoningMarkers.some((p) => p.test(preamble.trim()))) {
      return text.slice(sepIdx + 5).trim();
    }
  }

  // Pattern 2: leading paragraph(s) that look like reasoning
  const paragraphs = text.split(/\n{2,}/);
  let firstCoachingPara = 0;
  const leadPatterns = [
    /^⚠️/,
    /^<rule>/i,
    /^The athlete is (asking|looking|trying|requesting|wondering)/i,
    /^I should (keep|answer|respond|address|be|make)/i,
    /^Key considerations:/i,
    /^This is a (training|general|coaching|question|philosophy)/i,
  ];
  while (
    firstCoachingPara < paragraphs.length - 1 &&
    leadPatterns.some((p) => p.test(paragraphs[firstCoachingPara].trim()))
  ) {
    firstCoachingPara++;
  }
  if (firstCoachingPara > 0) {
    return paragraphs.slice(firstCoachingPara).join("\n\n").trim();
  }

  return text;
}

// ─────────────────────────────────────────────
// Main eval runner
// ─────────────────────────────────────────────

async function runEval(fixture) {
  const systemPrompt = buildEvalSystemPrompt(fixture);
  const userMessage = buildUserMessage(fixture);

  const isPlanQuality = fixture.category === "plan_quality";
  const isPlanUpdate = fixture.category === "plan_update";

  // Step 1: Get coaching response
  let coachResponse = null;
  let coachError = null;
  try {
    const coachMsg = await client.messages.create({
      model: COACHING_MODEL,
      max_tokens: isPlanQuality ? 1500 : 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    coachResponse = stripReasoningPreamble(
      coachMsg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text.trim())
        .join("\n\n")
        .trim()
    );
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
  const judgePromptStr = isPlanQuality
    ? buildPlanJudgePrompt(fixture, coachResponse)
    : isPlanUpdate
    ? buildPlanUpdateJudgePrompt(fixture, coachResponse)
    : buildJudgePrompt(fixture, coachResponse);
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
