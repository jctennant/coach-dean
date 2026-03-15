import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getValidAccessToken, getActivity } from "@/lib/strava";

/**
 * GET /api/webhooks/strava
 * Strava webhook verification (responds to the subscription challenge).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    return NextResponse.json({ "hub.challenge": challenge });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * POST /api/webhooks/strava
 * Receives Strava webhook events for activity create/update/delete and athlete deauthorize.
 */
export async function POST(request: Request) {
  const body = await request.json();
  const { object_type, aspect_type, object_id, owner_id } = body;

  // Acknowledge immediately — Strava expects a 200 within 2 seconds
  // Process asynchronously in practice; for MVP we handle inline.

  if (object_type === "athlete" && aspect_type === "deauthorize") {
    await supabase
      .from("users")
      .update({
        strava_access_token: null,
        strava_refresh_token: null,
      })
      .eq("strava_athlete_id", owner_id);

    return NextResponse.json({ ok: true });
  }

  if (object_type === "activity" && aspect_type === "create") {
    // Look up user by Strava athlete ID
    const { data: user } = await supabase
      .from("users")
      .select("id, phone_number, onboarding_step")
      .eq("strava_athlete_id", owner_id)
      .single();

    if (!user) {
      console.warn(`No user found for Strava athlete ${owner_id}`);
      return NextResponse.json({ ok: true });
    }

    // Don't trigger coaching responses during onboarding — the activity is still
    // stored so it appears in their history, but we don't interrupt the flow.
    if (user.onboarding_step !== null) {
      console.log(`[strava-webhook] user ${user.id} is in onboarding (${user.onboarding_step}), skipping post_run`);
      // Still store the activity below, just don't fire the coaching response.
    }

    try {
      const accessToken = await getValidAccessToken(user.id);
      const activity = await getActivity(accessToken, object_id);

      // Check if we've already processed this activity — Strava sometimes sends
      // duplicate webhook events for the same activity_id.
      const { data: existing } = await supabase
        .from("activities")
        .select("id")
        .eq("strava_activity_id", activity.id)
        .maybeSingle();

      const isNew = !existing;

      // Compute average pace (min/mi)
      const distanceMiles = activity.distance / 1609.34;
      const movingTimeMinutes = activity.moving_time / 60;
      const avgPaceMinutes = distanceMiles > 0 ? movingTimeMinutes / distanceMiles : 0;
      const totalPaceSec = Math.round(avgPaceMinutes * 60);
      const paceMin = Math.floor(totalPaceSec / 60);
      const paceSec = totalPaceSec % 60;
      const averagePace = `${paceMin}:${paceSec.toString().padStart(2, "0")}/mi`;

      // Store (or update) the activity
      await supabase.from("activities").upsert(
        {
          user_id: user.id,
          strava_activity_id: activity.id,
          activity_type: activity.type,
          distance_meters: activity.distance,
          moving_time_seconds: activity.moving_time,
          elapsed_time_seconds: activity.elapsed_time,
          average_heartrate: activity.average_heartrate || null,
          max_heartrate: activity.max_heartrate || null,
          average_cadence: activity.average_cadence || null,
          average_pace: averagePace,
          elevation_gain: activity.total_elevation_gain,
          suffer_score: activity.suffer_score || null,
          gear_id: activity.gear?.id || null,
          gear_name: activity.gear?.name || null,
          start_date: activity.start_date,
          summary: {
            // Use splits_metric — distance in meters, elevation in meters, guaranteed consistent units.
            // splits_imperial uses miles as split boundary but elevation_difference unit is ambiguous
            // (some Strava clients return feet, others meters). splits_metric is always meters.
            splits: activity.splits_metric,
            laps: activity.laps,
          },
        },
        { onConflict: "strava_activity_id" }
      );

      // Remove any manual/conversation activity for the same user, date, and
      // similar distance — the Strava record is richer and should take precedence.
      if (isNew && activity.distance) {
        const dateStr = activity.start_date.slice(0, 10);
        const { data: manualDupes } = await supabase
          .from("activities")
          .select("id, distance_meters")
          .eq("user_id", user.id)
          .in("source", ["manual", "conversation"])
          .gte("start_date", `${dateStr}T00:00:00Z`)
          .lte("start_date", `${dateStr}T23:59:59Z`);

        const dupeIds = (manualDupes || [])
          .filter((row) => row.distance_meters && Math.abs(row.distance_meters - activity.distance) < 500)
          .map((row) => row.id);

        if (dupeIds.length > 0) {
          console.log(`[strava-webhook] removing ${dupeIds.length} manual dupe(s) for user ${user.id} on ${dateStr}`);
          await supabase.from("activities").delete().in("id", dupeIds);
        }
      }

      // Only fire coaching response for new activities (not duplicate webhook events)
      // and only for fully onboarded users.
      if (isNew && user.onboarding_step === null) {
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.id,
            trigger: "post_run",
            activityId: activity.id,
          }),
        });
      } else if (!isNew) {
        console.log(`[strava-webhook] duplicate event for activity ${activity.id}, skipping coaching response`);
      }
    } catch (err) {
      console.error("Error processing Strava activity webhook:", err);
    }
  }

  return NextResponse.json({ ok: true });
}
