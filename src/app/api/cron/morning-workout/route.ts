import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/cron/morning-workout
 * Triggered daily by Vercel cron. Sends morning workout plans to all active users.
 * Phase 2 — stub for now.
 */
export async function GET(request: Request) {
  // Verify cron secret to prevent unauthorized triggers
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch users who have completed onboarding, have Strava connected, and haven't opted out
  const { data: users } = await supabase
    .from("users")
    .select("id, timezone")
    .not("strava_access_token", "is", null)
    .is("onboarding_step", null)
    .not("phone_number", "is", null)
    .eq("messaging_opted_out", false);

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  for (const user of users) {
    // TODO: Check user timezone — only send if it's ~7am in their local time
    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          trigger: "morning_plan",
        }),
      });
      sent++;
    } catch (err) {
      console.error(`Failed to send morning workout to user ${user.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, sent });
}
