import { NextResponse } from "next/server";
import { runAfter } from "@/lib/safe-after";
import { supabase } from "@/lib/supabase";
import { insertConversation, type MessageType } from "@/lib/conversations";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { calculateVDOTPaces, easyPaceRange, formatRaceDistance } from "@/lib/paces";
import { getCheckoutPageUrl } from "@/lib/stripe";
import type { Json } from "@/lib/database.types";
import { parseTimezoneFromLocation } from "@/lib/timezone";
import type { UploadedPlanWeek } from "@/lib/training-plan";
import { computeWeekSessions } from "@/lib/training-plan";
import { composeStrengthRoutine } from "@/lib/strength-library";

export const maxDuration = 60;

// Tracks userIds currently in a dry_run onboarding request.
const dryRunUsers = new Set<string>();



interface OnboardingRequest {
  userId: string;
  message: string;
  chatId?: string | null;
  dry_run?: boolean;
}


/** Send SMS and store in conversations. */
async function sendAndStore(
  userId: string,
  phone: string,
  message: string,
  messageType?: MessageType
): Promise<{ chatId: string | null }> {
  const isDryRun = dryRunUsers.has(userId);
  let chatId: string | null = null;
  if (!isDryRun) {
    const result = await sendSMS(phone, message);
    chatId = result?.chatId ?? null;
  }
  await insertConversation({
    user_id: userId,
    role: "assistant",
    content: message,
    message_type: messageType ?? "coach_response",
  });
  return { chatId };
}

/**
 * POST /api/onboarding/handle
 *
 * Simplified routing:
 *   "onboarding"        → unified Claude conversation handler
 *   "awaiting_strava"   → Strava connect / skip handler
 *   "awaiting_timezone" → post-plan city/state collection for reminder timing
 *   "awaiting_payment"  → payment link re-send
 */
export async function POST(request: Request) {
  const { userId, message, chatId, dry_run = false }: OnboardingRequest = await request.json();
  if (dry_run) dryRunUsers.add(userId);

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, phone_number, name, onboarding_step, onboarding_data, timezone, strava_athlete_id")
    .eq("id", userId)
    .single();

  if (userError || !user) {
    if (dry_run) dryRunUsers.delete(userId);
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const step = user.onboarding_step as string | null;
  const onboardingData = (user.onboarding_data as Record<string, unknown>) || {};

  // Typing keep-alive loop for long-running LLM calls
  let keepTypingAlive = false;
  if (chatId && !dry_run) {
    keepTypingAlive = true;
    const typingId = chatId;
    void (async () => {
      while (keepTypingAlive) {
        await new Promise((r) => setTimeout(r, 4500));
        if (keepTypingAlive) void startTyping(typingId);
      }
    })();
  }

  let result: NextResponse;
  switch (step) {
    case "onboarding":
      result = await handleConversation(user, message, onboardingData, chatId);
      break;
    case "awaiting_strava":
      result = await handleStrava(user, message, onboardingData, chatId);
      break;
    case "awaiting_timezone":
      result = await handleTimezone({ ...user, onboarding_data: onboardingData }, message);
      break;
    case "awaiting_payment":
      result = await handleAwaitingPayment(user);
      break;
    default:
      result = NextResponse.json({ ok: true });
  }

  keepTypingAlive = false;
  if (dry_run) dryRunUsers.delete(userId);
  return result;
}

// ---------------------------------------------------------------------------
// Race date pre-search (OpenAI path)
// ---------------------------------------------------------------------------

/**
 * Looks up a race date using a minimal prompt that stays under gpt-4o-search-preview's
 * 6000 TPM limit. Only called when AI_PROVIDER=openai and race_name is already known.
 */
async function preSearchRaceDate(raceName: string): Promise<string | null> {
  const year = new Date().getFullYear();
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: "Race date lookup. Search for the exact date. Reply ONLY with: DATE: YYYY-MM-DD — or NONE if not found.",
      messages: [{ role: "user", content: `Exact date of ${raceName} in ${year} or ${year + 1}?` }],
      tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join(" ");
    const match = text.match(/DATE:\s*(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unified conversation handler
// ---------------------------------------------------------------------------

const ULTRA_GOALS = ["30k", "50k", "50mi", "100k", "100mi"];

const VALID_GOAL_BUCKETS = new Set([
  "mile", "5k", "10k", "half_marathon", "marathon", "trail_race", "30k", "50k", "50mi", "100k", "100mi",
  "cycling",
  "general_fitness", "return_to_running", "injury_recovery",
]);

/**
 * Unified onboarding conversation handler.
 *
 * One Sonnet call drives the conversation naturally. A Haiku call extracts
 * structured fields from the full conversation after each exchange. When
 * Claude signals [READY], onboarding is complete and the plan is generated.
 *
 * Claude uses [STRAVA_LINK] as a placeholder to request the Strava connect flow.
 */

// ---------------------------------------------------------------------------
// Off-topic classifier + handler (goals stage only)
// ---------------------------------------------------------------------------

// Keywords that strongly indicate an on-topic onboarding message.
// If any match, skip the classifier LLM call entirely.
const ONBOARDING_KEYWORDS = /\b(race|run|running|marathon|strava|injury|goal|train|training|week|pace|mile|km|5k|10k|half|plan|fatigue|sleep|coach|workout|hurt|pain|knee|achilles|hamstring|shin|hip|calf|plantar|itb|it band|mileage|base|speed|tempo|interval|easy|long run|trail|ultra|fitness|PR|personal record|finish|time goal|taper|build|connect|app|account|skip|yes|no|sure|ok|got it|sounds good|makes sense)\b/i;

async function classifyOffTopic(
  message: string,
  stageGoal: string,
  history: Array<{ role: string; content: string }>
): Promise<boolean> {
  // System triggers are always on-topic
  if (/^\(strava/.test(message)) return false;
  // No question mark → almost certainly a direct answer, skip LLM
  if (!/\?/.test(message)) return false;
  // Contains training/running keywords → on-topic, skip LLM
  if (ONBOARDING_KEYWORDS.test(message)) return false;
  // Very short questions are likely direct responses, not tangents
  if (message.trim().length < 50) return false;

  const lastAssistantMsg = [...history].reverse().find(m => m.role === "assistant")?.content ?? "";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    system: `Classify whether an athlete's message is advancing onboarding or is a tangent/question unrelated to the current step.

Current step goal: ${stageGoal}
Coach's last message: "${lastAssistantMsg.slice(0, 200)}"

Reply with exactly one word: ON_TOPIC or OFF_TOPIC.

ON_TOPIC: answers the coach's question, provides training info, names a race, mentions injury, confirms Strava, or is a direct response to what was asked.
OFF_TOPIC: general questions (gear recommendations, nutrition science, app functionality issues, how running zones work in theory, unrelated complaints).`,
    messages: [{ role: "user", content: message }],
  });

  const verdict = response.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("")
    .trim()
    .toUpperCase();
  return verdict === "OFF_TOPIC";
}

async function handleOffTopicMessage(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  data: Record<string, unknown>,
  stageGoal: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  chatId?: string | null
): Promise<NextResponse> {
  void chatId;
  const firstName = ((data.name as string | null) ?? user.name ?? "").split(" ")[0] || null;
  const redirectLine = stageGoal.includes("name") ? "What's your name, and what are you training for?"
    : stageGoal.includes("goal") ? "What race or goal are you training for?"
    : stageGoal.includes("Strava") ? "To keep going I need to connect to Strava — the link's just above."
    : "Ready to lock this in whenever you are.";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: `You are Coach Dean, an AI running coach currently onboarding a new athlete.

The athlete asked a question or went off-topic. Answer it briefly and specifically — no generic coaching advice.
Then redirect back to where you left off with: "${redirectLine}"

Rules:
- Answer the question in 1–2 sentences max. Be specific.
- Do NOT ask a new onboarding question — use the redirect line above verbatim.
- Plain text, no markdown.${firstName ? `\n- Athlete's name: ${firstName}` : ""}`,
    messages: [...history, { role: "user", content: message }],
  });

  const text = response.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("")
    .trim() || `${redirectLine}`;

  await insertConversation([
    { user_id: user.id, role: "user", content: message, message_type: "user_message" },
    { user_id: user.id, role: "assistant", content: text, message_type: "onboarding" },
  ]);
  if (!dryRunUsers.has(user.id)) await sendSMS(user.phone_number, text);
  return NextResponse.json({ ok: true });
}

async function handleConversation(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
): Promise<NextResponse> {
  // Load conversation history (last 30 messages, oldest-first)
  const { data: historyRows } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(30);

  const history = (historyRows ?? [])
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string }));

  // True if Dean has never replied yet in this onboarding conversation
  const isFirstResponse = !history.some((m) => m.role === "assistant");

  // ---- EXTRACT FIRST -------------------------------------------------------
  // Run Haiku extraction on the conversation including the user's current message
  // BEFORE building the system prompt or doing race-date pre-search. This lets the
  // OpenAI pre-search loop see freshly-extracted race names this same turn (without
  // it, the very turn an athlete first names a race, no pre-search fires and the
  // model is tempted to promise an async lookup it can't deliver). On Anthropic,
  // it also keeps "WHAT YOU ALREADY KNOW" current so Dean doesn't re-ask.
  // Trade-off: assistant-derived fields (race elevation/altitude from Dean's web
  // search results) get captured on the NEXT turn when the assistant reply lands
  // in history — acceptable since these influence later turns, not this one.
  const extracted = await extractFields([
    ...history,
    { role: "user", content: message },
  ]);
  const mergedData: Record<string, unknown> = { ...onboardingData };
  for (const [k, v] of Object.entries(extracted)) {
    if (v !== null && v !== undefined) {
      if (Array.isArray(v) && (v as unknown[]).length === 0) continue;
      mergedData[k] = v;
    }
  }
  if (mergedData.goal && !VALID_GOAL_BUCKETS.has(mergedData.goal as string)) {
    delete mergedData.goal;
  }
  if (mergedData.race_date) {
    const dateStr = mergedData.race_date as string;
    const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr));
    if (!isValidDate) {
      console.warn(`[onboarding] discarding invalid race_date: "${dateStr}"`);
      delete mergedData.race_date;
    }
  }
  // VDOT paces from a freshly-extracted road race PR — same logic as before,
  // moved here so paces are available to the system prompt this turn.
  {
    const extractedDist = mergedData.recent_race_distance_km as number | undefined;
    const stravaBestIsTrail = mergedData.strava_best_race_is_trail === true;
    const stravaBestKm = mergedData.strava_best_race_km as number | undefined;
    const likelyTrailSlipthrough = extractedDist != null
      && stravaBestIsTrail
      && stravaBestKm != null
      && Math.abs(extractedDist - stravaBestKm) < 1;

    if (mergedData.recent_race_distance_km && mergedData.recent_race_time_minutes && !likelyTrailSlipthrough) {
      const paces = calculateVDOTPaces(
        mergedData.recent_race_distance_km as number,
        mergedData.recent_race_time_minutes as number
      );
      if (paces.easy) mergedData.easy_pace = paces.easy;
      if (paces.tempo) mergedData.tempo_pace = paces.tempo;
      if (paces.interval) mergedData.interval_pace = paces.interval;
    }
  }
  // -------------------------------------------------------------------------

  // Build Strava context (best race for pace suggestion, if available)
  let stravaContext = "";
  if (mergedData.strava_connected) {
    const sbr = await lookupBestStravaRace(user.id);
    // Build analytics lines from stored data (computed at Strava connect time)
    const avgWeeklyMiles = mergedData.strava_avg_weekly_miles as number | null ?? null;
    const mileageTrend = mergedData.strava_mileage_trend as string | null ?? null;
    const avgElevFtPerRun = mergedData.strava_avg_elev_ft_per_run as number | null ?? null;
    const longestRunMiles = mergedData.strava_longest_run_miles as number | null ?? null;
    const avgRunsPerWeek = mergedData.strava_avg_runs_per_week as number | null ?? null;
    const recent4Weeks = mergedData.strava_recent_4_weeks as number[] | null ?? null;
    const hrZonePct = mergedData.strava_hr_zone_pct as { z1: number; z2: number; z3: number; z4: number; z5: number } | null ?? null;
    const estimatedMaxHR = mergedData.strava_estimated_max_hr as number | null ?? null;
    const maxWeeklySpikePct = mergedData.strava_max_weekly_spike_pct as number | null ?? null;

    // If Strava connected but all analytics are null, the activity import failed.
    // Tell Claude directly so it doesn't hallucinate numbers from missing data.
    const importFailed = avgWeeklyMiles === null && longestRunMiles === null && avgRunsPerWeek === null && !sbr;

    if (importFailed) {
      stravaContext = "\nSTRAVA: Connected but activity import failed — no training data is available. CRITICAL: Do NOT invent any mileage, pace, elevation, or frequency numbers. Tell the athlete the import didn't come through and ask them to briefly describe their recent training so you can build the plan from their actual data.";
    } else {

    const weeklyLine = avgWeeklyMiles != null
      ? ` Recent avg: ~${avgWeeklyMiles} mi/week${mileageTrend ? ` (${mileageTrend})` : ""}.`
      : "";
    const frequencyLine = avgRunsPerWeek != null ? ` ~${avgRunsPerWeek} runs/week.` : "";
    const longRunPct = mergedData.strava_long_run_pct as number | null ?? null;
    const longestLine = longestRunMiles != null
      ? ` Longest run (8 weeks): ${longestRunMiles} mi${longRunPct != null ? ` (${longRunPct}% of weekly volume)` : ""}.`
      : "";
    const daysSinceLastRun = mergedData.strava_days_since_last_run as number | null ?? null;
    const lastRunLine = daysSinceLastRun != null
      ? daysSinceLastRun <= 3
        ? ` Last run: ${daysSinceLastRun} day${daysSinceLastRun !== 1 ? "s" : ""} ago.`
        : daysSinceLastRun <= 10
          ? ` Last run: ${daysSinceLastRun} days ago.`
          : ` Last run: ${daysSinceLastRun} days ago (currently inactive — factor this into plan timing).`
      : "";
    const easyPaceTrend = mergedData.strava_easy_pace_trend as string | null ?? null;
    const easyPaceDelta = mergedData.strava_easy_pace_trend_delta_sec as number | null ?? null;
    const paceTrendLine = easyPaceTrend
      ? ` Easy pace trend (Z2 runs): ${easyPaceTrend}${easyPaceDelta != null && easyPaceDelta >= 5 ? ` (~${easyPaceDelta}s/mi ${easyPaceTrend === "improving" ? "faster" : "slower"} recently)` : ""}.`
      : "";
    const TRAIL_GOALS = ["trail_race", "30k", "50k", "50mi", "100k", "100mi"];
    const mergedGoal = mergedData.goal as string | null;
    const isTrailGoal = mergedGoal ? TRAIL_GOALS.includes(mergedGoal) : false;
    // Only inject the "0 ft" signal when we have real data showing zero vert.
    // Null means the import didn't produce elevation data — not that vert is actually 0.
    const elevLine = avgElevFtPerRun
      ? ` Avg elevation/run: ${avgElevFtPerRun} ft.`
      : isTrailGoal && avgElevFtPerRun === 0
        ? " Avg elevation/run: 0 ft (no vertical training in recent runs)."
        : "";
    // Show weekly progression oldest→newest so trend is readable (e.g. "22, 25, 28, 30")
    const progressionLine = recent4Weeks && recent4Weeks.some(m => m > 0)
      ? ` Weekly miles (oldest→newest): ${[...recent4Weeks].reverse().join(", ")}.`
      : "";
    const hrZoneLine = hrZonePct
      ? ` HR zones (% of runs by avg HR): Z1 ${hrZonePct.z1}%, Z2 ${hrZonePct.z2}%, Z3 ${hrZonePct.z3}%, Z4 ${hrZonePct.z4}%, Z5 ${hrZonePct.z5}%.${estimatedMaxHR ? ` Est. max HR: ${estimatedMaxHR} bpm.` : ""}`
      : "";
    // Compute from/to context for the spike so Claude can cite actual numbers.
    // recent4Weeks is [lastWeek, 2weeksAgo, 3weeksAgo, 4weeksAgo] (newest first).
    let spikeFromMi: number | null = null;
    let spikeToMi: number | null = null;
    if (recent4Weeks && maxWeeklySpikePct != null && maxWeeklySpikePct >= 20) {
      for (let i = 0; i < recent4Weeks.length - 1; i++) {
        const older = recent4Weeks[i + 1];
        const newer = recent4Weeks[i];
        if (older > 3) {
          const pct = Math.round(((newer - older) / older) * 100);
          if (pct === maxWeeklySpikePct) { spikeFromMi = older; spikeToMi = newer; break; }
        }
      }
    }
    const spikeLine = maxWeeklySpikePct != null && maxWeeklySpikePct >= 20
      ? ` WARNING: Mileage spike: largest week-over-week jump in last 4 weeks was +${maxWeeklySpikePct}%${spikeFromMi != null && spikeToMi != null ? ` (${spikeFromMi}mi → ${spikeToMi}mi)` : ""}.`
      : "";

    if (sbr) {
      const easyRange = easyPaceRange(sbr.easy_pace);
      // For trail races, withhold the easy pace suggestion entirely — trail paces run slower
      // than road paces due to elevation, so the VDOT-derived easy pace is systematically
      // low. Showing it causes Claude to anchor on the wrong number even after the user
      // provides a road race time. Instead, prompt Claude to collect a road baseline.
      const paceNote = sbr.is_trail
        ? ` Note: this is a trail race — easy pace suggestion withheld. Collect a road 5K/10K/HM time to set accurate training zones.`
        : ` Suggested easy pace: ${easyRange}/mi. You can use this to set their training zones.`;
      stravaContext = `\nSTRAVA: Connected.${weeklyLine}${frequencyLine}${longestLine}${lastRunLine}${elevLine}${progressionLine}${paceTrendLine}${hrZoneLine}${spikeLine} Best race for pace calibration: ${sbr.label} on ${sbr.date_str} in ${sbr.time_str}.${paceNote}`;

      // Store trail-race flag so completeOnboarding can guard the VDOT recalculation.
      // This prevents Haiku from accidentally extracting the trail race distance/time
      // (visible in coach conversation history) and producing wrong pace zones.
      mergedData.strava_best_race_is_trail = sbr.is_trail;
      mergedData.strava_best_race_km = sbr.dist_km;
      // Store VDOT-derived paces from the Strava best race so completeOnboarding
      // can use them as the authoritative source rather than Haiku-extracted paces
      // (which can accidentally come from Coach lines and be in wrong units).
      if (!sbr.is_trail) {
        mergedData.strava_vdot_tempo_pace = sbr.tempo_pace;
        mergedData.strava_vdot_interval_pace = sbr.interval_pace;
      }
    } else {
      const hasRaceData = !!(mergedData.recent_race_distance_km && mergedData.recent_race_time_minutes);
      const hasPaceData = !!mergedData.easy_pace;
      const paceNote = hasRaceData || hasPaceData
        ? " No race activity found on Strava — using pace data already collected from conversation."
        : " No races found for VDOT calculation — ask for a recent race time or PR to set training paces.";
      stravaContext = `\nSTRAVA: Connected.${weeklyLine}${frequencyLine}${longestLine}${lastRunLine}${elevLine}${progressionLine}${paceTrendLine}${hrZoneLine}${spikeLine}${paceNote}`;
    }

    } // end: !importFailed
  } else {
    // Strava is mandatory — never treat the athlete as having skipped. If a legacy
    // user has strava_skipped: true, ignore it and re-pitch Strava on the next ask.
    stravaContext = "\nSTRAVA: Not connected yet — REQUIRED before [READY]. Re-pitch with [STRAVA_LINK] if the athlete pushes back.";
  }

  const collected = summarizeCollected(mergedData);

  // ── Stage dispatch ──────────────────────────────────────────────────────────
  // Route to dedicated handlers BEFORE building the goals-stage system prompt.
  // Each stage has one job, its own focused prompt, and explicit completion logic
  // controlled by app code rather than the LLM.
  const currentStage = mergedData.stage as string | undefined;
  if (message === "(strava connected)" && mergedData.strava_connected) {
    // Post-Strava: opinionated data synthesis + ask about injury.
    return handleDataAnalysis(user, mergedData, stravaContext, chatId);
  }
  if (currentStage === "injury_intake") {
    // Injury intake: one focused follow-up probe, then deterministic completion.
    return handleInjuryIntake(user, message, mergedData, chatId);
  }
  // Falls through to goals stage (collect name + goal + race date + Strava).

  // ── Off-topic classifier ────────────────────────────────────────────────────
  // Cheap Haiku call to detect tangential questions so the goals-stage Sonnet
  // prompt can answer them naturally without confusing state advancement.
  const stageGoal = !mergedData.name ? "collect the athlete's name and what they're training for"
    : !mergedData.goal ? "confirm the athlete's training goal"
    : !mergedData.strava_connected ? "get the athlete to connect Strava"
    : "wrap up and signal ready";
  const isOffTopic = await classifyOffTopic(message, stageGoal, history);
  if (isOffTopic) {
    return handleOffTopicMessage(user, message, mergedData, stageGoal, history, chatId);
  }

  const systemPrompt = `${!isFirstResponse ? `This is an ongoing conversation. You already introduced yourself — continue naturally without re-introducing or using first-meeting phrases.

