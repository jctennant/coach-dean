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

  // Build Strava context (best race for pace suggestion, if available)
  let stravaContext = "";
  if (onboardingData.strava_connected) {
    const sbr = await lookupBestStravaRace(user.id);
    // Build analytics lines from stored data (computed at Strava connect time)
    const avgWeeklyMiles = onboardingData.strava_avg_weekly_miles as number | null ?? null;
    const mileageTrend = onboardingData.strava_mileage_trend as string | null ?? null;
    const avgElevFtPerRun = onboardingData.strava_avg_elev_ft_per_run as number | null ?? null;
    const longestRunMiles = onboardingData.strava_longest_run_miles as number | null ?? null;
    const avgRunsPerWeek = onboardingData.strava_avg_runs_per_week as number | null ?? null;
    const recent4Weeks = onboardingData.strava_recent_4_weeks as number[] | null ?? null;

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

    if (sbr) {
      const easyRange = easyPaceRange(sbr.easy_pace);
      // For trail races, withhold the easy pace suggestion entirely — trail paces run slower
      // than road paces due to elevation, so the VDOT-derived easy pace is systematically
      // low. Showing it causes Claude to anchor on the wrong number even after the user
      // provides a road race time. Instead, prompt Claude to collect a road baseline.
      const paceNote = sbr.is_trail
        ? ` Note: this is a trail race — easy pace suggestion withheld. Collect a road 5K/10K/HM time to set accurate training zones.`
        : ` Suggested easy pace: ${easyRange}/mi. You can use this to set their training zones.`;
      stravaContext = `\nSTRAVA: Connected.${weeklyLine}${frequencyLine}${longestLine}${elevLine}${progressionLine} Best race for pace calibration: ${sbr.label} on ${sbr.date_str} in ${sbr.time_str}.${paceNote}`;

      // Store trail-race flag so completeOnboarding can guard the VDOT recalculation.
      // This prevents Haiku from accidentally extracting the trail race distance/time
      // (visible in coach conversation history) and producing wrong pace zones.
      onboardingData.strava_best_race_is_trail = sbr.is_trail;
      onboardingData.strava_best_race_km = sbr.dist_km;
    } else {
      const hasRaceData = !!(onboardingData.recent_race_distance_km && onboardingData.recent_race_time_minutes);
      const hasPaceData = !!onboardingData.easy_pace;
      const paceNote = hasRaceData || hasPaceData
        ? " No race activity found on Strava — using pace data already collected from conversation."
        : " No races found for VDOT calculation — ask for a recent race time or PR to set training paces.";
      stravaContext = `\nSTRAVA: Connected.${weeklyLine}${frequencyLine}${longestLine}${elevLine}${progressionLine}${paceNote}`;
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
- Athlete's name — CRITICAL: ask in your second message if not already known. Do NOT ask in the first message, but do NOT skip it either. Never address the athlete as "Athlete" or use a placeholder — if you don't have their name, you must ask.
- Training goal (specific race/event name and type, or general fitness). If they have no committed race — only aspirational talk like "maybe someday" or "thinking about eventually" — their goal is return_to_running or general_fitness, NOT the race distance.
- Do they have an existing training plan they're following? (yes/no). If yes: see PLAN COMPLEMENT mode below — training schedule is NOT required. If no: offer to build one if they're self-directed, and training schedule IS required.
- Training schedule (which days of the week work best) — NOT required for PLAN COMPLEMENT mode users
- Race date (if they have a named race — MANDATORY: always web_search the exact date, never state one from memory; not required for general_fitness / return_to_running / healthy_builder mode)
- Fitness baseline: a recent race PR, current easy pace, OR Strava is connected
- Current weekly mileage — REQUIRED if Strava is not connected AND not already shown in the STRAVA context above. If Strava is connected and shows "Recent avg: ~X mi/week", that IS the mileage baseline — do NOT ask "are you currently running" or "how many miles per week." That data is already known. Only ask if Strava is not connected or shows no weekly mileage. Ask directly: "How many miles are you running per week right now?" or "Are you currently running, and if so, about how many miles per week?" If they say they're not running yet or just starting out, that is also useful — record as 0. Do not skip this even if you have their pace — mileage and pace are independent.
- Terrain type and training tools: do NOT ask directly — extract passively from what they say. Infer terrain from goal when obvious (named trail race → trail, road marathon → road). Extract tools from any mention of Runna, TrainingPeaks, Garmin, etc.

Required ONLY for ultra goals (30k, 50k, 50mi, 100k, 100mi) — must collect before [READY]:
- Ultra and trail race background: how many ultras have they done? Any trail races? This is essential for planning.
- Injury or physical limitation notes

Required ONLY for return_to_running or injury_recovery goals — must collect before [READY]:
- Injury or physical limitation notes (what happened, current status)

Required for short races (mile, 5k, 10k) — pacing depends entirely on goal time:
- Goal finish time or pace (e.g. "sub 5 minute mile", "under 22 minutes for 5K"). Ask directly after you have their goal type confirmed. This is essential for calibrating interval and tempo paces.

Ask before signaling [READY] for any goal (work it in naturally, not as a separate interrogation):
- For PLAN COMPLEMENT mode: "Anything recurring I should watch for in your Strava data?" — frame it as what Dean should flag in analysis, not as general intake or injury background for a plan.
- For all other modes: "Anything I should know — like injuries to work around or training preferences?" Examples to surface if not mentioned: injury history, areas to protect, things they hate (e.g. treadmills, track), or anything else relevant. Keep it open-ended. One short question.

Optional (only collect if it comes up naturally):
- Goal finish time for longer races (half marathon, marathon, trail)
- Other races this season (B/C tune-up races)

WHAT YOU ALREADY KNOW:
${collected || "Nothing yet."}
${stravaContext}

CONVERSATION MODE — read the athlete's first response and set the mode before collecting anything else. Most users fall into one of three modes:

PLAN COMPLEMENT (athlete already follows a plan — Runna, TrainingPeaks, coach-written, etc.):
CORE POSITIONING: Dean is a post-run analyst here, not a plan builder. Every question you ask must be framed in terms of what Dean needs to do its job — analyzing their Strava runs and sending useful feedback. If you can't explain why a question helps Dean analyze runs better, don't ask it.
- Confirm upfront: Dean works alongside their plan, not as a replacement. Your value: after every Strava run, you'll send a coaching debrief and write it back to their Strava activity — how the effort looked, what to watch for, what it means for the week.
- Plan sharing — pitch it with confidence, not as optional admin: "Text me a PDF of your plan or just describe it here — it gives me the context to understand your overall build and makes your post-run feedback a lot more useful." Do not use apologetic framing like "not required, but helpful."
- Ask about Strava early — it's the primary data channel in this mode.
- Fitness baseline: if Strava isn't connected, ask for a recent race time or easy pace — but frame it correctly: "This helps me calibrate your training zones so I can tell you whether a run was truly aerobic or whether you were drifting into threshold without realizing it." Not "to build your plan."
- Do NOT collect training days — Dean fires on Strava activity events and can infer the schedule from data.
- Do NOT offer to rebuild their plan. Do NOT ask "do you have a plan" if they've already told you.

RACE-GOAL CHASER (has a specific event, no current plan):
IMPORTANT: Before assuming this mode, confirm the athlete doesn't already have a plan. When someone says "I'm building toward X race" without explicitly saying they have no plan, you MUST ask: "Are you following a training plan already, or are you looking to put one together?" Do not skip this — many athletes training for a race already have a plan (Runna, coach-written, etc.) and belong in PLAN COMPLEMENT mode instead. Only proceed as RACE-GOAL CHASER once they confirm they don't have a plan.
- Acknowledge the goal and connect their current fitness to it concretely — one sentence.
- Collect: race name + date (web_search immediately), Strava, fitness baseline, training days.
- Offer to build a plan once you have the race details.
- Race date IS required before [READY] in this mode.

HEALTHY BUILDER / INJURY-PRONE (no specific race — staying consistent, returning from injury, or building volume sustainably):
- Lead with curiosity: "What's been happening with your training?" or "What's the injury situation?"
- Don't push toward race-goal framing. Their goal is sustainable running and staying healthy.
- Collect: name, injury/limitation context (what happened, current status, are they running now), current weekly mileage, training days.
- Race date is NOT required before [READY] in this mode.
- For injury context: ask both what happened AND current status — this directly shapes the first training block.

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
  ? `- This is your FIRST message. Open with 2 sentences that are specific and concise about what Dean does. Example: "I'm Coach Dean, your AI running coach. After every Strava run I'll send you a coaching note — how the effort actually went, whether to adjust, what to watch for — and write it back to your Strava activity." Then ask a single branching question: "To start — are you already following a training plan, building toward a specific race, or more focused on staying healthy and running consistently?" Do NOT ask for their name in the first message — collect it in the next turn. Do NOT reference specific tools like Runna or TrainingPeaks in the intro — not every user has them. Do NOT use the phrase "SMS running coach" or "SMS coach" — use "AI running coach" instead.`
  : ""}

STRAVA:
Ask about Strava as your NEXT question once you have the athlete's goal and mode — before asking for race times, pace, or weekly mileage. Strava can provide all of that automatically, so don't collect fitness data manually if Strava might have it. Write "[STRAVA_LINK]" as a placeholder — the system will replace it with the actual link. Only ask once.
When you ask, briefly explain the value in one or two sentences: connecting Strava means you'll automatically read every run and calibrate training zones from real data — no manual reporting needed. After each run, you'll send them a coaching note and write it back to their Strava activity so it's always there.
CRITICAL: Even if the athlete volunteers race history, fitness data, or pace information before you've asked about Strava — do NOT follow up on that data yet. Ask about Strava first. You can come back to those details after the Strava question is answered. The Strava question takes priority over any follow-up on volunteered fitness data.
IMPORTANT: When you ask about Strava, make it a standalone turn — do not combine it with other questions (training days, pace, etc.) in the same message. Ask only the Strava question in that message. Ask other questions in your next turn after the user responds. This prevents you from re-asking questions the user already answered when they were bundled with the Strava link.
PLACEMENT: [STRAVA_LINK] must appear on its own line at the very end of the message — never embedded inline in a sentence (e.g. never "connect here: [STRAVA_LINK]."). End your question, then put [STRAVA_LINK] on a new line after.

PRICING QUESTIONS:
If the athlete asks whether this costs money or is free, answer directly and briefly: there's a free 7-day trial — they get full access to their plan and coaching before any payment. Don't dodge the question or defer it. Answer it in one sentence, then continue onboarding naturally.

TRAINING PACES — do NOT quote specific paces (e.g. "7:45/mi easy") during onboarding:
Training zones are computed server-side from the athlete's data when the plan is built. You cannot reliably calculate VDOT-based paces in your head — if you try, you will get them wrong, and the athlete will notice. Instead, acknowledge their baseline and connect it to their goal at a high level ("17:50 5K is a strong baseline — your plan will have the right interval and tempo zones dialed in"). The accurate paces will be in their plan. Never state a specific min/mi easy, tempo, or interval pace in this conversation.

DEMONSTRATING VALUE — do this consistently, not just sometimes:
- When you receive a fitness baseline (race PR or easy pace), always reflect back one specific insight connecting their data to their goal. Examples: "A 2:05 half puts you in the 4:20-4:30 marathon range if we train smart." / "Your 18:45 5K puts your current mile equivalent around 5:10 — a 10-second drop is very achievable with the right speedwork." Keep it to one sentence. Do NOT quote a specific min/mi easy pace.
- When the athlete expresses a doubt, constraint, or frustration ("is 3 days enough?", "I've been inconsistent", "stuck at X for two years"), answer it briefly and specifically before asking your next question. Don't skip past it. This is often the highest-impact moment in the conversation.
- For general fitness goals with no race target, connect their numbers to what they'll experience: "At 11:00/mi and 15 miles/week you've got a solid base — within the first training block you'll notice real speed gains." Something concrete, not generic encouragement.
- When the athlete mentions something they've been struggling with or stuck on — a weakness, plateau, specific thing they want to improve — dig one level deeper before moving on. Ask the why: "Is it more of an endurance thing or are you finding your speed isn't there?" / "What do you think has been holding you back?" One follow-up question shows genuine coaching curiosity and gives you the context to actually address it. This applies broadly: triathlete saying their run is weak, runner stuck at the same 5K time, someone who says they've been inconsistent. Don't just acknowledge it — understand it.
- Name the specific training mechanism that will address a stated struggle. Don't say "we'll work on that" — say what you'll actually do and why it works. Specificity is what makes this feel like real coaching vs a generic chatbot.
- Use the athlete's own language and context to make your wrap-up message feel personal, not templated. Reference their specific race, goal, or constraint: "I'll get your plan together now — you'll see your first week built around those three early morning windows" beats "I'll get your plan together now."

EXISTING PLAN USERS:
If the athlete already follows a training plan (Runna, TrainingPeaks, coach-written, etc.), Dean works alongside the plan — not as a replacement. See PLAN COMPLEMENT mode above for detailed instructions.
Key rules: do NOT ask for training schedule/days. Frame every question from the analyst perspective — what Dean needs to read their Strava runs accurately. When asking for a fitness baseline, say why: "This helps me calibrate your training zones so I can tell if a run was aerobic or drifting into threshold." When asking about injuries, ask what to watch for in the data, not what to work around in a plan. For plan sharing, pitch: "Text me a PDF of your plan or describe it here — it gives me the context to understand your build and makes your post-run feedback a lot more useful."
Do NOT offer to rebuild their plan or question their plan choice. Do NOT reject or discourage athletes who already have a plan — this is a fully supported use case.

RACE TARGET FOR TIME-GOAL ATHLETES:
If the athlete has a time goal for a specific distance (e.g. "sub-20 5K", "break 3 hours in the marathon") but has not named a specific race or event, always ask: "Any race on the calendar you're targeting this at?" A specific race date is essential for structuring the training timeline — do not skip this even if you have everything else.

CYCLING AND TRIATHLON GOALS:
If the athlete's goal is purely cycling with no running component, be honest: "I specialize in running — I can structure a cycling plan but if pure cycling coaching is your main need, I may not be your best fit. Is running part of the mix at all?" Do not just proceed as if cycling and running coaching are equivalent.
If the athlete confirms they are cycling-only and not interested in running, wish them well and stop with a single message. After sending your farewell, treat the conversation as closed — do not send any further replies, even if the user says "thanks" or "goodbye". One exit message, full stop. Do not acknowledge, apologize, or reply again.
If the athlete is training for a triathlon, clarify your role upfront: "For triathlons I handle the run leg — I'll build your running program and check in after every run workout. For swim and bike you'd want dedicated coaching, but I'll make sure your run is dialed in."
Also ask about any physical limitations or injury history before signaling [READY] for triathlon goals — this directly affects run-specific programming.

STRAVA CONTEXT:
When Strava connects, give a genuine analytical read of the data — this is a taste of the post-run coaching they'll get ongoing. Use the specific numbers in the STRAVA block above. Pick 2–3 observations that tell a real story:
- Volume + trend: are they building, steady, or tapering? ("You've been building — 22, 25, 28, 30 miles over the last four weeks.")
- Long run proportion: is the longest run appropriately long relative to weekly volume? ("Your long runs are around X% of weekly volume — that's [in a solid range / a bit low for your goal / right where you want it].")
- Frequency: runs/week pattern. ("You're running 5 days consistently — good base to work with.")
- Elevation: if they're training for a trail race with significant vert, note whether their elevation load matches the demand. ("Averaging 500ft per run is solid prep for Dipsea's terrain.")
End with one forward-looking sentence connecting their data to their goal — something that demonstrates you're already thinking about their training, not just logging it.
Do NOT narrate all the stats like a report. Pick what's most interesting and make it feel like a real coach read the data.
If the inbound message is "(strava connected)", that is a system trigger — not something the user typed. Do not reference or repeat it. Just continue the conversation naturally from where you left off.

RACE RESPONSE RULE — NO WIKIPEDIA RECAPS:
When an athlete mentions a race they're doing, do NOT describe the race back to them (distances, elevation stats, location details). They already know the race — they signed up for it. Instead, respond with ONE coaching insight about what the race demands and why it matters for their training. Be specific and useful: e.g. "Dipsea's stairs and Snowbird's vert reward the same thing — strong hiking and climbing legs. Good double-header." Use the course data from your search to inform your insight, not to narrate it back.

RACE DATE AND COURSE PROFILE — MANDATORY SEARCH:
The moment an athlete mentions a specific named race, call web_search immediately to find the exact date AND the course profile. Do not state, confirm, or summarize any race date without first searching. Memory dates are frequently wrong, and user-provided dates are often wrong too — ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable. A month alone ("next April", "this fall") is never enough — get the specific day.
When searching for a trail, mountain, or ultra race: also look up the course's total elevation gain (in feet), starting altitude (if it's a mountain race), and terrain character (groomed fire roads, singletrack, technical, etc.). Mention these in your response naturally so the extraction pass can capture them — e.g. "Hardrock 100 is on July 19th with about 33,000ft of gain and starting at high altitude in the San Juans." You don't need to ask the athlete for this info if you can find it from the search.
After searching: if the search result shows the race date is within the next 6 weeks AND the user is starting a new coaching relationship (not explicitly asking for race-week prep), do NOT proceed — ask first: "That's only [X] weeks away — are you looking for race-week prep for this year, or building toward [next year]?" Do not pivot to taper mode or any race-specific framing until the user confirms the year.
After searching: if the user has not stated a specific date (only a month or vague timeframe), confirm the search result with them before proceeding: "I found it listed as [date] — does that sound right?"
FIRST-OF-MONTH GUARD: If the only date information you have is a month ("in June", "sometime in July", "this fall"), do NOT proceed with the 1st of that month as a placeholder. Stop and ask: "Do you know the exact date?" A first-of-month date is almost always wrong and will miscalibrate the entire training timeline.
After searching: if the athlete stated a specific date (day + month) and the search result is within 2 days of it, use the athlete's stated date — web results frequently have minor calendar errors, and athletes are generally right about their own races. Only override the athlete's specific date if the search shows a clearly different week or month; in that case note it (e.g. "I found it listed as [search date] — does that sound right?"). Never silently override a specific athlete-provided date with a search result that differs by just 1–2 days.

