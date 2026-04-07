import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { supabase } from "@/lib/supabase";

/**
 * POST /api/billing/checkout
 * Creates a Stripe Checkout session for a user identified by their dashboard token.
 * Returns { url } — the Stripe-hosted checkout URL to redirect the user to.
 */
export async function POST(request: Request) {
  const { token, plan } = await request.json() as { token: string; plan: "monthly" | "annual" };

  if (!token || !plan) {
    return NextResponse.json({ error: "Missing token or plan" }, { status: 400 });
  }

  const priceId = plan === "annual"
    ? process.env.STRIPE_ANNUAL_PRICE_ID!
    : process.env.STRIPE_MONTHLY_PRICE_ID!;

  const { data: user, error } = await supabase
    .from("users")
    .select("id, stripe_customer_id, billing_enabled, subscription_status")
    .eq("dashboard_token", token)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (!user.billing_enabled) {
    return NextResponse.json({ error: "Billing not enabled for this user" }, { status: 403 });
  }

  // Prevent duplicate subscriptions — if already trialing or active, redirect to dashboard.
  const activeStatuses = ["trialing", "active"];
  if (activeStatuses.includes(user.subscription_status as string)) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    const dashboardUrl = `${appUrl}/dashboard?token=${token}`;
    return NextResponse.json({ url: dashboardUrl });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";

  // Reuse existing Stripe customer if we have one
  const customerParam = user.stripe_customer_id
    ? { customer: user.stripe_customer_id as string }
    : {};

  const session = await getStripe().checkout.sessions.create({
    ...customerParam,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 7,
      metadata: { userId: user.id },
    },
    metadata: { userId: user.id },
    success_url: `${appUrl}/checkout/success?token=${token}`,
    cancel_url: `${appUrl}/checkout?token=${token}`,
    allow_promotion_codes: true,
  });

  if (!session.url) {
    return NextResponse.json({ error: "Failed to create checkout session" }, { status: 500 });
  }

  return NextResponse.json({ url: session.url });
}