` : ""}You are Coach Dean, an AI running coach onboarding a new athlete entirely over SMS text messages.

Dean's core job: help athletes get faster without getting injured. Every conversation should calibrate both performance and injury risk from the start.

Your job: collect the information below through natural conversation, then signal you're ready with [READY].

WHAT TO COLLECT:
Required before signaling [READY] — for ALL athletes:
- Athlete's name — ask in your FIRST message, combined with the training context question. Never address the athlete as "Athlete" or use a placeholder — if you don't have their name, you must ask.
- Training goal (specific race/event name and type, or general fitness/consistency). If they have no committed race — only aspirational talk like "maybe someday" or "thinking about eventually" — their goal is return_to_running or general_fitness, NOT the race distance.
- Strava — REQUIRED. Ask right after goal is established, BEFORE injury history or any other questions. Strava is the primary data source and answers fitness questions automatically. Do NOT offer a skip option.
- Injury history — REQUIRED FOR ALL ATHLETES. Handled in a dedicated stage after Strava connects — do NOT ask about it here. If the athlete volunteers injury info, acknowledge it briefly and continue.

Additional required fields by situation:
- Race date — required for any named race goal. MANDATORY web_search before stating any date.
- Ultra background (30k+): how many ultras, any trail races — must collect before [READY]
- Goal finish time (mile/5k/10k only): pacing depends entirely on this — ask directly once goal type is confirmed.
- Race goal for trail/mountain races: ask once the race is confirmed — "Are you racing to finish, or is there a time or placement you're targeting?" Don't assume — finishing a trail race and racing competitively require very different training.
- Prior race experience (trail/mountain races): "Have you run [race name] before?" — one question, ask naturally. Course familiarity changes what to emphasize in training and sets realistic expectations.
- Training days per week: ask if Strava has no data — "How many days a week are you looking to train?" (Don't ask which specific days — the athlete chooses their own schedule. Plans are day-agnostic.)

Optional (collect passively if mentioned — do NOT ask for these):
- Fitness baseline (pace/PR): Strava provides this automatically. Only ask if Strava has no usable race data.
- Current weekly mileage: Strava provides this. Only ask if Strava has no data.
- Strength & cross-training: extract if mentioned naturally.
- Terrain type and training tools: extract passively from context.
- Training days: do NOT ask. Plans are day-agnostic.
- Goal finish time for longer races (half marathon, marathon, trail)
- Other races this season (B/C tune-up races)

WHAT YOU ALREADY KNOW:
${collected || "Nothing yet."}
${stravaContext}

CONVERSATION FLOW:
1. First message: intro + name + "what's going on or what are you working toward" in one question
2. After name + goal established (and race dates confirmed): ask the plan check question — mandatory, see PLAN CHECK below
3. After plan check is answered: ask for Strava
4. After Strava connects: dedicated injury intake stage runs automatically — you don't need to ask about it
5. Signal [READY] when name + goal + plan check answered + Strava connected

PLAN CHECK — MANDATORY STEP AFTER GOAL IS ESTABLISHED:
Once you have the athlete's name and goal (all named race dates confirmed), ask this as a standalone question BEFORE Strava:
"Are you following a training plan or working with a coach right now?"
Do NOT skip this. Do NOT combine it with another question.

When they answer YES: Ask what week of the plan they're on — that's the ONE question for this message. Example: "Got it — I work alongside it. What week are you on?" After they answer, offer to share that week's sessions (text it out or upload a PDF) and move to Strava on the next message.
When they answer NO or uncertain: "No problem — once Strava connects I'll build the plan from your data." Move to Strava immediately.
When they answer with injury context (e.g. "yeah I had a plan but the shin thing is messing it up"): acknowledge the plan status AND the injury signal, then move to Strava.

EXISTING PLAN (athlete mentions Runna, TrainingPeaks, a coach-written plan, etc.):
Dean works alongside their plan — no competing structure, no rebuilding. The plan check question makes this explicit and positions Dean correctly. When plan context is shared, acknowledge it and capture it — it informs post-run analysis framing.

INSTRUCTIONS:
- Ask ONE question per message. Not two, not a list. If you need multiple things, prioritize and ask the single most important one.
- Do not re-ask for anything listed under "what you already know" above, or anything the user has clearly stated earlier in this conversation.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- Never start a message with just the athlete's name alone on its own line. Use the name naturally within a sentence instead.
- When the athlete tells you their name for the first time, acknowledge it warmly at the start of your response — e.g. "Jake!" or "Hey Jake —" before continuing. Do NOT use "Nice to meet you" or any formal first-meeting phrase. Just use the name naturally.
- React to a race or goal with ONE concrete coaching observation — NOT generic praise, NOT a race description. Banned phrases (hard errors): "great choice!", "exciting challenge!", "big commitment!", "that sounds like a challenging", "that sounds like an exciting", "what an exciting", "sounds like a great goal", "that's exciting". A coaching observation names a specific training demand: "Snowbird's vertical is the whole race — climbing legs matter more than pacing there." Name the actual demand, not your opinion of the goal.
- If they ask a coaching question, answer it briefly, then continue naturally.
- Training days: do NOT ask which days of the week they run. Plans are day-agnostic — the athlete picks their own days. If they mention a weekly count (e.g. "5 days a week"), acknowledge it but don't follow up with "which days".
${(mergedData.preferred_units as string | null) === "metric" ? "- UNITS: This athlete prefers metric — use km for distances and min/km for paces in all messages.\n" : ""}
${isFirstResponse
  ? `- This is your FIRST message. Lead with the early-warning-signs differentiator: Dean's core value is catching injury and load problems before they sideline athletes — not just recapping data. Example opening: "Hey! I'm Coach Dean — I send a coaching note after every run you log on Strava: what it means for your training, whether to push or ease off, and what to watch for. Think of me as the thing that catches early warning signs so you can race and train without getting sidelined." Then close with a single question that invites both their name and what's going on — e.g. "What's your name, and what are you working toward (or dealing with right now)?" The "dealing with" framing naturally surfaces injuries and current concerns alongside goals. Do NOT ask name and goal as two separate questions — one question. Do NOT reference specific tools like Runna or TrainingPeaks. Do NOT say "SMS running coach" — say "AI running coach".`
  : ""}

INJURY MENTIONS IN GOALS STAGE:
Injury is the most important signal. When an athlete mentions an injury or physical issue, lead with it — treat it as the primary concern before asking anything else.

STEP 1 — Is the athlete's goal itself about recovering from injury or returning to running?
• YES (e.g. "I want to get back to running", "I've been sidelined for months", "I'm not really training right now"): Acknowledge the injury as the central challenge. Ask ONE specific question about it — where it hurts, during/after runs, or whether they've seen anyone. Then move to plan check. Do NOT mention Strava in this message.
• NO (athlete has a race or fitness goal but mentions injury in passing): Acknowledge the injury FIRST with a specific coaching statement ("Shin soreness a week out from a race — let's sort that out before we do anything else."), then pivot to the plan check question. NEVER ask detailed injury follow-ups in the goals stage (during/after/how long) — that's injury intake's job after Strava. But DO surface the injury prominently; don't bury it after goal logistics.

In ALL cases:
- Injury acknowledgment must be concrete and specific, not generic. "Shin soreness close to race day needs a clear management plan" beats "that sounds tough."
- Do NOT say "we'll be careful", "gradual progression", "training safe and progressive" — generic dismissal that signals nothing.
- Name the body part: "Left hamstring" not "that issue you mentioned".

