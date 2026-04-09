import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping } from "@/lib/linq";
import { trackEvent } from "@/lib/track";
import { calculateVDOTPaces, easyPaceRange, formatRaceDistance } from "@/lib/paces";
import { getCheckoutPageUrl } from "@/lib/stripe";
import type { Json } from "@/lib/database.types";

export const maxDuration = 60;

// Tracks userIds currently in a dry_run onboarding request.
const dryRunUsers = new Set<string>();

interface OnboardingRequest {
  userId: string;
  message: string;
  chatId?: string | null;
  dry_run?: boolean;
}

/** Extract JSON from Claude's response, handling markdown code blocks */
function extractJSON(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];
  return text;
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
    .select("id, phone_number, name, onboarding_step, onboarding_data")
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
      result = await handleCadence({ ...user, onboarding_data: onboardingData }, message);
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
// Unified conversation handler
// ---------------------------------------------------------------------------

const ULTRA_GOALS = ["30k", "50k", "50mi", "100k", "100mi"];

const VALID_GOAL_BUCKETS = new Set([
  "mile", "5k", "10k", "half_marathon", "marathon", "trail_race", "30k", "50k", "50mi", "100k", "100mi",
  "sprint_tri", "olympic_tri", "70.3", "ironman", "cycling",
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

  // Build Strava context (best race for pace suggestion, if available)
  let stravaContext = "";
  if (onboardingData.strava_connected) {
    const sbr = await lookupBestStravaRace(user.id);
    if (sbr) {
      const easyRange = easyPaceRange(sbr.easy_pace);
      const trailNote = sbr.is_trail
        ? " Note: this is a trail race — road training paces will be slightly faster."
        : "";
      stravaContext = `\nSTRAVA: Connected. Best race on file: ${sbr.label} on ${sbr.date_str} in ${sbr.time_str}.${trailNote} Suggested easy pace: ${easyRange}/mi. You can use this to set their training zones.`;
    } else {
      const stats = onboardingData.strava_stats as Record<string, unknown> | null;
      const recent = stats?.recent_run_totals as Record<string, unknown> | null;
      const recentMiles = recent?.distance
        ? Math.round((recent.distance as number) / 1609.34)
        : null;
      const hasRaceData = !!(onboardingData.recent_race_distance_km && onboardingData.recent_race_time_minutes);
      const hasPaceData = !!onboardingData.easy_pace;
      const paceNote = hasRaceData || hasPaceData
        ? " No race activity found on Strava — using pace data already collected from conversation."
        : " No races found for VDOT calculation — ask for a recent race time or PR to set training paces.";
      stravaContext = `\nSTRAVA: Connected.${recentMiles ? ` Recent 4-week mileage: ~${recentMiles} miles.` : ""}${paceNote}`;
    }
  } else if (onboardingData.strava_skipped) {
    stravaContext = "\nSTRAVA: User skipped Strava. Collect mileage + pace data manually.";
  } else {
    stravaContext = "\nSTRAVA: Not connected yet.";
  }

  const collected = summarizeCollected(onboardingData);

  const systemPrompt = `${!isFirstResponse ? `This is an ongoing conversation. You already introduced yourself — continue naturally without re-introducing or using first-meeting phrases.

` : ""}You are Coach Dean, an AI running coach onboarding a new athlete entirely over SMS text messages.

Your job: collect the information below through natural conversation, then signal you're ready with [READY].

WHAT TO COLLECT:
Required before signaling [READY]:
- Athlete's name (ask in your first message if not already known)
- Training goal (specific race/event name and type, or general fitness). If they have no committed race — only aspirational talk like "maybe someday" or "thinking about eventually" — their goal is return_to_running or general_fitness, NOT the race distance.
- Training schedule (which days of the week work best)
- Race date (if they have a named race — MANDATORY: always web_search the exact date, never state one from memory)
- Fitness baseline: a recent race PR, current easy pace, OR Strava is connected
- Current weekly mileage — REQUIRED if Strava is not connected. Ask directly: "How many miles are you running per week right now?" or "Are you currently running, and if so, about how many miles per week?" If they say they're not running yet or just starting out, that is also useful — record as 0. Do not skip this even if you have their pace — mileage and pace are independent.

Required ONLY for ultra goals (30k, 50k, 50mi, 100k, 100mi) — must collect before [READY]:
- Ultra and trail race background: how many ultras have they done? Any trail races? This is essential for planning.
- Injury or physical limitation notes

Required ONLY for return_to_running or injury_recovery goals — must collect before [READY]:
- Injury or physical limitation notes (what happened, current status)

Required for short races (mile, 5k, 10k) — pacing depends entirely on goal time:
- Goal finish time or pace (e.g. "sub 5 minute mile", "under 22 minutes for 5K"). Ask directly after you have their goal type confirmed. This is essential for calibrating interval and tempo paces.

Optional (only collect if it comes up naturally):
- Goal finish time for longer races (half marathon, marathon, trail)
- Other races this season (B/C tune-up races)

WHAT YOU ALREADY KNOW:
${collected || "Nothing yet."}
${stravaContext}

INSTRUCTIONS:
- Ask 1–2 questions per message. Never fire off 5 at once.
- Do not re-ask for anything listed under "what you already know" above, or anything the user has clearly already stated earlier in this conversation. Read the full conversation history before asking for any field — if the user mentioned their city, timezone, or training days in a prior turn, do not ask again.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- Never start a message with just the athlete's name alone on its own line (e.g. "Jake!" followed by a blank line). Use the name naturally within a sentence instead.
- If they ask a coaching question, answer it briefly, then continue naturally.
- Training days: if the athlete says "X days a week" or "I run X times a week" without naming the specific days, always ask which days before moving on.
- Day ranges: if the athlete says "X through Y" or "X-Y" (e.g. "Tues-Thursday", "Mon to Wed"), interpret this as ALL days in that range, inclusive. "Tues-Thursday" means Tuesday, Wednesday, AND Thursday — not just Tuesday and Thursday.

${isFirstResponse
  ? "- This is your FIRST message to this athlete. Introduce yourself in 1–2 sentences (AI running coach, builds personalized plans, tracks runs via Strava, checks in over text), then ask for their name. Keep it punchy, not salesy."
  : ""}

STRAVA:
Ask about Strava early — once you have the athlete's name and goal, it should be one of your next questions. Don't wait until the end of onboarding. Write "[STRAVA_LINK]" as a placeholder — the system will replace it with the actual link. Only ask once.
When you ask, briefly explain the value in one sentence: connecting Strava means you'll automatically read every run and calibrate training zones from real data — no manual reporting needed. Also mention it helps inform the training plan.
IMPORTANT: When you ask about Strava, make it a standalone turn — do not combine it with other questions (training days, pace, etc.) in the same message. Ask only the Strava question in that message. Ask other questions in your next turn after the user responds. This prevents you from re-asking questions the user already answered when they were bundled with the Strava link.
PLACEMENT: [STRAVA_LINK] must appear on its own line at the very end of the message — never embedded inline in a sentence (e.g. never "connect here: [STRAVA_LINK]."). End your question, then put [STRAVA_LINK] on a new line after.

PRICING QUESTIONS:
If the athlete asks whether this costs money or is free, answer directly and briefly: there's a free 7-day trial — they get full access to their plan and coaching before any payment. Don't dodge the question or defer it. Answer it in one sentence, then continue onboarding naturally.

DEMONSTRATING VALUE — do this consistently, not just sometimes:
- When you receive a fitness baseline (race PR or easy pace), always reflect back one specific insight connecting their data to their goal. Examples: "A 2:05 half puts you in the 4:20-4:30 marathon range if we train smart." / "Your 18:45 5K puts your current mile equivalent around 5:10 — a 10-second drop is very achievable with the right speedwork." Keep it to one sentence.
- When the athlete expresses a doubt, constraint, or frustration ("is 3 days enough?", "I've been inconsistent", "stuck at X for two years"), answer it briefly and specifically before asking your next question. Don't skip past it. This is often the highest-impact moment in the conversation.
- For general fitness goals with no race target, connect their numbers to what they'll experience: "At 11:00/mi and 15 miles/week you've got a solid base — within the first training block you'll notice real speed gains." Something concrete, not generic encouragement.
- When the athlete mentions something they've been struggling with or stuck on — a weakness, plateau, specific thing they want to improve — dig one level deeper before moving on. Ask the why: "Is it more of an endurance thing or are you finding your speed isn't there?" / "What do you think has been holding you back?" One follow-up question shows genuine coaching curiosity and gives you the context to actually address it. This applies broadly: triathlete saying their run is weak, runner stuck at the same 5K time, someone who says they've been inconsistent. Don't just acknowledge it — understand it.
- Name the specific training mechanism that will address a stated struggle. Don't say "we'll work on that" — say what you'll actually do and why it works. Specificity is what makes this feel like real coaching vs a generic chatbot.
- Use the athlete's own language and context to make your wrap-up message feel personal, not templated. Reference their specific race, goal, or constraint: "I'll get your plan together now — you'll see your first week built around those three early morning windows" beats "I'll get your plan together now."

CYCLING AND TRIATHLON GOALS:
If the athlete's goal is purely cycling with no running component, be honest: "I specialize in running — I can structure a cycling plan but if pure cycling coaching is your main need, I may not be your best fit. Is running part of the mix at all?" Do not just proceed as if cycling and running coaching are equivalent.
If the athlete confirms they are cycling-only and not interested in running, wish them well and stop. Do not continue responding to further messages once the conversation has concluded with a graceful exit. A single warm farewell is enough — do not reply again if they say thanks or goodbye.
If the athlete is training for a triathlon, clarify your role upfront: "For triathlons I handle the run leg — I'll build your running program and check in after every run workout. For swim and bike you'd want dedicated coaching, but I'll make sure your run is dialed in."
Also ask about any physical limitations or injury history before signaling [READY] for triathlon goals — this directly affects run-specific programming.

STRAVA CONTEXT:
When Strava connects and shows training history, demonstrate that you've genuinely analyzed their data — don't just say "I can see your Strava." Reference something specific and concrete: their recent mileage, training frequency, effort distribution, or a notable run. The goal is to make them feel you actually understand who they are as a runner, not just that you have access to their account. Examples: "I can see you've been putting in consistent 40-mile weeks with most of it at easy effort — that's a solid aerobic base to build from." / "Looks like you've been running 5 days a week fairly consistently, with a longer effort on Saturdays." Surface observations that connect to their goal or what they've told you they want to improve. Don't ask a generic "what's been missing?" — let the data itself show you know them.
If the inbound message is "(strava connected)", that is a system trigger — not something the user typed. Do not reference or repeat it. Just continue the conversation naturally from where you left off.

RACE DATE — MANDATORY SEARCH:
The moment an athlete mentions a specific named race, call web_search immediately to find the exact date. Do not state, confirm, or summarize any race date without first searching. Memory dates are frequently wrong, and user-provided dates are often wrong too — ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable. A month alone ("next April", "this fall") is never enough — get the specific day.
After searching: if the search result shows the race date is within the next 6 weeks AND the user is starting a new coaching relationship (not explicitly asking for race-week prep), do NOT proceed — ask first: "That's only [X] weeks away — are you looking for race-week prep for this year, or building toward [next year]?" Do not pivot to taper mode or any race-specific framing until the user confirms the year.
After searching: if the user has not stated a specific date (only a month or vague timeframe), confirm the search result with them before proceeding: "I found it listed as [date] — does that sound right?"
After searching: always use the date from your search result, not the date the athlete stated. If they differ, note it (e.g. "I found it listed as [search date] — does that sound right?") rather than silently overriding in either direction.

SIGNALING READY:
When you have name + goal + training_days + at least one of (pace/PR data OR Strava connected), end your final message with [READY] on its own line. The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
Name is always required — if the user hasn't told you their name yet, ask before signaling [READY]. If you asked for the name but the user deflected or skipped it, circle back and ask again before wrapping up.
When you signal [READY], do not ask any more questions in that message. Wrap up warmly and set expectations (e.g. "I'll get your plan put together now") — the plan will be sent right after.

ULTRA AND INJURY GOALS — extra required fields:
For ultra goals (30k, 50k, 50mi, 100k, 100mi): you MUST ask about their ultra/trail race history AND any injuries or physical limitations before signaling [READY]. "Any prior ultras or trail races?" covers both.
For return_to_running or injury_recovery goals: you MUST ask about the injury/limitation and current status before [READY].

${alreadyAskedPaceCalibration
  ? `PACE CALIBRATION — trail race on Strava:
You already asked about road race times earlier in this conversation. Do NOT ask again. Accept whatever pace data the athlete has provided and proceed.`
  : `PACE CALIBRATION — trail race on Strava:
If Strava is connected and the STRAVA note says "this is a trail race", ask ONCE before signaling [READY]: "Your best Strava effort is a trail race, which tends to run slower than road races due to elevation. Do you have a recent road 5K, 10K, or half marathon time I can use for more accurate training paces? No worries if not — I can work with what's there."
Do NOT ask this if a recent road race PR is already listed under "WHAT YOU ALREADY KNOW" (easy_pace or recent race already provided).`}`;

  // Call Claude Sonnet — web_search handles race date lookups automatically
  const claudeResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 600,
    system: systemPrompt,
    messages: [...history, { role: "user", content: message }],
    tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
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
    } else {
      // Simpler greeting phrases ("Nice to meet you", "Great to meet you")
      rawText = rawText.replace(
        /^(nice|great|good|wonderful|so nice|really nice|so glad|happy)\s+to\s+(meet|have)\s+you[,!.]?\s*/i,
        ""
      );
    }
  }

  // Parse signals
  const isReady = /\[READY\]/i.test(rawText);
  const wantsStravaLink = /\[STRAVA_LINK\]/i.test(rawText);

  // Clean signals from displayed text
  let responseText = rawText
    .replace(/\[READY\]/gi, "")
    .replace(/\[STRAVA_LINK\]/gi, "")
    .trim();

  // Inject actual Strava URL where placeholder was
  if (wantsStravaLink && !onboardingData.strava_connected && !onboardingData.strava_skipped) {
    const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
    responseText = `${responseText}\n\n${stravaUrl}\n\nNo Strava? Just reply "skip".`;
  }

  // Extract structured fields from the full conversation using Haiku
  const extracted = await extractFields([
    ...history,
    { role: "user", content: message },
    { role: "assistant", content: responseText },
  ]);

  // Merge new fields into onboarding_data (don't overwrite with nulls)
  const mergedData = { ...onboardingData };
  for (const [k, v] of Object.entries(extracted)) {
    if (v !== null && v !== undefined) {
      // For arrays, only overwrite if the new value is non-empty
      if (Array.isArray(v) && (v as unknown[]).length === 0) continue;
      mergedData[k] = v;
    }
  }

  // Validate goal bucket — discard if invalid
  if (mergedData.goal && !VALID_GOAL_BUCKETS.has(mergedData.goal as string)) {
    delete mergedData.goal;
  }

  // Calculate VDOT paces whenever race time data is present.
  // Always recalculate — race-derived paces are more reliable than a pace extracted
  // from conversation text (e.g. one mentioned in the Strava insight message).
  // This ensures that if a user provides a better/corrected race time later in the
  // conversation, the VDOT updates rather than being blocked by a stale easy_pace.
  if (mergedData.recent_race_distance_km && mergedData.recent_race_time_minutes) {
    const paces = calculateVDOTPaces(
      mergedData.recent_race_distance_km as number,
      mergedData.recent_race_time_minutes as number
    );
    if (paces.easy) mergedData.easy_pace = paces.easy;
    if (paces.tempo) mergedData.tempo_pace = paces.tempo;
    if (paces.interval) mergedData.interval_pace = paces.interval;
  }

  // Store user's inbound message
  await supabase.from("conversations").insert({
    user_id: user.id,
    role: "user",
    content: message,
    message_type: "user_message",
  });

  if (isReady) {
    // Save final data and complete onboarding
    await supabase.from("users")
      .update({ onboarding_data: mergedData as unknown as Json })
      .eq("id", user.id);
    await sendAndStore(user.id, user.phone_number, responseText, "onboarding");
    await completeOnboarding(user, mergedData, chatId);
    return NextResponse.json({ ok: true });
  }

  if (wantsStravaLink && !onboardingData.strava_connected && !onboardingData.strava_skipped) {
    // Claude asked about Strava — pause conversation until user connects or skips
    await supabase.from("users")
      .update({
        onboarding_step: "awaiting_strava",
        onboarding_data: mergedData as unknown as Json,
      })
      .eq("id", user.id);
    await sendAndStore(user.id, user.phone_number, responseText, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  // Continue conversation
  await supabase.from("users")
    .update({ onboarding_data: mergedData as unknown as Json })
    .eq("id", user.id);
  await sendAndStore(user.id, user.phone_number, responseText, "onboarding");
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
  if (Array.isArray(data.training_days) && (data.training_days as string[]).length > 0) {
    lines.push(`Training days: ${(data.training_days as string[]).join(", ")}`);
  }
  if (data.days_per_week) lines.push(`Days per week: ${data.days_per_week}`);
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
  if (data.injury_notes) lines.push(`Injury/limitation: ${data.injury_notes}`);
  if (data.ultra_race_history) lines.push(`Ultra background: ${data.ultra_race_history}`);
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

/** Extract structured training fields from a conversation using Claude Haiku. */
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
    max_tokens: 600,
    system: `Extract training data from this conversation. Return ONLY valid JSON. Today is ${today}.

Output format (include only fields that are clearly stated — use null for anything not mentioned):
{
  "name": string | null,
  "goal": "mile"|"5k"|"10k"|"half_marathon"|"marathon"|"trail_race"|"30k"|"50k"|"50mi"|"100k"|"100mi"|"sprint_tri"|"olympic_tri"|"70.3"|"ironman"|"cycling"|"general_fitness"|"return_to_running"|"injury_recovery" | null,
  "race_name": string | null,
  "race_date": "YYYY-MM-DD" | null,
  "goal_distance_miles": number | null,
  "goal_time_minutes": number | null,
  "training_days": ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] (any subset) | null,
  "days_per_week": number | null,
  "easy_pace": "M:SS" | null,
  "tempo_pace": "M:SS" | null,
  "interval_pace": "M:SS" | null,
  "weekly_miles": number | null,
  "recent_race_distance_km": number | null,
  "recent_race_time_minutes": number | null,
  "injury_notes": string | null,
  "ultra_race_history": string | null,
  "experience_years": number | null,
  "other_races": [{"name": string|null, "date": "YYYY-MM-DD"|null, "priority": "B"|"C", "goal": string|null, "goal_distance_miles": number|null}] | null,
  "timezone": string | null,
  "strava_skipped": true | null,
  "wants_speed_work": true | null
}

Rules:
- Only extract data clearly stated in the conversation. Do not infer or guess.
- goal: use "trail_race" for trail/mountain races that aren't standard road distances (e.g. a 5mi, 8.9mi, 15mi trail race). Use standard buckets (5k, 10k, half_marathon, marathon) only for road races at those distances. IMPORTANT: if the athlete says they have no committed race — only aspirational/eventual talk ("maybe a marathon someday", "thinking about eventually") — use "return_to_running" or "general_fitness", NOT the race distance. The goal must reflect what they are actually training for right now, not what they might do later.
- training_days: lowercase full names only (e.g. ["tuesday","thursday","saturday","sunday"]). When the athlete specifies a range with "through", "to", or "-" (e.g. "Tuesday through Thursday", "Tues-Thursday", "Mon-Wed"), expand it to ALL days in that range inclusive — "Tues-Thursday" → ["tuesday","wednesday","thursday"].
- goal_time_minutes: total float minutes. "1:30" → 90.0, "17:40" → 17.67, "2:25:00" → 145.0
- race_date: use the most specific date mentioned for the goal race. If a specific date (day + month) was stated by either participant, use that exact date. Only default to first of month if no specific date was ever given. Today is ${today}.
- recent_race_distance_km: distance of their most-cited PR or recent race (not the goal race). IMPORTANT: extract this even when the athlete qualifies the race (e.g. "it was net downhill", "when I was in better shape", "a while ago", "it was hilly"). Caveated times are still useful for calibration — always extract if a distance and time are both stated.
- recent_race_time_minutes: finishing time of that race in total float minutes. M:SS format means minutes:seconds — "18:45" → 18.75, "38:20" → 38.33. H:MM:SS or H:MM format — "1:05:30" → 65.5, "1:52" → 112.0. Never convert M:SS as if the first number were hours.
- easy_pace: format "M:SS" (e.g. "8:30" means 8 minutes 30 seconds per mile)
- timezone: IANA string when a location is mentioned (e.g. "Provo, UT" → "America/Denver", "San Francisco" → "America/Los_Angeles")
- other_races: only B/C secondary races, not the main A race (goal/race_name/race_date). Use the same date precision rule as race_date — specific date if stated, first-of-month only as last resort.
- ultra_race_history: summarize any ultra or trail race background mentioned (e.g. "3 marathons PR 3:45, 2 trail halves, no prior ultras"). Populate whenever the athlete describes their racing/ultra history, even if they say they have none.
- strava_skipped: set to true if the athlete explicitly says they don't have Strava, won't use it, or skip it. Leave null if the topic hasn't come up.
- wants_speed_work: set to true if the athlete explicitly says they want to work on speed, get faster, improve their speed, or add speed work. Leave null if not mentioned.`,
    messages: [{ role: "user", content: transcript }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "{}";
  try {
    return JSON.parse(extractJSON(text)) as Record<string, unknown>;
  } catch {
    console.error("[onboarding] field extraction failed:", text);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Strava step (simplified)
// ---------------------------------------------------------------------------

async function handleStrava(
  user: { id: string; phone_number: string; name: string | null },
  message: string,
  onboardingData: Record<string, unknown>,
  chatId?: string | null
): Promise<NextResponse> {
  const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
  const isSkip = /\b(skip|no strava|don.?t have|no thanks|nope|later|next|without it)\b/i.test(message);

  // If asking about Strava specifically, explain value and re-send link
  if (!isSkip && /strava/i.test(message) && message.includes("?")) {
    const reply = `Yes, worth it — it's free and once connected I can automatically analyze every run without you reporting anything. Here's the link:\n\n${stravaUrl}\n\nAlready have it? Tap the link to connect. No Strava? Just reply "skip".`;
    await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  if (!isSkip) {
    // Non-skip, non-question — just re-send the link
    const reply = `Connect Strava for automatic run tracking:\n\n${stravaUrl}\n\nOr reply "skip" to continue without it.`;
    await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  // User skipped Strava — return to unified conversation handler
  // Route back through handleConversation so Dean has full context of what
  // was already asked (avoiding double-asking questions like training days
  // that may have been bundled in the same message as the Strava link).
  const mergedData = { ...onboardingData, strava_skipped: true };
  await supabase.from("users").update({
    onboarding_step: "onboarding",
    onboarding_data: mergedData as unknown as Json,
  }).eq("id", user.id);

  void trackEvent(user.id, "onboarding_strava_skipped", {});

  return handleConversation(user, message, mergedData, chatId);
}

// ---------------------------------------------------------------------------
// Cadence handler (post-plan reminder preference)
// ---------------------------------------------------------------------------

async function handleCadence(
  user: { id: string; phone_number: string; name: string | null; onboarding_data: Record<string, unknown> },
  message: string
): Promise<NextResponse> {
  const timezoneAlreadyConfirmed = !!(user.onboarding_data.timezone_confirmed);

  const [cadenceResponse, parsedTimezone] = await Promise.all([
    anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16,
      system: `The athlete is responding to: "Would you like a reminder about your upcoming workouts the morning of, or the evening before? If not, I'll just send you a weekly plan every Sunday."

Classify their reply. Return only one word: "morning", "nightly", "weekly", or "unclear".
- "morning", "day of", "morning of", "same day", "that morning", "morning works", any morning time like "8am" → morning
- "evening", "night before", "nightly", "the night before", "evening works" → nightly
- "no", "nope", "neither", "no thanks", "just the weekly", "weekly", "sunday", "no reminders" → weekly
- Anything not clearly answering the reminder question → unclear`,
      messages: [{ role: "user", content: message }],
    }),
    timezoneAlreadyConfirmed ? Promise.resolve(null) : parseTimezoneFromMessage(message),
  ]);

  const raw =
    cadenceResponse.content[0].type === "text"
      ? cadenceResponse.content[0].text.trim().toLowerCase()
      : "weekly";

  if (raw.startsWith("unclear")) {
    return handleNonCadenceMessage(user, message);
  }

  const cadence = raw.startsWith("morning")
    ? "morning_reminders"
    : raw.startsWith("nightly")
    ? "nightly_reminders"
    : "weekly_only";

  // Check if initial plan was ever sent
  const { data: planMessages } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", user.id)
    .eq("message_type", "initial_plan")
    .limit(1);
  const planAlreadySent = (planMessages?.length ?? 0) > 0;

  const userUpdate: Record<string, unknown> = { onboarding_step: null };
  if (!timezoneAlreadyConfirmed && parsedTimezone) {
    userUpdate.timezone = parsedTimezone;
    userUpdate.onboarding_data = { ...user.onboarding_data, timezone_confirmed: true };
  }

  await Promise.all([
    supabase.from("training_profiles").update({ proactive_cadence: cadence }).eq("user_id", user.id),
    supabase.from("users").update(userUpdate).eq("id", user.id),
  ]);

  void trackEvent(user.id, "cadence_preference_set", { cadence });

  if (!planAlreadySent) {
    await sendAndStore(
      user.id,
      user.phone_number,
      "Got it — and sorry for the delay! Let me get your plan together now.",
      "awaiting_cadence"
    );
    after(async () => {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, trigger: "initial_plan" }),
        });
      } catch (err) {
        console.error("[onboarding] cadence plan re-trigger failed:", err);
      }
    });
    return NextResponse.json({ ok: true });
  }

  const confirmation =
    cadence === "morning_reminders"
      ? "Perfect — I'll remind you the morning of each session. How does the plan look? Let me know if anything needs tweaking."
      : cadence === "nightly_reminders"
      ? "Perfect — I'll send you a heads-up the evening before each session. How does the plan look? Let me know if anything needs tweaking."
      : "Got it — I'll send you a weekly plan every Sunday. How does the plan look? Happy to adjust anything.";

  await sendAndStore(user.id, user.phone_number, confirmation, "awaiting_cadence");
  return NextResponse.json({ ok: true });
}

