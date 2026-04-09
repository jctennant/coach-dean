import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * GET /api/cron/analyze-conversations
 * Runs daily. Fetches yesterday's conversations, analyzes them with Claude for
 * coaching errors / user complaints / hallucinations, and emails a digest.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const toEmail = process.env.ANALYSIS_EMAIL_TO;
  if (!toEmail) {
    console.error("[analyze-conversations] ANALYSIS_EMAIL_TO not set");
    return NextResponse.json({ error: "ANALYSIS_EMAIL_TO not configured" }, { status: 500 });
  }

  // Yesterday window in UTC
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const dateLabel = dayStart.toISOString().slice(0, 10);

  // Fetch all conversations from yesterday, with user phone for context
  const { data: messages, error } = await supabase
    .from("conversations")
    .select("user_id, role, content, message_type, created_at, strava_activity_id")
    .gte("created_at", dayStart.toISOString())
    .lte("created_at", dayEnd.toISOString())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[analyze-conversations] DB error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!messages || messages.length === 0) {
    console.log(`[analyze-conversations] No conversations on ${dateLabel}, skipping email`);
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Fetch activity metadata for post_run messages so the analyzer has ground truth
  // about what data Strava actually provided (laps, HR) — without this it can't
  // distinguish real data from hallucinations.
  const activityIds = [...new Set(
    messages
      .filter((m) => m.strava_activity_id != null)
      .map((m) => m.strava_activity_id as number)
  )];
  const activityMeta: Record<number, {
    hasLaps: boolean; hasHR: boolean; hasCadence: boolean; hasWatts: boolean;
    distanceMiles: number | null; activityType: string | null;
  }> = {};
  if (activityIds.length > 0) {
    const { data: activities } = await supabase
      .from("activities")
      .select("strava_activity_id, average_heartrate, average_cadence, average_watts, activity_type, distance_meters, summary")
      .in("strava_activity_id", activityIds);
    for (const act of activities ?? []) {
      const rawSummary = act.summary as { laps?: unknown[] } | null;
      activityMeta[act.strava_activity_id as number] = {
        hasLaps: !!(rawSummary?.laps && rawSummary.laps.length > 0),
        hasHR: act.average_heartrate != null,
        hasCadence: act.average_cadence != null,
        hasWatts: act.average_watts != null,
        distanceMiles: act.distance_meters != null ? Math.round((act.distance_meters / 1609.34) * 10) / 10 : null,
        activityType: act.activity_type ?? null,
      };
    }
  }

  // Group by user
  const byUser: Record<string, typeof messages> = {};
  for (const msg of messages) {
    if (!byUser[msg.user_id]) byUser[msg.user_id] = [];
    byUser[msg.user_id].push(msg);
  }

  // Format transcripts — annotate post_run messages with what Strava data was present
  const transcripts = Object.entries(byUser)
    .map(([userId, msgs]) => {
      const lines = msgs.map((m) => {
        const time = new Date(m.created_at ?? Date.now()).toISOString().slice(11, 16);
        const label =
          m.role === "user"
            ? "Athlete"
            : `Coach Dean (${m.message_type ?? "response"})`;
        let annotation = "";
        if (m.message_type === "post_run" && m.strava_activity_id) {
          const meta = activityMeta[m.strava_activity_id];
          if (meta) {
            const facts = [
              `activity type: ${meta.activityType ?? "unknown"}`,
              `distance: ${meta.distanceMiles ?? "unknown"} mi`,
              `HR monitor: ${meta.hasHR ? "YES" : "NO"}`,
              `cadence data: ${meta.hasCadence ? "YES" : "NO"}`,
              `power/watts data: ${meta.hasWatts ? "YES" : "NO"}`,
              `manual laps recorded: ${meta.hasLaps ? "YES" : "NO"}`,
              "per-mile GPS splits: YES (always present on GPS activities)",
            ];
            annotation = `\n  [STRAVA DATA AVAILABLE FOR THIS RUN — ${facts.join(", ")}]`;
          }
        }
        const content = (m.content as string ?? "").replace(/[\uD800-\uDFFF]/g, "");
        return `[${time}] ${label}:${annotation}\n  ${content}`;
      });
      return `=== User ${userId.slice(0, 8)} ===\n${lines.join("\n")}`;
    })
    .join("\n\n");

  const userCount = Object.keys(byUser).length;

  // Analyze with Claude
  const analysisPrompt = `You are reviewing coaching conversations from an AI running coach called Coach Dean.
Analyze the transcripts below from ${dateLabel} (${userCount} users, ${messages.length} messages total) and identify any issues.

IMPORTANT — what Coach Dean has access to via Strava for each annotated post_run message:
- Activity summary: distance, moving time, pace, total elevation gain (feet), sport type, start date/time — ALWAYS present
- Per-mile GPS splits: pace, distance, net elevation change per mile, HR per mile (if HR monitor YES), cadence per mile (if cadence data YES) — ALWAYS present on GPS activities; "per-mile GPS splits: YES" in annotation means all of these are available
- Lap data (when "manual laps recorded: YES"): per-lap pace, per-lap distance, per-lap total elevation gain, per-lap avg HR (if HR monitor YES), per-lap cadence (if cadence data YES), per-lap power (if power/watts data YES)
- Heart rate: average HR, max HR — only when "HR monitor: YES"
- Cadence: average cadence, per-split cadence, per-lap cadence — only when "cadence data: YES"
- Power/watts: activity average watts, per-lap watts — only when "power/watts data: YES". NOTE: Zwift rides ALWAYS have power data; power meters (Stryd, Garmin, bike power meters) also populate this.
- Weekly mileage: computed live from Strava activity history
- Athlete profile: name, location, gear/shoes

A true hallucination is when Dean cites specific numbers that Strava does not provide. Use the annotation as ground truth.

TRUE hallucinations (flag these):
- HR values when "HR monitor: NO"
- Cadence values (spm) when "cadence data: NO"
- Power/watt values when "power/watts data: NO"
- Specific lap counts, per-lap detail when "manual laps recorded: NO" — phrases like "lap-button pacing", "lap 6 and 7", "warmup lap / hard lap / cooldown lap"
- Data about runs that didn't happen according to Strava

NOT hallucinations (do NOT flag these):
- Any pace, split pace, or mile-by-mile breakdown — always from GPS splits
- Per-mile elevation changes or references to climbs/descents at specific mile markers — from GPS split elevation_difference field
- HR values when "HR monitor: YES"
- Cadence values when "cadence data: YES"
- Power/watt values when "power/watts data: YES" — including Zwift rides, which always have power
- Per-lap pace, distance, elevation, HR, cadence, or power when "manual laps recorded: YES" (and the relevant sensor is YES for HR/cadence/power)
- Fast pace figures on VirtualRide/Zwift activities — these are speed-based virtual environments, not GPS, and paces like 2:56/mi equivalent are plausible at high Zwift speeds
- Weekly mileage totals — computed live from Strava
- Overall vert, average pace, or any summary stat from the activity itself

Look for:
1. **Coaching errors** — wrong paces, wrong distances, contradicting previous messages, bad advice
2. **Data hallucinations** — Coach Dean inventing specific numbers that Strava would not provide (see above). Do NOT flag Dean citing run distance, pace, or weekly mileage as hallucinations — those come from Strava.
3. **User complaints or corrections** — athlete saying "that's wrong", "no I said", "that's not right", expressing confusion
4. **Onboarding friction** — users getting stuck, repeating themselves, giving up
5. **Positive patterns** — interactions that went really well and should be preserved
6. **Suggested improvements** — specific prompt or logic changes that would fix the issues found

For each issue, include:
- A short title
- Severity: P0 (breaking), P1 (fix soon), P2 (nice to have)
- The relevant transcript excerpt (quote directly)
- What went wrong and why
- A suggested fix

Be specific. If there are no issues, say so clearly.

Format your response as HTML suitable for an email body (use <h2>, <h3>, <p>, <blockquote>, <ul> tags). Start with a one-paragraph executive summary.

TRANSCRIPTS:
${transcripts}`;

  const [convAnalysisResponse, planHealthHtml] = await Promise.all([
    anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: analysisPrompt }],
    }),
    buildPlanHealthSection(now),
  ]);

  const analysisHtml =
    convAnalysisResponse.content[0].type === "text"
      ? convAnalysisResponse.content[0].text
      : "<p>Analysis unavailable.</p>";

  // Send email
  const { error: emailError } = await resend.emails.send({
    from: "Coach Dean <noreply@coachdean.ai>",
    to: toEmail,
    subject: `Coach Dean — Conversation Analysis ${dateLabel} (${userCount} users)`,
    html: `
      <div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #1a1a1a;">
        <h1 style="font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 12px;">
          Coach Dean · Daily Conversation Analysis · ${dateLabel}
        </h1>
        <p style="color: #6b7280; font-size: 13px;">
          ${userCount} users · ${messages.length} messages · analyzed with Claude Sonnet
        </p>
        ${analysisHtml}
        <hr style="margin-top: 40px; border: none; border-top: 1px solid #e5e7eb;" />
        ${planHealthHtml}
        <hr style="margin-top: 40px; border: none; border-top: 1px solid #e5e7eb;" />
        <p style="color: #9ca3af; font-size: 11px;">
          Generated by /api/cron/analyze-conversations · ${now.toISOString()}
        </p>
      </div>
    `,
  });

  if (emailError) {
    console.error("[analyze-conversations] Email send failed:", emailError);
    return NextResponse.json({ error: "Email failed", detail: emailError }, { status: 500 });
  }

  console.log(`[analyze-conversations] Analysis email sent for ${dateLabel} to ${toEmail}`);
  return NextResponse.json({ ok: true, date: dateLabel, users: userCount, messages: messages.length });
}