STRAVA:
Ask about Strava after goal is established — BEFORE anything else. Write "[STRAVA_LINK]" as a placeholder — the system will replace it with the actual link. Only ask once.
EXCEPTION: For return_to_running or injury_recovery goals (athlete's primary goal is recovering from injury or getting back to running), ask ONE injury question BEFORE asking for Strava. Do NOT mention Strava in this message at all — that comes after the injury question is answered.
Do NOT write your own pitch sentence about connecting Strava (e.g. "I'll connect to Strava to read your runs and add a coaching note to each one") — the system appends that line automatically right after the link, and it accurately describes both what's read and what's written back. Writing your own version will make it appear twice, and any wording that undersells it (e.g. "read your runs automatically" alone) will contradict the write-access grant the link actually requests — the athlete can see the OAuth scope screen. Just lead naturally into [STRAVA_LINK]; a short transition or nothing at all before the placeholder is fine. Don't offer an opt-out, don't mention permission checkboxes, don't explain the technical mechanism, and don't mention friends seeing anything.
CRITICAL: Even if the athlete volunteers race history or pace info before Strava — do NOT follow up on that data yet. Ask about Strava first.
IMPORTANT: Strava ask must be a standalone turn — don't combine it with other questions. Ask only the Strava question in that message.
PLACEMENT: [STRAVA_LINK] must appear on its own line at the very end of the message.

PRICING QUESTIONS:
If the athlete asks whether this costs money, answer directly: there's a free 7-day trial. Answer in one sentence, then continue onboarding naturally.

TRAINING PACES — do NOT quote specific paces during onboarding:
Training zones are computed server-side from the athlete's data. You cannot reliably calculate VDOT-based paces in your head. Instead, acknowledge their baseline and connect it to their goal at a high level ("17:50 5K is a strong baseline — your training zones will be dialed in"). Never state a specific min/mi easy, tempo, or interval pace.

DEMONSTRATING VALUE — do this consistently, not just sometimes:
- When the athlete names their race: react with a concrete coaching insight about the timeline or what the race demands — NEVER generic praise. Banned: "Great choice!", "Awesome goal!", "That sounds like a challenging/exciting goal!", "What an exciting race!", or any sentence that expresses enthusiasm about the goal rather than coaching insight. Instead name the specific training demand or timeline constraint: "Dipsea on June 14 gives you 6 weeks — enough for a real build and proper taper, but not much margin for setbacks."
- When you receive a fitness baseline (race PR or easy pace), reflect back one specific insight connecting their data to their goal. Keep it to one sentence. Do NOT quote a specific min/mi easy pace.
- When the athlete expresses a doubt, constraint, or frustration, answer it briefly and specifically before asking your next question. This is often the highest-impact moment.
- When they mention a struggle or plateau, dig one level deeper before moving on. One follow-up question shows genuine coaching curiosity.
- Name the specific training mechanism that will address a stated struggle. Specificity is what makes this feel like real coaching.
- When the athlete mentions injury history, connect it directly to what Dean will watch for: "With IT band history, I'll flag when your weekly jump is too steep and watch your long run percentage." This makes the intake feel purposeful, not administrative.

RACE TARGET FOR TIME-GOAL ATHLETES:
If the athlete has a time goal for a specific distance but has not named a specific race, ask: "Any race on the calendar you're targeting this at?" A specific race date is essential for structuring the training timeline.

CYCLING AND TRIATHLON GOALS:
If the athlete's goal is purely cycling with no running component, be honest: "I specialize in running — I can structure a cycling plan but if pure cycling coaching is your main need, I may not be your best fit. Is running part of the mix at all?" Do not just proceed as if cycling and running coaching are equivalent.
If the athlete confirms they are cycling-only and not interested in running, wish them well and stop with a single message. After sending your farewell, treat the conversation as closed — do not send any further replies, even if the user says "thanks" or "goodbye". One exit message, full stop. Do not acknowledge, apologize, or reply again.
If the athlete is training for a triathlon, clarify your role upfront: "For triathlons I handle the run leg — I'll build your running program and check in after every run workout. For swim and bike you'd want dedicated coaching, but I'll make sure your run is dialed in."
Also ask about any physical limitations or injury history before signaling [READY] for triathlon goals — this directly affects run-specific programming.

STRAVA CONNECTED:
If the inbound message is "(strava connected)", that is a system trigger that fires a dedicated data-analysis stage — it will never reach this goals-stage prompt. Ignore this line; it's here for reference only.

RACE DATE CONFIRMATION COMES FIRST:
Whenever a "RACE DATE PRE-LOOKUP" or "RACE DATE LOOKUP FAILED" line appears anywhere in this prompt (injected at the end), your VERY NEXT message MUST address those race dates before anything else — before Strava, before any other step in the flow.
EXCEPTION — skip confirmation if the athlete already gave a specific date and the search matches: If the athlete stated a specific day + month (e.g. "June 14") AND the pre-lookup result matches that date (within 2 days), treat the date as confirmed. Do NOT ask "do those dates sound right?" — that's redundant when the athlete just told you. Only ask for confirmation when: (a) the athlete gave only a vague timeframe (e.g. "in June", "sometime in July") and the lookup found a specific date, OR (b) the lookup result conflicts with the athlete's stated date (different week or month). If the lookup failed for any race, ask the athlete directly for that race's exact date. Do not move on to Strava/anything else until every race date is confirmed in the conversation. This is because every downstream step (training weeks, taper, periodization) depends on those dates being correct.

NEVER NAME A RACE WITHOUT A CONFIRMED DATE:
Before referencing any specific race by name in your reply (e.g. "Dipsea", "Snowbird", "Boston"), that race's date must already appear under "WHAT YOU ALREADY KNOW" above OR be confirmed in the conversation. If you're about to mention a race whose date you don't know, STOP — instead ask the athlete directly: "Is [race name] still on your calendar? What's the date?" Then call web_search to verify the date once they confirm. Casually mentioning a named race without a date — even in a supportive aside ("perfect for trail races like Dipsea and Snowbird") — is a hard error: it implies you've already incorporated those races into the plan when you haven't.

MULTI-RACE CALENDARS — confirm every race:
If the athlete mentions more than one race (an A race plus B/C tune-ups), each race needs a confirmed date before [READY]. Do not signal [READY] with any race date missing or first-of-month. If a B/C race date is unknown, ask: "What's the date of [race name]?" — one question, one answer, then continue.

RACE RESPONSE RULE — NO WIKIPEDIA RECAPS:
When an athlete mentions a race they're doing, do NOT describe the race back to them (distances, elevation stats, location details). They already know the race — they signed up for it. Instead, respond with ONE coaching insight about what the race demands and why it matters for their training. Be specific and useful: e.g. "Dipsea's stairs and Snowbird's vert reward the same thing — strong hiking and climbing legs. Good double-header." Use the course data from your search to inform your insight, not to narrate it back.

RACE DATE AND COURSE PROFILE — MANDATORY SEARCH:
web_search is ONLY for looking up named race dates and course profiles. Do NOT use web_search for injury information, rehab advice, training guidance, or suggesting races the athlete hasn't named. If an athlete mentions a generic goal ("a half marathon in October") without naming a specific race, do NOT search — ask them which race they're targeting.
The moment an athlete mentions a specific named race, call web_search immediately to find the exact date AND the course profile. Do not state, confirm, or summarize any race date without first searching. Memory dates are frequently wrong, and user-provided dates are often wrong too — ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable. A month alone ("next April", "this fall") is never enough — get the specific day.
NAME COLLISION GUARD: Search results sometimes contain a different race with a confusingly similar name (e.g. same venue, different weekend — "Rocky Raccoon" vs. "Rocky 50"). Only use a result whose name matches what the athlete actually said. If the closest match isn't an exact name match, do not "correct" the athlete's date — ask them to confirm which race they mean instead.
When searching for a trail, mountain, or ultra race: also look up the course's total elevation gain (in feet), starting altitude (if it's a mountain race), and terrain character (groomed fire roads, singletrack, technical, etc.). Mention these in your response naturally so the extraction pass can capture them — e.g. "Hardrock 100 is on July 19th with about 33,000ft of gain and starting at high altitude in the San Juans." You don't need to ask the athlete for this info if you can find it from the search.
After searching: if the search result shows the race date is within the next 6 weeks AND the user is starting a new coaching relationship (not explicitly asking for race-week prep), do NOT proceed — ask first: "That's only [X] weeks away — are you looking for race-week prep for this year, or building toward [next year]?" Do not pivot to taper mode or any race-specific framing until the user confirms the year.
After searching: if the user has not stated a specific date (only a month or vague timeframe), confirm the search result with them before proceeding: "I found it listed as [date] — does that sound right?"
FIRST-OF-MONTH GUARD: If the only date information you have is a month ("in June", "sometime in July", "this fall"), do NOT proceed with the 1st of that month as a placeholder. Stop and ask: "Do you know the exact date?" A first-of-month date is almost always wrong and will miscalibrate the entire training timeline.
If no web_search tool is available to you in this context and the athlete has mentioned a race but you don't have a confirmed exact date, you MUST ask for it directly — do not proceed without it. Example: "What's the exact date of the Dipsea?" Ask this before moving on to any other question.

NEVER PROMISE ASYNC WORK YOU CAN'T DELIVER:
You cannot say "let me pull that up", "give me a moment", "I'll check and get back to you", "one sec while I look", or anything implying you'll send a follow-up message later. There is no async loop — every reply you send is the only reply that turn. If you need information you don't have (a race date, course profile, etc.), either (a) call the web_search tool inline this turn so the answer is in this same reply, or (b) ask the athlete for it directly. Do not narrate the lookup as if it were happening in the background. The user will be left staring at silence.

NEVER SEND STANDALONE HOLDING MESSAGES:
"Give me a sec", "One moment", "Got it, let me think", "Pulling that up" — these are dead-end UX moments when sent as standalone messages. There is no follow-up message coming from you. Never send an acknowledgment message and then analysis in a separate message — that's two turns that should be one. If you're doing something substantial (Strava analysis, race date lookup), use the waiting moment to ask a question so the analysis arrives after at least one exchange — making it feel earned, not automated.
After searching: if the athlete stated a specific date (day + month) and the search result is within 2 days of it, use the athlete's stated date — web results frequently have minor calendar errors, and athletes are generally right about their own races. Only override the athlete's specific date if the search shows a clearly different week or month; in that case note it (e.g. "I found it listed as [search date] — does that sound right?"). Never silently override a specific athlete-provided date with a search result that differs by just 1–2 days.

SIGNALING READY:
READY CHECK — do this before every reply: scan WHAT YOU ALREADY KNOW for these four items:
1. Name ✓
2. Goal (+ race date if a named race) ✓
3. Plan check answered ✓ (shown as "Training context: has existing plan" or "no existing plan" under WHAT YOU ALREADY KNOW)
4. Strava connected ✓ (shown as "STRAVA: Connected" in the context above)

Injury history is collected in a dedicated injury intake stage AFTER Strava connects — do NOT wait for it here.

If all three are present: signal [READY] in THIS message. Do not ask ANY follow-up question. Write a synthesis wrap-up that references the specific race (or goal), the timeline (how many weeks away), and one key observation from Strava or the conversation — then [READY] on its own line. Example: "Got it — Snowbird in 6 weeks, solid 25 miles/week base. First coaching note lands after your next run." Keep it to 1–2 sentences.

The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
[READY] IS REQUIRED ON ANY WRAP-UP: If your message says anything like "you're all set", "ready to kick off", "we're good to go", or otherwise signs off without a question, you MUST include [READY] on its own line.
Name is always required — if the user hasn't told you their name yet, ask before signaling [READY].
CRITICAL — [READY] means zero open questions: [READY] can only appear in a message that contains NO questions of any kind. The moment you add a question mark to a message, [READY] is off the table for that turn.
WORD ACCURACY: The term is "aerobic" (related to oxygen use / endurance). Never write "aerodynamic" — that's about airflow over a bike or car, not running physiology.

