import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { trackEvent } from "@/lib/track";
import { getRestrictedPhones } from "@/lib/admin-restrict";

export const maxDuration = 60;

const WINDOW_MAX_MINUTES = 90; // look back this far for missed messages
const WINDOW_MIN_MINUTES = 3;  // ignore very recent messages (still processing)

// Onboarding steps where an unanswered inbound message means the athlete is stranded.
// awaiting_payment is excluded: its handler re-sends a canned checkout link, so re-firing
// it would just repeat a message the athlete already chose not to act on.
const RECOVERABLE_ONBOARDING_STEPS = new Set(["onboarding", "awaiting_strava", "awaiting_timezone"]);

// How recently an account must have been created for a missing plan to be treated as a
// failed initial_plan rather than normal state. Accounts predating training_plans rows
// legitimately have none, and must never be re-fired at.
const MISSING_PLAN_MAX_ACCOUNT_AGE_DAYS = 7;

/**
 * GET /api/cron/missed-messages
 * Safety net for unanswered user messages. Runs every 30 minutes.
 *
 * When a handler crashes inside after() — or anywhere between storing the inbound message
 * and sending a reply — the user gets no reply at all. This cron catches that: finds
 * user_message rows from the 3–90 min window with no subsequent assistant reply, and
 * re-dispatches the right handler for each affected user.
 *
 * Routing depends on where the user is:
 *   - onboarding_step IS NULL          → coach/respond (trigger: user_message)
 *   - onboarding_step is recoverable   → onboarding/handle (retry: true), replaying the
 *                                        original message body so the stage handler
 *                                        re-runs the turn that failed
 *
 * Onboarding coverage was added 2026-08-04: every stranded-athlete bug in onboarding
 * ("Dean left me hanging") shares the shape this cron already recovers from post-onboarding,
 * but onboarding users were filtered out, so their only backstop was the reengagement cron
 * two days later. `retry: true` tells onboarding/handle to skip content dedup (the inbound
 * row is minutes old and would otherwise read as evidence the turn was handled) and to not
 * insert the inbound row a second time.
 *
 * Skips: opted-out users, and users whose last message was a plain acknowledgment that
 * doesn't need a reply ("thanks!", "ok", etc.) — those are let through anyway since the
 * handlers deal with them.
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

  // Fetch all user messages in the 3–90 min window from active users
  const { data: candidates, error } = await supabase
    .from("conversations")
    .select("user_id, created_at, content")
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
  const latestByUser = new Map<string, { at: string; content: string }>();
  for (const row of candidates) {
    if (!latestByUser.has(row.user_id) && row.created_at) {
      latestByUser.set(row.user_id, {
        at: row.created_at as string,
        content: (row.content as string | null) ?? "",
      });
    }
  }

  const userIds = Array.from(latestByUser.keys());

  // Fetch user state: onboarding_step, opted_out. Onboarding users are included now —
  // they're routed to onboarding/handle below instead of coach/respond.
  let usersQuery = supabase
    .from("users")
    .select("id, phone_number, onboarding_step, messaging_opted_out, linq_chat_id, created_at")
    .in("id", userIds)
    .eq("messaging_opted_out", false);

  const restrictedPhones = getRestrictedPhones();
  if (restrictedPhones) usersQuery = usersQuery.in("phone_number", restrictedPhones);

  const { data: users } = await usersQuery;

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, retried: 0 });
  }

  const eligibleIds = new Set(users.map((u) => u.id));

  // For each eligible user, check whether an assistant reply exists after their message
  let retried = 0;
  const retriedUsers: string[] = [];

  for (const user of users) {
    if (!eligibleIds.has(user.id)) continue;

    const step = user.onboarding_step as string | null;
    const isOnboarding = step !== null;
    if (isOnboarding && !RECOVERABLE_ONBOARDING_STEPS.has(step)) continue;

    const { at: lastUserMsgAt, content: lastUserMsg } = latestByUser.get(user.id)!;

    const { data: replyRows } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "assistant")
      .gt("created_at", lastUserMsgAt)
      .limit(1)
      .maybeSingle();

    if (replyRows) continue; // already got a reply

    // An onboarding turn can only be replayed if we still have the message body to
    // replay — the stage handlers are driven by the inbound text, unlike coach/respond
    // which re-reads state.
    if (isOnboarding && !lastUserMsg) continue;

    // A just-onboarded athlete whose plan never arrived needs initial_plan, not a chat reply.
    //
    // completeOnboarding fires initial_plan through runAfter → fetch(coach/respond), and
    // coach/respond returns 200 immediately and does all its work inside its own runAfter —
    // so the fetch succeeding proves nothing about whether a plan was generated or sent.
    // Anything that throws in there is logged and Sentry'd, onboarding_step is already null,
    // and the athlete just gets silence (handleScheduleConfirm sends no message of its own,
    // so their last exchange is the schedule answer). Without this branch the athlete was
    // still recovered — but as trigger: "user_message", which un-hangs them with a
    // conversational reply while leaving them with no plan and Dean reading empty state.
    let recoveryTrigger: "user_message" | "initial_plan" = "user_message";
    if (!isOnboarding) {
      const accountAgeDays = user.created_at
        ? (now.getTime() - new Date(user.created_at as string).getTime()) / (1000 * 60 * 60 * 24)
        : Infinity;
      if (accountAgeDays <= MISSING_PLAN_MAX_ACCOUNT_AGE_DAYS) {
        const [{ data: planRow }, { data: planMsg }] = await Promise.all([
          supabase.from("training_plans").select("id").eq("user_id", user.id).limit(1).maybeSingle(),
          supabase
            .from("conversations")
            .select("id")
            .eq("user_id", user.id)
            .eq("message_type", "initial_plan")
            .limit(1)
            .maybeSingle(),
        ]);
        // Neither the stored arc nor any delivered plan message exists — initial_plan
        // never completed. Both are checked because they fail independently: the arc can
        // be written and the SMS still die, or vice versa.
        if (!planRow && !planMsg) {
          recoveryTrigger = "initial_plan";
          console.warn(`[missed-messages] user ${user.id} is onboarded with no plan — re-firing initial_plan`);
          void trackEvent(user.id, "initial_plan_missing_recovered", {});
        }
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    const target = isOnboarding
      ? {
          url: `${appUrl}/api/onboarding/handle`,
          body: {
            userId: user.id,
            message: lastUserMsg,
            retry: true,
            ...(user.linq_chat_id ? { chatId: user.linq_chat_id } : {}),
          },
        }
      : {
          url: `${appUrl}/api/coach/respond`,
          body: {
            userId: user.id,
            trigger: recoveryTrigger,
            ...(user.linq_chat_id ? { chatId: user.linq_chat_id } : {}),
          },
        };

    console.log(
      `[missed-messages] re-firing ${isOnboarding ? `onboarding/handle (step: ${step})` : `coach/respond (${recoveryTrigger})`} for user ${user.id} (last msg: ${lastUserMsgAt})`
    );
    try {
      const resp = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.body),
      });
      if (resp.ok) {
        retried++;
        retriedUsers.push(user.id);
        void trackEvent(user.id, "missed_message_recovered", {
          ...(isOnboarding ? { onboarding_step: step } : {}),
        });
      } else {
        console.warn(`[missed-messages] ${target.url} returned ${resp.status} for user ${user.id}`);
      }
    } catch (err) {
      console.error(`[missed-messages] fetch failed for user ${user.id}:`, err);
    }
  }

  console.log(`[missed-messages] done — retried ${retried}/${users.length} users`);
  return NextResponse.json({ ok: true, retried, users: retriedUsers });
}
