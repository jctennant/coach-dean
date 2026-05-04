import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { calculateVDOTPaces, easyPaceRange, formatRaceDistance } from "@/lib/paces";
import { getCheckoutPageUrl } from "@/lib/stripe";
import type { Json } from "@/lib/database.types";
import { parseTimezoneFromLocation } from "@/lib/timezone";

export const maxDuration = 60;

// Tracks userIds currently in a dry_run onboarding request.
const dryRunUsers = new Set<string>();

/**
 * Detect the primary language from a set of user messages.
 * Returns an ISO 639-1 code or "en" as fallback.
 */
function detectLanguage(userMessages: string[]): string {
  const frenchWords = /\b(je|tu|il|nous|vous|ils|ne|pas|que|les|des|avec|pour|dans|très|aussi|bien|mais|avoir|être|c'est|j'ai|pardon|merci|bonjour|peux|donc|mon|ma|mes|ton|ta|notre|votre|leur|suis|avez|fait|fais|cette|ça|ca|moi|toi|lui|nous|eux|oui|non|pourquoi|comment|quand|où|quoi|qui|quel|quelle|veux|vouloir|faire|parle|parler|préfère|voudrais|puis|depuis|plus|moins|comme|aussi|après|avant|pendant)\b/i;
  const spanishWords = /\b(yo|tú|él|nosotros|vosotros|ellos|no|que|los|las|con|para|por|muy|también|bien|pero|haber|ser|estar|es|soy|tengo|hola|gracias|sí|porque|cómo|cuándo|dónde|quién|qué|quiero|puedo|hacer|hablar)\b/i;
  const frenchCount = userMessages.filter(m => frenchWords.test(m)).length;
  const spanishCount = userMessages.filter(m => spanishWords.test(m)).length;
  if (frenchCount >= 2 && frenchCount >= spanishCount) return "fr";
  if (spanishCount >= 2 && spanishCount > frenchCount) return "es";
  return "en";
}

/** Map ISO 639-1 code to English language name. */
function langCodeToName(code: string): string {
  const names: Record<string, string> = { fr: "French", es: "Spanish", de: "German", pt: "Portuguese", it: "Italian", nl: "Dutch" };
  return names[code] ?? code;
}

/**
 * Fallback parser for working mode when Dean fails to emit [MODE:...].
 * Only fires when the last assistant message asked the three-options question —
 * otherwise a "1" reply could mean anything. This is a safety net for model
 * tag-compliance failures; the tag emission in the prompt is still the primary path.
 */
