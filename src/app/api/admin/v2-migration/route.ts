/**
 * POST /api/admin/v2-migration
 *
 * One-time migration message for existing users transitioning to Dean v2.0.
 *
 * Targets users who:
 *   - Completed onboarding (onboarding_step IS NULL)
 *   - Have Strava connected (active users logging runs)
 *   - Haven't received this message yet (v2_migration_sent_at IS NULL)
 *   - Haven't opted out of messaging
 *
 * Body:
 *   secret   string   — must match ADMIN_SECRET
 *   dry_run  boolean  — if true, returns user list and messages without sending
 *   userId   string   — optional: send only to this one user (for testing)
 *
 * Returns:
 *   { ok: true, sent: number, skipped: number, users: [{ id, name, phone }] }
 *
 * Safe to call multiple times — v2_migration_sent_at prevents double-sends.
 */

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { insertConversation } from "@/lib/conversations";
import { sendSMS } from "@/lib/linq";

export const maxDuration = 120;

const MIGRATION_MESSAGE = `Hey — quick heads up on a Dean update.

I've been focused on plan generation and daily workout reminders. Starting now I'm shifting to deeper analysis: after every run I'll break down effort, conditions, and what it means for your training. Sunday recaps continue as usual.

The morning and nightly reminder texts are stopping — they were tied to the plan format and most of you weren't finding them useful. Post-run debriefs and weekly recaps are the core now.

Nothing changes on your end. Text me anytime.`;

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

  // Build query — optionally scoped to a single user for testing
  let query = supabase
    .from("users")
    .select("id, name, phone_number")
    .is("onboarding_step", null)
    .eq("messaging_opted_out", false)
    .not("strava_access_token", "is", null)
    .is("v2_migration_sent_at", null);

  if (userId) {
    query = query.eq("id", userId);
  }

  const { data: users, error } = await query;

  if (error) {
    console.error("[v2-migration] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, skipped: 0, users: [] });
  }

  console.log(`[v2-migration] ${dry_run ? "DRY RUN — " : ""}targeting ${users.length} users`);

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
      await sendSMS(phone, MIGRATION_MESSAGE);

      // Store in conversations for history
      await insertConversation({
        user_id: user.id,
        role: "assistant",
        content: MIGRATION_MESSAGE,
        message_type: "v2_migration",
      });

      // Mark as sent
      await supabase
        .from("users")
        .update({ v2_migration_sent_at: new Date().toISOString() })
        .eq("id", user.id);

      sent++;
      results.push({ id: user.id, name: user.name as string | null, status: "sent" });
      console.log(`[v2-migration] sent to ${user.id} (${user.name ?? "unnamed"})`);

      // Space sends 2 seconds apart to avoid rate limits
      if (sent < users.length) await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[v2-migration] failed for ${user.id}:`, err);
      skipped++;
      results.push({ id: user.id, name: user.name as string | null, status: "error" });
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, users: results });
}