/**
 * Builds the plan health section of the daily email.
 *
 * For every active user (has a training_state), checks:
 * 1. Is weekly_mileage_target in training_state consistent with the current week
 *    in training_plans?
 * 2. Based on the last 3 days of conversations, did Dean promise plan changes
 *    that aren't reflected in the stored state?
 * 3. Is the plan arc's starting mileage reasonable given the user's stated
 *    fitness level and Strava history?
 */
async function buildPlanHealthSection(now: Date): Promise<string> {
  try {
    // Fetch all users who have a training_state (actively being coached)
    const { data: states } = await supabase
      .from("training_state")
      .select("user_id, current_week, current_phase, weekly_mileage_target, weekly_plan_sessions, updated_at");

    if (!states || states.length === 0) {
      return `<h2 style="font-size: 16px; margin-top: 32px;">Plan Health</h2><p style="color: #6b7280;">No active users.</p>`;
    }

    const userIds = states.map((s) => s.user_id as string);

    // Fetch profiles, plans, and recent conversations (last 3 days) in parallel
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const [{ data: profiles }, { data: plans }, { data: recentConvos }] = await Promise.all([
      supabase
        .from("training_profiles")
        .select("user_id, goal, race_date, fitness_level, days_per_week, current_easy_pace, current_vdot")
        .in("user_id", userIds),
      supabase
        .from("training_plans")
        .select("user_id, created_at, total_weeks, weeks")
        .in("user_id", userIds)
        .order("created_at", { ascending: false }),
      supabase
        .from("conversations")
        .select("user_id, role, content, message_type, created_at")
        .in("user_id", userIds)
        .gte("created_at", threeDaysAgo.toISOString())
        .order("created_at", { ascending: true }),
    ]);

    // Index by user_id (keep only latest plan per user)
    const profileByUser = Object.fromEntries((profiles ?? []).map((p) => [p.user_id, p]));
    const planByUser: Record<string, typeof plans extends (infer T)[] | null ? T : never> = {};
    for (const plan of plans ?? []) {
      const uid = plan.user_id as string;
      if (!planByUser[uid]) planByUser[uid] = plan; // already ordered desc, first = latest
    }
    const convosByUser: Record<string, typeof recentConvos extends (infer T)[] | null ? T[] : never[]> = {};
    for (const msg of recentConvos ?? []) {
      const uid = msg.user_id as string;
      if (!convosByUser[uid]) convosByUser[uid] = [];
      convosByUser[uid].push(msg);
    }

    // Build a compact per-user summary for Claude
    const userSummaries = states.map((state) => {
      const uid = state.user_id as string;
      const profile = profileByUser[uid];
      const plan = planByUser[uid];
      const convos = convosByUser[uid] ?? [];

      const currentWeek = state.current_week as number;
      const stateTarget = state.weekly_mileage_target as number | null;

      // Pull the current week's target from the plan arc
      const planWeeks = (plan?.weeks ?? []) as Array<{ week_number: number; phase: string; mileage_target: number }>;
      const planCurrentWeek = planWeeks.find((w) => w.week_number === currentWeek);
      const planTarget = planCurrentWeek?.mileage_target ?? null;

      // Show first 5 weeks of arc + current week neighborhood
      const arcPreview = planWeeks
        .filter((w) => w.week_number <= 5 || Math.abs(w.week_number - currentWeek) <= 1)
        .map((w) => `Wk${w.week_number}(${w.phase}): ${w.mileage_target}mi`)
        .join(", ");

      // Sessions
      const sessions = (state.weekly_plan_sessions as Array<{ day: string; date?: string; label: string }> | null) ?? [];
      const sessionsStr = sessions.map((s) => `${s.day}${s.date ? " " + s.date : ""}: ${s.label}`).join(" | ");

      // Conversations summary
      const convoLines = convos.map((c) => {
        const time = new Date(c.created_at ?? Date.now()).toISOString().slice(5, 16); // MM-DD HH:MM
        const speaker = c.role === "user" ? "Athlete" : `Dean(${c.message_type ?? "msg"})`;
        // Strip surrogate pairs and non-BMP chars that can cause JSON encoding errors in the API
        const content = (c.content as string ?? "").replace(/[\uD800-\uDFFF]/g, "").slice(0, 300);
        return `  [${time}] ${speaker}: ${content}`;
      });

      return [
        `--- User ${uid.slice(0, 8)} ---`,
        `Goal: ${profile?.goal ?? "unknown"} | Race: ${profile?.race_date ?? "none"} | Fitness: ${profile?.fitness_level ?? "unknown"} | Days/wk: ${profile?.days_per_week ?? "?"}`,
        `VDOT: ${profile?.current_vdot ?? "none"} | Easy pace: ${profile?.current_easy_pace ?? "none"}`,
        `Plan created: ${plan?.created_at?.slice(0, 10) ?? "none"} | Total weeks: ${plan?.total_weeks ?? "?"}`,
        `Current week: ${currentWeek} | Phase: ${state.current_phase}`,
        `training_state.weekly_mileage_target: ${stateTarget ?? "null"}`,
        `training_plans week ${currentWeek} target: ${planTarget ?? "missing"}`,
        planTarget != null && stateTarget != null && planTarget !== stateTarget
          ? `⚠️ MISMATCH: state says ${stateTarget}mi, plan says ${planTarget}mi`
          : `✓ State/plan targets match`,
        `Plan arc: ${arcPreview || "no plan"}`,
        `This week sessions: ${sessionsStr || "none"}`,
        convos.length > 0
          ? `Recent conversations (last 3 days):\n${convoLines.join("\n")}`
          : `Recent conversations: none in last 3 days`,
      ].join("\n");
    });

    const planHealthPrompt = `You are reviewing the training plan health for an AI running coach called Coach Dean.

Below is a snapshot of every active user's plan state and their last 3 days of conversation.

For EACH user, check:
1. STATE/PLAN MISMATCH — Is training_state.weekly_mileage_target different from the training_plans current week target? If so, flag it (this means Dean said it updated but the plan arc wasn't regenerated).
2. PLAN DRIFT — Based on the recent conversation, did Dean promise to change something (mileage, sessions, pace targets) that isn't reflected in the current state? Quote the exact promise and the conflicting state value.
3. PLAN ARC SANITY — Does the starting mileage make sense given the user's fitness level and goal? E.g. an "intermediate" runner with a marathon goal starting at 9mi/week is suspicious. Flag clearly conservative or overly aggressive starts.
4. OTHER CONCERNS — Anything else that looks wrong: no plan generated, stale plan (created months ago with wrong race date), sessions that don't match the stated goal type, etc.

For each issue:
- User ID (first 8 chars is fine)
- Issue type: MISMATCH | DRIFT | ARC_SANITY | OTHER
- Severity: P0 (user will get wrong coaching right now) | P1 (fix soon) | P2 (minor)
- What the data shows vs. what it should show
- Recommended fix (e.g. "run POST /api/admin/regenerate-plan with prescribedWeek1Miles=19")

If a user has no issues, say "✓ User [id] — looks good" on one line and move on.

Format as HTML (use <h3>, <p>, <ul>, <blockquote> tags). Start with a one-line count: "X of Y users have issues."

USER DATA:
${userSummaries.join("\n\n")}`;

    const planResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: planHealthPrompt }],
    });

    const planAnalysisHtml =
      planResponse.content[0].type === "text"
        ? planResponse.content[0].text
        : "<p>Plan health analysis unavailable.</p>";

    return `
      <h2 style="font-size: 16px; margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
        Plan Health · ${states.length} active users · ${threeDaysAgo.toISOString().slice(0, 10)} → today
      </h2>
      <p style="color: #6b7280; font-size: 12px;">Checks: state/plan mismatch · drift from conversation promises · arc sanity</p>
      ${planAnalysisHtml}
    `;
  } catch (err) {
    console.error("[analyze-conversations] Plan health section failed:", err);
    return `<h2 style="font-size: 16px; margin-top: 32px;">Plan Health</h2><p style="color: #dc2626;">Error building plan health section: ${String(err)}</p>`;
  }
}
