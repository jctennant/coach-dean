import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2025-03-31.basil",
    });
  }
  return _stripe;
}

/** Returns the checkout page URL to embed in the payment link SMS. */
export function getCheckoutPageUrl(dashboardToken: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
  return `${appUrl}/checkout?token=${dashboardToken}`;
}
