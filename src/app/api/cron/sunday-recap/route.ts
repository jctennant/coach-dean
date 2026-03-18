import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getValidAccessToken, getAthleteStats } from "@/lib/strava";
import type { Json } from "@/lib/database.types";

/**
 * GET /api/cron/sunday-recap
 * Triggered weekly on Sunday by Vercel cron. Sends weekly recap to all active users.
 */
export async function GET(request: Request) {
  // Verify cron secret to prevent unauthorized triggers
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional ?userId= param for testing — limits the run to a single user.
  const { searchParams } = new URL(request.url);
  const testUserId = searchParams.get("userId");
  const excludeUserIds = (searchParams.get("excludeUserIds") ?? "").split(",").filter(Boolean);

  // Fetch all users who have completed onboarding and haven't opted out.
  // Sunday recap goes to everyone regardless of proactive_cadence — it replaces
  // the nightly reminder for Monday so users get a full weekly overview instead.
  let query = supabase
    .from("users")
    .select("id, strava_athlete_id, onboarding_data")
    .is("onboarding_step", null)
    .not("phone_number", "is", null)
    .eq("messaging_opted_out", false);

  if (testUserId) query = query.eq("id", testUserId);
  if (excludeUserIds.length > 0) query = query.not("id", "in", `(${excludeUserIds.join(",")})`)

  const { data: users } = await query;

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  for (const user of users) {
    // Refresh YTD stats from Strava before generating the recap so Dean has
    // accurate year-to-date mileage for milestone callouts ("500 miles this year!").
    // Non-fatal — if this fails we proceed with whatever is cached.
    if (user.strava_athlete_id) {
      try {
        const accessToken = await getValidAccessToken(user.id);
        const stats = await getAthleteStats(accessToken, user.strava_athlete_id as number);
        const existingData = (user.onboarding_data as Record<string, unknown>) || {};
        const existingStats = (existingData.strava_stats as Record<string, unknown>) || {};
        await supabase
          .from("users")
          .update({
            onboarding_data: {
              ...existingData,
              strava_stats: {
                ...existingStats,
                ytd_run_totals: stats.ytd_run_totals,
                all_run_totals: stats.all_run_totals,
                refreshed_at: new Date().toISOString(),
              },
            } as unknown as Json,
          })
          .eq("id", user.id);
        console.log(`[sunday-recap] refreshed Strava stats for user ${user.id}`);
      } catch (err) {
        console.error(`[sunday-recap] stats refresh failed for user ${user.id} (non-fatal):`, err);
      }
    }

    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          trigger: "weekly_recap",
        }),
      });
      sent++;
    } catch (err) {
      console.error(`Failed to send weekly recap to user ${user.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true, sent });
}