async function handleNonCadenceMessage(
  user: { id: string; phone_number: string; name: string | null },
  message: string
): Promise<NextResponse> {
  const cadenceQuestion =
    "Last thing — would you like a reminder about your upcoming workouts the morning of, or the evening before? If not, I'll just send you a weekly plan every Sunday.";

  const classifyResponse = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 16,
    system: `The athlete received their training plan and instead of answering a reminder preference question, sent a different message. Classify it as one word:
- "cancel" — athlete wants to cancel their subscription
- "plan_feedback" — wants to change the plan (fewer/more runs, different schedule, volume)
- "coaching_question" — asking a training or race prep question
- "other" — everything else`,
    messages: [{ role: "user", content: message }],
  });

  const msgType =
    classifyResponse.content[0].type === "text"
      ? classifyResponse.content[0].text.trim().toLowerCase()
      : "other";

  if (msgType.startsWith("cancel")) {
    const { data: userData } = await supabase
      .from("users")
      .select("dashboard_token")
      .eq("id", user.id)
      .single();
    const dashboardToken = userData?.dashboard_token as string | null;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    const cancelUrl = dashboardToken ? `${appUrl}/cancel?token=${dashboardToken}` : null;
    const reply = cancelUrl
      ? `To cancel your subscription, tap here — you can manage everything yourself:\n\n${cancelUrl}\n\nSorry to see you go! Let me know if there's anything I can do.`
      : "To cancel, just text Jake directly at this number and he'll take care of it right away. Sorry to see you go!";
    await sendAndStore(user.id, user.phone_number, reply, "awaiting_cadence");
    return NextResponse.json({ ok: true });
  }

  if (msgType.startsWith("plan_feedback")) {
    const ackResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 120,
      system: `You are Coach Dean. The athlete asked to change their training plan. Write 1-2 short sentences acknowledging what they asked for and confirming you're rebuilding the plan. Tell them the updated dashboard link will arrive in a moment. Do NOT ask any questions. Do NOT include a session list.`,
      messages: [{ role: "user", content: message }],
    });
    const ackRaw =
      ackResponse.content[0].type === "text"
        ? ackResponse.content[0].text.trim()
        : "On it — rebuilding your plan around those preferences. Dashboard link coming shortly.";

    await supabase.from("conversations").insert({
      user_id: user.id,
      role: "user",
      content: message,
      message_type: "user_message",
    });
    await sendAndStore(user.id, user.phone_number, ackRaw, "awaiting_cadence");

    // Fire the rebuild_plan trigger — it persists profile updates from the conversation
    // first, then regenerates the full arc with the corrected profile. This replaces the
    // old initial_plan fire-and-forget which didn't persist pace corrections first.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    void fetch(`${appUrl}/api/coach/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, trigger: "rebuild_plan" }),
    });
    return NextResponse.json({ ok: true });
  }

  if (msgType.startsWith("coaching_question")) {
    const answerResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 300,
      system: `You are Coach Dean. Answer the athlete's coaching question directly in 2-4 sentences. Do not explain your reasoning or approach — just answer. If the question is about a product/dashboard feature you can't control, say "Got it — I'll pass that along." in one sentence. After your answer, on a new line, add exactly: "${cadenceQuestion}"`,
      messages: [{ role: "user", content: message }],
    });
    const answer =
      answerResponse.content[0].type === "text"
        ? answerResponse.content[0].text.trim()
        : cadenceQuestion;
    await sendAndStore(user.id, user.phone_number, answer, "awaiting_cadence");
    return NextResponse.json({ ok: true });
  }

  // Fallback: re-ask the cadence question
  await sendAndStore(
    user.id,
    user.phone_number,
    `Just one last thing — ${cadenceQuestion}`,
    "awaiting_cadence"
  );
  return NextResponse.json({ ok: true });
}

