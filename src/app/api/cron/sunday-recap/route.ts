import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

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

  // Fetch all users who have completed onboarding and haven't opted out
  const { data: users } = await supabase
    .from("users")
    .select("id")
    .is("onboarding_step", null)
    .not("phone_number", "is", null)
    .eq("messaging_opted_out", false);

  if (!users || users.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  let sent = 0;
  for (const user of users) {
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
