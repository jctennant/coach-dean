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

  console.log("[linq-webhook] event:", event);
  console.log("[linq-webhook] headers present:", {
    signature: !!signature,
    timestamp: !!timestamp,
    event,
  });

  // Verify webhook signature
  if (process.env.LINQ_WEBHOOK_SECRET && signature && timestamp) {
    const secret = process.env.LINQ_WEBHOOK_SECRET;
    const message = `${timestamp}.${rawBody}`;

    // Try hex digest first, then base64
    const hexDigest = crypto
      .createHmac("sha256", secret)
      .update(message)
      .digest("hex");
    const base64Digest = crypto
      .createHmac("sha256", secret)
      .update(message)
      .digest("base64");

    if (signature !== hexDigest && signature !== base64Digest) {
      console.warn("[linq-webhook] signature mismatch", {
        received: signature,
        expectedHex: hexDigest,
        expectedBase64: base64Digest,
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    console.log("[linq-webhook] signature verified");
  }

  // Only process inbound messages
  if (event !== "message.received") {
    console.log("[linq-webhook] ignoring event:", event);
    return NextResponse.json({ ok: true });
  }

  const payload = JSON.parse(rawBody);
  console.log("[linq-webhook] payload keys:", Object.keys(payload));
  console.log("[linq-webhook] full payload:", JSON.stringify(payload, null, 2));

  // Extract sender phone and message text from the payload.
  // Supports both v2025-01-01 and v2026-02-03 payload formats.
  const senderPhone =
    payload.sender_handle || payload.from_handle || null;
  const parts = payload.message?.parts || payload.parts || [];
  const textPart = parts.find(
    (p: { type: string; value?: string }) => p.type === "text"
  );
  const body = textPart?.value || "";

  console.log("[linq-webhook] parsed:", { senderPhone, body, partsCount: parts.length });

  if (!body || !senderPhone) {
    console.warn("[linq-webhook] missing body or senderPhone, skipping");
    return NextResponse.json({ ok: true });
  }

  // Look up user by phone number
  const { data: user } = await supabase
    .from("users")
    .select("id, onboarding_step")
    .eq("phone_number", senderPhone)
    .single();

  if (!user) {
    console.log("[linq-webhook] new user, creating:", senderPhone);

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
      console.error("[linq-webhook] error creating user:", error);
      return NextResponse.json({ ok: true });
    }

    const welcomeMessage =
      "Hey! I'm Dean, your AI running coach. What are you training for? (e.g., half marathon in June, 10K, just getting in shape)";

    console.log("[linq-webhook] sending welcome SMS to:", senderPhone);

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

    console.log("[linq-webhook] welcome flow completed for:", senderPhone);
    return NextResponse.json({ ok: true });
  }

  console.log("[linq-webhook] existing user:", user.id, "step:", user.onboarding_step);

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
