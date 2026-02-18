import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import crypto from "crypto";

/**
 * POST /api/webhooks/linq
 * Receives inbound messages and events from Linq.
 * Webhook signature verified via HMAC-SHA256.
 * Returns 200 immediately, processes message asynchronously via after().
 */
export async function POST(request: Request) {
  const signature = request.headers.get("x-webhook-signature");
  const timestamp = request.headers.get("x-webhook-timestamp");
  const event = request.headers.get("x-webhook-event");

  const rawBody = await request.text();

  console.log("[linq-webhook] event:", event);

  // Verify webhook signature
  if (process.env.LINQ_WEBHOOK_SECRET && signature && timestamp) {
    const secret = process.env.LINQ_WEBHOOK_SECRET;
    const message = `${timestamp}.${rawBody}`;

    const hexDigest = crypto
      .createHmac("sha256", secret)
      .update(message)
      .digest("hex");
    const base64Digest = crypto
      .createHmac("sha256", secret)
      .update(message)
      .digest("base64");

    if (signature !== hexDigest && signature !== base64Digest) {
      console.warn("[linq-webhook] signature mismatch");
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

  // Extract sender phone and message text from the payload.
  // Webhook v2026-02-03: data is nested under payload.data
  const data = payload.data || payload;
  const messageId: string | null = data.id || null;
  const senderPhone =
    data.sender_handle?.handle || data.from_handle?.handle ||
    data.sender_handle || data.from_handle || null;
  const parts = data.parts || data.message?.parts || [];
  const textPart = parts.find(
    (p: { type: string; value?: string }) => p.type === "text"
  );
  const body = textPart?.value?.trim() || "";

  console.log("[linq-webhook] parsed:", { senderPhone, body: body.slice(0, 50), messageId });

  if (!body || !senderPhone) {
    console.warn("[linq-webhook] missing body or senderPhone, skipping");
    return NextResponse.json({ ok: true });
  }

  // Return 200 immediately, process in background
  after(async () => {
    try {
      await handleInboundMessage(senderPhone, body, messageId);
    } catch (err) {
      console.error("[linq-webhook] async processing error:", err);
    }
  });

  return NextResponse.json({ ok: true });
}

async function handleInboundMessage(
  senderPhone: string,
  body: string,
  messageId: string | null
) {
  // Deduplicate by external message ID
  if (messageId) {
    const { data: existing } = await supabase
      .from("conversations")
      .select("id")
      .eq("external_message_id", messageId)
      .limit(1)
      .maybeSingle();

    if (existing) {
      console.log("[linq-webhook] duplicate message, skipping:", messageId);
      return;
    }
  }

  // Look up user by phone number
  const { data: user } = await supabase
    .from("users")
    .select("id, onboarding_step")
    .eq("phone_number", senderPhone)
    .single();

  if (!user) {
    console.log("[linq-webhook] new user, creating:", senderPhone);

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
      return;
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
          external_message_id: messageId,
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
    return;
  }

  console.log("[linq-webhook] existing user:", user.id, "step:", user.onboarding_step);

  // Store the inbound message
  await supabase.from("conversations").insert({
    user_id: user.id,
    role: "user",
    content: body,
    message_type: "user_message",
    external_message_id: messageId,
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
}
