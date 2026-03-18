import { NextResponse } from "next/server";

/**
 * POST /api/admin/trigger
 *
 * Manually fire a coach/respond trigger for a specific user.
 * Protected by ADMIN_SECRET env var.
 *
 * Body: { secret: string, userId: string, trigger?: string }
 * trigger defaults to "initial_plan"
 */
export async function POST(request: Request) {
  const { secret, userId, trigger = "initial_plan", dry_run = false, force_confetti = false } = await request.json();

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL not set" }, { status: 500 });
  }

  console.log(`[admin/trigger] firing trigger="${trigger}" for userId=${userId}${force_confetti ? " (force_confetti)" : ""}`);

  const res = await fetch(`${appUrl}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, trigger, dry_run, force_confetti }),
  });

  const body = await res.json().catch(() => ({}));
  return NextResponse.json({ ok: res.ok, status: res.status, body });
}
