import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/chat/last-message?userId=<uuid>
 *
 * Returns the most recent assistant message and current onboarding_step
 * for a user. Used by the dev chat UI after calling onboarding/handle
 * (which returns { ok: true } without the message text).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("userId");

  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const [{ data: msg }, { data: user }] = await Promise.all([
    supabase
      .from("conversations")
      .select("content")
      .eq("user_id", userId)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("users")
      .select("onboarding_step")
      .eq("id", userId)
      .single(),
  ]);

  return NextResponse.json({
    message: msg?.content ?? null,
    onboarding_step: (user?.onboarding_step as string | null) ?? null,
  });
}
