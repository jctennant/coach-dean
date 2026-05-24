import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { trackEvent } from "@/lib/track";

export const maxDuration = 60;

const WINDOW_MAX_MINUTES = 90; // look back this far for missed messages
const WINDOW_MIN_MINUTES = 3;  // ignore very recent messages (still processing)

/**
 * GET /api/cron/missed-messages
 * Safety net for unanswered user messages. Runs every 30 minutes.
 *
 * When coach/respond crashes inside after() the user gets no reply. This cron
 * catches that: finds user_message rows from the 3–90 min window with no
 * subsequent assistant reply, and re-fires coach/respond for each affected user.
 *
 * Skips: onboarding users (different flow), opted-out users, and users whose
 * last message was a plain acknowledgment that doesn't need a reply ("thanks!",
 * "ok", etc.) — those are let through anyway since coach/respond handles them.
 *
 * Set up on cron-job.org to hit GET /api/cron/missed-messages every 30 minutes.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const windowMax = new Date(now.getTime() - WINDOW_MAX_MINUTES * 60 * 1000).toISOString();
  const windowMin = new Date(now.getTime() - WINDOW_MIN_MINUTES * 60 * 1000).toISOString();

  // Fetch all user messages in the 3–90 min window from fully-onboarded, active users
  const { data: candidates, error } = await supabase
    .from("conversations")
    .select("user_id, created_at")
    .eq("message_type", "user_message")
    .gte("created_at", windowMax)
    .lte("created_at", windowMin)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[missed-messages] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, retried: 0 });
  }

  // Deduplicate — only check each user once (their most recent message in the window)
  const latestByUser = new Map<string, string>();
  for (const row of candidates) {
    if (!latestByUser.has(row.user_id) && row.created_at) {
      latestByUser.set(row.user_id, row.created_at as string);
    }
  }

  const userIds = Array.from(latestByUser.keys());

  // Fetch user state: onboarding_step, opted_out
  const { data: users } = await supabase
    .from("users")
    .select("id, phone_number, onboarding_step, messaging_opted_out, linq_chat_id")
    .in("id", userIds)
    .is("onboarding_step", null)           // fully onboarded only
    .eq("messaging_opted_out", false);

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, retried: 0 });
  }

  const eligibleIds = new Set(users.map((u) => u.id));

  // For each eligible user, check whether an assistant reply exists after their message
  let retried = 0;
  const retriedUsers: string[] = [];

  for (const user of users) {
    if (!eligibleIds.has(user.id)) continue;

    const lastUserMsgAt = latestByUser.get(user.id)!;

    const { data: replyRows } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "assistant")
      .gt("created_at", lastUserMsgAt)
      .limit(1)
      .maybeSingle();

    if (replyRows) continue; // already got a reply

    // No reply found — re-fire coach/respond
    console.log(`[missed-messages] re-firing for user ${user.id} (last msg: ${lastUserMsgAt})`);
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
      const resp = await fetch(`${appUrl}/api/coach/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          trigger: "user_message",
          ...(user.linq_chat_id ? { chatId: user.linq_chat_id } : {}),
        }),
      });
      if (resp.ok) {
        retried++;
        retriedUsers.push(user.id);
        void trackEvent(user.id, "missed_message_recovered");
      } else {
        console.warn(`[missed-messages] coach/respond returned ${resp.status} for user ${user.id}`);
      }
    } catch (err) {
      console.error(`[missed-messages] fetch failed for user ${user.id}:`, err);
    }
  }

  console.log(`[missed-messages] done — retried ${retried}/${users.length} users`);
  return NextResponse.json({ ok: true, retried, users: retriedUsers });
}
