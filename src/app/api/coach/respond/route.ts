import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS } from "@/lib/twilio";

type TriggerType = "morning_plan" | "post_run" | "user_message";

interface CoachRequest {
  userId: string;
  trigger: TriggerType;
  activityId?: number;
}

/**
 * POST /api/coach/respond
 * Core coaching function. Given a user + trigger, generates and sends a coaching response via SMS.
 */
export async function POST(request: Request) {
  const { userId, trigger, activityId }: CoachRequest = await request.json();

  // Fetch user context in parallel
  const [userResult, profileResult, stateResult, conversationsResult] =
    await Promise.all([
      supabase.from("users").select("*").eq("id", userId).single(),
      supabase
        .from("training_profiles")
        .select("*")
        .eq("user_id", userId)
        .single(),
      supabase
        .from("training_state")
        .select("*")
        .eq("user_id", userId)
        .single(),
      supabase
        .from("conversations")
        .select("role, content, message_type, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(15),
    ]);

  const user = userResult.data;
  const profile = profileResult.data;
  const state = stateResult.data;
  const recentMessages = conversationsResult.data?.reverse() || [];

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // If post_run, fetch the activity
  let activityData = null;
  if (trigger === "post_run" && activityId) {
    const { data } = await supabase
      .from("activities")
      .select("*")
      .eq("strava_activity_id", activityId)
      .single();
    activityData = data;
  }

  // Build system prompt
  const systemPrompt = buildSystemPrompt(user, profile, state, recentMessages);

  // Build user message based on trigger
  const userMessage = buildUserMessage(trigger, activityData);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const coachMessage =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Send SMS
  await sendSMS(user.phone_number, coachMessage);

  // Store the response
  await supabase.from("conversations").insert({
    user_id: userId,
    role: "assistant",
    content: coachMessage,
    message_type:
      trigger === "post_run"
        ? "post_run"
        : trigger === "morning_plan"
          ? "morning_plan"
          : "coach_response",
    strava_activity_id: activityId || null,
  });

  // Update training state if post_run
  if (trigger === "post_run" && activityData) {
    const distanceMiles = activityData.distance_meters / 1609.34;
    await supabase
      .from("training_state")
      .update({
        week_mileage_so_far: (state?.week_mileage_so_far || 0) + distanceMiles,
        last_activity_date: activityData.start_date,
        last_activity_summary: {
          type: activityData.activity_type,
          distance_miles: Math.round(distanceMiles * 100) / 100,
          pace: activityData.average_pace,
          hr: activityData.average_heartrate,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  return NextResponse.json({ ok: true, message: coachMessage });
}

function buildSystemPrompt(
  user: Record<string, unknown>,
  profile: Record<string, unknown> | null,
  state: Record<string, unknown> | null,
  recentMessages: Array<{ role: string; content: string; message_type: string }>
): string {
  const conversationHistory = recentMessages
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`)
    .join("\n");

  return `You are an expert running coach communicating via text message. You are coaching ${user.name || "this athlete"} for a ${profile?.goal || "general fitness"} ${profile?.race_date ? `on ${profile.race_date}` : ""}.

TRAINING PHILOSOPHY:
- Follow periodized training: base → build → peak → taper
- 80/20 rule: ~80% easy effort, ~20% quality workouts
- Progressive overload: increase weekly mileage by no more than 10%/week
- Every 4th week is a recovery week (reduce volume 25-30%)
- Long runs progress by ~1 mile per week
- Quality workouts: tempo runs, intervals, race pace work (introduced in build phase)

CURRENT STATE:
- Week ${state?.current_week || 1} of training, phase: ${state?.current_phase || "base"}
- Weekly mileage target: ${state?.weekly_mileage_target || "TBD"} mi
- Mileage so far this week: ${state?.week_mileage_so_far || 0} mi
- Current paces: Easy ${profile?.current_easy_pace || "TBD"}, Tempo ${profile?.current_tempo_pace || "TBD"}, Interval ${profile?.current_interval_pace || "TBD"}
- Last activity: ${state?.last_activity_summary ? JSON.stringify(state.last_activity_summary) : "None yet"}
- Active adjustments: ${state?.plan_adjustments || "None"}
- Fitness level: ${profile?.fitness_level || "unknown"}
- Training days/week: ${profile?.days_per_week || "TBD"}
- Constraints: ${profile?.constraints || "None"}

COMMUNICATION STYLE:
- Text message tone: concise, encouraging, knowledgeable
- Use numbers and paces specifically — don't be vague
- Flag potential injury/overtraining signals directly
- It's okay to tell the user to rest or scale back
- Keep messages under 300 words
- Use occasional emoji sparingly

RECENT CONVERSATION:
${conversationHistory || "No previous messages."}`;
}

function buildUserMessage(
  trigger: TriggerType,
  activityData: Record<string, unknown> | null
): string {
  switch (trigger) {
    case "morning_plan":
      return "Generate today's workout plan for this athlete. Consider their current training state, recent activity, and any adjustments needed.";
    case "post_run":
      return `The athlete just completed a workout. Here are the details:\n${JSON.stringify(activityData, null, 2)}\n\nProvide post-run feedback analyzing their performance, noting what went well, any concerns, and what's coming up next.`;
    case "user_message":
      return "The athlete just sent you a message (see the most recent message in RECENT CONVERSATION above). Respond helpfully as their running coach.";
  }
}
