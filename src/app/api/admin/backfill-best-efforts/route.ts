/**
 * POST /api/admin/backfill-best-efforts
 *
 * Re-fetches Strava detail data (best_efforts + activity_name) for a user's
 * stored activities. Skips activities already populated unless force=true.
 *
 * Body: { userId: string, limit?: number, force?: boolean }
 * Returns: { ok: true, updated: number, skipped: number, errors: number }
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getValidAccessToken, fetchAndStoreBestEfforts } from "@/lib/strava";

export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { userId?: string; limit?: number; force?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { userId, limit = 500, force = false } = body;
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const { data: user } = await supabase
    .from("users")
    .select("id, strava_athlete_id")
    .eq("id", userId)
    .single();

  if (!user?.strava_athlete_id) {
    return NextResponse.json({ error: "User not found or no Strava connection" }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(userId);
  } catch (err) {
    return NextResponse.json({ error: `Strava auth failed: ${err}` }, { status: 500 });
  }

  const result = await fetchAndStoreBestEfforts(userId, accessToken, { limit, forceRefresh: force });
  return NextResponse.json({ ok: true, ...result });
}
