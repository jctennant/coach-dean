import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { insertConversation, type MessageType } from "@/lib/conversations";
import { sendSMS } from "@/lib/linq";
import { trackEvent } from "@/lib/track";

export const maxDuration = 60;

const NUDGE_1_DAYS = 14;       // days of post-onboarding silence before first nudge
const NUDGE_2_DAYS = 7;        // days after nudge #1 with no reply before final nudge (21 days total)
const PRE_PLAN_NUDGE_DAYS = 2; // days stuck mid-onboarding before sending a resume nudge

// All onboarding steps that exist before the initial plan is sent.
// Users stuck here get a single "looks like we got cut off" nudge.
// (awaiting_payment is deliberately excluded — the payment-reminder cron owns it.)
const PRE_PLAN_STEPS = new Set([
  "onboarding",
  "awaiting_strava",
  "awaiting_timezone",
]);

const NUDGE_1_MESSAGE =
  "Hey — haven't heard from you in a bit! Still training? Text me anytime — I'm here for feedback on your runs and keeping you on track. Or text STOP to pause all messages.";

const NUDGE_2_MESSAGE =
  "Hey — since I haven't heard back, I'll stop sending messages. If you ever want to pick things back up, just text me and I'll be here.";

const ONBOARDING_RESUME_MESSAGE =
  "Hey — still interested in getting set up with coaching? Just reply and we'll finish in a minute.";

/**
 * GET /api/cron/reengagement
 * Runs daily. Nudges users who have gone silent, and sends a final goodbye
 * if they don't respond to the first nudge.
 *
 * Post-onboarding logic (uniform — no cadence differentiation):
 * 1. Nudge #1: 14+ days of silence → send first nudge, set reengagement_sent_at
 * 2. If user replies after nudge #1 → clear reengagement_sent_at (reset the clock)
 * 3. Nudge #2: 7+ days after nudge #1 with no reply (21 days total) → send final nudge
 *    Tracked via message_type = 'reengagement_final' — never messaged again after this.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: users, error } = await supabase
    .from("users")
    .select("id, phone_number, reengagement_sent_at, created_at, onboarding_step")
    .eq("messaging_opted_out", false)
    .not("phone_number", "is", null);

  if (error) {
    console.error("[reengagement] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, nudged: 0 });
  }

  // Batch-fetch which fully-onboarded users have already received the final nudge.
  // These users are permanently done — never message them again.
  const onboardedUserIds = users
    .filter((u) => u.onboarding_step === null)
    .map((u) => u.id);
  const { data: finalNudgeRows } =
    onboardedUserIds.length > 0
      ? await supabase
          .from("conversations")
          .select("user_id")
          .in("user_id", onboardedUserIds)
          .eq("message_type", "reengagement_final")
      : { data: [] };
  const alreadyFinalIds = new Set((finalNudgeRows ?? []).map((r) => r.user_id));

  const now = Date.now();
  let nudged = 0;

  for (const user of users) {
    try {
      // --- Pre-plan stall: user started onboarding but never finished ---
      // Send one resume nudge after PRE_PLAN_NUDGE_DAYS of silence. When they reply,
      // the onboarding/handle route picks up from their current step automatically.
      // reengagement_sent_at is used as a dedup guard — only nudge once.
      if (user.onboarding_step && PRE_PLAN_STEPS.has(user.onboarding_step as string)) {
        if (!user.reengagement_sent_at) {
          const { data: lastInbound } = await supabase
            .from("conversations")
            .select("created_at")
            .eq("user_id", user.id)
            .eq("role", "user")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          const silenceBasis = lastInbound?.created_at
            ? new Date(lastInbound.created_at)
            : new Date(user.created_at as string);
          const daysSilent = (now - silenceBasis.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSilent >= PRE_PLAN_NUDGE_DAYS) {
            await sendNudge(user.id, user.phone_number as string, ONBOARDING_RESUME_MESSAGE, "reengagement");
            void trackEvent(user.id, "onboarding_resume_nudge_sent", {
              step: user.onboarding_step,
              days_silent: Math.round(daysSilent),
            });
            console.log(
              `[reengagement] onboarding resume nudge → ${user.id} (step: ${user.onboarding_step}, ${Math.round(daysSilent)}d silent)`
            );
            nudged++;
          }
        }
        continue;
      }

      // Only run post-onboarding logic for fully onboarded users
      if (user.onboarding_step !== null) continue;

      // Already received the final nudge — never message again
      if (alreadyFinalIds.has(user.id)) continue;

      const { data: lastInbound } = await supabase
        .from("conversations")
        .select("created_at")
        .eq("user_id", user.id)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      const lastInboundAt: Date | null = lastInbound?.created_at
        ? new Date(lastInbound.created_at)
        : null;
      const sentAt: Date | null = user.reengagement_sent_at
        ? new Date(user.reengagement_sent_at as string)
        : null;
      const silenceBasis = lastInboundAt ?? new Date(user.created_at as string);
      const daysSilent = (now - silenceBasis.getTime()) / (1000 * 60 * 60 * 24);
      const repliedSinceNudge1 = sentAt && lastInboundAt && lastInboundAt > sentAt;

      // User replied after nudge #1 — reset the sequence so the clock can restart
      if (sentAt && repliedSinceNudge1) {
        await supabase.from("users").update({ reengagement_sent_at: null }).eq("id", user.id);
        console.log(`[reengagement] ${user.id} replied after nudge #1 — sequence reset`);
        continue;
      }

      // Nudge #2 (final): 7+ days after nudge #1 with no reply
      if (sentAt && !repliedSinceNudge1) {
        const daysSinceNudge1 = (now - sentAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceNudge1 >= NUDGE_2_DAYS) {
          await sendNudge(user.id, user.phone_number as string, NUDGE_2_MESSAGE, "reengagement_final");
          void trackEvent(user.id, "reengagement_nudge_sent", {
            nudge: 2,
            days_silent: Math.round(daysSilent),
          });
          console.log(
            `[reengagement] nudge #2 (final) → ${user.id} after ${Math.round(daysSilent)}d silence`
          );
          nudged++;
          continue;
        }
      }

      // Nudge #1: 14+ days of silence, not currently in nudge sequence
      if (!sentAt && daysSilent >= NUDGE_1_DAYS) {
        await sendNudge(user.id, user.phone_number as string, NUDGE_1_MESSAGE, "reengagement");
        void trackEvent(user.id, "reengagement_nudge_sent", {
          nudge: 1,
          days_silent: Math.round(daysSilent),
        });
        console.log(`[reengagement] nudge #1 → ${user.id} after ${Math.round(daysSilent)}d silence`);
        nudged++;
      }
    } catch (err) {
      console.error(`[reengagement] error processing user ${user.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, nudged });
}

async function sendNudge(userId: string, phone: string, message: string, messageType: MessageType) {
  await Promise.all([
    sendSMS(phone, message),
    insertConversation({
      user_id: userId,
      role: "assistant",
      content: message,
      message_type: messageType,
    }),
    supabase.from("users").update({ reengagement_sent_at: new Date().toISOString() }).eq("id", userId),
  ]);
}
