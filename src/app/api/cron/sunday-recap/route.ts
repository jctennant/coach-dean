import { NextResponse } from "next/server";
import { runAfter } from "@/lib/safe-after";
import { supabase } from "@/lib/supabase";
import { getValidAccessToken, getAthleteStats } from "@/lib/strava";
import type { Json } from "@/lib/database.types";
import { getRestrictedPhones } from "@/lib/admin-restrict";

export const maxDuration = 300;

/**
 * GET /api/cron/sunday-recap
 * Triggered weekly at 01:00 UTC Monday (= Sunday 6pm PDT / 9pm EDT).
 * Fires after most US runners have finished their Sunday run.
 * Sends weekly recap + coming week plan to all active users.
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

  const restrictedPhones = getRestrictedPhones();
  if (restrictedPhones) query = query.in("phone_number", restrictedPhones);

  const { data: users } = await query;

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  // Return 200 immediately so cron-job.org doesn't hit its 30s HTTP timeout.
  // The loop below does a Strava API call + awaited fetch per user, which blows
  // the budget once we have more than a handful of Strava-connected users.
  // Vercel keeps the function alive to finish `after()` work post-response.
  runAfter("sunday-recap", async () => {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Process users in batches of 30 to stay under the 450k TPM rate limit.
    // Each batch uses ~360k tokens (30 × ~12k). 30s between batches lets the
    // window recover. Scales safely to ~150 users before needing a job queue.
    const BATCH_SIZE = 30;
    const allResults: PromiseSettledResult<string>[] = [];
    for (let b = 0; b < users.length; b += BATCH_SIZE) {
      const batch = users.slice(b, b + BATCH_SIZE);
      const batchResults = await Promise.allSettled(batch.map(async (user) => {
        // Refresh YTD stats from Strava before generating the recap so Dean has
        // accurate year-to-date mileage for milestone callouts ("500 miles this year!").
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

        // Skip users who already received an initial_plan or weekly_recap in the last 8 hours.
        // This prevents a double-plan when someone onboards on the same Sunday the cron fires.
        const { data: recentPlan } = await supabase
          .from("conversations")
          .select("id")
          .eq("user_id", user.id)
          .eq("role", "assistant")
          .in("message_type", ["initial_plan", "weekly_recap"])
          .gte("created_at", eightHoursAgo)
          .limit(1)
          .single();
        if (recentPlan) {
          console.log(`[sunday-recap] skipping user ${user.id} — received a plan within the last 8 hours`);
          return "skipped";
        }

        await fetch(`${appUrl}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, trigger: "weekly_recap" }),
          signal: AbortSignal.timeout(90_000),
        });
        return "sent";
      }));
      allResults.push(...batchResults);
      batchResults.forEach((r, i) => {
        if (r.status === "rejected") console.error(`[sunday-recap] failed for user ${batch[i].id}:`, r.reason);
      });
      if (b + BATCH_SIZE < users.length) {
        console.log(`[sunday-recap] batch ${Math.floor(b / BATCH_SIZE) + 1} done — waiting 30s before next batch`);
        await sleep(30_000);
      }
    }

    const sent = allResults.filter(r => r.status === "fulfilled" && r.value === "sent").length;
    const skipped = allResults.filter(r => r.status === "fulfilled" && r.value === "skipped").length;
    const failed = allResults.filter(r => r.status === "rejected").length;
    console.log(`[sunday-recap] completed — sent ${sent}, skipped ${skipped}, failed ${failed} of ${users.length}`);
  });

  return NextResponse.json({ ok: true, queued: users.length });
}
