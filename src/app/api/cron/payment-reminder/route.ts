import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { getCheckoutPageUrl } from "@/lib/stripe";

/**
 * GET /api/cron/payment-reminder
 * Runs daily. Sends a one-time follow-up to users who are still in 'awaiting_payment'
 * (haven't clicked the checkout link) after 24 hours.
 *
 * Only fires once per user — checks that payment_link_sent_at is between 1–2 days ago
 * and the user is still in the awaiting_payment step.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Users who received the payment link 1–2 days ago and still haven't subscribed
  const { data: users, error } = await supabase
    .from("users")
    .select("id, phone_number, name, dashboard_token")
    .eq("onboarding_step", "awaiting_payment")
    .eq("billing_enabled", true)
    .gte("payment_link_sent_at", twoDaysAgo)
    .lte("payment_link_sent_at", oneDayAgo);

  if (error) {
    console.error("[payment-reminder] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  const tasks = users.map(async (user) => {
    const dashboardToken = user.dashboard_token as string | null;
    if (!dashboardToken) return;

    const name = (user.name as string | null) ?? "hey";
    const checkoutUrl = getCheckoutPageUrl(dashboardToken);
    const message = `${name.split(" ")[0]}, your training plan is ready and waiting — just needs one more step to unlock it. Start your free 7-day trial here: ${checkoutUrl}`;

    try {
      await sendSMS(user.phone_number as string, message);
      sent++;
      console.log(`[payment-reminder] sent reminder to user ${user.id}`);
    } catch (err) {
      console.error(`[payment-reminder] failed for user ${user.id}:`, err);
    }
  });

  await Promise.allSettled(tasks);

  return NextResponse.json({ ok: true, sent });
}
