import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { Json } from "@/lib/database.types";

export async function POST(request: Request) {
  let body: { userId: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId } = body;
  if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 });

  const { data: user } = await supabase.from("users").select("id, onboarding_data").eq("id", userId).single();
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Remove Dean-generated training plans
  await supabase.from("training_plans").delete().eq("user_id", userId);

  // Clear uploaded plan context from onboarding_data
  const existingData = ((user.onboarding_data as Record<string, unknown>) || {});
  const { plan_context: _, plan_filename: __, has_existing_plan: ___, plan_uploaded: ____, ...restData } = existingData;
  await supabase.from("users").update({ onboarding_data: restData as unknown as Json }).eq("id", userId);

  // Reset plan-related fields in training_state
  await supabase.from("training_state").update({
    current_week: 1,
    weekly_mileage_target: null,
    weekly_long_run_miles: null,
    weekly_quality_session: null,
    weekly_plan_sessions: null,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);

  return NextResponse.json({ ok: true });
}