async function parseTimezoneFromMessage(message: string): Promise<string | null> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    system: `Convert the location in this message to an IANA timezone string. Return ONLY the IANA string (e.g. "America/Denver", "America/Los_Angeles", "America/New_York"). If no location is mentioned, return "none".`,
    messages: [{ role: "user", content: message }],
  });
  const raw =
    response.content[0].type === "text" ? response.content[0].text.trim() : "none";
  if (raw === "none") return null;
  return /^[A-Za-z_]+\/[A-Za-z_]+$/.test(raw) ? raw : null;
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

  const firstName = (user.name ?? "").split(" ")[0] || "Hey";
  const checkoutUrl = getCheckoutPageUrl(dashboardToken);
  const onboardingData = (userData?.onboarding_data as Record<string, unknown>) || {};

  const msg = buildPaymentMessage(firstName, checkoutUrl, onboardingData);
  await sendAndStore(user.id, user.phone_number, msg, "awaiting_payment");
  return NextResponse.json({ ok: true });
}

/** Build a personalized trial CTA that references the athlete's specific plan. */
function buildPaymentMessage(
  firstName: string,
  checkoutUrl: string,
  data: Record<string, unknown>
): string {
  const raceName = data.race_name as string | null;
  const raceDate = data.race_date as string | null;
  const goal = data.goal as string | null;

  // Calculate weeks until race if we have a date
  let weeksDetail = "";
  if (raceDate) {
    const msPerWeek = 1000 * 60 * 60 * 24 * 7;
    const weeksOut = Math.round((new Date(raceDate + "T12:00:00Z").getTime() - Date.now()) / msPerWeek);
    if (weeksOut > 0) weeksDetail = `${weeksOut}-week `;
  }

  // Build goal description
  let goalDesc = "personalized running plan";
  if (raceName && raceDate) {
    const dateStr = new Date(raceDate + "T12:00:00Z").toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
    });
    goalDesc = `${weeksDetail}${raceName} plan (${dateStr})`;
  } else if (goal === "general_fitness" || goal === "return_to_running") {
    goalDesc = "personalized training plan";
  } else if (goal) {
    goalDesc = `${weeksDetail}${goal.replace(/_/g, " ")} plan`;
  }

  return `${firstName}, your ${goalDesc} is built and ready. Start your free 7-day trial to unlock it:\n${checkoutUrl}`;
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
  }>
): { distance_meters: number; moving_time_seconds: number; start_date: string; is_trail: boolean } | null {
  const now = Date.now();
  const STANDARD_KM = [5, 10, 15, 21.097, 42.195];

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
      const isTrail = r.activity_type === "TrailRun";
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
      .select("distance_meters, moving_time_seconds, start_date, activity_type")
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
  opts?: { skipInitialPlan?: boolean }
): Promise<void> {
  const goal = (data.goal as string) || "general_fitness";
  const raceDate = (data.race_date as string) || null;
  const experienceYears = (data.experience_years as number) ?? 1;
  const weeklyMiles = (data.weekly_miles as number) ?? null;
  const weeklyHours = (data.weekly_hours as number) || null;
  const crosstrain = (data.crosstraining_tools as string[]) || [];
  const daysPerWeek = (data.days_per_week as number) ?? 4;
  const trainingDays = (data.training_days as string[]) || [];
  const easyPace = (data.easy_pace as string) || null;
  const tempoPace = (data.tempo_pace as string) || null;
  const intervalPace = (data.interval_pace as string) || null;
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
        crosstraining_tools: crosstrain,
        proactive_cadence: "weekly_only",
        injury_notes: injuryNotes,
        goal_distance_miles: goalDistanceMiles,
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
        .filter((r) => r.date)
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
      const firstName = (name ?? "").split(" ")[0] || "Hey";
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + 7);
      const trialEndFormatted = trialEndDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      });
      const checkoutUrl = getCheckoutPageUrl(dashboardToken);
      const sms = `${firstName}, your plan is ready! Start your free 7-day trial — no charge until ${trialEndFormatted}. Cancel any time: ${checkoutUrl}`;
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
      }
    });
  }
}
