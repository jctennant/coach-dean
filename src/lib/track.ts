import { supabase } from "@/lib/supabase";
import { getPostHogClient } from "@/lib/posthog";

/**
 * Fire-and-forget event tracking.
 * Writes to Supabase events table and mirrors to PostHog.
 * Never throws — tracking failures are logged but never crash the app.
 */
export async function trackEvent(
  userId: string,
  eventName: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  try {
    const [{ error }] = await Promise.all([
      supabase.from("events").insert({ user_id: userId, event_name: eventName, properties }),
      (async () => {
        const ph = getPostHogClient();
        if (!ph) return;
        ph.capture({ distinctId: userId, event: eventName, properties });
        // flushAt: 1 sends immediately on capture — no shutdown needed.
        // Calling shutdown() here closes the HTTP client and breaks all
        // subsequent events in the same Lambda instance.
      })(),
    ]);
    if (error) console.error("[track] supabase insert failed:", eventName, error.message);
  } catch (err) {
    console.error("[track] unexpected error:", eventName, err);
  }
}
