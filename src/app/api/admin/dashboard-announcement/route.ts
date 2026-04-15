/**
 * POST /api/admin/dashboard-announcement
 *
 * Sends a one-time message to active users announcing:
 *   - The new dashboard (race readiness, training load, fitness projections)
 *   - Plan import feature (text Dean a summary or upload on the dashboard)
 *
 * Targets users who:
 *   - Completed onboarding (onboarding_step IS NULL)
 *   - Have not opted out of messaging
 *   - Were active in the last 14 days (have a conversation row in that window)
 *   - Haven't received this message yet (dashboard_announcement_sent_at IS NULL)
 *
 * Body:
 *   secret   string   — must match ADMIN_SECRET
 *   dry_run  boolean  — if true, returns user list without sending
 *   userId   string   — optional: send only to this one user (for testing)
 *
 * Safe to call multiple times — dashboard_announcement_sent_at prevents double-sends.
 *
 * Dry-run:
 *   curl -X POST https://coachdean.ai/api/admin/dashboard-announcement \
 *     -H "Content-Type: application/json" \
 *     -d '{"secret":"<ADMIN_SECRET>","dry_run":true}'
 * Live:
 *   curl -X POST https://coachdean.ai/api/admin/dashboard-announcement \
 *     -H "Content-Type: application/json" \
 *     -d '{"secret":"<ADMIN_SECRET>"}'
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

export const maxDuration = 120;

const ANNOUNCEMENT_MESSAGE = `Quick update — I added a dashboard at coachdean.ai/dashboard with race readiness, training load trends, and fitness projections from your Strava data. Worth a look before your next race.

Also: if you're following an external plan (Runna, Garmin Coach, etc.), just text me a quick summary — like "Runna half marathon plan, week 8 of 16, ~40mi/week" — and I'll factor it into my feedback. You can also upload a plan screenshot on the dashboard.

Text me anytime.`;

export async function POST(request: Request) {
  let body: { secret?: string; dry_run?: boolean; userId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { secret, dry_run = false, userId } = body;

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find eligible users — active in the last 14 days via conversations
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Get users with recent conversation activity
  const { data: recentUserIds } = await supabase
    .from("conversations")
    .select("user_id")
    .gte("created_at", cutoff);

  if (!recentUserIds || recentUserIds.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: 0, users: [] });
  }

  const activeIds = [...new Set(recentUserIds.map(r => r.user_id).filter(Boolean))] as string[];

  let query = supabase
    .from("users")
    .select("id, name, phone_number")
    .is("onboarding_step", null)
    .eq("messaging_opted_out", false)
    .is("dashboard_announcement_sent_at", null)
    .in("id", activeIds);

  if (userId) {
    query = query.eq("id", userId);
  }

  const { data: users, error } = await query;

  if (error) {
    console.error("[dashboard-announcement] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: 0, users: [] });
  }

  console.log(`[dashboard-announcement] ${dry_run ? "DRY RUN — " : ""}targeting ${users.length} users`);

  let sent = 0;
  let skipped = 0;
  const results: { id: string; name: string | null; status: string }[] = [];

  for (const user of users) {
    const phone = user.phone_number as string | null;

    if (!phone) {
      skipped++;
      results.push({ id: user.id, name: user.name as string | null, status: "skipped_no_phone" });
      continue;
    }

    if (dry_run) {
      results.push({ id: user.id, name: user.name as string | null, status: "dry_run" });
      sent++;
      continue;
    }

    try {
      await sendSMS(phone, ANNOUNCEMENT_MESSAGE);

      await supabase.from("conversations").insert({
        user_id: user.id,
        role: "assistant",
        content: ANNOUNCEMENT_MESSAGE,
        message_type: "dashboard_announcement",
      });

      await supabase
        .from("users")
        .update({ dashboard_announcement_sent_at: new Date().toISOString() })
        .eq("id", user.id);

      sent++;
      results.push({ id: user.id, name: user.name as string | null, status: "sent" });
      console.log(`[dashboard-announcement] sent to ${user.id} (${user.name ?? "unnamed"})`);

      // Space sends 2 seconds apart to avoid rate limits
      if (sent < users.length) await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[dashboard-announcement] failed for ${user.id}:`, err);
      skipped++;
      results.push({ id: user.id, name: user.name as string | null, status: "error" });
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, users: results });
}