function parseModeFallback(
  userMessage: string,
  lastAssistantMessage: string | null
): "FROM_SCRATCH" | "COMPLEMENT" | "NO_PLAN" | null {
  if (!lastAssistantMessage) return null;
  const askedMode =
    /three different ways|trois mani[eè]res|trois façons/i.test(lastAssistantMessage) ||
    (/\(1\)/.test(lastAssistantMessage) &&
      /\(2\)/.test(lastAssistantMessage) &&
      /\(3\)/.test(lastAssistantMessage));
  if (!askedMode) return null;

  const msg = userMessage.trim().toLowerCase();

  if (/^(1|one|option\s*1|first|#1|\(1\))[.!\s]*$/i.test(msg)) return "FROM_SCRATCH";
  if (/^(2|two|option\s*2|second|#2|\(2\))[.!\s]*$/i.test(msg)) return "COMPLEMENT";
  if (/^(3|three|option\s*3|third|#3|\(3\))[.!\s]*$/i.test(msg)) return "NO_PLAN";

  if (/\bfrom scratch\b|\bbuild (me )?(a |one|it)|\bbuild one\b/i.test(msg)) return "FROM_SCRATCH";
  // French FROM_SCRATCH patterns: "pars de zéro", "depuis zéro", "crée(r) un plan", "sans plan", "pas de plan"
  if (/\b(pars?|partir|depuis|de) (de )?z[eé]ro\b|\bcr[eé][eé](r)? (un |mon )?(plan|programme)\b|\bsans plan\b|\bpas de plan\b/i.test(msg)) return "FROM_SCRATCH";
  if (
    /\b(runna|trainingpeaks|training peaks|garmin coach)\b/i.test(msg) ||
    /\b(i (have|follow|use|am on|'?m on)|already (have|follow|using))\b.*\b(plan|coach|program)\b/i.test(msg) ||
    /\bwork alongside\b|\balongside (my|a) plan\b/i.test(msg) ||
    // French COMPLEMENT patterns: "j'ai (déjà) un plan", "je suis un plan", "travaille avec mon plan"
    /\bj'ai (déjà |un )?plan\b|\bje suis (déjà |un )?plan\b|\btravaille.{0,10}(avec|sur) (mon|un) plan\b/i.test(msg)
  )
    return "COMPLEMENT";
  if (
    /\bno (set )?(plan|schedule)\b|\bjust (coaching )?(notes|feedback)\b|\bpost.run (notes?|feedback) only\b|\bfeedback only\b/i.test(
      msg
    ) ||
    // French NO_PLAN patterns: "sans planning", "juste des notes", "retours après chaque course"
    /\bsans (planning|programme fixe)\b|\bjuste des notes\b|\bjuste un (retour|feedback)\b|\bret(our|ours) apr[eè]s chaque (course|run)\b/i.test(msg)
  )
    return "NO_PLAN";

  return null;
}

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
  messageType?: string
): Promise<{ chatId: string | null }> {
  const isDryRun = dryRunUsers.has(userId);
  let chatId: string | null = null;
  if (!isDryRun) {
    const result = await sendSMS(phone, message);
    chatId = result?.chatId ?? null;
  }
  await supabase.from("conversations").insert({
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
 *   "onboarding"       → unified Claude conversation handler
 *   "awaiting_strava"  → Strava connect / skip handler
 *   "awaiting_cadence" → reminder preference handler (post-plan)
 *   "awaiting_payment" → payment link re-send
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
    case "awaiting_cadence":
      // Legacy state — graduate these users to fully onboarded with default cadence.
      // awaiting_cadence was removed; new users are defaulted to nightly_reminders at plan generation.
      await Promise.all([
        supabase.from("users").update({ onboarding_step: null }).eq("id", user.id),
        supabase.from("training_profiles").update({ proactive_cadence: "nightly_reminders" }).eq("user_id", user.id),
      ]);
      result = NextResponse.json({ ok: true });
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

  // True if Dean has already asked the pace calibration question in this conversation.
  // Used to suppress re-asking rather than relying on a prompt instruction.
  const alreadyAskedPaceCalibration = history.some(
    (m) => m.role === "assistant" && /road\s+(5k|10k|half marathon)/i.test(m.content)
  );

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
  // Detect language from user messages once and persist — only set if not already stored
  if (!mergedData.preferred_language) {
    const userMsgs = [...history.filter(m => m.role === "user").map(m => m.content), message];
    const detected = detectLanguage(userMsgs);
    if (detected !== "en") mergedData.preferred_language = detected;
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

    const weeklyLine = avgWeeklyMiles != null
      ? ` Recent avg: ~${avgWeeklyMiles} mi/week${mileageTrend ? ` (${mileageTrend})` : ""}.`
      : "";
    const frequencyLine = avgRunsPerWeek != null ? ` ~${avgRunsPerWeek} runs/week.` : "";
    const longestLine = longestRunMiles != null ? ` Longest run (8 weeks): ${longestRunMiles} mi.` : "";
    const elevLine = avgElevFtPerRun ? ` Avg elevation/run: ${avgElevFtPerRun} ft.` : "";
    // Show weekly progression oldest→newest so trend is readable (e.g. "22, 25, 28, 30")
    const progressionLine = recent4Weeks && recent4Weeks.some(m => m > 0)
      ? ` Weekly miles (oldest→newest): ${[...recent4Weeks].reverse().join(", ")}.`
      : "";
    const hrZoneLine = hrZonePct
      ? ` HR zones (% of runs by avg HR): Z1 ${hrZonePct.z1}%, Z2 ${hrZonePct.z2}%, Z3 ${hrZonePct.z3}%, Z4 ${hrZonePct.z4}%, Z5 ${hrZonePct.z5}%.${estimatedMaxHR ? ` Est. max HR: ${estimatedMaxHR} bpm.` : ""}`
      : "";
    const spikeLine = maxWeeklySpikePct != null && maxWeeklySpikePct >= 20
      ? ` ⚠️ Mileage spike detected: largest week-over-week jump in last 4 weeks was +${maxWeeklySpikePct}%.`
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
      stravaContext = `\nSTRAVA: Connected.${weeklyLine}${frequencyLine}${longestLine}${elevLine}${progressionLine}${hrZoneLine}${spikeLine} Best race for pace calibration: ${sbr.label} on ${sbr.date_str} in ${sbr.time_str}.${paceNote}`;

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
      stravaContext = `\nSTRAVA: Connected.${weeklyLine}${frequencyLine}${longestLine}${elevLine}${progressionLine}${hrZoneLine}${spikeLine}${paceNote}`;
    }
  } else {
    // Strava is mandatory — never treat the athlete as having skipped. If a legacy
    // user has strava_skipped: true, ignore it and re-pitch Strava on the next ask.
    stravaContext = "\nSTRAVA: Not connected yet — REQUIRED before [READY]. Re-pitch with [STRAVA_LINK] if the athlete pushes back.";
  }

  const collected = summarizeCollected(mergedData);

  const onbLang = (mergedData.preferred_language as string | undefined) ?? "en";
  const langInstruction = onbLang !== "en"
    ? `\nLANGUAGE: This athlete communicates in ${langCodeToName(onbLang)}. You MUST respond in ${langCodeToName(onbLang)} for every message. Do not switch to English. When the instructions below specify exact English wording (e.g. the three-options question), translate it into ${langCodeToName(onbLang)} while preserving all options and their structure.\n`
    : "";

  const systemPrompt = `${!isFirstResponse ? `This is an ongoing conversation. You already introduced yourself — continue naturally without re-introducing or using first-meeting phrases.

` : ""}${langInstruction}You are Coach Dean, an AI running coach onboarding a new athlete entirely over SMS text messages.

Dean's core job: help athletes get faster without getting injured. Every conversation should calibrate both performance and injury risk from the start.

Your job: collect the information below through natural conversation, then signal you're ready with [READY].

WHAT TO COLLECT:
Required before signaling [READY] — for ALL athletes:
- Athlete's name — ask in your FIRST message, combined with the training context question. Never address the athlete as "Athlete" or use a placeholder — if you don't have their name, you must ask.
- Training goal (specific race/event name and type, or general fitness/consistency). If they have no committed race — only aspirational talk like "maybe someday" or "thinking about eventually" — their goal is return_to_running or general_fitness, NOT the race distance.
- Strava — REQUIRED. Ask right after goal is established, BEFORE injury history or any other questions. Strava is the primary data source and answers fitness questions automatically. Do NOT offer a skip option.
- Injury history — REQUIRED FOR ALL ATHLETES. Must ask and receive an answer before [READY]. Frame naturally: "Has injury ever been a factor for you?" or "Anything you're managing right now or have had to work around before?" Even "no injuries at all" is a complete and valid answer. Ask AFTER Strava connects — not before.
- Plan preference — your final question before [READY]. See PLAN PREFERENCE section below.

Additional required fields by situation:
- Race date — required for any named race goal. MANDATORY web_search before stating any date.
- Ultra background (30k+): how many ultras, any trail races — must collect before [READY]
- Goal finish time (mile/5k/10k only): pacing depends entirely on this — ask directly once goal type is confirmed.

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
Everyone gets the same core intake. The order is roughly:
1. First message: intro + ask for their name and training context in one question (e.g. "What's your name, and how's your training been going lately?")
2. Once goal is clear AND any race dates are confirmed (see "RACE DATE CONFIRMATION COMES FIRST" below): ask about Strava. This comes BEFORE injury history or any other questions. Strava data often answers fitness questions automatically.
3. After Strava connects: ask about injury history ("Has injury ever been a factor for you, or anything you're managing right now?")
4. Collect remaining required fields: race date and fitness baseline as applicable (Strava usually covers fitness automatically)
5. Final question before [READY]: ask plan preference. See PLAN PREFERENCE section below.
6. Signal [READY] when all required fields are in

PLAN PREFERENCE (ask this as your final question before [READY]):
After you have name + goal + Strava connected + injury history answered, ask one final question before wrapping up:
"One last thing — want me to build you a training plan, or would you prefer just a coaching note after each run?"
- If they want a plan → reflect it back briefly, emit [MODE:FROM_SCRATCH] on its own line, then signal [READY] in the same message (since you have all the data).
- If they prefer just feedback → reflect it back briefly, emit [MODE:NO_PLAN] on its own line, then signal [READY].
EXCEPTION: If the athlete has already explicitly mentioned following a specific training platform (Runna, TrainingPeaks, Garmin Coach, a coach-written plan, etc.) at any point in the conversation, skip the question — emit [MODE:COMPLEMENT] on its own line when you acknowledge their plan, and move toward [READY] without asking.

MODE TAG — REQUIRED before signaling [READY]:
Emit ONE of these tags on its own line in the message where you wrap up:
- [MODE:FROM_SCRATCH] — athlete wants Dean to build them a plan
- [MODE:COMPLEMENT] — athlete already follows a plan (Runna, TrainingPeaks, coach, etc.)
- [MODE:NO_PLAN] — athlete wants post-run coaching notes only, no plan
The tag is stripped before the message is sent — do not mention or explain it. Never emit it speculatively before you know their preference.

SELF-CHECK BEFORE SENDING [READY]: If your message contains [READY], it MUST also contain one [MODE:...] tag. Without it, the system cannot route the athlete correctly.

EXISTING PLAN (athlete already follows Runna, TrainingPeaks, a coach-written plan, etc.):
Dean is a post-run analyst, not a plan builder. Confirm Dean works alongside their plan, not as a replacement. Do NOT offer to rebuild their plan. When asking about injuries, frame it as "what to watch for in the data." Text-message plan PDF: "Text me a PDF of your plan or describe it here — it gives me context to make your post-run feedback much more useful."

INSTRUCTIONS:
- Ask 1–2 questions per message. Never fire off 5 at once.
- Do not re-ask for anything listed under "what you already know" above, or anything the user has clearly stated earlier in this conversation.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- Never start a message with just the athlete's name alone on its own line. Use the name naturally within a sentence instead.
- When the athlete tells you their name for the first time, acknowledge it warmly at the start of your response — e.g. "Jake!" or "Hey Jake —" before continuing. Do NOT use "Nice to meet you" or any formal first-meeting phrase. Just use the name naturally.
- If they ask a coaching question, answer it briefly, then continue naturally.
- Training days: do NOT ask which days of the week they run. Plans are day-agnostic — the athlete picks their own days. If they mention a weekly count (e.g. "5 days a week"), acknowledge it but don't follow up with "which days".
${(mergedData.preferred_units as string | null) === "metric" ? "- UNITS: This athlete prefers metric — use km for distances and min/km for paces in all messages.\n" : ""}
${isFirstResponse
  ? `- This is your FIRST message. Lead with the Strava/post-run differentiator, then broaden the goal framing beyond just racing. Example: "Hey! I'm Coach Dean — I'll send you a coaching note after every run you log on Strava: what it means, whether to push or back off, and what's coming. My job is to make sure your training actually adds up to something, whether that's a race PR, staying healthy, or just running more consistently." Then close with a single question that asks for BOTH their name and what they're working toward — e.g. "What's your name, and what are you training for?" or "What's your name and what are you working toward?" Do NOT ask for name and goal as two separate questions — combine them into one. Do NOT reference specific tools like Runna or TrainingPeaks in the intro. Do NOT use the phrase "SMS running coach" — use "AI running coach" instead.`
  : ""}

INJURY INTAKE:
Injury history shapes the training plan — it's not a liability check, it's how Dean builds a program that actually gets the athlete to race day. Ask for every athlete, because most runners who plateau or underperform do so because something went wrong with their body, not their motivation.
- Ask after Strava connects — not before. Framing: "Has injury ever been a factor for you?" or "Anything you're managing right now or have had to work around?" Frame it as building context, not checking for problems.
- When they mention an injury: understand (1) what happened, and (2) what it means for how we structure training. Connect it to performance: "With IT band history I'll make sure we build the base gradually — that's the difference between making it to the start line and not." One follow-up is appropriate. Don't interrogate.
- "No injuries, all good" is a complete answer — accept it and move on.
- For injury_recovery or return_to_running goals: dig deeper — ask what happened AND current status.
- For ultra goals: also ask about trail/ultra race history before [READY].

STRAVA:
Ask about Strava as your NEXT question once you have goal — BEFORE injury history, race times, pace, or any other questions. Write "[STRAVA_LINK]" as a placeholder — the system will replace it with the actual link. Only ask once.
Briefly explain the value: connecting Strava means Dean automatically reads every run, calibrates training zones from real data, and writes a short coaching note directly to each activity description — like "🟢 Easy zone nailed — 92% Z1-Z2" — so feedback is always there in their Strava feed. Mention that Strava will show an "Upload your activities" checkbox on the permissions screen — that's what controls the write-back — and they can uncheck it if they'd prefer not to have notes added.
CRITICAL: Even if the athlete volunteers race history or pace info before Strava — do NOT follow up on that data yet. Ask about Strava first.
IMPORTANT: Strava ask must be a standalone turn — don't combine it with other questions. Ask only the Strava question in that message.
PLACEMENT: [STRAVA_LINK] must appear on its own line at the very end of the message.

PRICING QUESTIONS:
If the athlete asks whether this costs money, answer directly: there's a free 7-day trial. Answer in one sentence, then continue onboarding naturally.

TRAINING PACES — do NOT quote specific paces during onboarding:
Training zones are computed server-side from the athlete's data. You cannot reliably calculate VDOT-based paces in your head. Instead, acknowledge their baseline and connect it to their goal at a high level ("17:50 5K is a strong baseline — your training zones will be dialed in"). Never state a specific min/mi easy, tempo, or interval pace.

DEMONSTRATING VALUE — do this consistently, not just sometimes:
- When you receive a fitness baseline (race PR or easy pace), reflect back one specific insight connecting their data to their goal. Keep it to one sentence. Do NOT quote a specific min/mi easy pace.
- When the athlete expresses a doubt, constraint, or frustration, answer it briefly and specifically before asking your next question. This is often the highest-impact moment.
- When they mention a struggle or plateau, dig one level deeper before moving on. One follow-up question shows genuine coaching curiosity.
- Name the specific training mechanism that will address a stated struggle. Specificity is what makes this feel like real coaching.
- When the athlete mentions injury history, connect it directly to what Dean will watch for: "With IT band history, I'll flag when your weekly jump is too steep and watch your long run percentage." This makes the intake feel purposeful, not administrative.
- Use the athlete's own language and context in your wrap-up message. Reference their specific race, goal, or constraint.
- INJURY MENTIONS ARE NOT EXERCISE REQUESTS: If the athlete says their knee feels tight or they've had hamstring issues, that is injury CONTEXT. Acknowledge it briefly and connect it to how Dean will structure their training (e.g. "With that knee tightness I'll keep an eye on your weekly ramp rate"). Do NOT launch into exercise prescriptions.

RACE TARGET FOR TIME-GOAL ATHLETES:
If the athlete has a time goal for a specific distance but has not named a specific race, ask: "Any race on the calendar you're targeting this at?" A specific race date is essential for structuring the training timeline.

CYCLING AND TRIATHLON GOALS:
If the athlete's goal is purely cycling with no running component, be honest: "I specialize in running — I can structure a cycling plan but if pure cycling coaching is your main need, I may not be your best fit. Is running part of the mix at all?" Do not just proceed as if cycling and running coaching are equivalent.
If the athlete confirms they are cycling-only and not interested in running, wish them well and stop with a single message. After sending your farewell, treat the conversation as closed — do not send any further replies, even if the user says "thanks" or "goodbye". One exit message, full stop. Do not acknowledge, apologize, or reply again.
If the athlete is training for a triathlon, clarify your role upfront: "For triathlons I handle the run leg — I'll build your running program and check in after every run workout. For swim and bike you'd want dedicated coaching, but I'll make sure your run is dialed in."
Also ask about any physical limitations or injury history before signaling [READY] for triathlon goals — this directly affects run-specific programming.

STRAVA CONTEXT:
When Strava connects, give a genuine analytical read of the data — this is a taste of the post-run coaching they'll get ongoing. Lead with the performance story: what does this training history tell you about where this athlete is and where they can go? Use specific numbers. Pick 2–3 observations:
- Volume + trend: the mileage progression tells you how the base is developing. ("You've been building — 22, 25, 28, 30 miles over the last four weeks — that's a solid platform.") Connect it to their goal.
- Long run proportion: is the longest run appropriately long for their goal distance? Note it as a performance factor.
- Frequency: consistency of training is often the biggest predictor of improvement. ("5 days consistently — that's where aerobic gains compound.")
- Elevation: for trail athletes, elevation load = specificity. ("Averaging 500ft per run is solid prep for Dipsea's terrain.")
- HR zones (if present): frame this as performance insight, not a warning label. High Z1-2 is a strong aerobic base — the engine that gets you faster. High Z3+ means they're working harder than the base phase calls for, which limits how much fitness they can absorb. Be direct but frame it as "here's what this means for your training": "85% of your runs are in Z1-2 — that's a genuinely strong aerobic base, your fitness will compound well" or "About half your runs are running at threshold or harder — that's leaving gains on the table. Keeping the easy days easy is usually the fastest path to a PR."
- Mileage spike (if ⚠️ spike warning is present): surface it with specific numbers from the weekly progression above. Identify the exact mileage jump (e.g. "You went from 22 to 38 miles") by comparing adjacent values in the weekly progression line. Approximate the week date by counting back from today. Do NOT say "there was a notable one recently" — be concrete: "You jumped from X to Y miles the week of [approximate date] — that's a Z% spike. Worth watching as we ramp." Don't open with the warning — let it land after the positive read.
- Multiple races (if athlete has 2+ races): name ALL of them in the calibration summary and explain the periodization logic. E.g. "With Dipsea on June 1 and the 10K + Cirque Series in July, I'll prioritize climbing strength and aerobic efficiency in May, then shift to speed sharpening in June." Don't let secondary races silently disappear.
End with one forward-looking sentence connecting their data to their goal — UNLESS the PACE CALIBRATION section below requires asking a road race question in this message. In that case, the pace calibration question is the final sentence; do NOT add a separate forward-looking sentence after it.
Do NOT narrate all the stats like a report. Pick what's most interesting and make it feel like a real coach read the data — the performance picture first, risk context woven in.
If the inbound message is "(strava connected)", that is a system trigger — not something the user typed. Do not reference or repeat it. Just continue the conversation naturally from where you left off.

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
The moment an athlete mentions a specific named race, call web_search immediately to find the exact date AND the course profile. Do not state, confirm, or summarize any race date without first searching. Memory dates are frequently wrong, and user-provided dates are often wrong too — ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable. A month alone ("next April", "this fall") is never enough — get the specific day.
When searching for a trail, mountain, or ultra race: also look up the course's total elevation gain (in feet), starting altitude (if it's a mountain race), and terrain character (groomed fire roads, singletrack, technical, etc.). Mention these in your response naturally so the extraction pass can capture them — e.g. "Hardrock 100 is on July 19th with about 33,000ft of gain and starting at high altitude in the San Juans." You don't need to ask the athlete for this info if you can find it from the search.
After searching: if the search result shows the race date is within the next 6 weeks AND the user is starting a new coaching relationship (not explicitly asking for race-week prep), do NOT proceed — ask first: "That's only [X] weeks away — are you looking for race-week prep for this year, or building toward [next year]?" Do not pivot to taper mode or any race-specific framing until the user confirms the year.
After searching: if the user has not stated a specific date (only a month or vague timeframe), confirm the search result with them before proceeding: "I found it listed as [date] — does that sound right?"
FIRST-OF-MONTH GUARD: If the only date information you have is a month ("in June", "sometime in July", "this fall"), do NOT proceed with the 1st of that month as a placeholder. Stop and ask: "Do you know the exact date?" A first-of-month date is almost always wrong and will miscalibrate the entire training timeline.
If no web_search tool is available to you in this context and the athlete has mentioned a race but you don't have a confirmed exact date, you MUST ask for it directly — do not proceed without it. Example: "What's the exact date of the Dipsea?" Ask this before moving on to any other question.

NEVER PROMISE ASYNC WORK YOU CAN'T DELIVER:
You cannot say "let me pull that up", "give me a moment", "I'll check and get back to you", "one sec while I look", or anything implying you'll send a follow-up message later. There is no async loop — every reply you send is the only reply that turn. If you need information you don't have (a race date, course profile, etc.), either (a) call the web_search tool inline this turn so the answer is in this same reply, or (b) ask the athlete for it directly. Do not narrate the lookup as if it were happening in the background. The user will be left staring at silence.
After searching: if the athlete stated a specific date (day + month) and the search result is within 2 days of it, use the athlete's stated date — web results frequently have minor calendar errors, and athletes are generally right about their own races. Only override the athlete's specific date if the search shows a clearly different week or month; in that case note it (e.g. "I found it listed as [search date] — does that sound right?"). Never silently override a specific athlete-provided date with a search result that differs by just 1–2 days.

SIGNALING READY:
READY CHECK — do this before every reply: scan WHAT YOU ALREADY KNOW for these five items:
1. Name ✓
2. Goal (+ race date if a named race) ✓
3. Strava connected ✓ (shown as "STRAVA: Connected" in the context above)
4. Injury history — any answer including "no injuries" ✓
5. Plan preference confirmed ✓ (shown as "Plan preference: …" in WHAT YOU ALREADY KNOW)

If ALL FIVE are present: signal [READY] in THIS message immediately. Do not ask ANY follow-up question — not training days, not strength work, not weekly mileage, not anything. Plans are day-agnostic; asking which days they train is explicitly forbidden because it delays the athlete unnecessarily. Write a warm 1-2 sentence wrap-up, emit [MODE:...] on its own line, then [READY] on its own line. Nothing else.

If plan preference hasn't been confirmed yet: ask "One last thing — want me to build you a training plan, or would you prefer just a coaching note after each run?" and wait for their answer before signaling [READY].
The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
[READY] IS REQUIRED ON ANY WRAP-UP: If your message says anything like "you're all set", "ready to kick off", "we're good to go", or otherwise signs off without a question, you MUST include [READY] and [MODE:...] on their own lines.
Name is always required — if the user hasn't told you their name yet, ask before signaling [READY]. If you asked for the name but the user deflected or skipped it, circle back and ask again before wrapping up.
CRITICAL — [READY] means zero open questions: [READY] can only appear in a message that contains NO questions of any kind — required or optional, soft or hard. The moment you add a question mark to a message, [READY] is off the table for that turn, no matter how minor the question seems. If you realize you still need to ask something (pace calibration, goal time, any follow-up), ask it in this message WITHOUT [READY] and wait for the athlete's response. Then wrap up and signal [READY] in your next turn. Signaling [READY] while an unanswered question is in the same message fires the plan immediately — the athlete never gets to respond.
When you signal [READY], wrap up warmly in 1-2 sentences: tell them their first coaching note will arrive after their next run on Strava (and if they asked for a plan, it will arrive shortly too). Tie it to their specific goal or race. Use first person only — never refer to yourself as "Dean". Keep it brief.
WORD ACCURACY: The term is "aerobic" (related to oxygen use / endurance). Never write "aerodynamic" — that's about airflow over a bike or car, not running physiology. Double-check this word before sending.

ULTRA AND INJURY GOALS — extra required fields:
For ultra goals (30k, 50k, 50mi, 100k, 100mi): you MUST ask about their ultra/trail race history AND any injuries or physical limitations before signaling [READY]. "Any prior ultras or trail races?" covers both.
For return_to_running or injury_recovery goals: you MUST ask about the injury/limitation and current status before [READY].

${alreadyAskedPaceCalibration
  ? `PACE CALIBRATION — trail race on Strava:
You already asked about road race times earlier in this conversation. Do NOT ask again. Accept whatever pace data the athlete has provided and proceed.`
  : `PACE CALIBRATION — trail race on Strava:
If Strava is connected and the STRAVA note says "this is a trail race", you MUST ask about road race times in THIS message — do not defer it to a later turn. Trail paces are slower than road paces due to elevation, so the suggested easy pace from Strava is only a rough estimate until we get a road benchmark. Reference the specific race from the STRAVA note by its label and date (e.g. "I can see a [label] from [date] in your Strava history"). Then explain that since it was a trail race, elevation makes trail paces slower than road paces, so you'd love a recent road 5K, 10K, or half marathon time for more accurate training zones — but no worries if they don't have one.
Do NOT use vague phrases like "your best Strava effort" without naming the specific race. Do NOT state the suggested easy pace as settled or confident — frame it as preliminary until the calibration question is answered.
Do NOT ask this if a recent road race PR is already listed under "WHAT YOU ALREADY KNOW" (easy_pace or recent race already provided).
IMPORTANT: Because this is a question, do NOT include [READY] in this same message. Wait for the athlete's response — even "I don't have one" is sufficient — then signal [READY] in the next turn.`}`;

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
  const isOpenAI = (process.env.AI_PROVIDER ?? "openai") === "openai";

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

  // Parse deterministic working-mode tag. Dean emits [MODE:FROM_SCRATCH|COMPLEMENT|NO_PLAN]
  // the moment the athlete confirms their working mode. This replaces Haiku
  // inference for has_existing_plan / wants_plan — those are downstream of a
  // single explicit choice, so a free-text extraction is the wrong tool.
  const modeMatch = rawText.match(/\[MODE:(FROM_SCRATCH|COMPLEMENT|NO_PLAN)\]/i);
  if (modeMatch) {
    const mode = modeMatch[1].toUpperCase();
    if (mode === "FROM_SCRATCH") {
      mergedData.has_existing_plan = false;
      mergedData.wants_plan = true;
    } else if (mode === "COMPLEMENT") {
      mergedData.has_existing_plan = true;
      mergedData.wants_plan = false;
    } else if (mode === "NO_PLAN") {
      mergedData.has_existing_plan = false;
      mergedData.wants_plan = false;
    }
  } else if (mergedData.has_existing_plan == null && mergedData.wants_plan == null) {
    // Safety net: Dean occasionally forgets the [MODE:...] tag even after
    // reflecting the mode back in prose. Parse the athlete's reply against the
    // previous assistant message if it was the three-options question.
    const lastAssistantMsg =
      [...history].reverse().find((m) => m.role === "assistant")?.content ?? null;
    const inferred = parseModeFallback(message, lastAssistantMsg);
    if (inferred) {
      console.warn(
        `[onboarding] [MODE] tag missing — inferred ${inferred} from athlete reply`
      );
      if (inferred === "FROM_SCRATCH") {
        mergedData.has_existing_plan = false;
        mergedData.wants_plan = true;
      } else if (inferred === "COMPLEMENT") {
        mergedData.has_existing_plan = true;
        mergedData.wants_plan = false;
      } else if (inferred === "NO_PLAN") {
        mergedData.has_existing_plan = false;
        mergedData.wants_plan = false;
      }
    }
  }

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
    const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
    const stravaLang = (mergedData.preferred_language as string | undefined) ?? "en";
    const notesUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;
    const stravaFooter = stravaLang === "fr"
      ? `Envie que je laisse une note de coaching sur chaque activité (ex. "🟢 Zone facile respectée — 92% Z1-Z2") ? Utilisez ce lien à la place :\n${notesUrl}`
      : stravaLang === "es"
      ? `¿Quieres que Dean agregue una nota de entrenamiento a cada actividad (ej. "🟢 Zona fácil lograda — 92% Z1-Z2")? Usa este enlace en su lugar:\n${notesUrl}`
      : `Want Dean to add a coaching note to each activity (like "🟢 Easy zone nailed — 92% Z1-Z2")? Use this link instead:\n${notesUrl}`;
    stravaMsg = `${stravaParagraph ? stravaParagraph + "\n\n" : ""}${stravaUrl}\n\n${stravaFooter}`; // stravaUrl = read-only; notesUrl = write opt-in (in footer)
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
  await supabase.from("conversations").insert({
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
      const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
      const lang = (mergedData.preferred_language as string | undefined) ?? "en";
      const pitch = lang === "fr"
        ? `Avant qu'on lance — j'ai vraiment besoin de Strava pour te coacher correctement. Sans ça, je ne peux pas voir tes courses ni te donner de retour utile après chaque sortie. Connecte ici (gratuit, deux minutes) :\n\n${stravaUrl}`
        : lang === "es"
        ? `Antes de empezar — necesito Strava de verdad para entrenarte. Sin él no puedo ver tus carreras ni darte feedback útil después de cada una. Conéctalo aquí (gratis, dos minutos):\n\n${stravaUrl}`
        : `Before we kick off — I really need Strava to coach you properly. Without it I can't see your runs or give you useful feedback after each one. Takes two minutes (free):\n\n${stravaUrl}`;
      await sendAndStore(user.id, user.phone_number, pitch, "awaiting_strava");
      return NextResponse.json({ ok: true });
    }

    // Mode guard: never silently default to plan-building when the athlete's
    // working mode is unresolved. If both has_existing_plan and wants_plan are
    // null at [READY], the downstream completeOnboarding path falls through to
    // initial_plan generation — which is wrong if the athlete actually wanted
    // post-run notes only. Re-ask the mode question explicitly instead.
    const modeUnresolved =
      mergedData.has_existing_plan == null && mergedData.wants_plan == null;
    if (modeUnresolved) {
      console.warn("[onboarding] [READY] fired but mode unresolved — re-asking mode question");
      await supabase.from("users")
        .update({ onboarding_data: mergedData as unknown as Json })
        .eq("id", user.id);
      const modeLang = (mergedData.preferred_language as string | undefined) ?? "en";
      const modeQuestion = modeLang === "fr"
        ? "Dernière chose — est-ce que vous voulez que je vous construise un plan d'entraînement, ou préférez-vous juste une note de coaching après chaque course ?"
        : modeLang === "es"
        ? "Una última cosa — ¿quieres que te construya un plan de entrenamiento, o prefieres solo una nota de entrenamiento después de cada carrera?"
        : "One last thing — want me to build you a training plan, or would you prefer just a coaching note after each run?";
      // Only append the fallback mode question if Claude's response doesn't already contain it
      // (Claude may have asked naturally, and appending again causes duplication).
      const alreadyAsked = /want me to build|coaching note after each run|just a coaching note/i.test(cleanedResponse ?? "");
      const combined = alreadyAsked
        ? (cleanedResponse ?? modeQuestion)
        : (cleanedResponse ? `${cleanedResponse}\n\n${modeQuestion}` : modeQuestion);
      await sendAndStore(user.id, user.phone_number, combined, "onboarding");
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
    lines.push(`Race date: ${formatted}`);
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
    const planPref = data.has_existing_plan
      ? "has existing plan (Dean works alongside it)"
      : data.wants_plan === false
      ? "no plan, wants post-run coaching notes only"
      : data.wants_plan === true
      ? "wants Dean to build a plan from scratch"
      : "no existing plan";
    lines.push(`Plan preference: ${planPref} — do NOT ask about this again`);
  }
  if (data.plan_uploaded) {
    const name = data.plan_filename ? ` ("${(data.plan_filename as string).replace(/\.pdf$/i, "")}")` : "";
    lines.push(`Training plan uploaded${name} — content available in context. Do NOT ask the athlete to send it again.`);
  }
  if (data.external_plan_description) lines.push(`Current plan: ${data.external_plan_description}`);
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
- external_plan_description: capture a brief factual summary when the athlete describes a training plan they're currently following (plan source/name, current week, weekly mileage). E.g. "Runna 16-week half marathon plan, week 6, ~35mi/week". Null if no current plan. Do NOT capture a plan Dean is going to build ("custom plan from Dean", "new plan Dean will make") — only current external plans. (has_existing_plan and wants_plan are NOT extracted here — they come from Dean's [MODE:...] tag, which is the source of truth.)
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
          external_plan_description: { type: ["string", "null"], description: "Brief factual summary of athlete's current external plan: source/name, current week, weekly mileage. E.g. 'Runna 16-week HM plan, week 8, ~40mi/week'. Null if no current plan — NEVER capture a plan Dean is going to build." },
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
// Strava step (simplified)
// ---------------------------------------------------------------------------

async function handleStrava(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  onboardingData: Record<string, unknown>,
  _chatId?: string | null
): Promise<NextResponse> {
  const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;

  // If asking about Strava — explain what it is and re-send the link
  const isAskingAboutStrava = /\b(what|what's|whats|how|why|tell me about|explain|never heard)\b/i.test(message);
  if (isAskingAboutStrava || (/strava/i.test(message) && message.includes("?"))) {
    const reply = `Strava is a free app that tracks your runs via GPS — lots of runners use it. Once you connect it, I'll automatically read every run you do and send you a personalized coaching note after each one.\n\n${stravaUrl}\n\nHeads up: Strava will ask to allow "Upload activities" — that's just their label for letting me add a coaching note and additional metrics to each of your runs. You can uncheck it if you'd prefer not.`;
    await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  // Any other message while awaiting Strava — re-send the link
  const reply = `Connect Strava so I can read your runs automatically:\n\n${stravaUrl}\n\nHeads up: Strava will ask to allow "Upload activities" — that's just their label for letting me add a coaching note and additional metrics to each of your runs. You can uncheck it if you'd prefer not.`;
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
  const currentLongRunMiles = (data.current_long_run_miles as number) ?? null;
  const longRunRaw = Math.round(weeklyMileage * 0.3);
  const longRun =
    currentLongRunMiles ?? (isUltra ? Math.max(longRunRaw, 10) : longRunRaw);

  const trainingTools = (data.training_tools as string[] | null) || [];
  const terrainType = (data.terrain_type as string | null) || null;
  const hasExistingPlan = (data.has_existing_plan as boolean | null) ?? null;
  const wantsPlan = (data.wants_plan as boolean | null) ?? null;
  const externalPlanDescription = (data.external_plan_description as string | null) || null;
  const crossTrainingActivities = (data.cross_training_activities as string[] | null) || (data.crosstraining_tools as string[] | null) || [];
  // Combine injury history + current niggles into injury_notes if not already set
  const injuryHistoryText = (data.injury_history as string | null) || null;
  const currentNiggles = (data.current_niggles as string | null) || null;
  const combinedInjuryNotes = injuryNotes
    || [injuryHistoryText, currentNiggles].filter(Boolean).join(" | ")
    || null;

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
        coaching_mode: hasExistingPlan === true ? 'complement' :
          hasExistingPlan === false && wantsPlan === false ? 'analyst' : 'full_coach',
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    ),
    supabase.from("training_state").upsert(
      {
        user_id: user.id,
        current_week: 1,
        current_phase: "base",
        weekly_mileage_target: weeklyMileage,
        long_run_target: longRun,
        week_mileage_so_far: 0,
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

  // Check if billing gate is needed
  const { data: billingUser } = await supabase
    .from("users")
    .select("billing_enabled, dashboard_token, phone_number")
    .eq("id", user.id)
    .single();

  const billingEnabled = !!(billingUser?.billing_enabled);

  const userUpdatePayload: Record<string, unknown> = {
    onboarding_data: data as unknown as Json,
  };
  if (name) userUpdatePayload.name = name;

  if (billingEnabled) {
    let dashboardToken = billingUser?.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      userUpdatePayload.dashboard_token = dashboardToken;
    }
    userUpdatePayload.onboarding_step = "awaiting_payment";
    userUpdatePayload.payment_link_sent_at = new Date().toISOString();
  } else {
    userUpdatePayload.onboarding_step = null;
  }

  const userResult = await supabase
    .from("users")
    .update(userUpdatePayload)
    .eq("id", user.id);

  if (userResult.error) console.error("[onboarding] users update failed:", userResult.error);

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

  if (billingEnabled) {
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

  // For users with an existing plan (Runna, TP, etc.), skip Dean's plan generation.
  // Dean's [READY] wrap-up already told them what to expect — no follow-up message needed.
  if (hasExistingPlan === true) {
    void trackEvent(user.id, "onboarding_completed", { goal, mode: "complement" });
    const { data: complementUser } = await supabase
      .from("users")
      .select("dashboard_token")
      .eq("id", user.id)
      .single();
    let dashboardToken = complementUser?.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      await supabase.from("users").update({
        dashboard_token: dashboardToken,
        trial_started_at: new Date().toISOString(),
      }).eq("id", user.id);
    }
    return;
  }

  // User has no existing plan and doesn't want one — post-run feedback only, no schedule.
  // Dean's [READY] wrap-up already told them what to expect — no follow-up message needed.
  if (hasExistingPlan === false && wantsPlan === false) {
    void trackEvent(user.id, "onboarding_completed", { goal, mode: "no_plan" });
    const { data: noPlanUser } = await supabase
      .from("users")
      .select("dashboard_token")
      .eq("id", user.id)
      .single();
    let dashboardToken = noPlanUser?.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      await supabase.from("users").update({
        dashboard_token: dashboardToken,
        trial_started_at: new Date().toISOString(),
      }).eq("id", user.id);
    }
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
          await supabase.from("conversations").insert({
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
    after(async () => {
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
