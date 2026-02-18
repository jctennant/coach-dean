import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import crypto from "crypto";

/**
 * POST /api/webhooks/linq
 * Receives inbound messages and events from Linq.
 * Webhook signature verified via HMAC-SHA256.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("x-webhook-signature");
  const timestamp = request.headers.get("x-webhook-timestamp");
  const event = request.headers.get("x-webhook-event");

  const rawBody = await request.text();

  // Verify webhook signature
  if (process.env.LINQ_WEBHOOK_SECRET && signature && timestamp) {
    const expected = crypto
      .createHmac("sha256", process.env.LINQ_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    if (signature !== expected) {
      console.warn("Linq webhook signature mismatch");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  // Only process inbound messages
  if (event !== "message.received") {
    return NextResponse.json({ ok: true });
  }

  const payload = JSON.parse(rawBody);

  // Extract sender phone and message text from the payload.
  // Supports both v2025-01-01 and v2026-02-03 payload formats.
  const senderPhone =
    payload.sender_handle || payload.from_handle || null;
  const parts = payload.message?.parts || payload.parts || [];
  const textPart = parts.find(
    (p: { type: string; value?: string }) => p.type === "text"
  );
  const body = textPart?.value || "";

  if (!body || !senderPhone) {
    return NextResponse.json({ ok: true });
  }

  // Look up user by phone number
  const { data: user } = await supabase
    .from("users")
    .select("id, onboarding_step")
    .eq("phone_number", senderPhone)
    .single();

  if (!user) {
    // New user — auto-create and start onboarding
    const { data: newUser, error } = await supabase
      .from("users")
      .insert({
        phone_number: senderPhone,
        onboarding_step: "awaiting_goal",
      })
      .select("id")
      .single();

    if (error || !newUser) {
      console.error("Error creating user from inbound SMS:", error);
      return NextResponse.json({ ok: true });
    }

    const welcomeMessage =
      "Hey! I'm Dean, your AI running coach. What are you training for? (e.g., half marathon in June, 10K, just getting in shape)";

    await Promise.all([
      sendSMS(senderPhone, welcomeMessage),
      supabase.from("conversations").insert([
        {
          user_id: newUser.id,
          role: "user",
          content: body,
          message_type: "user_message",
        },
        {
          user_id: newUser.id,
          role: "assistant",
          content: welcomeMessage,
          message_type: "coach_response",
        },
      ]),
    ]);

    return NextResponse.json({ ok: true });
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

  return NextResponse.json({ ok: true });
}
