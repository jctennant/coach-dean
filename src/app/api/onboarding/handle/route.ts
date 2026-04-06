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
      result = await handleStrava(user, message, onboardingData);
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
      stravaContext = `\nSTRAVA: Connected.${recentMiles ? ` Recent 4-week mileage: ~${recentMiles} miles.` : ""} No races found for VDOT calculation — ask for a recent race time or PR to set training paces.`;
    }
  } else if (onboardingData.strava_skipped) {
    stravaContext = "\nSTRAVA: User skipped Strava. Collect mileage + pace data manually.";
  } else {
    stravaContext = "\nSTRAVA: Not connected yet.";
  }

  const collected = summarizeCollected(onboardingData);

  const systemPrompt = `You are Coach Dean, an AI running coach onboarding a new athlete entirely over SMS text messages.

Your job: collect the information below through natural conversation, then signal you're ready with [READY].

WHAT TO COLLECT:
Required before signaling [READY]:
- Athlete's name (ask in your first message if not already known)
- Training goal (specific race/event name and type, or general fitness)
- Training schedule (which days of the week work best)

Important — collect naturally, don't skip:
- Race date (if they have a named race — use web_search to look it up if needed)
- Fitness baseline: a recent race PR, current easy pace, OR Strava is connected
- Location / city (to send reminders at the right time)

Optional (only collect if it comes up naturally):
- Goal finish time for the race
- Other races this season (B/C tune-up races)
- Current weekly mileage (only if Strava not connected and not mentioned)
- Injury or physical limitation notes
- Ultra / trail background (only for 50K+ goals)

WHAT YOU ALREADY KNOW:
${collected || "Nothing yet."}
${stravaContext}

INSTRUCTIONS:
- Ask 1–2 questions per message. Never fire off 5 at once.
- Do not re-ask for anything listed under "what you already know" above.
- Acknowledge what they share before asking the next thing.
- Be warm and specific to their goal. 3–4 sentences per message max.
- Plain text only. No markdown, asterisks, or bullet points.
- If they ask a coaching question, answer it briefly, then continue naturally.
- Whenever the athlete names a race, always use web_search to find the exact date — never state or assume a date from memory. A month alone (e.g. "July") is not enough; get the specific day.
${isFirstResponse
  ? "- This is your FIRST message to this athlete. Introduce yourself in 1–2 sentences (AI running coach, builds personalized plans, tracks runs via Strava, checks in over text), then ask for their name. Keep it punchy, not salesy."
  : "- You have already introduced yourself in a previous message. Do NOT re-introduce yourself or repeat what you do. Do NOT open with 'Hey [name]!' or any greeting phrase like 'Great to meet you', 'Great to hear from you', 'Nice to meet you', 'Glad you're here', etc. Acknowledge what they just said and move forward."
}

STRAVA:
Ask about Strava early — once you have the athlete's name and goal, it should be one of your next questions. Don't wait until the end of onboarding. Write "[STRAVA_LINK]" as a placeholder — the system will replace it with the actual link. Only ask once.

SIGNALING READY:
When you have goal + training_days + at least one of (pace/PR data OR Strava connected) + location, end your final message with [READY] on its own line. The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
When you signal [READY], do not ask any more questions in that message. Wrap up warmly and set expectations (e.g. "I'll get your plan put together now") — the plan will be sent right after.`;

  // Call Claude Sonnet — web_search handles race date lookups automatically
  const claudeResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 600,
    system: systemPrompt,
    messages: [...history, { role: "user", content: message }],
    tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
  });

  // Extract final text (post-search text blocks only, discarding pre-search reasoning)
  let rawText = "";
  let lastToolIdx = -1;
  for (let i = 0; i < claudeResponse.content.length; i++) {
    if (claudeResponse.content[i].type === "tool_use") lastToolIdx = i;
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

  // Calculate VDOT paces when race time data is newly available
  if (!mergedData.easy_pace && mergedData.recent_race_distance_km && mergedData.recent_race_time_minutes) {
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
  if (data.easy_pace) lines.push(`Easy pace: ${data.easy_pace}/mi`);
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
  "other_races": [{"name": string|null, "date": "YYYY-MM-DD"|null, "priority": "B"|"C", "goal": string|null}] | null,
  "timezone": string | null
}

Rules:
- Only extract data clearly stated in the conversation. Do not infer or guess.
- goal: use "trail_race" for trail/mountain races that aren't standard road distances (e.g. a 5mi, 8.9mi, 15mi trail race). Use standard buckets (5k, 10k, half_marathon, marathon) only for road races at those distances.
- training_days: lowercase full names only (e.g. ["tuesday","thursday","saturday","sunday"])
- goal_time_minutes: total float minutes. "1:30" → 90.0, "17:40" → 17.67, "2:25:00" → 145.0
- race_date: use the most specific date mentioned for the goal race. If a specific date (day + month) was stated by either participant, use that exact date. Only default to first of month if no specific date was ever given. Today is ${today}.
- recent_race_distance_km: distance of their most-cited PR or recent race (not the goal race)
- recent_race_time_minutes: finishing time of that race in minutes
- easy_pace: format "M:SS" (e.g. "8:30" means 8 minutes 30 seconds per mile)
- timezone: IANA string when a location is mentioned (e.g. "Provo, UT" → "America/Denver", "San Francisco" → "America/Los_Angeles")
- other_races: only B/C secondary races, not the main A race (goal/race_name/race_date). Use the same date precision rule as race_date — specific date if stated, first-of-month only as last resort.`,
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
  onboardingData: Record<string, unknown>
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

  // User skipped Strava — return to onboarding conversation
  const mergedData = { ...onboardingData, strava_skipped: true };
  await supabase.from("users").update({
    onboarding_step: "onboarding",
    onboarding_data: mergedData as unknown as Json,
  }).eq("id", user.id);

  void trackEvent(user.id, "onboarding_strava_skipped", {});

  // Generate a natural "no worries + next question" reply using Haiku
  const collected = summarizeCollected(mergedData);
  const nextResponse = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    system: `You are Coach Dean, an AI running coach. The athlete just skipped connecting Strava. In 2 sentences max: briefly acknowledge (e.g. "No worries!"), then ask the single most important missing piece.

Already collected:
${collected || "Nothing yet."}

Ask for training days if missing. If training days are collected, ask for their city/timezone. Plain text only.`,
    messages: [{ role: "user", content: message }],
  });

  const replyText =
    nextResponse.content[0].type === "text"
      ? nextResponse.content[0].text.trim()
      : "No worries! Which days of the week work best for your training?";

  await supabase.from("conversations").insert({
    user_id: user.id,
    role: "user",
    content: message,
    message_type: "user_message",
  });
  await sendAndStore(user.id, user.phone_number, replyText, "onboarding");
  return NextResponse.json({ ok: true });
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
      system: `The athlete is responding to: "Would you like a reminder the morning of each workout, or the evening before? If not, I'll just send you a weekly plan every Sunday."

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
    "Last thing — would you like a reminder the morning of each workout, or the evening before? If not, I'll just send you a weekly plan every Sunday.";

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
      max_tokens: 100,
      system: `You are Coach Dean. The athlete asked to change their training plan. Acknowledge their request specifically in 1-2 short sentences. Confirm you'll rebuild around their preference. Do NOT ask any questions.`,
      messages: [{ role: "user", content: message }],
    });
    const ack =
      ackResponse.content[0].type === "text"
        ? ackResponse.content[0].text.trim()
        : "Absolutely — I'll rebuild your plan around those preferences.";

    await supabase.from("conversations").insert({
      user_id: user.id,
      role: "user",
      content: message,
      message_type: "user_message",
    });
    await sendAndStore(user.id, user.phone_number, ack, "awaiting_cadence");
    void fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, trigger: "initial_plan" }),
    });
    return NextResponse.json({ ok: true });
  }

  if (msgType.startsWith("coaching_question")) {
    const answerResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 300,
      system: `You are Coach Dean. Answer the athlete's coaching question in 2-4 sentences. After your answer, on a new line, add exactly: "${cadenceQuestion}"`,
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
    .select("dashboard_token")
    .eq("id", user.id)
    .single();

  const dashboardToken = userData?.dashboard_token as string | null;
  if (!dashboardToken) return NextResponse.json({ ok: true });

  const firstName = (user.name ?? "").split(" ")[0] || "Hey";
  const checkoutUrl = getCheckoutPageUrl(dashboardToken);
  const msg = `${firstName}, your plan is ready and waiting! Start your free 7-day trial here:\n${checkoutUrl}`;
  await sendAndStore(user.id, user.phone_number, msg, "awaiting_payment");
  return NextResponse.json({ ok: true });
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
          goal_distance_miles: null,
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
      const cancelUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai"}/cancel?token=${dashboardToken}`;
      const sms = `${firstName}, your plan is ready! Start your free 7-day trial to unlock it — no charge until ${trialEndFormatted}. Cancel any time — before or after the trial — at ${cancelUrl}\n\n${checkoutUrl}`;
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
