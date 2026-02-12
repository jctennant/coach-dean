import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/twilio";

const E164_REGEX = /^\+1\d{10}$/;

export async function POST(request: Request) {
  const { phone } = await request.json();

  if (!phone || !E164_REGEX.test(phone)) {
    return NextResponse.json(
      { error: "Valid US phone number required" },
      { status: 400 }
    );
  }

  // Check if user already exists
  const { data: existing } = await supabase
    .from("users")
    .select("id, onboarding_step")
    .eq("phone_number", phone)
    .single();

  if (existing) {
    return NextResponse.json(
      { error: "This phone number is already signed up. Check your texts!" },
      { status: 409 }
    );
  }

  // Create user with onboarding step
  const { data: user, error } = await supabase
    .from("users")
    .insert({
      phone_number: phone,
      onboarding_step: "awaiting_goal",
    })
    .select("id")
    .single();

  if (error) {
    console.error("Error creating user:", error);
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }

  const welcomeMessage =
    "Hey! I'm Dean, your AI running coach. What are you training for? (e.g., half marathon in June, 10K, just getting in shape)";

  // Send welcome SMS and store in conversations
  await Promise.all([
    sendSMS(phone, welcomeMessage),
    supabase.from("conversations").insert({
      user_id: user.id,
      role: "assistant",
      content: welcomeMessage,
      message_type: "coach_response",
    }),
  ]);

  return NextResponse.json({ ok: true });
}
