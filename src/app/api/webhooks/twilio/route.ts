import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/**
 * POST /api/webhooks/twilio
 * Receives inbound SMS from users via Twilio.
 */
export async function POST(request: Request) {
  const formData = await request.formData();
  const body = formData.get("Body") as string;
  const from = formData.get("From") as string;

  if (!body || !from) {
    return new NextResponse("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  }

  // Look up user by phone number
  const { data: user } = await supabase
    .from("users")
    .select("id, onboarding_step")
    .eq("phone_number", from)
    .single();

  if (!user) {
    console.warn(`Inbound SMS from unknown number: ${from}`);
    return new NextResponse("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
    });
  }

  // Store the inbound message
  await supabase.from("conversations").insert({
    user_id: user.id,
    role: "user",
    content: body,
    message_type: "user_message",
  });

  if (user.onboarding_step) {
    // Route to onboarding handler
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/onboarding/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        message: body,
      }),
    });
  } else {
    // Normal coaching flow
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        trigger: "user_message",
      }),
    });
  }

  // Return empty TwiML — we send the response via the API, not inline
  return new NextResponse("<Response></Response>", {
    headers: { "Content-Type": "text/xml" },
  });
}
