import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { insertConversation } from "@/lib/conversations";
import { sendSMS } from "@/lib/linq";
import { getCheckoutPageUrl } from "@/lib/stripe";
import { trackEvent } from "@/lib/track";

/**
 * GET /api/cron/trial-expiry
 * Runs daily. Closes the reverse free trial for users whose 7-day window has
 * elapsed and who haven't subscribed yet — flips them to onboarding_step
 * "awaiting_payment" so the existing payment-reminder + dunning crons can
 * follow up, and sends a single "trial's up" SMS with the checkout link.
 *
 * Match criteria:
 *  - reverse_trial_enabled = true
 *  - subscription_status not in (trialing, active) — Stripe sub already covers them
 *  - onboarding_step IS NULL — they're past onboarding and not already gated
 *  - trial_started_at <= 7 days ago
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: users, error } = await supabase
    .from("users")
    .select("id, phone_number, name, dashboard_token, subscription_status")
    .eq("reverse_trial_enabled", true)
    .is("onboarding_step", null)
    .not("trial_started_at", "is", null)
    .lte("trial_started_at", sevenDaysAgo);

  if (error) {
    console.error("[trial-expiry] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  const eligible = (users ?? []).filter((u) => {
    const status = u.subscription_status as string | null;
    return status !== "trialing" && status !== "active";
  });

  if (eligible.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  const tasks = eligible.map(async (user) => {
    let dashboardToken = user.dashboard_token as string | null;
    if (!dashboardToken) {
      dashboardToken = crypto.randomUUID();
      await supabase
        .from("users")
        .update({ dashboard_token: dashboardToken })
        .eq("id", user.id);
    }

    const _rawFirst = ((user.name as string | null) ?? "").split(" ")[0];
    const firstName = _rawFirst && _rawFirst.toLowerCase() !== "athlete" ? _rawFirst : "Hey";
    const checkoutUrl = getCheckoutPageUrl(dashboardToken);
    const message = `${firstName}, your free week with me is up. To keep the coaching going — runs, plans, race prep — subscribe here: ${checkoutUrl}`;

    try {
      await sendSMS(user.phone_number as string, message);
      await insertConversation({
        user_id: user.id,
        role: "assistant",
        content: message,
        message_type: "awaiting_payment",
      });
      await supabase
        .from("users")
        .update({
          onboarding_step: "awaiting_payment",
          payment_link_sent_at: new Date().toISOString(),
        })
        .eq("id", user.id);
      void trackEvent(user.id, "reverse_trial_expired", {});
      sent++;
      console.log(`[trial-expiry] gated user ${user.id}`);
    } catch (err) {
      console.error(`[trial-expiry] failed for user ${user.id}:`, err);
    }
  });

  await Promise.allSettled(tasks);

  return NextResponse.json({ ok: true, sent });
}
