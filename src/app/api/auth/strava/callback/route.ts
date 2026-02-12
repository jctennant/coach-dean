import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/twilio";

/**
 * GET /api/auth/strava/callback
 * Handles the OAuth callback from Strava. Exchanges the code for tokens,
 * updates the user, advances onboarding, and redirects to confirmation page.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const userId = searchParams.get("state"); // User ID passed via OAuth state

  if (!code || !userId) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=missing_params`
    );
  }

  // Exchange authorization code for tokens
  const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=token_exchange_failed`
    );
  }

  const tokenData = await tokenResponse.json();
  const { access_token, refresh_token, expires_at, athlete } = tokenData;

  // Update user with Strava tokens
  const { data: user, error } = await supabase
    .from("users")
    .update({
      strava_athlete_id: athlete.id,
      strava_access_token: access_token,
      strava_refresh_token: refresh_token,
      strava_token_expires_at: new Date(expires_at * 1000).toISOString(),
      name: athlete.firstname || athlete.username || null,
      onboarding_step: "awaiting_schedule",
    })
    .eq("id", userId)
    .select("id, phone_number, name")
    .single();

  if (error || !user) {
    console.error("Error updating user with Strava tokens:", error);
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}?error=db_error`
    );
  }

  // Send SMS asking about training schedule
  const scheduleMsg = `Strava connected — nice! Last question: which days of the week work best for running? (e.g., Tue, Thu, Sat, Sun)`;

  await Promise.all([
    sendSMS(user.phone_number, scheduleMsg),
    supabase.from("conversations").insert({
      user_id: user.id,
      role: "assistant",
      content: scheduleMsg,
      message_type: "coach_response",
    }),
  ]);

  // Redirect browser to confirmation page
  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL}/strava-connected`
  );
}
