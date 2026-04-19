/**
 * POST /api/admin/changelog
 *
 * Sends the April 2026 changelog SMS to active users covering:
 *   - New plan format (mileage target + long run + 1-2 quality sessions, no day-by-day)
 *   - Strava activity annotations
 *   - Dashboard reminder
 *
 * Targets users who:
 *   - Completed onboarding (onboarding_step IS NULL)
 *   - Have not opted out of messaging
 *   - Were active in the last 30 days (conversation row in that window)
 *   - Haven't received this message yet (plan_update_sent_at IS NULL)
 *
 * Body:
 *   secret   string   — must match ADMIN_SECRET
 *   dry_run  boolean  — if true, returns user list without sending (default false)
 *   userId   string   — optional: send only to this one user (for testing)
 *
 * Safe to call multiple times — plan_update_sent_at prevents double-sends.
 *
 * Dry-run:
 *   curl -X POST https://coachdean.ai/api/admin/changelog -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>","dry_run":true}'
 * Single user test:
 *   curl -X POST https://coachdean.ai/api/admin/changelog -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>","userId":"<USER_ID>","dry_run":true}'
 * Live:
 *   curl -X POST https://coachdean.ai/api/admin/changelog -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>"}'
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

export const maxDuration = 120;

// Split on \n\n so each paragraph sends as its own SMS bubble
const CHANGELOG_MESSAGES = [
  `Quick update on how I structure your plan.

I don't map out every day anymore. Each week I give you three anchors: a mileage target, a long run, and one or two quality sessions — tempo, intervals, or strides depending on where you are in training. You fill in easy runs around those. Keeps things flexible when life gets in the way, and puts the decision-making back with you.`,

  `Two things on the dashboard at coachdean.ai/dashboard worth checking: race readiness, training load trends, and fitness projections are all there now. And if you haven't connected Strava yet, you can do it from the dashboard — once connected, I'll start adding a note to each activity after you finish with effort verdict, zone context, and how the run fits the week.`,
];

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

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentUserIds } = await supabase
    .from("conversations")
    .select("user_id")
    .gte("created_at", cutoff);

  if (!recentUserIds || recentUserIds.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: 0, users: [] });
  }

  const activeIds = [...new Set(recentUserIds.map((r) => r.user_id).filter(Boolean))] as string[];

  let query = supabase
    .from("users")
    .select("id, name, phone_number")
    .is("onboarding_step", null)
    .eq("messaging_opted_out", false)
    .is("plan_update_sent_at", null)
    .in("id", activeIds);

  if (userId) {
    query = query.eq("id", userId);
  }

  const { data: users, error } = await query;

  if (error) {
    console.error("[changelog] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: 0, users: [] });
  }

  console.log(`[changelog] ${dry_run ? "DRY RUN — " : ""}targeting ${users.length} users`);

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
      for (let i = 0; i < CHANGELOG_MESSAGES.length; i++) {
        await sendSMS(phone, CHANGELOG_MESSAGES[i]);
        await supabase.from("conversations").insert({
          user_id: user.id,
          role: "assistant",
          content: CHANGELOG_MESSAGES[i],
          message_type: "changelog",
        });
        if (i < CHANGELOG_MESSAGES.length - 1) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      await supabase
        .from("users")
        .update({ plan_update_sent_at: new Date().toISOString() })
        .eq("id", user.id);

      sent++;
      results.push({ id: user.id, name: user.name as string | null, status: "sent" });
      console.log(`[changelog] sent to ${user.id} (${user.name ?? "unnamed"})`);

      // Space between users to avoid rate limits
      if (sent < users.length) await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[changelog] failed for ${user.id}:`, err);
      skipped++;
      results.push({ id: user.id, name: user.name as string | null, status: "error" });
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, users: results });
}