ULTRA AND INJURY GOALS — extra required fields:
For ultra goals (30k, 50k, 50mi, 100k, 100mi): you MUST ask about their ultra/trail race history before signaling [READY].
For return_to_running or injury_recovery goals: you MUST ask about the injury/limitation and current status before [READY].`;

  // Treat a stored first-of-month date as suspect (month-only guess) and re-search.
  const isFirstOfMonth = (d: unknown) => typeof d === "string" && /^\d{4}-\d{2}-01$/.test(d);
  // Lookup is needed if the A race has no confirmed date OR any named B/C race
  // is missing a date — both must be confirmed before [READY].
  // mergedData reflects the just-extracted race names from this turn's user message,
  // so a freshly-mentioned race triggers pre-search this same turn (no async loop).
  const otherRacesNeedingDate = (
    (mergedData.other_races as Array<{ name?: string | null; date?: string | null }> | null) ?? []
  ).some((r) => r?.name && (!r.date || isFirstOfMonth(r.date)));
  const needsRaceDateLookup =
    !mergedData.race_date || isFirstOfMonth(mergedData.race_date) || otherRacesNeedingDate;
  const isOpenAI = (process.env.AI_PROVIDER ?? "anthropic") === "openai";

  // On OpenAI, gpt-4o-search-preview has a 6000 TPM hard limit — far too small for
  // the full onboarding system prompt + conversation history. Instead, run a minimal
  // pre-search call (~100 tokens) to look up the race date using race names from the
  // just-extracted mergedData. Main call uses gpt-4o (no search).
  let raceDateInjection = "";
  if (isOpenAI) {
    const raceName = mergedData.race_name as string | null;
    // Collect B/C race names that are missing or have first-of-month placeholder dates
    const otherRaces = (mergedData.other_races as Array<{ name?: string | null; date?: string | null; priority: string }> | null) ?? [];
    const otherRaceNames = otherRaces
      .filter((r) => r.name && (!r.date || isFirstOfMonth(r.date)))
      .map((r) => r.name as string);

    const searchPromises: Array<Promise<void>> = [];

    if (raceName && needsRaceDateLookup) {
      searchPromises.push(
        preSearchRaceDate(raceName).then((date) => {
          if (date) {
            raceDateInjection += `\nRACE DATE PRE-LOOKUP: "${raceName}" is on ${date}. Present this date to the athlete and confirm it sounds right. Do not search again.`;
          } else {
            raceDateInjection += `\nRACE DATE LOOKUP FAILED: Could not find the exact date for "${raceName}" online. You MUST ask the athlete directly: "What's the exact date of ${raceName}?" Do not proceed or signal [READY] until you have a confirmed date.`;
          }
        })
      );
    }

    for (const name of otherRaceNames) {
      searchPromises.push(
        preSearchRaceDate(name).then((date) => {
          if (date) {
            raceDateInjection += `\nSECONDARY RACE PRE-LOOKUP: "${name}" is on ${date}. Confirm with athlete: "I found ${name} listed as ${date} — does that sound right?"`;
          } else {
            raceDateInjection += `\nSECONDARY RACE LOOKUP FAILED: Could not find exact date for "${name}". Ask the athlete: "What's the exact date of ${name}?"`;
          }
        })
      );
    }

    if (searchPromises.length > 0) await Promise.all(searchPromises);

    // If any lookups ran, wrap in a <rule> tag so Dean treats this as a hard
    // directive rather than soft guidance. Per the "RACE DATE CONFIRMATION
    // COMES FIRST" section, race date confirmation must precede mode/Strava.
    if (raceDateInjection) {
      raceDateInjection = `\n\n<rule>RACE DATE CONFIRMATION REQUIRED — address ALL of the below in your NEXT reply before moving to mode/Strava/anything else:${raceDateInjection}\n</rule>`;
    }
  }

  const claudeResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 600,
    system: systemPrompt + raceDateInjection,
    messages: [...history, { role: "user", content: message }],
    // On OpenAI: search tools omitted — pre-search above handles race date lookup.
    // On Anthropic: pass web_search so Claude can search inline (no TPM constraint).
    ...(needsRaceDateLookup && !isOpenAI ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" }] } : {}),
  });

  // Extract final text (post-search text blocks only, discarding pre-search reasoning)
  // The hosted web_search tool returns "server_tool_use" blocks (not "tool_use"),
  // so we must check both types to correctly discard pre-search text.
  let rawText = "";
  let lastToolIdx = -1;
  for (let i = 0; i < claudeResponse.content.length; i++) {
    const t = claudeResponse.content[i].type;
    if (t === "tool_use" || t === "server_tool_use") lastToolIdx = i;
  }
  for (let i = lastToolIdx + 1; i < claudeResponse.content.length; i++) {
    const block = claudeResponse.content[i];
    if (block.type === "text") rawText += block.text;
  }
  if (!rawText.trim()) {
    // Fallback: no tool use, take all text blocks
    for (const block of claudeResponse.content) {
      if (block.type === "text") rawText += (block as { type: "text"; text: string }).text;
    }
  }

  // Strip re-introduction on non-first messages. The model re-introduces itself ("I'm Coach Dean,
  // your AI running coach...") regardless of instructions. Detect by presence of "I'm Coach Dean"
  // near the start, then find the first actual question and start from there.
  if (!isFirstResponse) {
    if (/i'm coach dean/i.test(rawText.slice(0, 400))) {
      const qIdx = rawText.indexOf("?");
      if (qIdx !== -1) {
        const before = rawText.slice(0, qIdx);
        const nlIdx = before.lastIndexOf("\n");
        const dotIdx = before.lastIndexOf(". ");
        const sentenceStart = Math.max(nlIdx + 1, dotIdx + 2);
        rawText = rawText.slice(sentenceStart > 0 ? sentenceStart : 0).trimStart();
      }
    }
    // Note: we intentionally do NOT strip "Nice/Great to meet you" here — those are valid warm
    // acknowledgments when the athlete first tells Dean their name. The prompt instructs Dean
    // to use the name naturally rather than generic first-meeting phrases, which is sufficient.
  }

  // Parse signals
  const wantsStravaLink = /\[STRAVA_LINK\]/i.test(rawText);
  const wantsDashboardLink = /\[DASHBOARD_LINK\]/i.test(rawText);
  // [DASHBOARD_LINK] implies wrap-up — Dean only emits it at the final signoff.
  // Treat it as implicit [READY] so a missing [READY] on a terminal message
  // doesn't leave the athlete stuck in "onboarding" with no plan generated.
  const isReady = /\[READY\]/i.test(rawText) || wantsDashboardLink;

  // Build responseText and (when Strava is requested) a separate stravaMsg.
  // Split at the paragraph containing [STRAVA_LINK] so:
  //   responseText = whatever Claude said before the Strava ask (may be empty)
  //   stravaMsg    = the Strava pitch + URL (always one coherent message)
  let responseText: string;
  let stravaMsg: string | null = null;

  if (wantsStravaLink && !mergedData.strava_connected) {
    const paragraphs = rawText.split(/\n{2,}/);
    const stravaParaIdx = paragraphs.findIndex(p => /\[STRAVA_LINK\]/i.test(p));
    const beforeStrava = paragraphs
      .slice(0, stravaParaIdx)
      .join("\n\n")
      .replace(/\[READY\]/gi, "")
      .replace(/\[MODE:(?:FROM_SCRATCH|COMPLEMENT|NO_PLAN)\]/gi, "")
      .trim();
    const stravaParagraph = paragraphs[stravaParaIdx]
      .replace(/\[STRAVA_LINK\]/gi, "")
      .replace(/\[READY\]/gi, "")
      .replace(/\[MODE:(?:FROM_SCRATCH|COMPLEMENT|NO_PLAN)\]/gi, "")
      .trim();
    responseText = beforeStrava;
    const writeUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;
    stravaMsg = `${stravaParagraph ? stravaParagraph + "\n\n" : ""}${writeUrl}\n\nI'll connect to Strava to read your runs and add a coaching note to each one.`;
  } else {
    responseText = rawText
      .replace(/\[READY\]/gi, "")
      .replace(/\[STRAVA_LINK\]/gi, "")
      .replace(/\[MODE:(?:FROM_SCRATCH|COMPLEMENT|NO_PLAN)\]/gi, "")
      .trim();
  }

  // Substitute [DASHBOARD_LINK] with the athlete's dashboard URL. Generate a
  // dashboard_token if one doesn't exist yet so the link is usable immediately.
  if (wantsDashboardLink) {
    const { data: dashUser } = await supabase
      .from("users")
      .select("dashboard_token")
      .eq("id", user.id)
      .single();
    let dashboardToken = dashUser?.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      await supabase.from("users")
        .update({ dashboard_token: dashboardToken })
        .eq("id", user.id);
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    const dashboardUrl = `${appUrl}/dashboard?token=${dashboardToken}`;
    responseText = responseText.replace(/\[DASHBOARD_LINK\]/gi, dashboardUrl);
  } else {
    // Safety net: if Dean mentioned [DASHBOARD_LINK] but got split into stravaMsg,
    // or if it slipped through any other path, strip the raw placeholder.
    responseText = responseText.replace(/\[DASHBOARD_LINK\]/gi, "").trim();
  }

  // Normalize whitespace — Claude occasionally wraps URLs with extra blank lines
  // or leading indent, which renders as awkward gaps in SMS.
  responseText = responseText
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Strip any ⚠️-prefixed reasoning preamble Claude may have output (e.g. "⚠️ CRITICAL …\n\n")
  // and "RESPONSE:" label separators — these are internal directives that must never reach the athlete.
  if (/^RESPONSE:\s*/im.test(responseText)) {
    const m = responseText.match(/^RESPONSE:\s*/im);
    if (m && m.index !== undefined) {
      const after = responseText.slice(m.index + m[0].length).trim();
      if (after) responseText = after;
    }
  } else {
    const paras = responseText.split(/\n{2,}/);
    let firstOk = 0;
    while (firstOk < paras.length - 1 && /^⚠️/.test(paras[firstOk].trim())) firstOk++;
    if (firstOk > 0) responseText = paras.slice(firstOk).join("\n\n").trim();
  }

  // Safety net: strip any <rule>...</rule> blocks that leaked into the output.
  // The raceDateInjection wraps pre-search results in <rule> tags; Dean is
  // instructed not to echo them but this enforces it at runtime.
  responseText = responseText.replace(/<rule>[\s\S]*?<\/rule>/gi, "").trim();

  // Strip all web search citation artifacts — SMS doesn't render links
  // 1. Markdown links: [text](url) → text
  responseText = responseText.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1");
  // 2. Bare domain citations: (dipsea.org), (cirqueseries.com), (utahvalleymarathon.com)
  responseText = responseText.replace(/\s*\([a-zA-Z0-9][a-zA-Z0-9.\-]*\.(com|org|net|io|ai|co|gov|edu|info|app|dev|run|health|fitness|sport)\b[^)]*\)/gi, "");
  // 3. Full URL citations in parentheses: (https://example.com/...)
  responseText = responseText.replace(/\s*\(https?:\/\/[^)]+\)/g, "");
  responseText = responseText.trim();

  // Note: extraction + VDOT calculation already ran at the top of this function
  // on [history + current user message] so race names could feed the OpenAI
  // pre-search loop. Assistant-introduced fields (race elevation/altitude from
  // Dean's web search) get captured next turn when the assistant reply lands in
  // history.

  // Store user's inbound message
  await insertConversation({
    user_id: user.id,
    role: "user",
    content: message,
    message_type: "user_message",
  });

  // Empty-response guard: if the model returned no text (or only [READY]/placeholders
  // that were stripped away), sending an empty SMS would leave the athlete staring
  // at silence — the exact failure pattern reported when a 5K time came in and Dean
  // went quiet. Fall back to a short acknowledgment so the conversation never stalls.
  const cleanedResponse = responseText.trim();
  if (!cleanedResponse && !stravaMsg) {
    console.warn("[onboarding] empty responseText after cleanup — sending fallback ack");
    responseText = "Got it — one sec.";
  }

  if (isReady) {
    // Strava gate: Coach Dean's value depends on reading every run automatically.
    // Without Strava, the post-run insights (cadence, decoupling, GAP, splits)
    // that are the core product never fire — the athlete eventually loses trust
    // and churns. Block [READY] when Strava is not connected and re-pitch it.
    // Only exception: athletes who can't run yet (return_to_running, injury_recovery)
    // can complete onboarding without Strava because they may have no recent activity.
    const goalForGate = mergedData.goal as string | null | undefined;
    const stravaConnected = !!mergedData.strava_connected;
    const stravaExempt = goalForGate === "return_to_running" || goalForGate === "injury_recovery";
    if (!stravaConnected && !stravaExempt) {
      console.warn("[onboarding] [READY] fired but Strava not connected — re-pitching Strava");
      await supabase.from("users")
        .update({
          onboarding_step: "awaiting_strava",
          onboarding_data: mergedData as unknown as Json,
        })
        .eq("id", user.id);
      const writeUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;
      const pitch = `Before we kick off — I need Strava to coach you properly. I'll read every run and add a coaching note to each one. Takes two minutes:\n\n${writeUrl}`;
      await sendAndStore(user.id, user.phone_number, pitch, "awaiting_strava");
      return NextResponse.json({ ok: true });
    }

    // Save final data and complete onboarding
    await supabase.from("users")
      .update({ onboarding_data: mergedData as unknown as Json })
      .eq("id", user.id);
    if (responseText.trim()) {
      await sendAndStore(user.id, user.phone_number, responseText.trimEnd(), "onboarding");
    }
    await completeOnboarding(user, mergedData, chatId, { dashboardLinkSentInWrapUp: wantsDashboardLink });
    return NextResponse.json({ ok: true });
  }

  if (wantsStravaLink && !mergedData.strava_connected) {
    // Claude asked about Strava — pause conversation until user connects.
    // Strava is mandatory; "skip" is no longer a valid path.
    await supabase.from("users")
      .update({
        onboarding_step: "awaiting_strava",
        onboarding_data: mergedData as unknown as Json,
      })
      .eq("id", user.id);
    if (responseText) await sendAndStore(user.id, user.phone_number, responseText.trimEnd(), "awaiting_strava");
    if (stravaMsg) await sendAndStore(user.id, user.phone_number, stravaMsg, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  // Continue conversation
  await supabase.from("users")
    .update({ onboarding_data: mergedData as unknown as Json })
    .eq("id", user.id);
  await sendAndStore(user.id, user.phone_number, responseText.trimEnd(), "onboarding");
  return NextResponse.json({ ok: true });
}

/** Summarize collected onboarding data for the system prompt. */
function summarizeCollected(data: Record<string, unknown>): string {
  const lines: string[] = [];

  if (data.name) lines.push(`Name: ${data.name}`);
  if (data.goal) {
    const distSuffix = data.goal_distance_miles ? `, ${data.goal_distance_miles} mi` : "";
    const goalStr = data.race_name
      ? `${data.race_name} (${data.goal}${distSuffix})`
      : (data.goal as string);
    lines.push(`Goal: ${goalStr}`);
  }
  if (data.race_date) {
    const formatted = new Date((data.race_date as string) + "T12:00:00Z")
      .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const daysUntil = Math.round(
      (new Date((data.race_date as string) + "T12:00:00Z").getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    );
    const weeksUntil = Math.round(daysUntil / 7);
    // Computed once here so every turn states the same countdown — leaving this to the
    // model to recompute from the calendar date each message is exactly how "5 weeks
    // out," "6 weeks to [race]," and "6 weeks out" ended up in three different messages
    // of the same conversation (see 2026-07-22 changelog on race-countdown drift).
    lines.push(`Race date: ${formatted} (${daysUntil} days / ${weeksUntil} week${weeksUntil !== 1 ? "s" : ""} away — always use this exact figure when stating the countdown; never recompute it from the date yourself)`);
  }
  if (data.goal_time_minutes) {
    const h = Math.floor((data.goal_time_minutes as number) / 60);
    const m = Math.round((data.goal_time_minutes as number) % 60);
    lines.push(`Goal time: ${h > 0 ? `${h}h ` : ""}${m}min`);
  }
  if (data.days_per_week) lines.push(`Runs per week: ${data.days_per_week}`);
  if (Array.isArray(data.training_tools) && (data.training_tools as string[]).length > 0) {
    lines.push(`Training tools: ${(data.training_tools as string[]).join(", ")}`);
  }
  if (data.terrain_type) lines.push(`Terrain: ${data.terrain_type}`);
  if (data.has_existing_plan != null) {
    const planCtx = data.has_existing_plan
      ? "has existing plan (Dean works alongside it)"
      : "no existing plan";
    lines.push(`Training context: ${planCtx}`);
  }
  if (data.plan_uploaded) {
    const name = data.plan_filename ? ` ("${(data.plan_filename as string).replace(/\.pdf$/i, "")}")` : "";
    lines.push(`Training plan uploaded${name} — content available in context. Do NOT ask the athlete to send it again.`);
  }
  if (data.external_plan_description) lines.push(`Current plan: ${data.external_plan_description}`);
  if (data.plan_current_week) lines.push(`Currently on plan week: ${data.plan_current_week}`);
  if (data.weekly_miles) lines.push(`Current weekly mileage: ~${data.weekly_miles} miles`);
  if (data.easy_pace) {
    const range = easyPaceRange(data.easy_pace as string);
    lines.push(`Easy pace range: ${range ?? `${data.easy_pace}/mi`} — use this exact range when telling the athlete their easy pace`);
  }
  if (data.recent_race_distance_km && data.recent_race_time_minutes) {
    const mins = data.recent_race_time_minutes as number;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    const timeStr = h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}:00`;
    lines.push(`Recent race PR: ${data.recent_race_distance_km}km in ${timeStr}`);
  }
  if (data.injury_history) lines.push(`Injury history: ${data.injury_history}`);
  if (data.current_niggles) lines.push(`Current niggles: ${data.current_niggles}`);
  if (data.injury_notes) lines.push(`Injury/limitation: ${data.injury_notes}`);
  if (data.injury_management) lines.push(`What they're doing for it: ${data.injury_management}`);
  if (data.reported_during) lines.push(`Injury timing: pain reported ${data.reported_during} runs`);
  if (data.injury_pain_character === "localized_or_rest_pain") lines.push(`RED FLAG: shin/tibia pain described as one specific spot or present at rest — possible stress fracture. Do not recommend continuing to run or add load (including easy miles or incline treadmill work) until the athlete confirms they've been checked by a doctor.`);
  if (data.avg_sleep_hours) lines.push(`Avg sleep: ${data.avg_sleep_hours} hours/night`);
  if (data.strength_habits) lines.push(`Strength/cross-training: ${data.strength_habits}`);
  if (data.ultra_race_history) lines.push(`Ultra background: ${data.ultra_race_history}`);
  if (data.preferred_units) lines.push(`Units preference: ${data.preferred_units}`);
  if (data.timezone) lines.push(`Timezone: ${data.timezone}`);
  if (data.strava_city) {
    const loc = data.strava_state ? `${data.strava_city}, ${data.strava_state}` : (data.strava_city as string);
    lines.push(`Location (from Strava): ${loc}`);
  }
  if (Array.isArray(data.other_races) && (data.other_races as unknown[]).length > 0) {
    const raceList = (data.other_races as Array<{ name: string | null; date: string | null; priority: string }>)
      .map((r) => `${r.name ?? "unnamed"} (${r.priority}, ${r.date ?? "no date"})`).join("; ");
    lines.push(`Other races: ${raceList}`);
  }

  return lines.join("\n");
}

/** Extract structured training fields from a conversation using Claude Haiku (tool use). */
async function extractFields(
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().split("T")[0];

  // Build a readable transcript for extraction
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`)
    .join("\n\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 700,
    system: `Extract training data clearly stated in this conversation and call save_training_fields. Today is ${today}.

Rules:
- Only extract data clearly stated in the conversation. Do not infer or guess. Use null for anything not mentioned.
- name: NEVER extract "Athlete" as the name — that is a transcript label, not the person's name. Only extract a name if the user explicitly stated it (e.g. "I'm Jake", "My name is Sarah").
- goal: use "trail_race" for trail/mountain races that aren't standard road distances. Use standard buckets (5k, 10k, half_marathon, marathon) only for road races at those distances. If the athlete has no committed race — only aspirational talk — use "return_to_running" or "general_fitness", NOT the race distance. For triathlon goals, use null (we handle run-only coaching for triathletes).
- has_existing_plan: true if the athlete explicitly confirms they are currently following a training plan or working with a coach (e.g. "yes, I'm on a Runna plan", "I have a coach", "yeah I'm following a program"). false if they explicitly say they have no plan or coach (e.g. "no, I'm just running on my own", "no plan", "no coach"). null if the plan check question hasn't been asked and answered yet — do NOT infer from context alone.
- external_plan_description: capture a brief factual summary when the athlete describes their current external plan (source/name, current week, weekly mileage). E.g. "Runna 16-week half marathon plan, week 6, ~35mi/week". Null if no current plan or if they only said yes without describing it yet. Do NOT capture a plan Dean is going to build.
- plan_current_week: the week number the athlete is currently on in their training plan (e.g. "I'm on week 8", "week 6 of my plan" → 8 or 6). Extract as a number. Null if not mentioned.
- training_days: lowercase full names only. Ranges like "Tues-Thursday" expand to ALL days inclusive → ["tuesday","wednesday","thursday"].
- goal_time_minutes: the athlete's explicit goal finish time for their TARGET race (e.g. "I want to break 4 hours", "sub-20 5K"). Do NOT use a past PR or best time as the goal time unless the athlete says it IS their goal (e.g. "my goal is to beat my 17:50 PR"). A statement like "my fastest 5K is 17:50" or "my PR is 3:45" is a fitness baseline — extract it as recent_race_time_minutes, NOT as goal_time_minutes. Total float minutes: "1:30" → 90.0, "17:40" → 17.67, "2:25:00" → 145.0.
- race_date: use whichever date is stated in the conversation — athlete's or Dean's. If both are stated and differ by 1–2 days, prefer the athlete's. If only a month was given with no specific day (e.g. "in June", "sometime in July"), return null — do NOT default to the 1st of that month. Only extract a first-of-month date if the athlete explicitly said "the 1st" or "June 1st". Today is ${today}.
- recent_race_distance_km: ONLY from lines labeled "Athlete:" in the transcript — NEVER from "Coach:" lines, Strava summaries, or race data the coach mentions. This captures the athlete's road race PR they state in their own words (e.g. "my fastest 5K is 17:50", "I ran a 1:38 half last fall"). Trail races (Dipsea, ultras, mountain races, any race with "trail" in the name) are NOT eligible — leave null even if the athlete mentions them. If the coach references a Strava trail race (e.g. "your Dipsea 30K"), do NOT extract that distance. Extract even if caveated ("net downhill", "a while ago").
- recent_race_time_minutes: ONLY from lines labeled "Athlete:" — never from "Coach:" lines. M:SS → "18:45" = 18.75. H:MM:SS → "1:05:30" = 65.5. Use the most recent road race time (not trail, not Strava coach summaries). If only a trail time is mentioned by the athlete, leave null.
- easy_pace: the athlete's stated easy running pace — "M:SS" format (e.g. "8:30" = 8 min 30 sec/mile). ONLY from lines labeled "Athlete:" — never from "Coach:" lines, training plan content, PDF attachments, or pace suggestions the coach provides. If Dean says "your easy pace is 9:30/mi" but the athlete never stated it themselves, leave null.
- preferred_units: 'metric' if the athlete mentions distances in km, paces in min/km, or writes primarily in a non-English language (French, Spanish, German, etc.). 'imperial' if they explicitly reference miles or min/mile. null if not determinable from the conversation.
- timezone: IANA string from location ("Provo, UT" → "America/Denver").
- race_name: extract the named target race when the athlete names one (e.g. "Dipsea", "Boston Marathon", "Snowbird Cirque Series"). Capture the name as stated, even if no date is given — the system will look up the date separately. If the athlete names multiple races, race_name is the primary/A race; the rest go into other_races.
- other_races: B/C secondary races only, not the main A race. Always include named races the athlete mentions even if the date isn't given (use null date) — capturing the name lets the system pre-search the date next turn. Same date rule as race_date: if only a month was given with no specific day, omit the date or leave it null — do NOT default to the 1st of the month.
- ultra_race_history: summarize any ultra/trail background mentioned, even if none.
- injury_history: summarize any historical injuries the athlete has had (past injuries they've recovered from, recurring issues, injury-prone areas). Extract from the athlete's own words only. Null if not mentioned.
- current_niggles: any current aches, pain, or issues the athlete is managing right now (distinct from past injury history). Null if not mentioned.
- injury_management: what the athlete is doing to manage a current injury — physical therapy, rest, icing, stretching protocol, seeing a doctor or physio, etc. Extract from the athlete's own words. Null if not mentioned or no current injury.
- reported_during: when the injury pain occurs — 'during' if they feel it while running, 'after' if only after finishing, 'both' if during and after. Null if not mentioned.
- injury_pain_character: for shin/tibia pain specifically — 'diffuse' if described as a general ache along the bone that's worse during/after running and eases with rest (typical shin splints), 'localized_or_rest_pain' if there's one specific painful spot, or pain present even at rest/walking/at night (possible stress fracture — needs medical evaluation before more loading). Null if not mentioned or not shin/tibia-related.
- avg_sleep_hours: if the athlete mentions how many hours of sleep they get (e.g. "I sleep about 7 hours", "usually 6-7 hours"), extract as a number. Null if not mentioned.
- strength_habits: a brief description of the athlete's strength training and cross-training habits — what they do, how often. Examples: "3x/week lifting, no cross-training", "yoga 2x/week, cycling occasionally", "no strength work". Null if not mentioned.
- cross_training_activities: array of cross-training activities the athlete does (e.g. ['cycling', 'swimming', 'yoga', 'lifting']). Null if not mentioned.
- wants_speed_work: true if athlete explicitly asks for speed work. Null otherwise.
- training_tools: array of tools mentioned (lowercase: 'runna', 'trainingpeaks', 'garmin', 'self_directed', 'other'). Null if not mentioned.
- terrain_type: 'road', 'trail', or 'mixed' based on what athlete says. Null if not mentioned.
- other_notes: any training preferences, dislikes, or context not captured elsewhere (e.g. "loves hills", "hates treadmills", "prefers morning runs"). Do not duplicate what's in injury_notes or strength_habits.
- race_elevation_gain_feet: if Dean's message mentions total elevation gain for the goal race (e.g. "33,000ft of gain", "8,500 feet of climbing"), extract that number in feet. Null if not mentioned.
- race_elevation_loss_feet: if total descent is mentioned separately, extract it. Usually equal to gain for out-and-back or loop courses; null if not mentioned.
- race_altitude_ft: if the race start or course altitude is mentioned (e.g. "starts at 9,000ft", "high altitude race"), extract in feet. Null if not mentioned.
- race_trail_subtype: classify the trail character if described. Groomed = fire roads, well-maintained singletrack. Mixed = standard dirt trail with some rocks/roots. Technical = rocky, rooty, requires careful footing. Highly_technical = scrambling, sustained technical terrain. Null if not mentioned or it's a road race.`,
    messages: [{ role: "user", content: transcript }],
    tools: [{
      name: "save_training_fields",
      description: "Save the extracted training fields from the conversation.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: ["string", "null"] },
          goal: { type: ["string", "null"], enum: ["mile", "5k", "10k", "half_marathon", "marathon", "trail_race", "30k", "50k", "50mi", "100k", "100mi", "cycling", "general_fitness", "return_to_running", "injury_recovery", null] },
          race_name: { type: ["string", "null"] },
          race_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
          goal_distance_miles: { type: ["number", "null"] },
          goal_time_minutes: { type: ["number", "null"] },
          training_days: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
          days_per_week: { type: ["number", "null"] },
          easy_pace: { type: ["string", "null"] },
          tempo_pace: { type: ["string", "null"] },
          interval_pace: { type: ["string", "null"] },
          weekly_miles: { type: ["number", "null"] },
          recent_race_distance_km: { type: ["number", "null"] },
          recent_race_time_minutes: { type: ["number", "null"] },
          injury_notes: { type: ["string", "null"] },
          ultra_race_history: { type: ["string", "null"] },
          injury_history: { type: ["string", "null"], description: "Historical injuries the athlete has had in the past — not current issues. E.g. 'IT band issues in 2023, stress fracture 2022'." },
          current_niggles: { type: ["string", "null"], description: "Current aches or pain the athlete is managing right now." },
          injury_management: { type: ["string", "null"], description: "What the athlete is doing to manage a current injury — PT, rest, ice, stretching, seeing a physio, etc. Only from athlete's own words." },
          strength_habits: { type: ["string", "null"], description: "Description of strength training and cross-training habits, including frequency. E.g. '2x/week lifting, no cross-training'." },
          cross_training_activities: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "Cross-training activities the athlete does, e.g. ['cycling', 'swimming', 'yoga', 'lifting']"
          },
          lifting_days: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "Days of the week the athlete lifts weights, lowercase 3-letter abbreviations (e.g. ['tue', 'thu']). Only set when athlete explicitly states days. Null if they only mention frequency (e.g. '3x/week') without naming days."
          },
          leg_lift_days: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "Subset of lifting_days that are leg-focused (squats, deadlifts, leg day). Only set when athlete distinguishes leg days from upper-body days."
          },
          active_injury: { type: ["boolean", "null"], description: "True if the athlete describes a CURRENT injury they're managing right now (e.g. 'my achilles is still bothering me', 'recovering from a stress fracture'). False/null for historical injuries that are resolved." },
          injury_severity: { type: ["string", "null"], enum: ["mild", "moderate", "severe", null], description: "Severity of the current active injury. mild=annoyance, can run modified. moderate=skipping some sessions, modifying others. severe=cannot run at all." },
          injury_body_part_current: { type: ["string", "null"], description: "Body part of the CURRENT active injury (e.g. 'left achilles', 'right knee'). Null for historical injuries." },
          reported_during: { type: ["string", "null"], enum: ["during", "after", "both", null], description: "When the injury pain occurs relative to running. 'during' = feels it while running, 'after' = feels it after finishing, 'both' = during and after. Null if not mentioned." },
          injury_pain_character: { type: ["string", "null"], enum: ["diffuse", "localized_or_rest_pain", null], description: "Shin/tibia pain only. 'diffuse' = general ache along the bone, eases with rest — typical shin splints. 'localized_or_rest_pain' = one specific painful spot, or pain even at rest/walking/night — possible stress fracture, needs medical evaluation before more loading. Null if not shin-related or not mentioned." },
          avg_sleep_hours: { type: ["number", "null"], description: "Average hours of sleep per night the athlete gets. E.g. '7 hours' → 7.0, '6-7 hours' → 6.5. Null if not mentioned." },
          experience_years: { type: ["number", "null"] },
          other_races: {
            oneOf: [
              {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", description: "YYYY-MM-DD. If only a month was given with no specific day, do NOT default to the 1st — leave null or omit. Only use first-of-month if the athlete explicitly said so." },
                    name: { type: ["string", "null"] },
                    goal: { type: ["string", "null"] },
                    priority: { type: "string", enum: ["B", "C"] },
                    goal_distance_miles: { type: ["number", "null"] },
                  },
                  required: ["date", "priority"],
                },
              },
              { type: "null" },
            ],
          },
          timezone: { type: ["string", "null"] },
          wants_speed_work: { type: ["boolean", "null"] },
          training_tools: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "Tools the athlete uses: 'runna', 'trainingpeaks', 'garmin', 'self_directed', 'other', etc."
          },
          terrain_type: { type: ["string", "null"], enum: ["road", "trail", "mixed", null], description: "Primary running terrain" },
          preferred_units: { type: ["string", "null"], enum: ["metric", "imperial", null], description: "Unit system the athlete prefers. 'metric' if they use km/min-per-km or write in non-English. 'imperial' if they reference miles. null if unclear." },
          has_existing_plan: { type: ["boolean", "null"], description: "true if athlete confirms they have an existing plan or coach, false if they confirm they don't, null if plan check question hasn't been answered yet." },
          external_plan_description: { type: ["string", "null"], description: "Brief factual summary of athlete's current external plan: source/name, current week, weekly mileage. E.g. 'Runna 16-week HM plan, week 8, ~40mi/week'. Null if no current plan — NEVER capture a plan Dean is going to build." },
          plan_current_week: { type: ["number", "null"], description: "The week number the athlete is currently on in their training plan (e.g. 'I'm on week 8' → 8). Null if not mentioned." },
          other_notes: { type: ["string", "null"] },
          race_elevation_gain_feet: { type: ["number", "null"], description: "Total elevation gain of the goal race course in feet. Extract from Dean's web search results if mentioned in the transcript." },
          race_elevation_loss_feet: { type: ["number", "null"], description: "Total elevation loss (descent) of the goal race course in feet." },
          race_altitude_ft: { type: ["number", "null"], description: "Starting or peak altitude of the race in feet. Extract if the race is a mountain race and altitude was mentioned in the transcript." },
          race_trail_subtype: { type: ["string", "null"], enum: ["groomed", "mixed", "technical", "highly_technical", null], description: "Trail character: groomed=fire roads/groomed singletrack, mixed=dirt/moderate rocks, technical=rocky/rooty/challenging, highly_technical=scrambling/extreme terrain." },
        },
        required: [],
      },
    }],
    tool_choice: { type: "tool" as const, name: "save_training_fields" },
  });

  const toolBlock = response.content.find(b => b.type === "tool_use" && b.name === "save_training_fields");
  if (toolBlock && toolBlock.type === "tool_use") {
    return (toolBlock.input as Record<string, unknown>) ?? {};
  }
  console.error("[onboarding] extractFields: no tool_use block returned");
  return {};
}

