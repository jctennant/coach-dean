import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { getCheckoutPageUrl } from "@/lib/stripe";

export const maxDuration = 60;

const DUNNING_MESSAGES = [
  (checkoutUrl: string) =>
    `Hey — your Coach Dean subscription has lapsed. Keep your training momentum going and resubscribe here: ${checkoutUrl}`,
  (checkoutUrl: string) =>
    `Just checking in — your Coach Dean access is still paused. Your training plan is waiting whenever you're ready: ${checkoutUrl}`,
  (checkoutUrl: string) =>
    `This'll be my last message. I've really enjoyed coaching you and I hope the training's been useful. Whenever you're ready to pick it back up, I'll be here: ${checkoutUrl}`,
];

/**
 * POST /api/webhooks/stripe
 * Handles Stripe subscription lifecycle events.
 */
export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("[stripe/webhook] signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as import("stripe").Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        if (!userId) {
          console.error("[stripe/webhook] checkout.session.completed missing userId metadata");
          break;
        }

        const subscriptionId = session.subscription as string | null;

        await supabase
          .from("users")
          .update({
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: subscriptionId,
            subscription_status: "trialing",
            onboarding_step: null,
            payment_link_sent_at: null,
          })
          .eq("id", userId);

        // Fire initial_plan now that the user has subscribed and onboarding is complete.
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, trigger: "initial_plan" }),
        }).catch((err) => console.error("[stripe/webhook] initial_plan trigger failed:", err));

        console.log(`[stripe/webhook] checkout completed for user ${userId}, initial_plan triggered`);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as import("stripe").Stripe.Subscription;
        const status = sub.status; // 'trialing' | 'active' | 'past_due' | 'canceled' | etc.

        const { data: user } = await supabase
          .from("users")
          .select("id, dunning_sent_count")
          .eq("stripe_subscription_id", sub.id)
          .single();

        if (!user) break;

        await supabase
          .from("users")
          .update({ subscription_status: status })
          .eq("id", user.id);

        console.log(`[stripe/webhook] subscription updated for user ${user.id}: ${status}`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as import("stripe").Stripe.Invoice;
        const customerId = invoice.customer as string;

        const { data: user } = await supabase
          .from("users")
          .select("id, phone_number, dashboard_token, dunning_sent_count, billing_enabled")
          .eq("stripe_customer_id", customerId)
          .single();

        if (!user || !user.billing_enabled) break;

        await supabase
          .from("users")
          .update({ subscription_status: "past_due" })
          .eq("id", user.id);

        // Send dunning message 1 (only if not already sent)
        if ((user.dunning_sent_count as number) === 0) {
          const dashboardToken = user.dashboard_token as string | null;
          if (dashboardToken) {
            const checkoutUrl = getCheckoutPageUrl(dashboardToken);
            await sendSMS(user.phone_number as string, DUNNING_MESSAGES[0](checkoutUrl));
          }
          await supabase
            .from("users")
            .update({ dunning_sent_count: 1, first_dunning_sent_at: new Date().toISOString() })
            .eq("id", user.id);
        }

        console.log(`[stripe/webhook] payment_failed for user ${user.id}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as import("stripe").Stripe.Subscription;
        const customerId = sub.customer as string;

        const { data: user } = await supabase
          .from("users")
          .select("id, phone_number, dashboard_token, dunning_sent_count, billing_enabled")
          .eq("stripe_customer_id", customerId)
          .single();

        if (!user || !user.billing_enabled) break;

        await supabase
          .from("users")
          .update({ subscription_status: "canceled" })
          .eq("id", user.id);

        // Send dunning message 1 if not already sent (payment_failed may have already sent it)
        if ((user.dunning_sent_count as number) === 0) {
          const dashboardToken = user.dashboard_token as string | null;
          if (dashboardToken) {
            const checkoutUrl = getCheckoutPageUrl(dashboardToken);
            await sendSMS(user.phone_number as string, DUNNING_MESSAGES[0](checkoutUrl));
          }
          await supabase
            .from("users")
            .update({ dunning_sent_count: 1, first_dunning_sent_at: new Date().toISOString() })
            .eq("id", user.id);
        }

        console.log(`[stripe/webhook] subscription deleted for user ${user.id}`);
        break;
      }

      default:
        // Unhandled event type — ignore
        break;
    }
  } catch (err) {
    console.error(`[stripe/webhook] error handling ${event.type}:`, err);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
