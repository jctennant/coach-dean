import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { trackEvent } from "@/lib/track";

export const maxDuration = 60;

const NUDGE_1_DAYS = 14;   // nightly_reminders user: nudge after 14 days silence
const NUDGE_2_DAYS = 30;   // weekly_only user: final message after 30 days silence
const DOWNGRADE_DAYS = 3;  // days after nudge #1 with no reply before switching to weekly_only
const CADENCE_STALL_DAYS = 3; // days stuck in awaiting_cadence with no reply before auto-completing

const NUDGE_1_MESSAGE =
  "Hey — I haven't heard from you in a couple weeks! Still training? " +
  "Reply anything to keep your daily check-ins going. " +
  "If you'd prefer to switch to just a weekly plan recap on Sundays, just let me know. " +
  "Or text STOP to pause all messages.";

const NUDGE_2_MESSAGE =
  "Hey — since I haven't heard from you in a while, I've removed you from future reminders. " +
  "If you're still training and want to pick things back up, just text me and I'll be here.";

/**
 * GET /api/cron/reengagement
 * Runs daily. Nudges users who have gone silent, and downgrades cadence
 * from nightly_reminders to weekly_only if they don't respond to the first nudge.
 *
 * Logic per user:
 * 1. Downgrade: if nudge was sent 3+ days ago with no reply and still on nightly_reminders → weekly_only
 * 2. Nudge nightly_reminders user: if 14+ days silent and no pending nudge → send nudge #1
 * 3. Final message to weekly_only user: if 30+ days silent and never nudged → send once, then stop
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Also include users stuck in awaiting_cadence — they got their initial plan but
  // never replied to the cadence question, so no proactive messages fire for them.
  const { data: users, error } = await supabase
    .from("users")
    .select("id, phone_number, reengagement_sent_at, created_at, onboarding_step")
    .or("onboarding_step.is.null,onboarding_step.eq.awaiting_cadence")
    .eq("messaging_opted_out", false)
    .not("phone_number", "is", null);

  if (error) {
    console.error("[reengagement] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, downgraded: 0, nudged: 0 });
  }

  const now = Date.now();
  let downgraded = 0;
  let nudged = 0;

  for (const user of users) {
    try {
      // --- awaiting_cadence stall: user got their initial plan but never replied ---
      // Default their cadence to nightly_reminders and complete onboarding so
      // proactive messages start firing. Fires after CADENCE_STALL_DAYS with no reply.
      if (user.onboarding_step === "awaiting_cadence") {
        const { data: lastInbound } = await supabase
          .from("conversations")
          .select("created_at")
          .eq("user_id", user.id)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .limit(1)
          .single();
        const { data: initialPlanMsg } = await supabase
          .from("conversations")
          .select("created_at")
          .eq("user_id", user.id)
          .eq("message_type", "initial_plan")
          .order("created_at", { ascending: false })
          .limit(1)
          .single();
        // Only act if the initial plan was sent >CADENCE_STALL_DAYS ago
        const planSentAt = initialPlanMsg?.created_at ? new Date(initialPlanMsg.created_at) : null;
        const daysSincePlan = planSentAt ? (now - planSentAt.getTime()) / (1000 * 60 * 60 * 24) : null;
        const repliedSincePlan = lastInbound?.created_at && planSentAt
          ? new Date(lastInbound.created_at) > planSentAt
          : false;
        if (daysSincePlan !== null && daysSincePlan >= CADENCE_STALL_DAYS && !repliedSincePlan) {
          const nudgeMsg =
            "Hey — just making sure you got your plan! I've defaulted to sending you an evening reminder before each session. " +
            "Reply anytime to switch to morning reminders or a weekly-only Sunday recap instead.";
          await Promise.all([
            supabase.from("training_profiles").update({ proactive_cadence: "nightly_reminders" }).eq("user_id", user.id),
            supabase.from("users").update({ onboarding_step: null }).eq("id", user.id),
          ]);
          await sendNudge(user.id, user.phone_number as string, nudgeMsg);
          void trackEvent(user.id, "cadence_stall_resolved", { days_since_plan: Math.round(daysSincePlan) });
          console.log(`[reengagement] resolved awaiting_cadence stall for ${user.id} after ${Math.round(daysSincePlan)}d`);
          nudged++;
        }
        continue; // don't run normal reengagement checks for onboarding-incomplete users
      }

      // Fetch last inbound message and cadence in parallel
      const [inboundResult, profileResult] = await Promise.all([
        supabase
          .from("conversations")
          .select("created_at")
          .eq("user_id", user.id)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .limit(1)
          .single(),
        supabase
          .from("training_profiles")
          .select("proactive_cadence")
          .eq("user_id", user.id)
          .single(),
      ]);

      const lastInboundAt: Date | null = inboundResult.data?.created_at
        ? new Date(inboundResult.data.created_at)
        : null;
      const cadence = (profileResult.data?.proactive_cadence as string) ?? "weekly_only";
      const sentAt: Date | null = user.reengagement_sent_at
        ? new Date(user.reengagement_sent_at as string)
        : null;

      // Days since the user last messaged Dean (fall back to account creation if never)
      const silenceBasis = lastInboundAt ?? new Date(user.created_at as string);
      const daysSilent = (now - silenceBasis.getTime()) / (1000 * 60 * 60 * 24);
      const daysSinceNudge = sentAt ? (now - sentAt.getTime()) / (1000 * 60 * 60 * 24) : null;
      const repliedSinceNudge = sentAt && lastInboundAt && lastInboundAt > sentAt;

      // --- Step 1: Downgrade nightly_reminders users who didn't reply to nudge #1 ---
      if (
        cadence === "nightly_reminders" &&
        sentAt !== null &&
        daysSinceNudge !== null &&
        daysSinceNudge >= DOWNGRADE_DAYS &&
        !repliedSinceNudge
      ) {
        await supabase
          .from("training_profiles")
          .update({ proactive_cadence: "weekly_only" })
          .eq("user_id", user.id);
        // Clear sent_at so the 30-day weekly_only nudge can eventually fire
        await supabase
          .from("users")
          .update({ reengagement_sent_at: null })
          .eq("id", user.id);
        void trackEvent(user.id, "reengagement_downgraded", {
          days_silent: Math.round(daysSilent),
        });
        console.log(`[reengagement] downgraded ${user.id} to weekly_only after ${Math.round(daysSinceNudge)}d no reply`);
        downgraded++;
        continue; // recalculate cadence next run; skip nudge checks this run
      }

      // --- Step 2: Nudge nightly_reminders user after 14 days silence ---
      if (cadence === "nightly_reminders" && sentAt === null && daysSilent >= NUDGE_1_DAYS) {
        await sendNudge(user.id, user.phone_number as string, NUDGE_1_MESSAGE);
        void trackEvent(user.id, "reengagement_nudge_sent", {
          nudge: 1,
          days_silent: Math.round(daysSilent),
        });
        console.log(`[reengagement] nudge #1 sent to ${user.id} after ${Math.round(daysSilent)}d silence`);
        nudged++;
        continue;
      }

      // --- Step 3: Final message to weekly_only user after 30 days silence (sent once only) ---
      if (cadence === "weekly_only" && daysSilent >= NUDGE_2_DAYS && sentAt === null) {
        await sendNudge(user.id, user.phone_number as string, NUDGE_2_MESSAGE);
        void trackEvent(user.id, "reengagement_nudge_sent", {
          nudge: 2,
          days_silent: Math.round(daysSilent),
        });
        console.log(`[reengagement] nudge #2 sent to ${user.id} after ${Math.round(daysSilent)}d silence`);
        nudged++;
      }
    } catch (err) {
      console.error(`[reengagement] error processing user ${user.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, downgraded, nudged });
}

async function sendNudge(userId: string, phone: string, message: string) {
  await Promise.all([
    sendSMS(phone, message),
    supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: message,
      message_type: "reengagement",
    }),
    supabase.from("users").update({ reengagement_sent_at: new Date().toISOString() }).eq("id", userId),
  ]);
}
