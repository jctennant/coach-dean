import { redirect } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";

/**
 * GET /cancel?token=<dashboard_token>
 *
 * Generates a Stripe Customer Portal session and redirects the user to it.
 * From the portal they can cancel, update payment info, view invoices, etc.
 *
 * Requires the Stripe Customer Portal to be configured in the Stripe Dashboard:
 * https://dashboard.stripe.com/test/settings/billing/portal
 */
export default async function CancelPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";

  if (!token) {
    return <ErrorScreen message="Invalid link — no token provided." />;
  }

  const { data: user } = await supabase
    .from("users")
    .select("id, stripe_customer_id, subscription_status, dashboard_token")
    .eq("dashboard_token", token)
    .single();

  if (!user) {
    return <ErrorScreen message="Link not recognized. Text Coach Dean for help." />;
  }

  if (!user.stripe_customer_id) {
    return <ErrorScreen message="No active subscription found for this account." />;
  }

  if (user.subscription_status === "canceled") {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 text-center">
        <div className="max-w-sm space-y-3">
          <p className="text-lg font-medium text-gray-800">Your subscription is already canceled.</p>
          <p className="text-sm text-gray-500">
            If you&apos;d like to resubscribe,{" "}
            <a href={`/checkout?token=${token}`} className="underline text-gray-700">
              start a new trial here
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  let portalUrl: string;
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripe_customer_id as string,
      return_url: `${appUrl}/dashboard?token=${token}`,
    });
    portalUrl = session.url;
  } catch (err) {
    console.error("[cancel] portal session creation failed:", err);
    return <ErrorScreen message="Couldn't load the cancellation page — text Coach Dean and he'll sort it out." />;
  }

  redirect(portalUrl);
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 text-center">
      <div className="max-w-sm space-y-3">
        <p className="text-gray-700">{message}</p>
      </div>
    </div>
  );
}
