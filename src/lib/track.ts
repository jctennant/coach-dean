import { supabase } from "@/lib/supabase";

/**
 * Fire-and-forget event tracking. Inserts a row into the events table.
 * Never throws — tracking failures are logged but never crash the app.
 */
export async function trackEvent(
  userId: string,
  eventName: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  try {
    const { error } = await supabase.from("events").insert({
      user_id: userId,
      event_name: eventName,
      properties,
    });
    if (error) console.error("[track] insert failed:", eventName, error.message);
  } catch (err) {
    console.error("[track] unexpected error:", eventName, err);
  }
}