// ---------------------------------------------------------------------------
// Data Analysis Stage — post-Strava opinionated synthesis + injury question
// ---------------------------------------------------------------------------

async function handleDataAnalysis(
  user: { id: string; phone_number: string; name: string | null },
  data: Record<string, unknown>,
  stravaContext: string,
  chatId?: string | null
): Promise<NextResponse> {
  void chatId;
  const injuryAlreadyCollected = !!(data.injury_history || data.current_niggles || data.injury_notes);
  const rawName = (data.name as string | null) || user.name || null;
  const firstName = rawName ? rawName.split(" ")[0] : null;
  const raceName = data.race_name as string | null;
  const raceDate = data.race_date as string | null;
  const goal = data.goal as string | null;
  const otherRaces = (data.other_races as Array<{ name?: string | null; date?: string | null; priority: string }> | null) ?? [];

  // Build race context for the prompt
  let raceContext = "";
  if (raceName && raceDate) {
    const weeksUntil = Math.round(
      (new Date(raceDate + "T12:00:00Z").getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)
    );
    raceContext = `${raceName} on ${raceDate} (${weeksUntil} week${weeksUntil !== 1 ? "s" : ""} away)`;
    const otherWithDates = otherRaces.filter(r => r.name && r.date);
    if (otherWithDates.length > 0) {
      const others = otherWithDates.map(r => {
        const w = Math.round((new Date(r.date! + "T12:00:00Z").getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000));
        return `${r.name} (${w}w)`;
      }).join(", ");
      raceContext += `. Secondary: ${others}`;
    }
  } else if (goal) {
    raceContext = goal.replace(/_/g, " ");
  }

  // Query race history from DB — background import may have completed by now,
  // giving us more than the 8-week window from the sync import.
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const { data: pastRaceRows } = await supabase
    .from("activities")
    .select("activity_name, start_date, distance_meters, moving_time_seconds")
    .eq("user_id", user.id)
    .eq("workout_type", 1)
    .gte("start_date", oneYearAgo)
    .order("start_date", { ascending: false })
    .limit(5);

  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };
  const raceHistoryLines = (pastRaceRows ?? [])
    .filter(r => r.activity_name && r.start_date)
    .map(r => {
      const distKm = Math.round((r.distance_meters ?? 0) / 100) / 10;
      const time = r.moving_time_seconds ? fmtTime(r.moving_time_seconds) : "";
      const month = new Date(r.start_date!).toLocaleDateString("en-US", { month: "short", year: "numeric" });
      return `  - ${r.activity_name} (${month}${distKm > 0 ? `, ${distKm} km` : ""}${time ? `, ${time}` : ""})`;
    });
  const raceHistorySection = raceHistoryLines.length > 0
    ? `\nRACE HISTORY (last 12 months from Strava):\n${raceHistoryLines.join("\n")}`
    : "";

  const injuryContext = [
    data.current_niggles as string | null,
    data.injury_notes as string | null,
    data.injury_history as string | null,
  ].filter(Boolean).join("; ") || null;

  const systemPrompt = `You are Coach Dean, an AI running coach. ${firstName ? firstName + "'s" : "An athlete's"} Strava just connected.

ATHLETE CONTEXT:
${raceContext ? `Race/Goal: ${raceContext}` : "Goal: general fitness"}
${stravaContext}${raceHistorySection}
${injuryAlreadyCollected && injuryContext ? `\nINJURY FLAGGED BEFORE STRAVA: ${injuryContext}` : ""}

${injuryAlreadyCollected ? `YOUR JOB — INJURY IS THE PRIMARY LENS:
The athlete already flagged an injury before connecting Strava. That injury is the primary coaching concern. Do NOT lead with HR zone distribution or aerobic efficiency. Use load/volume signals (weekly mileage, trend, weeks to race) as the data backbone, and connect everything back to the injury and race timeline.

Write 3–4 sentences:
1. Lead with the injury + what the training volume says about risk given the race timeline. Use at least 2 specific numbers from the STRAVA context above (e.g. weekly mileage, weeks to race, mileage trend). CRITICAL: only cite numbers that appear in the STRAVA data above — never invent figures. If no mileage data is available, say so and ask the athlete instead of guessing.
2. One specific signal you'll watch: name it clearly (load spike, pace drop, mileage jump). Connect it to the injury. Don't be generic.
3. One forward-looking sentence about what the coaching relationship will specifically monitor — make the athlete feel watched, not just coached.

Do NOT lead with or headline HR zone analysis. If the Z3 pattern is relevant (extra fatigue → slower recovery), you may mention it briefly as one supporting observation, but it must not be the opening or the main point.
Close with ONE question — ask what they're doing for the injury right now. Use the specific body part from the INJURY FLAGGED line. Example: "Are you doing anything for the [body part] right now — physio, rest, any treatment?" One sentence, nothing else after it.` : `YOUR JOB: Give a coaching opinion on what you see — not a data summary, but an interpretation connected to their specific race and timeline. This is the moment you earn their trust.

Write 3–4 sentences:
1. One insight that connects their training data to the race timeline. Use at least 2 specific numbers from the Strava data (e.g. weekly mileage, HR zone %, longest run, weeks until race). Be direct — not "solid base" but what it means for THIS specific race. E.g. if their HR distribution is skewed hard for a climb-heavy trail race, say what that means.
2. One thing that needs attention or one adjustment. Be specific about WHY it matters for this race.
3. One forward-looking sentence about what the coaching will watch.

Then close with exactly: "Has injury ever been a factor for you, or anything you're managing right now? That affects how I set up the plan."`}

Rules:
- Do NOT ask for road race times — training zones calibrate from Strava data
- Do NOT narrate all the stats — pick 2–3 meaningful facts and make them mean something
- Avoid: "solid base", "great foundation", "exciting", "strong work", "keep it up"
- 4 sentences max${injuryAlreadyCollected ? "" : " before the injury question"}
- Plain text, no markdown
- RACE HISTORY: If a RACE HISTORY section appears above, you MUST reference at least one race by name or result. Acknowledging it ("I can see you ran a 1:48 half in September") shows you've read their full background, not just the last 8 weeks. Don't list all races — pick the one most relevant to the current goal.
- PACE TREND: If "Easy pace trend (Z2 runs): improving" appears, mention it explicitly as a positive signal ("your Z2 pace has improved ~22s/mi"). If "declining", flag it. Don't skip this data point.
- INACTIVITY: If "Last run: X days ago" shows more than 10 days, factor this into the training start timing.
${injuryAlreadyCollected ? `- HR ZONES: Do not lead with or headline HR zone analysis when injury is already known. If ≥50% of runs are in Z3 and the pattern is relevant to injury recovery (more fatigue → slower healing), you may mention it as a supporting detail only — never the headline.` : `- HIGH Z3 WARNING: If ≥50% of runs are in Z3, name this clearly but without alarm. Z3 is "no man's land" — hard enough to accumulate fatigue, too easy to build race-specific fitness. Note that wrist-based HR can read high, so the real zones might be slightly lower, but the pattern is still worth polarizing: more true easy (Z1/Z2) and add one genuine quality session (Z4/Z5). Frame it as a direction to move toward, not a condemnation of what they've been doing.`}
- TRAIL RACES: If "Avg elevation/run: 0 ft (no vertical training)" appears explicitly in the Strava context AND the race is a trail/mountain race, lead with the elevation gap. Use the athlete's actual weekly mileage and weeks to race from the data above — do not invent or estimate these numbers.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: "user", content: "(strava connected)" }],
  });

  const synthesisText = response.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("")
    .trim();

  const finalText = synthesisText || "Your training data is in. Has injury ever been a factor for you, or anything you're managing right now?";

  // Advance to injury intake stage; if injury was already collected, pre-mark follow-up sent
  // so handleInjuryIntake skips straight to completion on the next message.
  const updatedData = {
    ...data,
    stage: "injury_intake",
    ...(injuryAlreadyCollected ? { injury_follow_up_sent: true } : {}),
  };

  await insertConversation({
    user_id: user.id,
    role: "user",
    content: "(strava connected)",
    message_type: "user_message",
  });

  await supabase.from("users")
    .update({ onboarding_data: updatedData as unknown as Json })
    .eq("id", user.id);

  await sendAndStore(user.id, user.phone_number, finalText, "onboarding");

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Injury Intake Stage — one focused probe, then deterministic completion
// ---------------------------------------------------------------------------

