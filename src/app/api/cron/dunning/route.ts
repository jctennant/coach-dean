import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { getCheckoutPageUrl } from "@/lib/stripe";

/**
 * GET /api/cron/dunning
 * Runs daily. Sends dunning messages 2 and 3 to users whose subscriptions have lapsed.
 *
 * Message 1 is sent immediately by the Stripe webhook (payment_failed / subscription.deleted).
 * Message 2: ~4 days after message 1 (first_dunning_sent_at + 4 days)
 * Message 3: ~8 days after message 1 (first_dunning_sent_at + 8 days) — final message
 *
 * After count = 3, we stop touching the user unless they resubscribe.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();

  // Users who have lapsed and haven't hit the final dunning message yet
  const { data: users, error } = await supabase
    .from("users")
    .select("id, phone_number, name, dashboard_token, dunning_sent_count, first_dunning_sent_at, subscription_status")
    .eq("billing_enabled", true)
    .in("subscription_status", ["past_due", "canceled"])
    .lt("dunning_sent_count", 3)
    .not("first_dunning_sent_at", "is", null);

  if (error) {
    console.error("[dunning] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  const tasks = users.map(async (user) => {
    const count = user.dunning_sent_count as number;
    const firstSentAt = user.first_dunning_sent_at as string;
    const dashboardToken = user.dashboard_token as string | null;

    if (!dashboardToken) return;

    // Determine if this user is due for message 2 (count=1, 4+ days elapsed)
    // or message 3 (count=2, 8+ days elapsed)
    const isDueForMsg2 = count === 1 && firstSentAt <= fourDaysAgo;
    const isDueForMsg3 = count === 2 && firstSentAt <= eightDaysAgo;

    if (!isDueForMsg2 && !isDueForMsg3) return;

    const msgIndex = count; // count=1 → messages[1], count=2 → messages[2]
    const checkoutUrl = getCheckoutPageUrl(dashboardToken);

    const DUNNING_MESSAGES = [
      // [0] sent by webhook — not used here
      () => "",
      // [1] Message 2
      () =>
        `Just checking in — your Coach Dean access is still paused. Your training plan is waiting whenever you're ready: ${checkoutUrl}`,
      // [2] Message 3 (final)
      () =>
        `This'll be my last message. I've really enjoyed coaching you and I hope the training's been useful. Whenever you're ready to pick it back up, I'll be here: ${checkoutUrl}`,
    ];

    try {
      await sendSMS(user.phone_number as string, DUNNING_MESSAGES[msgIndex]());
      await supabase
        .from("users")
        .update({ dunning_sent_count: count + 1 })
        .eq("id", user.id);
      sent++;
      console.log(`[dunning] sent message ${msgIndex + 1} to user ${user.id}`);
    } catch (err) {
      console.error(`[dunning] failed for user ${user.id}:`, err);
    }
  });

  await Promise.allSettled(tasks);

  return NextResponse.json({ ok: true, sent });
}
