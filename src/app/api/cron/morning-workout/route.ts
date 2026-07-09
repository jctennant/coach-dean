import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/cron/morning-workout
 * Triggered daily by Vercel cron. Sends morning workout plans to all active users.
 * Users on injury hold receive a daily check-in instead of a training plan.
 */
export async function GET(request: Request) {
  // Verify cron secret to prevent unauthorized triggers
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch active users plus their injury hold state in one query
  const { data: users } = await supabase
    .from("users")
    .select("id, timezone, training_state!inner(injury_hold_since)")
    .not("strava_access_token", "is", null)
    .is("onboarding_step", null)
    .not("phone_number", "is", null)
    .eq("messaging_opted_out", false);

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, checkins: 0 });
  }

  let sent = 0;
  let checkins = 0;

  for (const user of users) {
    // TODO: Check user timezone — only send if it's ~7am in their local time
    const stateArr = user.training_state as { injury_hold_since: string | null }[] | null;
    const state = Array.isArray(stateArr) ? stateArr[0] : (stateArr as { injury_hold_since: string | null } | null);
    const onInjuryHold = !!(state?.injury_hold_since);

    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          trigger: onInjuryHold ? "injury_checkin" : "morning_plan",
        }),
      });

      if (onInjuryHold) {
        checkins++;
      } else {
        sent++;
      }
    } catch (err) {
      console.error(`Failed to send morning message to user ${user.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, sent, checkins });
}