async function handleInjuryIntake(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  data: Record<string, unknown>,
  chatId?: string | null
): Promise<NextResponse> {
  // Support legacy boolean flag and new numeric counter
  const followUpCount = (data.injury_follow_up_count as number | null)
    ?? ((data.injury_follow_up_sent as boolean | null) ? 1 : 0);

  // Extract injury details from this message
  const extracted = await extractFields([{ role: "user", content: message }]);
  const mergedData: Record<string, unknown> = { ...data };
  for (const [k, v] of Object.entries(extracted)) {
    if (v !== null && v !== undefined) {
      if (Array.isArray(v) && (v as unknown[]).length === 0) continue;
      mergedData[k] = v;
    }
  }

  // Store user message
  await insertConversation({
    user_id: user.id,
    role: "user",
    content: message,
    message_type: "user_message",
  });

  // Detect "no injury" responses
  const noInjury = /\b(no (injury|injuries|issues|pain|niggles|problems)|all good|nothing|clean|healthy|fine|never|n\/a)\b/i.test(message);
  // Injury already captured during goals stage (follow-up pre-marked by handleDataAnalysis).
  // Requiring injury_severity here (not just any injury text) closes a real gate gap: a
  // bare mention like "I'm dealing with shin splints" in the athlete's very first message
  // used to be enough on its own to skip straight to plan delivery once the athlete
  // answered ANY injury-adjacent question — including one that only described what they
  // were doing about it, never how severe it was or whether it hurt at rest. Severity is
  // the single most safety-relevant field (it's the "can they run at all" screen), so it
  // must be known before treating the injury intake as complete (see 2026-07-22 changelog).
  // Shin/tibia red-flag screen (diffuse ache vs. one specific spot / rest pain) must also
  // be answered before completing, same as severity — otherwise a severity value inferred
  // or volunteered early (e.g. "I've cut back a lot" read as moderate) can short-circuit
  // completion before the stress-fracture screen ever gets asked, exactly defeating the
  // point of adding it. Only required when the body part is actually shin-related.
  const bodyPartForGate = ((mergedData.injury_body_part_current as string | null) ?? "").toLowerCase();
  const isShinRelatedForGate = /shin|tibia/.test(bodyPartForGate);
  const redFlagScreenAnswered = !isShinRelatedForGate || !!mergedData.injury_pain_character;
  // Ultra goals (30k+) require ultra/trail race background before [READY] per the main
  // conversation prompt (line ~646), but Strava connecting mid-conversation routes straight
  // into this deterministic injury-intake → completion pipeline, bypassing that question
  // entirely if it hadn't come up yet. Gate completion on it here too, same pattern as the
  // shin red-flag screen, so a fast Strava connect can't skip a required field.
  const goalForGate = (mergedData.goal as string | null) ?? null;
  const isUltraGoalForGate = !!goalForGate && ULTRA_GOALS.includes(goalForGate);
  const ultraBackgroundAnswered = !isUltraGoalForGate || !!mergedData.ultra_race_history;
  const injuryAlreadyKnown = !!(mergedData.injury_history || mergedData.current_niggles || mergedData.injury_notes)
    && !!mergedData.injury_severity
    && redFlagScreenAnswered
    && ultraBackgroundAnswered;
  // All three fields needed: body_part, severity, reported_during (+ red-flag screen for shins)
  const hasAllSymptomFields = !!(mergedData.injury_body_part_current && mergedData.injury_severity && mergedData.reported_during)
    && redFlagScreenAnswered
    && ultraBackgroundAnswered;
  // Hard cap at 2 follow-up questions total. If ultra background is still outstanding at
  // that point, allow one extra turn (cap 3) to ask it specifically rather than either
  // looping forever or silently dropping a required field — but never beyond that, so a
  // stuck extraction can't block onboarding indefinitely.
  const hitFollowUpCap = followUpCount >= (ultraBackgroundAnswered ? 2 : 3);
  const shouldComplete = (noInjury && ultraBackgroundAnswered) || injuryAlreadyKnown || hasAllSymptomFields || hitFollowUpCap;

  if (shouldComplete) {
    const timezone = (mergedData.timezone as string | null) ?? "America/New_York";
    const completionMsg = await buildSynthesisMessage(mergedData, timezone, message);
    await supabase.from("users")
      .update({ onboarding_data: mergedData as unknown as Json })
      .eq("id", user.id);
    await sendAndStore(user.id, user.phone_number, completionMsg, "onboarding");
    await completeOnboarding(user, mergedData, chatId);
    return NextResponse.json({ ok: true });
  }

  // Choose follow-up target based on what's missing
  const missingFields: string[] = [];
  if (!mergedData.injury_body_part_current) missingFields.push("which body part specifically");
  // Shin/tibia pain specifically needs a red-flag screen before severity alone: diffuse
  // ache along the bone that eases with rest reads as shin splints, but a single sharply
  // painful point, or pain that persists at rest/walking/at night, is the classic
  // presentation that should raise a stress fracture concern instead — a materially
  // different (and more urgent) answer than "how limiting is it." Ask this ahead of the
  // generic severity question whenever the body part is shin-related and it hasn't been
  // answered yet.
  const bodyPartLower = ((mergedData.injury_body_part_current as string | null) ?? "").toLowerCase();
  const isShinRelated = /shin|tibia/.test(bodyPartLower);
  const hasRedFlagScreen = !!mergedData.injury_pain_character;
  if (isShinRelated && !hasRedFlagScreen) {
    missingFields.push("whether the pain is a diffuse ache along the shin bone or one specific painful spot, and whether it hurts even at rest or walking (not just during runs) — this distinguishes ordinary shin splints from something that needs a doctor before any loading, like a stress fracture");
  }
  if (!mergedData.injury_management && !mergedData.reported_during) {
    missingFields.push("what they're doing for it (physio, rest, ice, etc.) and when the pain flares — ask both in one question");
  } else if (!mergedData.injury_management) {
    missingFields.push("what they're doing for it right now — any treatment, physio, rest");
  } else if (!mergedData.reported_during) {
    missingFields.push("when it flares (during runs, after, or both)");
  }
  if (!mergedData.injury_severity) missingFields.push("how limiting it is right now — can they run modified, or not at all");
  // Ultra background is asked last, after any injury-symptom gaps — same priority order as
  // the main conversation prompt (injury before ultra background).
  if (!ultraBackgroundAnswered) {
    missingFields.push("their ultra/trail race background — how many ultras they've done, or trail race experience, or if this is their first");
  }

  // "no injury" + missing ultra background: this is not an injury follow-up at all, so use
  // a plain race-background question instead of the injury-framed prompts below. Bounded by
  // the same cap as everything else so a stuck extraction can't loop forever.
  if (noInjury && !ultraBackgroundAnswered && !hitFollowUpCap) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 120,
      system: `You are Coach Dean. The athlete just said they have no current injury. Ask ONE question about their ultra/trail race background — how many ultras they've done, or trail race experience, or whether this would be their first.

ONE question only. No advice, no reassurance. Just the question.
Plain text, 1–2 sentences max.`,
      messages: [{ role: "user", content: message }],
    });
    const followUpText = response.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("")
      .trim() || "Have you run any ultras before, or would this be your first?";

    const updatedData = { ...mergedData, injury_follow_up_count: followUpCount + 1 };
    await supabase.from("users")
      .update({ onboarding_data: updatedData as unknown as Json })
      .eq("id", user.id);
    await sendAndStore(user.id, user.phone_number, followUpText, "onboarding");
    return NextResponse.json({ ok: true });
  }

  const followUpSystem = followUpCount === 0
    ? `You are Coach Dean. An athlete just described an injury. Ask ONE specific follow-up question targeting the most important unknown: ${missingFields[0] ?? "how long it's been happening and whether they're doing anything for it"}.

ONE question only. No advice, no stretches, no reassurance. Just the question.
Plain text, 1–2 sentences max.`
    : `You are Coach Dean. You've asked one follow-up about an injury. Ask ONE final targeted question to fill the most important remaining gap: ${missingFields[0] ?? "whether they're doing anything for it and how limiting it is"}.

This is the last question before onboarding completes — make it count. ONE question, no reassurance.
Plain text, 1–2 sentences max.`;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system: followUpSystem,
    messages: [{ role: "user", content: message }],
  });

  const followUpText = response.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("")
    .trim() || "How long has it been bothering you, and do you feel it during runs, after, or both?";

  const updatedData = { ...mergedData, injury_follow_up_count: followUpCount + 1 };
  await supabase.from("users")
    .update({ onboarding_data: updatedData as unknown as Json })
    .eq("id", user.id);
  await sendAndStore(user.id, user.phone_number, followUpText, "onboarding");
  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Plan-aware synthesis message — Sonnet call when plan + active injury present
// ---------------------------------------------------------------------------

async function buildSynthesisMessage(data: Record<string, unknown>, timezone: string, lastUserMessage?: string): Promise<string> {
  const rawName = (data.name as string) || "";
  const firstName = rawName.split(" ")[0] || "Hey";
  const activeInjury = data.active_injury === true;
  const injuryBodyPart = (data.injury_body_part_current as string | null) || null;
  const allWeeks = (data.plan_sessions_all_weeks as UploadedPlanWeek[] | null) ?? [];
  const raceDate = data.race_date as string | null;

  if (activeInjury && injuryBodyPart && allWeeks.length > 0) {
    const totalWeeks = allWeeks.length;
    const storedWeek = data.plan_current_week as number | null;
    let currentPlanWeek: number;
    if (storedWeek && storedWeek >= 1 && storedWeek <= totalWeeks) {
      currentPlanWeek = storedWeek;
    } else if (raceDate) {
      const daysUntilRace = Math.ceil(
        (new Date(raceDate + "T12:00:00Z").getTime() - Date.now()) / (24 * 60 * 60 * 1000)
      );
      currentPlanWeek = Math.max(1, Math.min(totalWeeks, totalWeeks - Math.ceil(daysUntilRace / 7) + 1));
    } else {
      currentPlanWeek = 1;
    }

    const weeklySessions = computeWeekSessions(allWeeks, currentPlanWeek, timezone);

    // Filter to remaining sessions from today onwards
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    const [, todayM, todayD] = todayStr.split("-").map(Number);
    const remainingSessions = weeklySessions.filter(s => {
      const [sm, sd] = s.date.split("/").map(Number);
      return sm * 31 + sd >= todayM * 31 + todayD;
    });

    if (remainingSessions.length > 0) {
      const sessionList = remainingSessions.map(s => `- ${s.day} (${s.date}): ${s.label}`).join("\n");
      const injurySeverity = (data.injury_severity as string | null) || "mild";
      const raceName = (data.race_name as string | null) || "your race";
      const avgMiles = data.strava_avg_weekly_miles as number | null;

      const lastMsgContext = lastUserMessage
        ? `\nATHLETE'S LAST MESSAGE: "${lastUserMessage}"`
        : "";
      const injuryPainCharacter = (data.injury_pain_character as string | null) || null;
      const redFlagInstruction = injuryPainCharacter === "localized_or_rest_pain"
        ? `\n\nRED FLAG — OVERRIDES EVERYTHING BELOW: the athlete described one specific painful spot or pain even at rest, not a diffuse ache — that's a possible stress fracture, not standard shin splints. Do NOT give load-management suggestions or schedule any session. Tell them directly to get it checked by a doctor before any more running, including easy miles or incline treadmill work. Skip point 2 (no session this week until cleared).`
        : "";

      const synthesisPrompt = `You are Coach Dean, a running coach. An athlete just completed onboarding. Write their completion message.

ATHLETE:
- Name: ${firstName}
- Active injury: ${injuryBodyPart} (${injurySeverity})
- Race: ${raceName}${raceDate ? ` on ${raceDate}` : ""}
- Weekly mileage: ${avgMiles ? `~${avgMiles} mi/week` : "unknown"}
${lastMsgContext}${redFlagInstruction}

REMAINING PLAN SESSIONS THIS WEEK:
${sessionList}

WRITE A COMPLETION MESSAGE UNDER 130 WORDS:

1. Give 3 specific ${injuryBodyPart} management suggestions ordered by impact. Format them inline as "(1) ... (2) ... (3) ...". Each must be specific and actionable — not "listen to your body". Shins: prioritize load reduction, icing after aggravating runs, using the next key session as the decision point. Use the body part and race timeline to make them concrete.

2. Identify the next quality session from PLAN SESSIONS (intervals, tempo, workout, or long run if no quality). Use its EXACT label and day from the plan. State: if the ${injuryBodyPart} is improving by the day before, do it (possibly shortened). If same or worse, swap for easy miles and protect for race day.

3. One sentence: the fitness is there — don't add stress to the ${injuryBodyPart} between now and race day.

4. Final sentence (exactly): "How's it feeling today compared to yesterday?"

Rules: NO generic advice. NO recapping what the athlete told you. NO motivational filler. If the athlete's last message asked a direct question, lead with the answer before anything else.
Plain text only, no markdown, no bullet points.`;

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 320,
        messages: [{ role: "user", content: synthesisPrompt }],
      });

      const text = response.content
        .filter(b => b.type === "text")
        .map(b => (b as { type: "text"; text: string }).text)
        .join("")
        .trim();

      if (text) return text;
    }
  }

  // Fall back to deterministic logic when no plan data or no active injury
  return buildDeterministicCompletion(data);
}

// ---------------------------------------------------------------------------
// Deterministic completion message — built from structured data, not LLM
// ---------------------------------------------------------------------------

// Per-body-part action for active injury acknowledgment in the completion message.
// UKK Institute hip & core protocol — same constant as in coach/respond/route.ts.
const UKK_PDF_URL = "https://ukkinstituutti.fi/wp-content/uploads/2024/06/TheRunRCTHipAndCoreProgram.pdf";

const INJURY_ACTION: Record<string, string> = {
  hamstring: "leg swings and walking lunges before your next run",
  "it band": "side-lying leg raises or banded walks before each run",
  itb: "side-lying leg raises or banded walks before each run",
  knee: "glute activation — clamshells or bridges — before your next run",
  achilles: "calf drops (straight + bent knee) after your next run",
  calf: "calf drops after your next run",
  shin: "reduce intensity for the next few days and ice if tender to touch",
  hip: "hip flexor stretch and single-leg glute work before your next run",
  plantar: "foot rolling and calf stretches first thing in the morning",
};

function getInjuryAction(bodyPart: string): string {
  const lower = bodyPart.toLowerCase();
  for (const [key, action] of Object.entries(INJURY_ACTION)) {
    if (lower.includes(key)) return action;
  }
  return "an easy warm-up before your next run";
}

