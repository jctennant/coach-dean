import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import { generateAndSaveFullPlan } from "@/lib/training-plan";

/**
 * POST /api/dashboard/request-link
 * Accepts a phone number, finds the matching user, ensures they have a
 * dashboard_token, and texts them their plan link.
 */
export async function POST(request: Request) {
  const { phone } = await request.json();
  if (!phone || typeof phone !== "string") {
    return NextResponse.json({ error: "Phone number required" }, { status: 400 });
  }

  // Normalize: strip non-digits, then format as +1XXXXXXXXXX for US
  const digits = phone.replace(/\D/g, "");
  // Try both with and without country code
  const candidates = [
    digits,
    digits.length === 10 ? `+1${digits}` : null,
    digits.startsWith("1") && digits.length === 11 ? `+${digits}` : null,
  ].filter(Boolean) as string[];

  let userData: { id: string; dashboard_token: string | null; phone_number: string } | null = null;

  for (const candidate of candidates) {
    const { data } = await supabase
      .from("users")
      .select("id, dashboard_token, phone_number")
      .eq("phone_number", candidate)
      .is("onboarding_step", null) // only fully onboarded users
      .single();
    if (data) {
      userData = data;
      break;
    }
  }

  if (!userData) {
    return NextResponse.json({ error: "No account found" }, { status: 404 });
  }

  // Check whether a training plan exists yet for this user
  const { data: existingPlan } = await supabase
    .from("training_plans")
    .select("id")
    .eq("user_id", userData.id)
    .limit(1)
    .single();

  if (!existingPlan) {
    // Existing user with no plan — backfill silently (no week-1 SMS, just generate the arc)
    const { data: profileData } = await supabase
      .from("training_profiles")
      .select("goal, race_date, current_easy_pace, days_per_week, fitness_level")
      .eq("user_id", userData.id)
      .single();
    const { data: stateData } = await supabase
      .from("training_state")
      .select("weekly_mileage_target")
      .eq("user_id", userData.id)
      .single();

    const avgMileage = (stateData?.weekly_mileage_target as number | null) ?? null;
    // generateAndSaveFullPlan sets a new dashboard_token, so no need to handle it separately
    await generateAndSaveFullPlan(
      userData.id,
      userData.phone_number,
      profileData as Record<string, unknown> | null,
      avgMileage,
      { skipLinkSms: true },
    );

    // Re-fetch the newly saved token
    const { data: refreshed } = await supabase
      .from("users")
      .select("dashboard_token")
      .eq("id", userData.id)
      .single();
    const token = refreshed?.dashboard_token;
    if (!token) return NextResponse.json({ error: "Plan generation failed" }, { status: 500 });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
    const planUrl = `${appUrl}/dashboard?token=${token}`;
    try {
      await sendSMS(userData.phone_number, `Here's your Coach Dean training plan: ${planUrl}`);
    } catch (err) {
      console.error("[dashboard/request-link] SMS failed:", err);
      return NextResponse.json({ error: "Failed to send SMS" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // Plan already exists — ensure token is set and just (re)send the link
  let token = userData.dashboard_token;
  if (!token) {
    token = crypto.randomUUID();
    await supabase.from("users").update({ dashboard_token: token }).eq("id", userData.id);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
  const planUrl = `${appUrl}/dashboard?token=${token}`;

  try {
    await sendSMS(userData.phone_number, `Here's your Coach Dean training plan: ${planUrl}`);
  } catch (err) {
    console.error("[dashboard/request-link] SMS failed:", err);
    return NextResponse.json({ error: "Failed to send SMS" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
