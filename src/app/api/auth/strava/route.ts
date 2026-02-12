import { NextResponse } from "next/server";

/**
 * GET /api/auth/strava
 * Initiates the Strava OAuth flow by redirecting to Strava's authorization page.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json(
      { error: "User ID is required" },
      { status: 400 }
    );
  }

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    response_type: "code",
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/callback`,
    scope: "read,activity:read_all",
    state: userId, // Pass user ID through OAuth state
  });

  return NextResponse.redirect(
    `https://www.strava.com/oauth/authorize?${params.toString()}`
  );
}