function buildDeterministicCompletion(data: Record<string, unknown>): string {
  const rawName = (data.name as string) || "";
  const firstName = rawName.split(" ")[0] || "Hey";
  const raceName = data.race_name as string | null;
  const raceDate = data.race_date as string | null;
  const avgMiles = data.strava_avg_weekly_miles as number | null;
  const hrZones = data.strava_hr_zone_pct as { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  const currentNiggles = data.current_niggles as string | null;
  const injuryHistory = data.injury_history as string | null;
  const mileageTrend = data.strava_mileage_trend as string | null;
  const otherRaces = (data.other_races as Array<{ name?: string | null; date?: string | null; priority: string }> | null) ?? [];
  const activeInjury = data.active_injury === true;
  const injuryBodyPart = (data.injury_body_part_current as string | null) || null;
  const injurySeverity = (data.injury_severity as string | null) || null;
  const reportedDuring = (data.reported_during as string | null) || null;
  const injuryManagement = (data.injury_management as string | null) || null;
  const injuryPainCharacter = (data.injury_pain_character as string | null) || null;
  const stravaConnected = !!(data.strava_connected);
  const goal = (data.goal as string | null) || null;
  const isRTR = goal === "return_to_running" || goal === "injury_recovery";

  // Race + timeline opening
  let opening = "";
  if (raceName && raceDate) {
    const weeksUntil = Math.round(
      (new Date(raceDate + "T12:00:00Z").getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)
    );
    const timelineStr = weeksUntil <= 1 ? "this week" : weeksUntil === 2 ? "2 weeks out" : `${weeksUntil} weeks out`;
    const nextOther = otherRaces.find(r => r.name && r.date);
    if (nextOther) {
      const nextWeeks = Math.round((new Date(nextOther.date! + "T12:00:00Z").getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000));
      opening = `${firstName}, ${raceName} ${timelineStr} then ${nextOther.name} ${nextWeeks} weeks later.`;
    } else {
      opening = `${firstName}, ${raceName} ${timelineStr}.`;
    }
  } else if (raceName) {
    opening = `${firstName}, ${raceName} is locked in.`;
  } else {
    opening = `${firstName}, you're set up.`;
  }

  // Key training observation from Strava data
  let observation = "";
  if (hrZones && avgMiles) {
    const highZ = hrZones.z3 + hrZones.z4 + hrZones.z5;
    if (highZ > 50) {
      observation = `Your ${avgMiles} mi/week base is there — keeping the easy days truly easy is the main lever right now.`;
    } else {
      observation = `Your aerobic base at ${avgMiles} mi/week is well-paced — good platform to build from.`;
    }
  } else if (avgMiles) {
    const trendNote = mileageTrend === "building" ? ", trending up" : "";
    observation = `Your base at ${avgMiles} mi/week${trendNote} gives us room to work.`;
  }

  // Injury note — specific action when active, pattern monitoring when historical
  let injuryNote = "";
  if (activeInjury && injuryBodyPart) {
    const action = getInjuryAction(injuryBodyPart);
    const whenStr = reportedDuring === "during" ? "during runs"
      : reportedDuring === "after" ? "after runs"
      : reportedDuring === "both" ? "during and after runs"
      : null;
    const severityNote = injurySeverity === "severe" ? "Given the severity, "
      : injurySeverity === "moderate" ? "Given how it's affecting training, "
      : "";
    const duringNote = whenStr ? ` Pain ${whenStr} is the watch-point for whether a session stays or gets swapped.` : "";

    // Management-aware injury action. A "localized_or_rest_pain" character overrides
    // all of the below — it's the shin-splints-vs-stress-fracture red flag, and no
    // amount of "manage it, reduce intensity" advice is appropriate until it's ruled out.
    let mgmtActionPart: string;
    if (injuryPainCharacter === "localized_or_rest_pain") {
      mgmtActionPart = `One thing before anything else: a specific painful spot (rather than a general ache) or pain even at rest can point to a stress fracture, not standard shin splints — get that checked by a doctor before adding any more running load, including easy miles or incline treadmill work.`;
    } else if (injuryManagement && /physio|pt\b|physical therapy|therapist|sports medicine|doctor|clinic/i.test(injuryManagement)) {
      mgmtActionPart = `Working alongside your physio on the ${injuryBodyPart}. If load from runs is pushing against the recovery timeline I'll flag it before it compounds.`;
    } else if (injuryManagement && /rest|taking.*off|not running|stopped/i.test(injuryManagement)) {
      mgmtActionPart = `Good call giving it some rest. When you're back running, I'll pace the ramp and flag any load spikes early.`;
    } else if (injuryManagement) {
      mgmtActionPart = `${injuryManagement} for the ${injuryBodyPart} — good. Before your next run, also ${action}.`;
    } else {
      mgmtActionPart = `${severityNote}Before your next run, do ${action}.`;
    }
    injuryNote = `${mgmtActionPart}${duringNote}`;
  } else if (currentNiggles && !/\b(none|no injury|healthy|fine)\b/i.test(currentNiggles)) {
    const text = currentNiggles.toLowerCase();
    const bodyPart = text.includes("hamstring") ? "hamstring"
      : text.includes("shin") ? "shin"
      : text.includes("knee") ? "knee"
      : text.includes("achilles") ? "achilles"
      : text.includes("it band") || text.includes("itb") ? "IT band"
      : text.includes("hip") ? "hip"
      : text.includes("calf") ? "calf"
      : text.includes("plantar") ? "plantar fascia"
      : null;
    if (bodyPart) {
      const action = getInjuryAction(bodyPart);
      injuryNote = `The ${bodyPart} — before your next run, do ${action}.`;
    } else {
      injuryNote = "Injury history noted — it factors into how I set your volume and easy/hard balance.";
    }
  } else if (injuryHistory && !/\b(none|no injury|no injuries|healthy|fine)\b/i.test(injuryHistory)) {
    injuryNote = "Injury history noted — it factors into how I set your volume and easy/hard balance.";
  }

  // Injury-first: when active injury present, lead with the injury note before the Strava observation.
  // This matches the "injury is the primary signal" framing in the onboarding spec.
  const parts = [opening];
  if (activeInjury && injuryNote) {
    parts.push(injuryNote);
    if (observation) parts.push(observation);
  } else {
    if (observation) parts.push(observation);
    if (injuryNote) parts.push(injuryNote);
  }

  // Close with how coaching works — specific to injury situation. When there's an active
  // injury, skip the "first run stays easy, tell me how it felt" close here — the
  // initial_plan closer (coach/respond/route.ts) already states that same idea once the
  // plan itself is delivered a few seconds later, so repeating it here just doubles it up
  // (see the 2026-07-22 changelog on cross-turn repetition between these two messages).
  if (activeInjury && injuryBodyPart) {
    // No additional closing sentence — the plan delivery message closes the loop.
  } else if (stravaConnected) {
    parts.push("After your next run, I'll send a coaching note — what it means for the week ahead and what to watch for. That's where we start.");
  } else {
    parts.push("Your first coaching note lands after your first run — what it means for the week ahead and what to watch for.");
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Strava step (simplified)
// ---------------------------------------------------------------------------

async function handleStrava(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  onboardingData: Record<string, unknown>,
  _chatId?: string | null
): Promise<NextResponse> {
  const writeUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;

  // If asking about Strava — explain what it is and re-send the link
  const isAskingAboutStrava = /\b(what|what's|whats|how|why|tell me about|explain|never heard)\b/i.test(message);
  if (isAskingAboutStrava || (/strava/i.test(message) && message.includes("?"))) {
    const reply = `Strava is a free app that tracks your runs via GPS — lots of runners use it. Once you connect it, I'll automatically read every run and add a coaching note to it.\n\n${writeUrl}`;
    await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  // Any other message while awaiting Strava — re-send the link
  const reply = `Connect Strava so I can read your runs automatically and add a coaching note after each one:\n\n${writeUrl}`;
  await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
  return NextResponse.json({ ok: true });
}


// ---------------------------------------------------------------------------
// Timezone handler (post-cadence location collection for non-Strava users)
// ---------------------------------------------------------------------------

async function handleTimezone(
  user: { id: string; phone_number: string; onboarding_data: Record<string, unknown> },
  message: string
): Promise<NextResponse> {
  const parsedTimezone = await parseTimezoneFromLocation(message);

  if (!parsedTimezone) {
    await sendAndStore(
      user.id,
      user.phone_number,
      "Sorry, I didn't catch that — what city or state are you in? (e.g. \"Denver, CO\" or \"Austin, TX\")",
      "awaiting_timezone"
    );
    return NextResponse.json({ ok: true });
  }

  await supabase
    .from("users")
    .update({
      timezone: parsedTimezone,
      onboarding_step: null,
      onboarding_data: { ...user.onboarding_data, timezone_confirmed: true } as unknown as import("@/lib/database.types").Json,
    })
    .eq("id", user.id);

  await sendAndStore(
    user.id,
    user.phone_number,
    "Got it — your reminders will go out at the right time for you. How does the plan look? Let me know if anything needs tweaking.",
    "awaiting_timezone"
  );
  return NextResponse.json({ ok: true });
}



// ---------------------------------------------------------------------------
// Payment step
// ---------------------------------------------------------------------------

async function handleAwaitingPayment(
  user: { id: string; phone_number: string; name: string | null }
): Promise<NextResponse> {
  const { data: userData } = await supabase
    .from("users")
    .select("dashboard_token, onboarding_data")
    .eq("id", user.id)
    .single();

  const dashboardToken = userData?.dashboard_token as string | null;
  if (!dashboardToken) return NextResponse.json({ ok: true });

  const _rawFirst = (user.name ?? "").split(" ")[0];
  const firstName = (_rawFirst && _rawFirst.toLowerCase() !== "athlete") ? _rawFirst : "Hey";
  const checkoutUrl = getCheckoutPageUrl(dashboardToken);
  const onboardingData = (userData?.onboarding_data as Record<string, unknown>) || {};

  const msg = buildPaymentMessage(firstName, checkoutUrl, onboardingData);
  await sendAndStore(user.id, user.phone_number, msg, "awaiting_payment");
  return NextResponse.json({ ok: true });
}

/** Build a personalized trial CTA anchored to the coaching relationship, not plan delivery. */
function buildPaymentMessage(
  firstName: string,
  checkoutUrl: string,
  data: Record<string, unknown>
): string {
  const raceName = data.race_name as string | null;
  const raceDate = data.race_date as string | null;
  const goal = data.goal as string | null;

  // Build a personal context hook referencing their specific goal
  let goalCtx = "";
  if (raceName && raceDate) {
    const dateStr = new Date(raceDate + "T12:00:00Z").toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
    });
    goalCtx = ` I'm tracking your load and watching for injury risk all the way to ${raceName} on ${dateStr}.`;
  } else if (raceName) {
    goalCtx = ` I'm calibrated for ${raceName} — your coaching notes will start after your next run.`;
  } else if (goal === "general_fitness" || goal === "return_to_running") {
    goalCtx = " I'm calibrated — your coaching notes will start after your next run.";
  } else if (goal) {
    goalCtx = ` I'm calibrated for your ${goal.replace(/_/g, " ")} goal — your coaching notes will start after your next run.`;
  }

  return `${firstName}, you're all set.${goalCtx} Start your free 7-day trial to keep the coaching going — no charge until the trial ends, cancel any time:\n${checkoutUrl}`;
}

// ---------------------------------------------------------------------------
// Strava race history helpers (for pace context in the conversation prompt)
// ---------------------------------------------------------------------------

interface StravaRaceSuggestion {
  label: string;
  date_str: string;
  time_str: string;
  dist_km: number;
  time_minutes: number;
  easy_pace: string;
  tempo_pace: string;
  interval_pace: string;
  is_trail?: boolean;
}

function selectBestRaceForPacing(
  races: Array<{
    distance_meters: number | null;
    moving_time_seconds: number | null;
    start_date: string;
    activity_type?: string | null;
    elevation_gain?: number | null;
  }>
): { distance_meters: number; moving_time_seconds: number; start_date: string; is_trail: boolean } | null {
  const now = Date.now();
  const STANDARD_KM = [5, 10, 15, 21.097, 42.195];
  // Trail races often have >80ft/mile elevation gain. Road races are typically <50ft/mile.
  // This catches trail races logged as "Run" rather than "TrailRun" in Strava.
  const TRAIL_VERT_THRESHOLD_FT_PER_MILE = 80;

  const scored = races
    .filter(
      (r) =>
        r.distance_meters != null &&
        r.moving_time_seconds != null &&
        r.distance_meters >= 1500 &&
        r.distance_meters <= 50000
    )
    .map((r) => {
      const daysAgo =
        (now - new Date(r.start_date).getTime()) / (1000 * 60 * 60 * 24);
      if (daysAgo > 900) return null;
      const recencyScore = daysAgo < 180 ? 3 : daysAgo < 365 ? 2 : 1;
      const distKm = r.distance_meters! / 1000;
      const isStandard = STANDARD_KM.some((d) => Math.abs(distKm - d) / d <= 0.03);
      const distScore = isStandard ? 2 : 1;
      const elevFtPerMile = r.elevation_gain != null && r.distance_meters != null
        ? (r.elevation_gain * 3.28084) / (r.distance_meters / 1609.34)
        : 0;
      const isTrail = r.activity_type === "TrailRun" || elevFtPerMile >= TRAIL_VERT_THRESHOLD_FT_PER_MILE;
      const trailPenalty = isTrail ? 0.5 : 1;
      return {
        race: r,
        score: recencyScore * distScore * trailPenalty,
        isTrail,
      };
    })
    .filter(
      (
        x
      ): x is {
        race: (typeof races)[number];
        score: number;
        isTrail: boolean;
      } => x !== null
    )
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;
  return {
    distance_meters: best.race.distance_meters!,
    moving_time_seconds: best.race.moving_time_seconds!,
    start_date: best.race.start_date,
    is_trail: best.isTrail,
  };
}

async function lookupBestStravaRace(
  userId: string
): Promise<StravaRaceSuggestion | null> {
  const [{ data: races }, { data: profile }] = await Promise.all([
    supabase
      .from("activities")
      .select("distance_meters, moving_time_seconds, start_date, activity_type, elevation_gain")
      .eq("user_id", userId)
      .eq("workout_type", 1)
      .order("start_date", { ascending: false })
      .limit(20),
    supabase
      .from("training_profiles")
      .select("preferred_units")
      .eq("user_id", userId)
      .single(),
  ]);

  const best = selectBestRaceForPacing(
    (races || []).filter(
      (r): r is typeof r & { start_date: string } => r.start_date != null
    )
  );
  if (!best) return null;

  const preferredUnits =
    (profile?.preferred_units as "imperial" | "metric" | null) ?? "imperial";
  const distKm = best.distance_meters / 1000;
  const timeMin = best.moving_time_seconds / 60;
  const paces = calculateVDOTPaces(distKm, timeMin);
  const label = formatRaceDistance(best.distance_meters, preferredUnits);

  const dateStr = new Date(best.start_date).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

  const totalSec = best.moving_time_seconds;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const timeStr =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;

  return {
    label,
    date_str: dateStr,
    time_str: timeStr,
    dist_km: distKm,
    time_minutes: timeMin,
    easy_pace: paces.easy,
    tempo_pace: paces.tempo,
    interval_pace: paces.interval,
    is_trail: best.is_trail,
  };
}

// ---------------------------------------------------------------------------
// Onboarding completion
// ---------------------------------------------------------------------------

const GOAL_DISTANCE_MILES_STANDARD: Record<string, number> = {
  mile: 1.0,
  "5k": 3.107,
  "10k": 6.214,
  half_marathon: 13.109,
  marathon: 26.219,
  "30k": 18.641,
  "50k": 31.069,
  "50mi": 50.0,
  "100k": 62.137,
  "100mi": 100.0,
};

function assessFitnessLevel(
  experienceYears: number,
  weeklyMiles: number | null,
  weeklyHours: number | null,
  goal?: string,
  daysPerWeek?: number
): string {
  if (weeklyHours != null) {
    if (weeklyHours >= 10 || experienceYears >= 3) return "advanced";
    if (weeklyHours >= 5 || experienceYears >= 1) return "intermediate";
    return "beginner";
  }
  const miles = weeklyMiles ?? 0;
  if (goal && ULTRA_GOALS.includes(goal) && (daysPerWeek ?? 0) >= 5) return "advanced";
  if (miles >= 30 || experienceYears >= 3) return "advanced";
  if (miles >= 15 || experienceYears >= 1) return "intermediate";
  return "beginner";
}

async function completeOnboarding(
  user: { id: string },
  data: Record<string, unknown>,
  chatId?: string | null,
  opts?: { skipInitialPlan?: boolean; dashboardLinkSentInWrapUp?: boolean }
): Promise<void> {
  const goal = (data.goal as string) || "general_fitness";
  const raceDate = (data.race_date as string) || null;
  const experienceYears = (data.experience_years as number) ?? 1;
  const weeklyMiles = (data.weekly_miles as number) ?? null;
  const weeklyHours = (data.weekly_hours as number) || null;
  const crosstrain = (data.crosstraining_tools as string[]) || [];
  const daysPerWeek = (data.days_per_week as number) ?? 4;
  const trainingDays = (data.training_days as string[]) || [];
  // Guard: if pace < threshold, it was almost certainly stored as min/km, auto-convert.
  // Easy: threshold 5:30/mi (330s) — sub-5:30 easy requires VDOT ~80+ (elite/pro).
  // Tempo: threshold 5:00/mi (300s) — sub-5:00 tempo requires VDOT ~65+ (world-class).
  // Interval: threshold 4:30/mi (270s) — sub-4:30 intervals require VDOT ~70+ (elite).
  function maybeConvertKmToMile(paceStr: string | null, thresholdSec: number, label: string): string | null {
    if (!paceStr) return null;
    const m = paceStr.match(/(\d+):(\d+)/);
    if (!m) return paceStr;
    const totalSec = parseInt(m[1]) * 60 + parseInt(m[2]);
    if (totalSec < thresholdSec) {
      const converted = Math.round(totalSec * 1.60934);
      const min = Math.floor(converted / 60);
      const sec = converted % 60;
      console.warn(`[completeOnboarding] ${label} ${paceStr} looks like min/km — auto-converting to ${min}:${String(sec).padStart(2, "0")}/mi`);
      return `${min}:${String(sec).padStart(2, "0")}/mi`;
    }
    return paceStr;
  }
  const easyPace = maybeConvertKmToMile((data.easy_pace as string) || null, 330, "easy_pace");
  // Priority for tempo/interval paces:
  // 1. If the athlete gave a road race time during onboarding, VDOT ran in handleConversation
  //    and stored the correct paces in data.tempo_pace / data.interval_pace — use those.
  // 2. If no athlete-stated race was extracted (VDOT didn't run), fall back to the Strava
  //    VDOT paces stored at Strava-connect time — always in correct min/mile format.
  // 3. Conversion guard catches any remaining km-stored-as-miles values.
  const athleteRaceRan = !!(data.recent_race_distance_km && data.recent_race_time_minutes);
  const rawTempoPace = athleteRaceRan
    ? (data.tempo_pace as string) || (data.strava_vdot_tempo_pace as string) || null
    : (data.strava_vdot_tempo_pace as string) || (data.tempo_pace as string) || null;
  const rawIntervalPace = athleteRaceRan
    ? (data.interval_pace as string) || (data.strava_vdot_interval_pace as string) || null
    : (data.strava_vdot_interval_pace as string) || (data.interval_pace as string) || null;
  const tempoPace = maybeConvertKmToMile(rawTempoPace, 300, "tempo_pace");
  const intervalPace = maybeConvertKmToMile(rawIntervalPace, 270, "interval_pace");
  const injuryNotes = (data.injury_notes as string) || null;
  const name = (data.name as string) || null;

  const isUltra = ULTRA_GOALS.includes(goal);

  const goalDistanceMiles =
    (data.goal_distance_miles as number | null) ??
    GOAL_DISTANCE_MILES_STANDARD[goal] ??
    null;

  const fitnessLevel = assessFitnessLevel(
    experienceYears,
    weeklyMiles,
    weeklyHours,
    goal,
    daysPerWeek
  );
  const weeklyMilesRaw = weeklyMiles ?? (isUltra ? 30 : 15);
  const weeklyMileage =
    weeklyMilesRaw <= 0
      ? 10
      : weeklyMilesRaw <= 10
      ? Math.ceil(weeklyMilesRaw)
      : Math.round(weeklyMilesRaw / 5) * 5 || 15;
  const currentLongRunMiles = (data.current_long_run_miles as number | null)
    ?? (data.strava_longest_run_miles as number | null)
    ?? null;
  const longRunRaw = Math.round(weeklyMileage * 0.3);
  const longRun =
    currentLongRunMiles ?? (isUltra ? Math.max(longRunRaw, 10) : longRunRaw);

  const trainingTools = (data.training_tools as string[] | null) || [];
  const terrainType = (data.terrain_type as string | null) || null;
  const hasExistingPlan = !!(data.has_existing_plan as boolean | null); // context only — affects framing in initial_plan
  const externalPlanDescription = (data.external_plan_description as string | null) || null;
  const crossTrainingActivities = (data.cross_training_activities as string[] | null) || (data.crosstraining_tools as string[] | null) || [];
  // Combine injury history + current niggles into injury_notes if not already set
  const injuryHistoryText = (data.injury_history as string | null) || null;
  const currentNiggles = (data.current_niggles as string | null) || null;
  const combinedInjuryNotes = injuryNotes
    || [injuryHistoryText, currentNiggles].filter(Boolean).join(" | ")
    || null;

  // Generate a personalized prehab/strength routine from the athlete's injury history so
  // it's ready from day one (deterministic — no LLM call). Stored under
  // dashboard_insights.strength_recovery; surfaced over SMS by coach/respond. Null when
  // there's no injury signal at all.
  const strengthRoutine = composeStrengthRoutine({
    bodyParts: [data.injury_body_part_current as string | null],
    injuryText: combinedInjuryNotes,
  });

  // Carry LTHR estimate from Strava connect into the profile if available.
  // Re-fetch onboarding_data fresh from the DB to avoid a race condition: the Strava
  // callback writes strava_lthr_estimate asynchronously, but any handleConversation
  // turn that ran between the callback write and this [READY] fire may have written
  // mergedData (built at request-start) back to the DB, clobbering the LTHR. The
  // fresh fetch ensures we see whatever the Strava callback wrote, not the stale copy.
  const { data: freshUserData } = await supabase
    .from("users")
    .select("onboarding_data")
    .eq("id", user.id)
    .single();
  const freshOnbData = (freshUserData?.onboarding_data as Record<string, unknown>) ?? {};
  const lthrEstimate = (freshOnbData.strava_lthr_estimate as number | null)
    ?? ((data as Record<string, unknown>).strava_lthr_estimate as number | null)
    ?? null;
  const lthrSource = (freshOnbData.strava_lthr_source as string | null)
    ?? ((data as Record<string, unknown>).strava_lthr_source as string | null)
    ?? null;
  const lthrConfidence = (freshOnbData.strava_lthr_confidence as string | null)
    ?? ((data as Record<string, unknown>).strava_lthr_confidence as string | null)
    ?? null;

  const [profileResult, stateResult] = await Promise.all([
    supabase.from("training_profiles").upsert(
      {
        user_id: user.id,
        goal,
        race_date: raceDate,
        fitness_level: fitnessLevel,
        days_per_week: daysPerWeek,
        training_days: trainingDays,
        current_easy_pace: easyPace,
        current_tempo_pace: tempoPace,
        current_interval_pace: intervalPace,
        crosstraining_tools: crossTrainingActivities.length > 0 ? crossTrainingActivities : crosstrain,
        training_tools: trainingTools,
        terrain_type: terrainType,
        external_plan_notes: externalPlanDescription,
        proactive_cadence: "weekly_only",
        ...((data.preferred_units as string | null) ? { preferred_units: data.preferred_units as string } : {}),
        injury_notes: combinedInjuryNotes,
        goal_distance_miles: goalDistanceMiles,
        ...((() => {
          const liftDays = data.lifting_days as string[] | null | undefined;
          const legDays = data.leg_lift_days as string[] | null | undefined;
          const fields: Record<string, unknown> = {};
          if (Array.isArray(liftDays)) fields.lifting_days = liftDays.map(d => String(d).toLowerCase().slice(0, 3));
          if (Array.isArray(legDays)) fields.leg_lift_days = legDays.map(d => String(d).toLowerCase().slice(0, 3));
          return fields;
        })()),
        ...((() => {
          const active = data.active_injury;
          const severity = data.injury_severity as string | null | undefined;
          const part = data.injury_body_part_current as string | null | undefined;
          if (active === true) {
            return {
              active_injury: true,
              ...(severity ? { injury_severity: severity } : {}),
              ...(part ? { injury_body_part: part } : {}),
              injury_start_date: new Date().toISOString().slice(0, 10),
            };
          }
          return {};
        })()),
        ...(lthrEstimate != null ? {
          lthr_estimate: lthrEstimate,
          lthr_source: lthrSource,
          lthr_confidence: lthrConfidence,
          lthr_last_updated: new Date().toISOString(),
          hr_zone_method: "lthr",
        } : {}),
        coaching_mode: 'adaptive',
        ...(((data.avg_sleep_hours as number | null) != null) ? { avg_sleep_hours: data.avg_sleep_hours as number } : {}),
        ...(strengthRoutine ? { dashboard_insights: { strength_recovery: strengthRoutine } as unknown as Json } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    ),
    supabase.from("training_state").upsert(
      {
        user_id: user.id,
        // If the athlete mentioned their current plan week (e.g. "Runna plan, week 6"),
        // seed current_week from that so plan sessions sync to the right week.
        current_week: (() => {
          const desc = externalPlanDescription ?? "";
          const m = desc.match(/week\s+(\d+)/i);
          return m ? parseInt(m[1], 10) : 1;
        })(),
        current_phase: "base",
        weekly_mileage_target: weeklyMileage,
        long_run_target: longRun,
        week_mileage_so_far: 0,
        ...((goal === "return_to_running" || goal === "injury_recovery") ? { return_to_run_phase: 1 } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    ),
  ]);

  if (profileResult.error) {
    console.error("[onboarding] training_profiles upsert failed:", profileResult.error);
    return;
  }
  if (stateResult.error) {
    console.error("[onboarding] training_state upsert failed:", stateResult.error);
    return;
  }

  // Seed symptom_history from onboarding injury data so the monitoring system
  // has day-1 context without waiting for a post-run check-in.
  if (data.active_injury === true && data.injury_body_part_current) {
    const initialSymptom = {
      date: new Date().toISOString().slice(0, 10),
      body_part: data.injury_body_part_current as string,
      severity: (data.injury_severity as string | null) ?? "mild",
      reported_during: (data.reported_during as string | null) ?? "after",
      source: "onboarding",
    };
    await supabase.from("training_profiles")
      .update({ symptom_history: [initialSymptom] })
      .eq("user_id", user.id);
  }

  // Check if billing gate is needed
  const { data: billingUser } = await supabase
    .from("users")
    .select("billing_enabled, reverse_trial_enabled, dashboard_token, phone_number")
    .eq("id", user.id)
    .single();

  const billingEnabled = !!(billingUser?.billing_enabled);
  const reverseTrialEnabled = !!(billingUser?.reverse_trial_enabled);

  const userUpdatePayload: Record<string, unknown> = {
    onboarding_data: data as unknown as Json,
  };
  if (name) userUpdatePayload.name = name;

  if (billingEnabled && !reverseTrialEnabled) {
    let dashboardToken = billingUser?.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      userUpdatePayload.dashboard_token = dashboardToken;
    }
    userUpdatePayload.onboarding_step = "awaiting_payment";
    userUpdatePayload.payment_link_sent_at = new Date().toISOString();
  } else {
    userUpdatePayload.onboarding_step = null;
    // Stamp the trial start so the coach gate and the trial-expiry cron can
    // measure the 7-day window. Also doubles as the "hasHadTrial" signal in
    // billing/checkout so Stripe doesn't tack on another 7 days of trial.
    if (reverseTrialEnabled) {
      userUpdatePayload.trial_started_at = new Date().toISOString();
      let dashboardToken = billingUser?.dashboard_token as string | null;
      if (!dashboardToken) {
        dashboardToken = crypto.randomUUID();
        userUpdatePayload.dashboard_token = dashboardToken;
      }
    }
  }

  // Guard against the race condition where a second message arrives while this
  // call is processing. If onboarding_step is already null (a prior [READY] call
  // completed and fired initial_plan), skip re-firing it.
  const userResult = await supabase
    .from("users")
    .update(userUpdatePayload)
    .eq("id", user.id)
    .eq("onboarding_step", "onboarding")
    .select("id");

  if (userResult.error) console.error("[onboarding] users update failed:", userResult.error);

  if (!userResult.data || userResult.data.length === 0) {
    console.warn("[onboarding] completeOnboarding: onboarding_step was already null — skipping duplicate initial_plan fire for user", user.id);
    return;
  }

  // Write races to DB
  if (raceDate && goal) {
    await supabase.from("races").delete().eq("user_id", user.id);

    const racesToInsert = [
      {
        user_id: user.id,
        race_date: raceDate,
        race_name: (data.race_name as string | null) ?? null,
        goal,
        priority: "A" as const,
        goal_time_minutes: (data.goal_time_minutes as number | null) ?? null,
        goal_distance_miles: goalDistanceMiles,
        elevation_gain_feet: (data.race_elevation_gain_feet as number | null) ?? null,
        elevation_loss_feet: (data.race_elevation_loss_feet as number | null) ?? null,
        race_altitude_ft: (data.race_altitude_ft as number | null) ?? null,
        trail_subtype: (data.race_trail_subtype as "groomed" | "mixed" | "technical" | "highly_technical" | null) ?? null,
      },
      ...((
        data.other_races as Array<{
          date: string;
          name: string | null;
          goal: string | null;
          priority: "B" | "C";
          goal_distance_miles?: number | null;
        }> | null
      ) ?? [])
        .filter((r) => {
          if (!r.date) {
            console.warn(`[onboarding] other_races item dropped — missing date: ${JSON.stringify(r)}`);
            return false;
          }
          const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(r.date) && !isNaN(Date.parse(r.date));
          if (!isValidDate) {
            console.warn(`[onboarding] other_races item dropped — invalid date "${r.date}": ${JSON.stringify(r)}`);
            return false;
          }
          return true;
        })
        .map((r) => ({
          user_id: user.id,
          race_date: r.date,
          race_name: r.name ?? null,
          goal: r.goal ?? goal,
          priority: r.priority,
          goal_time_minutes: null,
          goal_distance_miles: r.goal_distance_miles ?? null,
        })),
    ];
    console.log(`[onboarding] inserting ${racesToInsert.length} race(s):`, racesToInsert.map(r => `${r.race_name ?? "unnamed"} (${r.priority})`).join(", "));

    const { error: racesError } = await supabase
      .from("races")
      .insert(racesToInsert);
    if (racesError)
      console.error("[onboarding] races insert failed:", racesError);
  }

  if (billingEnabled && !reverseTrialEnabled) {
    const dashboardToken =
      (userUpdatePayload.dashboard_token as string | null) ??
      (billingUser?.dashboard_token as string | null);
    if (dashboardToken) {
      const _rawFirst2 = (name ?? "").split(" ")[0];
      const firstName = (_rawFirst2 && _rawFirst2.toLowerCase() !== "athlete") ? _rawFirst2 : "Hey";
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + 7);
      const trialEndFormatted = trialEndDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      });
      const checkoutUrl = getCheckoutPageUrl(dashboardToken);
      const sms = `${firstName}, you're all set — I'll be sending you a coaching note after every run. Start your free 7-day trial to keep the coaching going — no charge until ${trialEndFormatted}, cancel any time: ${checkoutUrl}`;
      const phoneNumber = billingUser?.phone_number as string;
      await sendAndStore(user.id, phoneNumber, sms, "awaiting_payment");
    }
    void trackEvent(user.id, "onboarding_completed", { goal, billing_gate: true });
    return;
  }

  if (opts?.skipInitialPlan) {
    void trackEvent(user.id, "onboarding_completed", { goal, plan_skipped: true });
    return;
  }

  const isDryRun = dryRunUsers.has(user.id);
  if (isDryRun) {
    try {
      await trackEvent(user.id, "onboarding_completed", { goal });
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.id,
            trigger: "initial_plan",
            dry_run: true,
          }),
        }
      );
      const { message } = (await res.json()) as { message?: string };
      if (message) {
        for (const part of message.split(/\n\n+/).filter(Boolean)) {
          await insertConversation({
            user_id: user.id,
            role: "assistant",
            content: part,
            message_type: "initial_plan",
          });
        }
      }
    } catch (err) {
      console.error("[onboarding] dry_run coach trigger failed:", err);
    }
  } else {
    runAfter("onboarding/initial-plan", async () => {
      try {
        await trackEvent(user.id, "onboarding_completed", { goal });
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.id,
            trigger: "initial_plan",
            chatId: chatId ?? undefined,
          }),
        });
      } catch (err) {
        console.error("[onboarding] coach trigger failed:", err);
        const { captureException } = await import("@sentry/nextjs");
        captureException(err, { tags: { trigger: "initial_plan" } });
      }
    });
  }
}
