import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";

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
      onboarding_data: { intro_sent: true },
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
    "Hey, I'm Coach Dean — your AI running coach, working entirely over text.\n\nI help with a few things: training for a race (5K up to ultra), building a consistent running habit, coming back from injury and rebuilding safely, or just general coaching on pacing, nutrition, and gear.\n\nWhat's your name, and what's brought you here?";

  // Send welcome SMS and store in conversations.
  // Capture the chatId from Linq so read receipts and typing indicators work
  // from the very first reply — otherwise linq_chat_id stays null until the
  // first inbound webhook, which misses the first exchange.
  const [{ chatId }] = await Promise.all([
    sendSMS(phone, welcomeMessage),
    supabase.from("conversations").insert({
      user_id: user.id,
      role: "assistant",
      content: welcomeMessage,
      message_type: "coach_response",
    }),
  ]);

  if (chatId) {
    void supabase.from("users").update({ linq_chat_id: chatId }).eq("id", user.id);
  }

  return NextResponse.json({ ok: true });
}
