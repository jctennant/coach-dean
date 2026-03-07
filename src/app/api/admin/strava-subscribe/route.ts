import { NextResponse } from "next/server";

/**
 * POST /api/admin/strava-subscribe
 *
 * Registers (or re-registers) the Strava webhook subscription.
 * Only needs to be called once per environment.
 * Protected by ADMIN_SECRET.
 *
 * Strava docs: https://developers.strava.com/docs/webhooks/
 */
export async function POST(request: Request) {
  const { secret } = await request.json();

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/strava`;
  const verifyToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;

  if (!verifyToken) {
    return NextResponse.json({ error: "STRAVA_WEBHOOK_VERIFY_TOKEN not set" }, { status: 500 });
  }

  const res = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: verifyToken,
    }),
  });

  const body = await res.json().catch(() => ({}));
  console.log("[admin/strava-subscribe] Strava response:", res.status, body);

  if (!res.ok) {
    return NextResponse.json({ error: "Strava API error", detail: body }, { status: 500 });
  }

  return NextResponse.json({ ok: true, subscription: body });
}

/**
 * GET /api/admin/strava-subscribe
 * View the current Strava webhook subscription.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("secret") !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(
    `https://www.strava.com/api/v3/push_subscriptions?client_id=${process.env.STRAVA_CLIENT_ID}&client_secret=${process.env.STRAVA_CLIENT_SECRET}`
  );

  const body = await res.json().catch(() => ({}));
  return NextResponse.json({ subscriptions: body });
}
