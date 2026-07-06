import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * POST /api/admin/test-user
 *
 * Creates a throwaway test user with a generated placeholder phone number.
 * Returns { userId, phone } so the caller can open /chat?userId=<uuid>.
 * Protected by ADMIN_SECRET.
 */
export async function POST(request: Request) {
  const { secret } = await request.json().catch(() => ({}));

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Generate a unique placeholder phone so the unique constraint doesn't collide
  // across test sessions. Format: +1555XXXXXXX (555 numbers are reserved/unroutable).
  const suffix = Date.now().toString().slice(-7);
  const phone = `+1555${suffix}`;

  const { data: user, error } = await supabase
    .from("users")
    .insert({
      phone_number: phone,
      onboarding_step: "onboarding",
      onboarding_data: {},
      timezone: "America/New_York",
    })
    .select("id")
    .single();

  if (error || !user) {
    console.error("[test-user] insert failed:", error);
    return NextResponse.json({ error: "Failed to create test user" }, { status: 500 });
  }

  return NextResponse.json({ userId: user.id, phone });
}
