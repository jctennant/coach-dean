/**
 * Onboarding pressure-test runner.
 *
 * Usage:
 *   node tests/run-onboarding-test.mjs TC04          # single scenario
 *   node tests/run-onboarding-test.mjs TC04 TC19     # multiple
 *   node tests/run-onboarding-test.mjs all           # all 20
 *
 * Requires the dev server running: npm run dev
 * Reads config from .env.local automatically.
 *
 * The runner is STEP-DRIVEN: it queries the actual DB onboarding_step after
 * each exchange and either sends the matching scenario message or a default
 * fallback. This means dynamic steps (race_date, timezone, etc.) are handled
 * automatically without being hard-coded into each scenario.
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient } from "@supabase/supabase-js";

// ── Load env ──────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, "../.env.local");
if (!existsSync(envPath)) {
  console.error("Missing .env.local — run from project root");
  process.exit(1);
}
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const scenarios = JSON.parse(readFileSync(join(__dir, "onboarding-scenarios.json"), "utf8"));

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (!args.length) {
  console.log("Usage: node tests/run-onboarding-test.mjs <TC01|all> [TC02 ...]");
  process.exit(0);
}

const toRun = args[0] === "all"
  ? scenarios.cases
  : scenarios.cases.filter(c => args.includes(c.id));

if (!toRun.length) {
  console.error("No matching scenarios found for:", args.join(", "));
  process.exit(1);
}

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
  red: "\x1b[31m", blue: "\x1b[34m", magenta: "\x1b[35m",
  bg_blue: "\x1b[44m", bg_green: "\x1b[42m", bg_yellow: "\x1b[43m",
};
const hr = (char = "─", len = 70) => char.repeat(len);

// ── Default responses for each dynamic step ───────────────────────────────────
// Used when the DB is at a step not covered by the scenario script.
const STEP_DEFAULTS = {
  awaiting_race_date:        "Not sure of the exact date yet — sometime this fall",
  awaiting_goal_time:        "No specific time, just want to finish strong",
  awaiting_ultra_background: "I've done a few shorter trail races, nothing over a marathon",
  awaiting_injury_background:"Nothing major — just the usual aches. Cleared to train normally",
  awaiting_strava:           "I'll skip Strava for now",
  awaiting_mileage_baseline: "Running about 20-25 miles a week currently",
  awaiting_schedule:         "Monday, Wednesday, Friday, and Sunday work for me",
  awaiting_timezone:         "I'm in New York City",
  awaiting_cadence:          "Evening before works great",
  awaiting_anything_else:    "No, I think that covers it!",
  awaiting_name:             "Just call me Runner",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function createTestUser(scenario) {
  const idx = Math.floor(Math.random() * 9000) + 1000;
  const phone = `+1999${String(idx).padStart(7, "0")}`;
  const { data, error } = await db.from("users").insert({
    phone_number: phone,
    name: `TEST_${scenario.id}`,
    onboarding_step: "awaiting_goal",
    onboarding_data: {},
  }).select("id").single();
  if (error) throw new Error(`Failed to create test user: ${error.message}`);
  return { id: data.id, phone };
}

async function deleteTestUser(userId) {
  await db.from("conversations").delete().eq("user_id", userId);
  await db.from("training_profiles").delete().eq("user_id", userId);
  await db.from("training_state").delete().eq("user_id", userId);
  await db.from("users").delete().eq("id", userId);
}

async function getOnboardingStep(userId) {
  const { data } = await db.from("users")
    .select("onboarding_step")
    .eq("id", userId)
    .single();
  return data?.onboarding_step ?? null;
}

async function sendMessage(userId, message) {
  const res = await fetch(`${APP_URL}/api/onboarding/handle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, message, dry_run: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`handle returned ${res.status}: ${body}`);
  }
}

async function getNewConversations(userId, since) {
  const { data } = await db.from("conversations")
    .select("content, message_type, created_at")
    .eq("user_id", userId)
    .eq("role", "assistant")
    .gt("created_at", since)
    .order("created_at", { ascending: true });
  return data ?? [];
}

function wrap(text, width = 68, indent = "   ") {
  return text.split("\n").map(line => {
    if (line.length <= width) return indent + line;
    const words = line.split(" ");
    let out = "", cur = "";
    for (const w of words) {
      if ((cur + w).length > width) { out += (out ? "\n" + indent : "") + cur.trim(); cur = ""; }
      cur += w + " ";
    }
    return out + (out ? "\n" + indent : "") + cur.trim();
  }).join("\n" + indent);
}

// ── Run a single exchange (one user message → Dean response) ──────────────────
async function sendExchange(userId, dbStep, message, watchFor, label) {
  const before = new Date().toISOString();

  console.log(`\n${C.cyan}${C.bold}YOU [${label ?? dbStep}]:${C.reset}`);
  console.log(`${C.cyan}${wrap(message)}${C.reset}`);

  await sendMessage(userId, message);

  // Wait for Claude + DB commit
  await new Promise(r => setTimeout(r, 4000));

  const replies = await getNewConversations(userId, before);

  if (!replies.length) {
    console.log(`${C.yellow}  ⚠ No response stored (check server logs)${C.reset}`);
  } else {
    for (const r of replies) {
      const isInitialPlan = r.message_type === "initial_plan";
      const typeLabel = isInitialPlan
        ? `${C.bg_green} INITIAL PLAN ${C.reset}`
        : `${C.green}${C.bold}DEAN:${C.reset}`;
      console.log(`\n${typeLabel}`);
      console.log(`${C.green}${wrap(r.content)}${C.reset}`);
    }
  }

  if (watchFor?.length) {
    console.log(`\n${C.yellow}${C.bold}  ✓ CHECK:${C.reset}`);
    for (const w of watchFor) {
      console.log(`${C.yellow}    · ${w}${C.reset}`);
    }
  }

  console.log("\n" + hr("·"));
  return replies;
}

// ── Run a single scenario ─────────────────────────────────────────────────────
async function runScenario(scenario) {
  console.log("\n" + hr("═"));
  console.log(`${C.bold}${C.bg_blue} ${scenario.id} ${C.reset} ${C.bold}${scenario.name}${C.reset}`);
  console.log(`${C.dim}Tags: ${scenario.tags.join(", ")}${C.reset}`);
  if (scenario.persona.notes) console.log(`${C.dim}Note: ${scenario.persona.notes}${C.reset}`);
  console.log(hr());

  let userId;
  try {
    const user = await createTestUser(scenario);
    userId = user.id;
    console.log(`${C.dim}Test user: ${userId} (${user.phone})${C.reset}\n`);

    // Build a lookup of scenario steps by their step key
    const scenarioByStep = {};
    for (const s of scenario.conversation) {
      scenarioByStep[s.step] = s;
    }
    const usedSteps = new Set();

    const MAX_EXCHANGES = 15;
    let exchanges = 0;

    while (exchanges < MAX_EXCHANGES) {
      const dbStep = await getOnboardingStep(userId);

      if (!dbStep) {
        console.log(`${C.green}${C.bold}✓ Onboarding complete (step = null)${C.reset}`);
        break;
      }

      exchanges++;

      // Find the best message to send:
      // 1. Unused scenario step matching current DB step
      // 2. Default fallback
      const scenarioStep = (!usedSteps.has(dbStep) && scenarioByStep[dbStep])
        ? scenarioByStep[dbStep]
        : null;

      let message, watchFor, label;

      if (scenarioStep) {
        message = scenarioStep.user_says;
        watchFor = scenarioStep.watch_for;
        label = dbStep;
        usedSteps.add(dbStep);
      } else {
        message = STEP_DEFAULTS[dbStep] ?? "OK, sounds good";
        watchFor = null;
        label = `${dbStep} [DEFAULT]`;
        console.log(`${C.dim}  (using default response for step: ${dbStep})${C.reset}`);
      }

      await sendExchange(userId, dbStep, message, watchFor, label);
    }

    if (exchanges >= MAX_EXCHANGES) {
      console.log(`${C.yellow}⚠ Hit max exchanges (${MAX_EXCHANGES}) — onboarding may be stuck${C.reset}`);
    }

    // Print unused scenario steps (steps in script that never fired)
    const unusedScenarioSteps = scenario.conversation
      .filter(s => !usedSteps.has(s.step))
      .map(s => s.step);
    if (unusedScenarioSteps.length) {
      console.log(`\n${C.dim}  Steps in scenario but never reached: ${unusedScenarioSteps.join(", ")}${C.reset}`);
    }

    // Red flags summary
    if (scenario.red_flags?.length) {
      console.log(`\n${C.red}${C.bold}⚠ RED FLAGS TO CHECK IN THE PLAN ABOVE:${C.reset}`);
      for (const f of scenario.red_flags) {
        console.log(`${C.red}  · ${f}${C.reset}`);
      }
    }

    console.log(`\n${C.green}${C.bold}✓ ${scenario.id} complete${C.reset}`);

  } catch (err) {
    console.error(`${C.red}✗ ${scenario.id} FAILED: ${err.message}${C.reset}`);
  } finally {
    if (userId) {
      await deleteTestUser(userId);
      console.log(`${C.dim}Cleaned up test user ${userId}${C.reset}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`${C.bold}Coach Dean — Onboarding Test Runner${C.reset}`);
console.log(`Running ${toRun.length} scenario(s) against ${APP_URL}`);
console.log(`${C.yellow}Make sure the dev server is running: npm run dev${C.reset}\n`);

for (const scenario of toRun) {
  await runScenario(scenario);
  if (toRun.indexOf(scenario) < toRun.length - 1) {
    await new Promise(r => setTimeout(r, 1000));
  }
}

console.log("\n" + hr("═"));
console.log(`${C.bold}Done. ${toRun.length} scenario(s) tested.${C.reset}\n`);