SIGNALING READY:
When you have name + goal + training_days + at least one of (pace/PR data OR Strava connected), end your final message with [READY] on its own line. For PLAN COMPLEMENT mode: training_days is NOT required — signal [READY] once you have name + goal + fitness baseline (or Strava connected).
The [READY] tag is stripped before sending — do not reference or explain it. Do not include [READY] if you still need to ask something essential.
Name is always required — if the user hasn't told you their name yet, ask before signaling [READY]. If you asked for the name but the user deflected or skipped it, circle back and ask again before wrapping up.
When you signal [READY], do not ask any more questions in that message. Wrap up warmly. For PLAN COMPLEMENT mode: wrap up with something like "I'll be analyzing every run you log — text me anytime." The system will send the dashboard link automatically as a follow-up. For all other modes: set expectations (e.g. "I'll get your plan put together now") — the plan will be sent right after.

ULTRA AND INJURY GOALS — extra required fields:
For ultra goals (30k, 50k, 50mi, 100k, 100mi): you MUST ask about their ultra/trail race history AND any injuries or physical limitations before signaling [READY]. "Any prior ultras or trail races?" covers both.
For return_to_running or injury_recovery goals: you MUST ask about the injury/limitation and current status before [READY].

${alreadyAskedPaceCalibration
  ? `PACE CALIBRATION — trail race on Strava:
You already asked about road race times earlier in this conversation. Do NOT ask again. Accept whatever pace data the athlete has provided and proceed.`
  : `PACE CALIBRATION — trail race on Strava:
If Strava is connected and the STRAVA note says "this is a trail race", you MUST ask about road race times in THIS message — do not defer it to a later turn. Trail paces are slower than road paces due to elevation, so the suggested easy pace from Strava is only a rough estimate until we get a road benchmark. Reference the specific race from the STRAVA note by its label and date (e.g. "I can see a [label] from [date] in your Strava history"). Then explain that since it was a trail race, elevation makes trail paces slower than road paces, so you'd love a recent road 5K, 10K, or half marathon time for more accurate training zones — but no worries if they don't have one.
Do NOT use vague phrases like "your best Strava effort" without naming the specific race. Do NOT state the suggested easy pace as settled or confident — frame it as preliminary until the calibration question is answered.
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

  // Build responseText and (when Strava is requested) a separate stravaMsg.
  // Split at the paragraph containing [STRAVA_LINK] so:
  //   responseText = whatever Claude said before the Strava ask (may be empty)
  //   stravaMsg    = the Strava pitch + URL (always one coherent message)
  let responseText: string;
  let stravaMsg: string | null = null;

  if (wantsStravaLink && !onboardingData.strava_connected && !onboardingData.strava_skipped) {
    const paragraphs = rawText.split(/\n{2,}/);
    const stravaParaIdx = paragraphs.findIndex(p => /\[STRAVA_LINK\]/i.test(p));
    const beforeStrava = paragraphs
      .slice(0, stravaParaIdx)
      .join("\n\n")
      .replace(/\[READY\]/gi, "")
      .trim();
    const stravaParagraph = paragraphs[stravaParaIdx]
      .replace(/\[STRAVA_LINK\]/gi, "")
      .replace(/\[READY\]/gi, "")
      .trim();
    responseText = beforeStrava;
    const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
    stravaMsg = `${stravaParagraph ? stravaParagraph + "\n\n" : ""}${stravaUrl}\n\nNo Strava? Just reply "skip".`;
  } else {
    responseText = rawText
      .replace(/\[READY\]/gi, "")
      .replace(/\[STRAVA_LINK\]/gi, "")
      .trim();
  }

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

  // Validate race_date — discard anything that isn't a real YYYY-MM-DD date
  // (Claude sometimes returns "<UNKNOWN>" or other placeholder strings)
  if (mergedData.race_date) {
    const dateStr = mergedData.race_date as string;
    const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(Date.parse(dateStr));
    if (!isValidDate) {
      console.warn(`[onboarding] discarding invalid race_date: "${dateStr}"`);
      delete mergedData.race_date;
    }
  }

  // Calculate VDOT paces whenever race time data is present.
  // Always recalculate — race-derived paces are more reliable than a pace extracted
  // from conversation text (e.g. one mentioned in the Strava insight message).
  // This ensures that if a user provides a better/corrected race time later in the
  // conversation, the VDOT updates rather than being blocked by a stale easy_pace.
  //
  // Guard: skip if the extracted distance matches the Strava trail race distance.
  // Haiku can accidentally extract the trail race from coach conversation history
  // (the coach mentions "Dipsea 30K in 3:45") — this produces a systematically
  // slow easy pace. We only skip if the distance matches the trail race within 1km;
  // if the user provides a different (road) race distance, VDOT still runs correctly.
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
    if (responseText) await sendAndStore(user.id, user.phone_number, responseText, "awaiting_strava");
    if (stravaMsg) await sendAndStore(user.id, user.phone_number, stravaMsg, "awaiting_strava");
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
  if (Array.isArray(data.training_tools) && (data.training_tools as string[]).length > 0) {
    lines.push(`Training tools: ${(data.training_tools as string[]).join(", ")}`);
  }
  if (data.terrain_type) lines.push(`Terrain: ${data.terrain_type}`);
  if (data.has_existing_plan != null) lines.push(`Has existing plan: ${data.has_existing_plan ? "yes" : "no"}`);
  if (data.external_plan_description) lines.push(`Current plan: ${data.external_plan_description}`);
  if (data.wants_weekly_recap != null) lines.push(`Wants weekly recap: ${data.wants_weekly_recap ? "yes" : "no"}`);
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
- has_existing_plan / external_plan_description: ALWAYS extract these when the athlete mentions a training plan. Examples that must set has_existing_plan=true: "I'm already on a Runna plan", "I follow a TrainingPeaks plan", "my coach gave me a plan", "I'm using a Hal Higdon program". For any of these, also capture external_plan_description as a brief factual summary: plan source/name, current week if mentioned, weekly mileage if mentioned. E.g. "Runna 16-week half marathon plan, week 6, ~35mi/week". Set has_existing_plan=false only if the athlete explicitly says they have no plan or are self-directed without one.
- training_days: lowercase full names only. Ranges like "Tues-Thursday" expand to ALL days inclusive → ["tuesday","wednesday","thursday"].
- goal_time_minutes: the athlete's explicit goal finish time for their TARGET race (e.g. "I want to break 4 hours", "sub-20 5K"). Do NOT use a past PR or best time as the goal time unless the athlete says it IS their goal (e.g. "my goal is to beat my 17:50 PR"). A statement like "my fastest 5K is 17:50" or "my PR is 3:45" is a fitness baseline — extract it as recent_race_time_minutes, NOT as goal_time_minutes. Total float minutes: "1:30" → 90.0, "17:40" → 17.67, "2:25:00" → 145.0.
- race_date: use whichever date is stated in the conversation — athlete's or Dean's. If both are stated and differ by 1–2 days, prefer the athlete's. If only a month was given with no specific day (e.g. "in June", "sometime in July"), return null — do NOT default to the 1st of that month. Only extract a first-of-month date if the athlete explicitly said "the 1st" or "June 1st". Today is ${today}.
- recent_race_distance_km: ONLY from lines labeled "Athlete:" in the transcript — NEVER from "Coach:" lines, Strava summaries, or race data the coach mentions. This captures the athlete's road race PR they state in their own words (e.g. "my fastest 5K is 17:50", "I ran a 1:38 half last fall"). Trail races (Dipsea, ultras, mountain races, any race with "trail" in the name) are NOT eligible — leave null even if the athlete mentions them. If the coach references a Strava trail race (e.g. "your Dipsea 30K"), do NOT extract that distance. Extract even if caveated ("net downhill", "a while ago").
- recent_race_time_minutes: ONLY from lines labeled "Athlete:" — never from "Coach:" lines. M:SS → "18:45" = 18.75. H:MM:SS → "1:05:30" = 65.5. Use the most recent road race time (not trail, not Strava coach summaries). If only a trail time is mentioned by the athlete, leave null.
- easy_pace: "M:SS" format (e.g. "8:30" = 8 min 30 sec/mile).
- timezone: IANA string from location ("Provo, UT" → "America/Denver").
- other_races: B/C secondary races only, not the main A race.
- ultra_race_history: summarize any ultra/trail background mentioned, even if none.
- strava_skipped: true if athlete says they don't have or won't use Strava. Null otherwise.
- wants_speed_work: true if athlete explicitly asks for speed work. Null otherwise.
- training_tools: array of tools mentioned (lowercase: 'runna', 'trainingpeaks', 'garmin', 'self_directed', 'other'). Null if not mentioned.
- terrain_type: 'road', 'trail', or 'mixed' based on what athlete says. Null if not mentioned.
- wants_weekly_recap: true if athlete says yes to weekly recap texts. False if they decline. Null if not asked yet.
- other_notes: any training preferences, dislikes, or context not captured elsewhere (e.g. "loves hills", "hates treadmills", "prefers morning runs", "wants more cross-training"). Do not duplicate what's in injury_notes.
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
          experience_years: { type: ["number", "null"] },
          other_races: {
            oneOf: [
              {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", description: "YYYY-MM-DD" },
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
          strava_skipped: { type: ["boolean", "null"] },
          wants_speed_work: { type: ["boolean", "null"] },
          training_tools: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "Tools the athlete uses: 'runna', 'trainingpeaks', 'garmin', 'self_directed', 'other', etc."
          },
          terrain_type: { type: ["string", "null"], enum: ["road", "trail", "mixed", null], description: "Primary running terrain" },
          has_existing_plan: { type: ["boolean", "null"], description: "True if athlete currently follows a training plan (Runna, TP, etc.)" },
          external_plan_description: { type: ["string", "null"], description: "Brief factual summary of athlete's current plan: source/name, current week, weekly mileage. E.g. 'Runna 16-week HM plan, week 8, ~40mi/week'." },
          wants_weekly_recap: { type: ["boolean", "null"], description: "True if athlete wants weekly recap SMS" },
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
  chatId?: string | null
): Promise<NextResponse> {
  const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
  const isSkip = /\b(skip|no strava|don.?t have|don.?t use|no thanks|nope|later|next|without it|i don.?t|not on strava)\b/i.test(message);

  // If asking about Strava (with or without a question mark)
  const isAskingAboutStrava = !isSkip && /\b(what|what's|whats|how|why|tell me about|explain|never heard)\b/i.test(message);
  if (isAskingAboutStrava || (!isSkip && /strava/i.test(message) && message.includes("?"))) {
    const reply = `Strava is a free app that tracks your runs via GPS — lots of runners use it. Once you connect it, I'll automatically read every run you do and adjust your training plan based on real data. No need to report anything manually.\n\nDon't have it? No problem — you can skip and I'll ask you a few quick questions to set your paces instead.\n\n${stravaUrl}\n\nHeads up: Strava will ask to allow "Upload activities" — that's just their label for letting me add a coaching note and additional metrics to each of your runs. You can uncheck it if you'd prefer not.\n\nNo Strava? Just reply "skip".`;
    await sendAndStore(user.id, user.phone_number, reply, "awaiting_strava");
    return NextResponse.json({ ok: true });
  }

  if (!isSkip) {
    // Non-skip, non-question — just re-send the link
    const reply = `Connect Strava for automatic run tracking:\n\n${stravaUrl}\n\nHeads up: Strava will ask to allow "Upload activities" — that's just their label for letting me add a coaching note and additional metrics to each of your runs. You can uncheck it if you'd prefer not.\n\nOr reply "skip" to continue without it.`;
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

  return `${firstName}, your ${goalDesc} is built and ready. To access it, sign up for your free 7-day trial:\n${checkoutUrl}`;
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

  const trainingTools = (data.training_tools as string[] | null) || [];
  const terrainType = (data.terrain_type as string | null) || null;
  const hasExistingPlan = (data.has_existing_plan as boolean | null) ?? null;
  const externalPlanDescription = (data.external_plan_description as string | null) || null;
  const wantsWeeklyRecap = (data.wants_weekly_recap as boolean | null) ?? true; // default on

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
        training_tools: trainingTools,
        terrain_type: terrainType,
        external_plan_notes: externalPlanDescription,
        proactive_cadence: wantsWeeklyRecap ? "weekly_only" : "none",
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
      const _rawFirst2 = (name ?? "").split(" ")[0];
      const firstName = (_rawFirst2 && _rawFirst2.toLowerCase() !== "athlete") ? _rawFirst2 : "Hey";
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + 7);
      const trialEndFormatted = trialEndDate.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      });
      const checkoutUrl = getCheckoutPageUrl(dashboardToken);
      const sms = `${firstName}, your plan is ready! To access it, sign up for your free 7-day trial — no charge until ${trialEndFormatted}. Cancel any time: ${checkoutUrl}`;
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
  // Instead, send a welcome message explaining what Dean will now do for them.
  if (hasExistingPlan === true) {
    void trackEvent(user.id, "onboarding_completed", { goal, mode: "complement" });
    const rawFirst = (name ?? "").split(" ")[0];
    const firstName = (rawFirst && rawFirst.toLowerCase() !== "athlete") ? rawFirst : "Hey";
    const { data: complementUser } = await supabase
      .from("users")
      .select("phone_number, dashboard_token")
      .eq("id", user.id)
      .single();
    const phone = complementUser?.phone_number as string;
    // Generate dashboard token for complement users so they can access their data.
    let dashboardToken = complementUser?.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      await supabase.from("users").update({
        dashboard_token: dashboardToken,
        trial_started_at: new Date().toISOString(),
      }).eq("id", user.id);
    }
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    const dashboardUrl = `${appUrl}/dashboard?token=${dashboardToken}`;
    const raceCtx = data.race_name
      ? ` I can see you're targeting ${data.race_name}${raceDate ? ` on ${new Date(raceDate + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : ""} — I'll factor that into every analysis.`
      : "";
    const welcomeMsg = `${firstName}, you're all set.${raceCtx} After every Strava run I'll send you a debrief and write it back to your Strava activity. Text me anytime. Let's go.`;
    await sendAndStore(user.id, phone, welcomeMsg, "initial_plan");
    const dashboardMsg = `Your dashboard — I'll keep your key notes and data here. You can also upload your plan as a PDF so I can reference it directly:\n${dashboardUrl}`;
    await sendAndStore(user.id, phone, dashboardMsg, "initial_plan");
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
