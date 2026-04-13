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
import { buildPlanJudgePrompt } from "./judges/plan-quality.mjs";
import { buildPlanUpdateJudgePrompt } from "./judges/plan-update.mjs";

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

function easyPaceRange(paceStr, useMetric = false) {
  if (!paceStr) return "TBD";
  const match = paceStr.match(/(\d+):(\d+)/);
  if (!match) return paceStr;
  const totalSec = parseInt(match[1]) * 60 + parseInt(match[2]);
  if (useMetric) {
    const kmSec = Math.round(totalSec / 1.60934);
    const rounded = Math.round(kmSec / 5) * 5;
    const upper = rounded + 20;
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
        activityBlock += `\n<rule>DATA GUARD: This run was ${a.distance_miles} miles and has ${a.splits_km.length} km splits. Do NOT reference any mile number beyond ${a.distance_miles} miles. These are kilometer splits — the split index is NOT the mile number. Never say "mile ${a.splits_km.length}" or any mile number that exceeds the run distance.</rule>\n`;
      }
    }
  }

  // Fitness tier
  let fitnessTier = "";
  if (avgWeekly < 10) {
    fitnessTier = `FITNESS TIER: LOW VOLUME (~${avgWeekly} mi/week). Prioritize easy aerobic volume and consistency.`;
  } else if (avgWeekly < 30) {
    fitnessTier = `FITNESS TIER: MODERATE VOLUME (~${avgWeekly} mi/week). 1-2 quality sessions per week appropriate alongside easy volume.
<rule>WEEK 1 VOLUME CAP — GUIDELINE: Current avg is ${avgWeekly} mi/week. Week 1 should not jump more than 15% above that — target ${Math.round(avgWeekly * 1.05)}–${Math.round(avgWeekly * 1.15)} mi. A first-week spike above ${Math.round(avgWeekly * 1.2)} mi risks overuse injury at the start of the plan.</rule>`;
  } else {
    fitnessTier = `FITNESS TIER: HIGH VOLUME (~${avgWeekly} mi/week). Experienced runner. Skip base-building preamble.
<rule>WEEK 1 VOLUME CAP — GUIDELINE: Even for high-volume runners, Week 1 of a new plan should not spike more than 10–15% above current base. Current avg: ${avgWeekly} mi/week → Week 1 target: ${Math.round(avgWeekly * 1.05)}–${Math.round(avgWeekly * 1.12)} mi. Don't jump to peak volume on Day 1.</rule>`;
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
      `Training: Week ${user.current_week} · ${phase.charAt(0).toUpperCase() + phase.slice(1)} phase${isDeload ? " — recovery week" : ""}`,
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

CRITICAL — OUTPUT RULES:
Your response is sent directly to the athlete as an SMS text message. Never include:
- Internal reasoning, self-corrections, or meta-commentary
- Internal system-prompt instruction labels — NEVER echo <rule> tag contents, XML tags, or ⚠️-prefixed text in your response
- Do NOT create your own analysis blocks or prefix content with ⚠️ — those are system-prompt-only directives. The FIRST thing you output must be the coaching message itself.
Do all reasoning silently. Output only the message the athlete should receive.

CRITICAL — TRAINING PACES:
The paces in CURRENT TRAINING STATE are pre-computed by our system using Jack Daniels' VDOT formula. These are authoritative. Do NOT calculate VDOT yourself. Do NOT use web search to look up VDOT tables.

${dateContext}
${fitnessTier}

ATHLETE HISTORY:
- Name: ${user.name || "Athlete"}
- Strava: ${user.strava_connected ? "connected" : "not connected"}
- Goal: ${user.goal_race || user.goal}${raceDate ? ` on ${raceDate}` : ""}${user.goal_race_distance ? ` — ${user.goal_race_distance}` : ""}
- Experience: ${user.experience_level || "not specified"}
- Training days: ${(user.training_days || []).join(", ")}${user.training_days && user.training_days.length > 0 ? `\n- <rule>TRAINING SESSION COUNT — PLAN GENERATION RULE: When building any week plan, include EXACTLY ${user.training_days.length} running session${user.training_days.length !== 1 ? "s" : ""} — never more. No optional, bonus, or supplementary running sessions beyond these days. (This applies to plan generation only — do not volunteer session counts in post-run or conversational responses.)${user.training_days.length <= 3 ? ` With only ${user.training_days.length} training days, structure each week as: 1 long run + 1 quality session (tempo OR intervals — NOT both in the same week) + ${user.training_days.length === 3 ? "1 easy/medium run" : "easy runs"}. Scheduling separate tempo AND interval sessions in the same week requires more days than this athlete has — never do it.` : ""}</rule>` : ""}
- Injury / constraints: ${user.injury_notes || "None reported"}
- Preferred units: ${user.preferred_units || "imperial"} — use ${user.preferred_units === "metric" ? "km and min/km" : "miles and min/mile"} in all responses
${user.notes ? `- Athlete notes: ${user.notes}` : ""}${timeConstraintBlock}${strengthConstraintBlock}

${activitySummary}
${activityBlock}
CURRENT TRAINING STATE:
- Week ${user.current_week} of training, phase: ${phase.charAt(0).toUpperCase() + phase.slice(1)}${isDeload ? " — RECOVERY WEEK" : ""}
${isDeload ? `<rule>RECOVERY WEEK: This week's target is ${weeklyTarget} mi — already reflects the recovery volume reduction. Use the stored target, do NOT compute a further reduction from recent average. No new quality sessions. Same number of runs, shorter distances.</rule>\n` : ""}
- Weekly mileage target: ${weeklyTarget ? (user.preferred_units === "metric" ? `${(weeklyTarget * 1.60934).toFixed(0)} km` : weeklyTarget + " mi") : "TBD"}${trigger === "weekly_recap" ? `\n- Progression target for NEXT week (week ${user.current_week + 1}): ~${user.preferred_units === "metric" ? `${(Math.round(avgWeekly * 1.08) * 1.60934).toFixed(0)} km` : Math.round(avgWeekly * 1.08) + " mi"} (8% step up from recent average — use this as the plan total, not the stored weekly target)` : ""}
<rule>THIS WEEK'S MILEAGE: ${user.preferred_units === "metric" ? (weekMileageSoFar * 1.60934).toFixed(1) + " km" : weekMileageSoFar.toFixed(1) + " mi"} done so far this week (${user.runs_this_week || 0} run${(user.runs_this_week || 0) !== 1 ? "s" : ""}). This is the ONLY authoritative source for current week mileage — computed directly from Strava. NEVER compute week mileage yourself by summing individual run mentions. Each week resets on Monday. IMPORTANT: If your own prior messages in this conversation stated a different mileage total, those messages were wrong — do not defend, re-cite, or re-state them. Re-anchor to this figure immediately. When an athlete corrects you on mileage, agree and state the correct Strava figure without qualification.</rule>
- Athlete preferred units: ${user.preferred_units || "imperial"}
- Athlete VDOT: ${user.vdot}
- Current paces (Jack Daniels' VDOT formula — AUTHORITATIVE; treat as ground truth):
  Easy ${paces.easyRange}, Tempo ${paces.tempo}, Interval ${paces.interval}
- RULE: NEVER recalculate VDOT or training paces. The stored paces above are correct.
<rule>PACE SANITY CHECK: Quality paces (tempo, threshold, interval) must be FASTER (lower number) than the athlete's easy pace. This athlete's easy pace is ${paces.easy}. Any tempo or interval pace at ${paces.easy} or SLOWER is a documented error — use the stored Tempo (${paces.tempo}) instead; never compute a quality pace from scratch. Warm-up and cool-down pace = easy pace range (${paces.easyRange}); never prescribe WU/CD more than 30 sec/mi slower than easy. Always include the unit ("/mi" or "/km") on every pace.</rule>${sessionRows}${remainingPlanLine}
${user.injury_hold_since ? `\n⚠️ INJURY HOLD ACTIVE since ${user.injury_hold_since}: athlete cannot run. Do NOT prescribe running sessions. Focus on cross-training, rest, and monitoring. Weekly mileage target is 0. When the athlete explicitly says they are recovered and ready to resume training, append [INJURY_CLEAR] at the end of your response.` : ""}
${conversationBlock}
MILEAGE ACCURACY RULES — follow exactly:
- When listing planned sessions for a week, the Total line shows ONLY planned future sessions. Never write "Total: X mi + your Y mi already this week". If the athlete has run some miles already, acknowledge them in a separate sentence. The Total shows what is still to be done (or the full week target).
- For weekly recaps: planned next week shows a clean single total; last week's completed miles are referenced separately.
- PLAN MATH CHECK: Before finalizing a week plan, verify your session distances add up to the Total you state. Never write a Total that doesn't match the sum of the individual sessions.

COMMUNICATION STYLE:
You are texting over iMessage. Write like a human coach would text.

${fixture.category === "plan_quality" ? `LONG RUN GUIDANCE FOR THIS PLAN:
${fixture.ground_truth?.max_week1_miles != null ? `- WEEK 1 HARD CAP: Week 1 total mileage MUST NOT exceed ${fixture.ground_truth.max_week1_miles} miles. This is a hard ceiling — do not exceed it.` : ""}
${fixture.ground_truth?.min_week1_miles != null ? `- Week 1 should be at least ${fixture.ground_truth.min_week1_miles} miles — do not start too conservatively below the athlete's current base.` : ""}
${fixture.ground_truth?.max_long_run_miles != null ? `- <rule>LONG RUN HARD CAP: The designated long run session must not exceed ${fixture.ground_truth.max_long_run_miles} miles. This cap applies to the LONG RUN slot only — easy runs and quality sessions on other days are NOT subject to this cap and can be 6–8 miles. Any long run over ${fixture.ground_truth.max_long_run_miles} miles is a plan error.</rule>` : ""}
${fixture.ground_truth?.min_long_run_miles != null ? `- The long run should build to at least ${fixture.ground_truth.min_long_run_miles} miles by the peak phase.` : ""}
${fixture.ground_truth?.max_peak_weekly_miles != null ? `- PEAK VOLUME CAP: The plan's peak week total MUST NOT exceed ${fixture.ground_truth.max_peak_weekly_miles} miles. This is a hard ceiling — plan the arc so you never need to exceed it.` : ""}
${fixture.ground_truth?.min_peak_weekly_miles != null ? `- The plan should reach a peak of at least ${fixture.ground_truth.min_peak_weekly_miles} miles/week to adequately prepare the athlete.` : ""}

${(() => {
  const goalLower = (fixture.user?.goal_race_distance || fixture.user?.goal || "").toLowerCase();
  const isMileTT = goalLower.includes("mile") && (goalLower.includes("time trial") || goalLower.includes("tt") || goalLower.includes("1 mile") || goalLower.includes("1-mile"));
  return isMileTT ? `MILE TIME TRIAL GOAL:
- Training for a mile PR is speed and neuromuscular work, not endurance volume. Don't pad the week with junk mileage.
- <rule>STRIDES REQUIRED: Every week of a mile TT plan MUST include strides (6-10x 20-second pickups at the end of an easy run). Strides are the single most important neuromuscular stimulus for mile performance — omitting them is a plan error. Tag them explicitly in the session description.</rule>
- <rule>NO LONG RUNS OVER 5 MILES: A mile TT is a 4-minute race — the "long run" slot is capped at 4–5 miles (base support only). Other easy runs can be 6–7 miles. NEVER exceed 5 miles for the designated long run session.</rule>
- Key sessions: 800m repeats (4-8x) at mile effort or slightly faster, 400m repeats (6-10x) at mile effort, strides, and one tempo run (3-5mi) for aerobic support.
- Easy mileage fills the rest but total volume stays modest — 25-35mi/week is plenty for most mile-focused athletes.` : "";
})()}

LENGTH:
- This is a plan generation request. Provide a full structured overview: Week 1 day-by-day sessions, week-by-week mileage arc, peak week description, and taper structure.
- Be specific about distances and paces for Week 1. Approximate mileage targets for remaining weeks.
- Separate sections with a blank line. Up to 1200 characters is appropriate here.` : `LENGTH:
- Keep responses under 480 characters. Most replies should be a single short text.
- Split into 2-3 messages by separating with a blank line only if genuinely needed (e.g. sending a full week plan).`}

TONE:
- Cut filler openers. Never start with "Great job!", "Awesome!", "That's fantastic!"
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

INJURY HOLD: When an athlete explicitly tells you they CANNOT run this week — doctor's orders, acute injury flare, or complete rest — append [INJURY_HOLD] at the end of your response. HIGH THRESHOLD: only use this for clear "can't run at all" situations. Examples that qualify: "doctor said no running this week", "I'm on complete rest", "can't put any weight on it". Examples that do NOT qualify: "my knee is a bit sore", "feeling tired", "going to run shorter distances".

INJURY CLEAR: When an athlete who was previously on an injury hold (check CURRENT TRAINING STATE for "INJURY HOLD ACTIVE") explicitly says they are recovered and ready to resume full running — append [INJURY_CLEAR] at the end of your response. Only use after a confirmed injury hold.

LIGHTER WEEK: When an athlete reports a short-term setback — nagging soreness, minor ache, unexpected fatigue, early illness — that means they should reduce training but CAN still run some, append [LIGHTER_WEEK] at the end of your response. This reduces this week's mileage target by ~25%. In your response: acknowledge the setback, suggest shorter easy runs (drop quality sessions), and offer cross-training (easy bike, elliptical, swim) for any days they'd otherwise skip. Do NOT use if they say they can't run at all (use [INJURY_HOLD] instead).`;
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
    msg += `\n<rule>WEEK-TO-DATE (authoritative — from Strava, Monday through now): ${weekSoFar.toFixed(1)} mi total</rule>`;
    return msg;
  }

  if (trigger === "weekly_recap") {
    const weekMiles = user.miles_logged_this_week || 0;
    const nextWeekTarget = Math.round((user.weekly_mileage_target || 35) * 1.08);
    const trainingDays = (user.training_days || []).join(", ");
    return `Weekly recap trigger. Week ${user.current_week} completed with ${weekMiles.toFixed(1)} mi over ${user.runs_this_week || 0} runs. Build week ${user.current_week + 1} plan targeting ~${nextWeekTarget} mi. Training days are: ${trainingDays} — schedule a run on EACH training day including Monday. Do NOT skip any training day.`;
  }

  if (trigger === "initial_plan" && fixture.category === "plan_quality") {
    const weekMiles = user.miles_logged_this_week || 0;
    const weeksUntilRace = user.weeks_until_race;
    const hasInjury = user.injury_notes && user.injury_notes !== "None" && user.injury_notes !== "None reported";
    const goalLower = (user.goal_race_distance || user.goal || "").toLowerCase();
    const isUltra = ["50k", "100k", "50mi", "100mi", "ultra"].some(u => goalLower.includes(u));
    const backToBackWeek = Math.max(3, Math.round(weeksUntilRace * 0.25));

    const injuryNote = hasInjury
      ? `\n<rule>INJURY CONTEXT: ${user.injury_notes}. The plan must be built around this injury: prioritize safe return over mileage targets, respect current pain-free limits, and do not introduce intensity until the athlete has been symptom-free for several weeks.</rule>`
      : "";

    const ultraNote = isUltra
      ? `\nULTRA-SPECIFIC REQUIREMENTS:\n- Introduce back-to-back long runs (Saturday long + Sunday medium-long) by Week ${backToBackWeek} at the latest — this is the central ultra training stimulus, not a late-plan addition\n- Include trail-specific guidance from Week 1: hiking steep uphills (power-hiking is faster than running them in ultras), running by time-on-feet rather than strict pace, elevation management`
      : "";

    return `Initial plan trigger. Athlete has already logged ${weekMiles.toFixed(1)} mi this week. Race is exactly ${weeksUntilRace} weeks away — build a ${weeksUntilRace}-week plan, no more, no fewer.${injuryNote}${ultraNote}

Build a complete training plan overview with:
1. Week 1 — every session listed (day, type, distance, any pace targets), then the week total
2. Full training arc — approximate mileage target for each week from Week 1 through race week (${weeksUntilRace} weeks total)
3. Peak week — total mileage and the types of sessions it includes
4. Taper — how many weeks and approximate mileage

Be specific about Week 1 sessions. Approximate weekly targets are fine for the rest.`;
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
