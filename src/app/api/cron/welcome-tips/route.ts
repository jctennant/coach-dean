import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { insertConversation } from "@/lib/conversations";
import { sendSMS } from "@/lib/linq";
import { trackEvent } from "@/lib/track";

export const maxDuration = 60;

const TIPS_MESSAGE =
  "Hey — now that you're all set up, a couple shortcuts worth knowing: " +
  "DASHBOARD → your training dashboard, " +
  "STRAVA CONNECTION → update your Strava permissions (add/remove activity notes), " +
  "FEEDBACK → reaches the team directly, " +
  "UNSUBSCRIBE → cancel your subscription, " +
  "STOP → stop all messages (we'll also send a cancellation link). " +
  "After every Strava run I'll send you feedback automatically — or just text me anytime. Good luck out there!";

/**
 * GET /api/cron/welcome-tips
 * Runs daily at 15:00 UTC (7am PST / 10am EST).
 * Sends a one-time shortcuts tip to users whose initial_plan was sent 20–48 hours ago.
 * Deduped via message_type = 'welcome_tips' in conversations — no extra DB column needed.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: users, error } = await supabase
    .from("users")
    .select("id, phone_number")
    .is("onboarding_step", null)
    .eq("messaging_opted_out", false)
    .not("phone_number", "is", null);

  if (error) {
    console.error("[welcome-tips] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  const userIds = users.map((u) => u.id);
  const now = Date.now();
  const twentyHoursAgo = new Date(now - 20 * 60 * 60 * 1000).toISOString();
  const fortyEightHoursAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();

  // Batch-fetch: users whose initial_plan landed in the 20–48h window,
  // and users who've already received this message.
  const [initialPlanRows, alreadySentRows] = await Promise.all([
    supabase
      .from("conversations")
      .select("user_id")
      .in("user_id", userIds)
      .eq("message_type", "initial_plan")
      .gte("created_at", fortyEightHoursAgo)
      .lt("created_at", twentyHoursAgo),
    supabase
      .from("conversations")
      .select("user_id")
      .in("user_id", userIds)
      .eq("message_type", "welcome_tips"),
  ]);

  const eligibleIds = new Set((initialPlanRows.data ?? []).map((r) => r.user_id));
  const alreadySentIds = new Set((alreadySentRows.data ?? []).map((r) => r.user_id));

  const toSend = users.filter((u) => eligibleIds.has(u.id) && !alreadySentIds.has(u.id));

  if (toSend.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  await Promise.allSettled(
    toSend.map(async (user) => {
      try {
        await sendSMS(user.phone_number as string, TIPS_MESSAGE);
        await insertConversation({
          user_id: user.id,
          role: "assistant",
          content: TIPS_MESSAGE,
          message_type: "welcome_tips",
        });
        void trackEvent(user.id, "welcome_tips_sent", {});
        console.log(`[welcome-tips] sent to ${user.id}`);
        sent++;
      } catch (err) {
        console.error(`[welcome-tips] failed for user ${user.id}:`, err);
      }
    })
  );

  return NextResponse.json({ ok: true, sent });
}
