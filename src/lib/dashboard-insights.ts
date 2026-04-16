/**
 * generateAndStoreDashboardInsights
 *
 * Called async (inside after()) after post_run, weekly_recap, and initial_plan.
 * Fetches training context from the DB, calls Haiku to produce:
 *   - A 1–2 sentence context summary of where the athlete is in training
 *   - 3 ranked focus areas: the highest-leverage things to work on right now
 *   - (when injury notes exist) strength & recovery recommendations
 * Stores the result as JSON in training_profiles.dashboard_insights.
 *
 * Never called at dashboard render time — the dashboard just reads the stored value.
 */

import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";

export type DashboardFocusItem = {
  label: string;
  text: string;
};

export type StrengthExercise = {
  name: string;
  specs: string;   // e.g. "3 × 15 each leg · slow lowering (3 sec down)"
  reason: string;  // italic explanatory note
};

export type CrossTraining = {
  emoji: string;
  name: string;    // e.g. "Easy bike — Thursday"
  desc: string;    // e.g. "45–60 min easy. Replaces your easy run…"
};

export type StrengthRecovery = {
  intro: string;           // 1–2 sentence context from injury history
  frequency: string;       // e.g. "2× this week"
  exercises: StrengthExercise[];
  cross_training?: CrossTraining;
};

export type DashboardInsights = {
  summary: string;
  focuses: DashboardFocusItem[];
  strength_recovery?: StrengthRecovery;
  generated_at: string;
  trigger: string;
};

export async function generateAndStoreDashboardInsights(
  userId: string,
  trigger: string,
  latestCoachMessage: string
): Promise<void> {
  try {
    const [profileRes, stateRes, messagesRes] = await Promise.all([
      supabase
        .from("training_profiles")
        .select("goal, race_date, injury_notes, current_easy_pace, current_tempo_pace, current_interval_pace")
        .eq("user_id", userId)
        .single(),
      supabase
        .from("training_state")
        .select("current_week, current_phase, weekly_mileage_target")
        .eq("user_id", userId)
        .single(),
      supabase
        .from("conversations")
        .select("content")
        .eq("user_id", userId)
        .eq("role", "assistant")
        .not("content", "is", null)
        .order("created_at", { ascending: false })
        .limit(12),
    ]);

    const profile = profileRes.data;
    const state = stateRes.data;
    const priorMessages = (messagesRes.data ?? [])
      .map(m => m.content as string | null)
      .filter((c): c is string => !!c);

    const hasInjuryNotes = !!profile?.injury_notes?.trim();

    const profileCtx = [
      profile?.goal ? `Goal: ${profile.goal}` : null,
      profile?.race_date ? `Race date: ${profile.race_date}` : null,
      profile?.injury_notes ? `Injury history: ${profile.injury_notes}` : null,
      profile?.current_easy_pace ? `Easy pace: ${profile.current_easy_pace}` : null,
      profile?.current_tempo_pace ? `Tempo pace: ${profile.current_tempo_pace}` : null,
      state?.current_phase ? `Training phase: ${state.current_phase}` : null,
      state?.current_week ? `Training week: ${state.current_week}` : null,
      state?.weekly_mileage_target ? `Weekly mileage target: ${state.weekly_mileage_target} mi` : null,
    ].filter(Boolean).join("\n");

    // Newest message first — the latest coach response (passed in) is most relevant
    const allMessages = [latestCoachMessage, ...priorMessages]
      .map((m, i) => `[${i + 1}] ${m.slice(0, 400)}`)
      .join("\n");

    const strengthRecoverySchema = hasInjuryNotes ? {
      strength_recovery: {
        type: "object" as const,
        description: "Strength and recovery plan based on injury history. Only include when there are specific injury notes.",
        properties: {
          intro: { type: "string", description: "1–2 sentences tying exercises to the athlete's specific injury pattern" },
          frequency: { type: "string", description: "Session frequency e.g. '2× this week'" },
          exercises: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Exercise name" },
                specs: { type: "string", description: "Sets/reps/cues, e.g. '3 × 15 each leg · slow lowering (3 sec down)'" },
                reason: { type: "string", description: "Short italic rationale linking to the injury site" },
              },
              required: ["name", "specs", "reason"],
            },
          },
          cross_training: {
            type: "object",
            description: "Optional cross-training alternative for one easy run",
            properties: {
              emoji: { type: "string", description: "Single emoji for the activity" },
              name: { type: "string", description: "Activity + day, e.g. 'Easy bike — Thursday'" },
              desc: { type: "string", description: "1–2 sentence description of benefit" },
            },
            required: ["emoji", "name", "desc"],
          },
        },
        required: ["intro", "frequency", "exercises"],
      },
    } : {};

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 768,
      system: `You are Dean, an AI running coach. Analyze this athlete's training context and recent coaching history to generate a personalized dashboard.

Your output has two required parts:
1. Context (1–2 sentences): where the athlete is in their training right now — phase, what's working, the single most important variable to watch. Be specific and concrete, not generic. Reference actual numbers or patterns if available.
2. Three prioritized focus areas — the highest-leverage things this athlete should do right now. Rank by impact: #1 = most important. Each focus: short label (1–2 words) + action text under 15 words, second person, direct.
${hasInjuryNotes ? `
3. Strength & recovery plan — because this athlete has injury notes, include specific exercises targeting their injury site. Tie each exercise to the injury pattern. Include 2–4 exercises with sets/reps/cues and a short italic rationale. Optionally suggest a cross-training alternative for one easy run day.` : ""}

Return an empty focuses array if there's insufficient data rather than inventing generic advice.`,
      messages: [{
        role: "user",
        content: `Athlete profile:\n${profileCtx}\n\nRecent coaching messages (newest first):\n${allMessages}`,
      }],
      tools: [{
        name: "save_dashboard_insights",
        description: "Save the training summary and focus areas for the athlete's dashboard",
        input_schema: {
          type: "object" as const,
          properties: {
            summary: {
              type: "string",
              description: "1–2 sentence context of where the athlete is in training right now",
            },
            focuses: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "1–2 word label" },
                  text: { type: "string", description: "Action text under 15 words, second person" },
                },
                required: ["label", "text"],
              },
            },
            ...strengthRecoverySchema,
          },
          required: ["summary", "focuses"],
        },
      }],
      tool_choice: { type: "tool" as const, name: "save_dashboard_insights" },
    });

    const block = response.content.find(
      b => b.type === "tool_use" && b.name === "save_dashboard_insights"
    );
    if (!block || block.type !== "tool_use") return;

    const extracted = block.input as {
      summary?: string;
      focuses?: DashboardFocusItem[];
      strength_recovery?: StrengthRecovery;
    };
    if (!extracted.summary?.trim()) return;

    const insights: DashboardInsights = {
      summary: extracted.summary.trim(),
      focuses: (extracted.focuses ?? []).slice(0, 3),
      ...(extracted.strength_recovery ? { strength_recovery: extracted.strength_recovery } : {}),
      generated_at: new Date().toISOString(),
      trigger,
    };

    await supabase
      .from("training_profiles")
      .update({ dashboard_insights: insights as unknown as import("@/lib/database.types").Json })
      .eq("user_id", userId);

    console.log(`[dashboard-insights] updated for user ${userId} (trigger: ${trigger})`);
  } catch (err) {
    // Non-fatal — dashboard falls back to stored value or graceful empty state
    console.error("[dashboard-insights] failed (non-fatal):", err);
  }
}
