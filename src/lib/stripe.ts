import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-03-31.basil",
});

/** Returns the checkout page URL to embed in the payment link SMS. */
export function getCheckoutPageUrl(dashboardToken: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
  return `${appUrl}/checkout?token=${dashboardToken}`;
}
