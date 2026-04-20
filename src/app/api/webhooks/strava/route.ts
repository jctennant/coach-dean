import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { getValidAccessToken, getActivity } from "@/lib/strava";
import { fetchActivityWeatherByCoords } from "@/lib/weather";
import { estimateLTHRFromRaces } from "@/lib/hr-zones";
import { estimateMaxHR } from "@/lib/hr-utils";

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
 * Returns 200 immediately (Strava requires a response within 2 seconds), then processes
 * the event asynchronously via after() to avoid timeout errors on slow DB/API calls.
 */
export async function POST(request: Request) {
  const body = await request.json();

  after(async () => {
    try {
      await processStravaEvent(body);
    } catch (err) {
      console.error("[strava-webhook] unhandled error in after():", err);
    }
  });

  return NextResponse.json({ ok: true });
}

async function processStravaEvent(body: {
  object_type: string;
  aspect_type: string;
  object_id: number;
  owner_id: number;
}) {
  const { object_type, aspect_type, object_id, owner_id } = body;

  if (object_type === "athlete" && aspect_type === "deauthorize") {
    await supabase
      .from("users")
      .update({
        strava_access_token: null,
        strava_refresh_token: null,
      })
      .eq("strava_athlete_id", owner_id);
    return;
  }

  if (object_type === "activity" && aspect_type === "create") {
    // Look up user by Strava athlete ID
    const { data: user } = await supabase
      .from("users")
      .select("id, phone_number, onboarding_step, messaging_opted_out")
      .eq("strava_athlete_id", owner_id)
      .single();

    if (!user) {
      console.warn(`No user found for Strava athlete ${owner_id}`);
      return NextResponse.json({ ok: true });
    }

    if (user.messaging_opted_out) {
      console.log(`[strava-webhook] user ${user.id} is opted out, skipping coaching for activity ${object_id}`);
      return;
    }

    // Users who are mid-onboarding still get a brief run reaction + nudge to finish setup.
    // The activity is stored either way so it appears in their history.

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
      let suppressCoaching = false;

      // Compute average pace (min/mi)
      const distanceMiles = activity.distance / 1609.34;
      const movingTimeMinutes = activity.moving_time / 60;
      const avgPaceMinutes = distanceMiles > 0 ? movingTimeMinutes / distanceMiles : 0;
      const totalPaceSec = Math.round(avgPaceMinutes * 60);
      const paceMin = Math.floor(totalPaceSec / 60);
      const paceSec = totalPaceSec % 60;
      const averagePace = `${paceMin}:${paceSec.toString().padStart(2, "0")}/mi`;

      // Extract GPS coordinates from Strava if available (used for historical weather fetch).
      const startLat: number | null = Array.isArray(activity.start_latlng) && activity.start_latlng.length >= 2
        ? activity.start_latlng[0]
        : null;
      const startLng: number | null = Array.isArray(activity.start_latlng) && activity.start_latlng.length >= 2
        ? activity.start_latlng[1]
        : null;

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
          average_watts: activity.average_watts || null,
          average_pace: averagePace,
          elevation_gain: activity.total_elevation_gain,
          suffer_score: activity.suffer_score || null,
          gear_id: activity.gear?.id || null,
          gear_name: activity.gear?.name || null,
          activity_name: activity.name || null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          best_efforts: (activity.best_efforts?.length ? activity.best_efforts : null) as any,
          start_date: activity.start_date,
          start_lat: startLat,
          start_lng: startLng,
          summary: {
            // Use splits_standard (per-mile splits). Both splits_standard and splits_metric
            // return elevation_difference in meters and average_speed in m/s — the units are
            // the same regardless of split type. splits_standard aligns with what US athletes
            // see in the Strava app (mile-by-mile breakdown), so Dean's analysis matches.
            splits: activity.splits_standard,
            laps: activity.laps,
          },
        },
        { onConflict: "strava_activity_id" }
      );

      // Fetch and store historical weather for this activity.
      // Done before firing the coaching trigger so the coach prompt can include
      // weather-adjusted effort context in the post_run debrief.
      if (isNew && startLat !== null && startLng !== null) {
        try {
          const weatherData = await fetchActivityWeatherByCoords(startLat, startLng, activity.start_date);
          if (weatherData) {
            await supabase
              .from("activities")
              .update({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              weather_data: weatherData as any,
                weather_fetched_at: new Date().toISOString(),
              })
              .eq("strava_activity_id", activity.id);
            console.log(`[strava-webhook] weather stored for activity ${activity.id}: ${weatherData.temp_c}°C, ${weatherData.condition}`);
          }
        } catch (weatherErr) {
          // Weather is best-effort — never block coaching on a weather API failure
          console.warn("[strava-webhook] weather fetch failed (non-fatal):", weatherErr);
        }
      }

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

      // Detect near-duplicate Strava activities — same run stored twice with different
      // activity IDs (e.g. watch auto-sync + manual GPX upload). Start times within
      // ±2 min and distance within 15% of each other = treat as the same run.
      if (isNew && activity.distance) {
        const startMs = new Date(activity.start_date).getTime();
        const startLow = new Date(startMs - 120_000).toISOString();
        const startHigh = new Date(startMs + 120_000).toISOString();

        const { data: nearDupes } = await supabase
          .from("activities")
          .select("id, strava_activity_id, distance_meters, average_heartrate, summary")
          .eq("user_id", user.id)
          .neq("strava_activity_id", activity.id)
          .eq("activity_type", activity.type)
          .gte("start_date", startLow)
          .lte("start_date", startHigh);

        const stravaNearDupe = (nearDupes || []).find((dupe) => {
          if (!dupe.distance_meters || !activity.distance) return false;
          const larger = Math.max(dupe.distance_meters, activity.distance);
          return Math.abs(dupe.distance_meters - activity.distance) / larger < 0.15;
        });

        if (stravaNearDupe) {
          // Determine which record is richer (has HR or lap data)
          const newIsRicher =
            activity.average_heartrate != null &&
            stravaNearDupe.average_heartrate == null;

          if (newIsRicher) {
            // Keep the new (richer) record, delete the old weaker one
            console.log(
              `[strava-webhook] near-dupe: deleting weaker existing activity ${stravaNearDupe.strava_activity_id} in favour of richer ${activity.id}`
            );
            await supabase.from("activities").delete().eq("id", stravaNearDupe.id);
          } else {
            // Keep the existing record, delete the new duplicate
            console.log(
              `[strava-webhook] near-dupe: new activity ${activity.id} is a duplicate of ${stravaNearDupe.strava_activity_id}, deleting new`
            );
            await supabase.from("activities").delete().eq("strava_activity_id", activity.id);
          }
          // Coaching already fired for the first-seen activity — suppress a second trigger
          suppressCoaching = true;
        }
      }

      // Second dedup guard: Strava can fire multiple webhook events for the same
      // activity ID hours apart (not just seconds). Check conversations by exact
      // strava_activity_id first — this is a permanent per-activity guard that
      // catches re-sends at any time interval.
      if (isNew && !suppressCoaching) {
        const { data: existingPostRunConv } = await supabase
          .from("conversations")
          .select("id")
          .eq("user_id", user.id)
          .eq("strava_activity_id", activity.id)
          .eq("message_type", "post_run")
          .limit(1)
          .maybeSingle();
        if (existingPostRunConv) {
          console.log(`[strava-webhook] post_run already sent for activity ${activity.id} for user ${user.id}, suppressing duplicate`);
          suppressCoaching = true;
        } else {
          // Fallback time-based guard for race conditions where the conversation
          // row for this activity hasn't been stored yet (e.g., two events arrive
          // within seconds before either completes its coach/respond call).
          const recentCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const { data: recentPostRun } = await supabase
            .from("conversations")
            .select("id")
            .eq("user_id", user.id)
            .eq("message_type", "post_run")
            .gte("created_at", recentCutoff)
            .limit(1)
            .maybeSingle();
          if (recentPostRun) {
            console.log(`[strava-webhook] post_run sent in last 10min for user ${user.id}, suppressing duplicate`);
            suppressCoaching = true;
          }
        }
      }

      // Recompute LTHR when a new race activity arrives — this is the highest-quality signal.
      // Runs async and never blocks coaching.
      if (isNew && activity.workout_type === 1 && user.onboarding_step === null) {
        void (async () => {
          try {
            const { data: allActivities } = await supabase
              .from("activities")
              .select("workout_type, average_heartrate, moving_time_seconds, activity_name, start_date, activity_type, max_heartrate")
              .eq("user_id", user.id)
              .order("start_date", { ascending: false })
              .limit(200);

            if (allActivities && allActivities.length > 0) {
              const maxHR = estimateMaxHR(allActivities.map(a => ({
                activity_type: a.activity_type,
                workout_type: a.workout_type ?? null,
                average_heartrate: a.average_heartrate ?? null,
                max_heartrate: a.max_heartrate ?? null,
              })));
              const lthrResult = estimateLTHRFromRaces(
                allActivities.map(a => ({
                  workout_type: a.workout_type ?? null,
                  average_heartrate: a.average_heartrate ?? null,
                  moving_time_seconds: a.moving_time_seconds ?? null,
                  activity_name: a.activity_name ?? null,
                  start_date: a.start_date ?? null,
                })),
                maxHR
              );
              if (lthrResult) {
                await supabase.from("training_profiles").update({
                  lthr_estimate: lthrResult.lthr,
                  lthr_source: lthrResult.source,
                  lthr_confidence: lthrResult.confidence,
                  lthr_last_updated: new Date().toISOString(),
                  hr_zone_method: "lthr",
                }).eq("user_id", user.id);
                console.log(`[strava-webhook] LTHR updated for user ${user.id}: ${lthrResult.lthr} bpm (${lthrResult.confidence})`);
              }
            }
          } catch (lthrErr) {
            console.warn("[strava-webhook] LTHR recompute failed (non-fatal):", lthrErr);
          }
        })();
      }

      // Fire coaching response for new activities. Fully onboarded users get the full
      // post_run analysis; users mid-onboarding get a brief reaction + segue to finish setup.
      if (isNew && !suppressCoaching) {
        // Post-[READY] users (awaiting_timezone) have a plan generated, so full post_run
        // coaching works. Pre-[READY] states ("onboarding", "awaiting_strava") have no
        // plan yet and fall back to the lightweight nudge.
        // NOTE: once billing is live, add "awaiting_payment" to the nudge list so the
        // full annotation is gated behind trial signup.
        const preReadyStates = new Set(["onboarding", "awaiting_strava", "awaiting_payment"]);
        const trigger = user.onboarding_step && preReadyStates.has(user.onboarding_step)
          ? "post_run_onboarding"
          : "post_run";
        await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.id,
            trigger,
            activityId: activity.id,
          }),
        });
      } else if (!isNew || suppressCoaching) {
        console.log(`[strava-webhook] duplicate event for activity ${activity.id}, skipping coaching response`);
      }
    } catch (err) {
      console.error("Error processing Strava activity webhook:", err);
    }
  }

  if (object_type === "activity" && aspect_type === "update") {
    // Refresh mutable fields (title, type) when an athlete edits their activity.
    // Most common case: title updated 10–15 min post-run.
    try {
      const { data: user } = await supabase
        .from("users")
        .select("id, strava_access_token, strava_refresh_token, strava_token_expires_at")
        .eq("strava_athlete_id", owner_id)
        .single();
      if (!user) return;

      const accessToken = await getValidAccessToken(user.id);
      const activity = await getActivity(accessToken, object_id);

      await supabase
        .from("activities")
        .update({ activity_name: activity.name || null })
        .eq("strava_activity_id", object_id);

      console.log(`[strava-webhook] updated activity_name for ${object_id}: "${activity.name}"`);
    } catch (err) {
      console.error("[strava-webhook] error processing activity update:", err);
    }
  }
}
