import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendSMS } from "@/lib/linq";
import crypto from "crypto";

// Allow up to 30s so the 10s debounce sleep fits within the function timeout
export const maxDuration = 30;

/**
 * POST /api/webhooks/linq
 * Receives inbound messages and events from Linq.
 * Webhook signature verified via HMAC-SHA256.
 * Returns 200 immediately, processes message asynchronously via after().
 *
 * Coaching messages are debounced: if a second message arrives within 10 seconds
 * of the first, only the last one triggers a response. Onboarding messages are
 * processed immediately (each step expects exactly one reply).
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

    // Store the inbound message, then route to onboarding/handle so handleGoal
    // can detect a goal in the first message (e.g. "Hi Dean! half marathon June").
    await supabase.from("conversations").insert({
      user_id: newUser.id,
      role: "user",
      content: body,
      message_type: "user_message",
      external_message_id: messageId,
    });

    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/onboarding/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: newUser.id, message: body }),
    });

    console.log("[linq-webhook] new user routed to onboarding/handle:", senderPhone);
    return;
  }

  console.log("[linq-webhook] existing user:", user.id, "step:", user.onboarding_step);

  // Store the inbound message and capture its ID for debounce comparison
  const { data: storedMsg } = await supabase
    .from("conversations")
    .insert({
      user_id: user.id,
      role: "user",
      content: body,
      message_type: "user_message",
      external_message_id: messageId,
    })
    .select("id")
    .single();

  if (user.onboarding_step) {
    // Onboarding: no debounce — each step expects exactly one reply
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/onboarding/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, message: body }),
    });
    return;
  }

  // Coaching flow: debounce 10 seconds so rapid multi-part messages are batched
  console.log("[linq-webhook] debounce: waiting 10s for user", user.id);
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  // After the wait, check if a newer user message has arrived
  const { data: latestMsg } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", user.id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!latestMsg || latestMsg.id !== storedMsg?.id) {
    console.log("[linq-webhook] debounce: newer message arrived, skipping response for", storedMsg?.id);
    return;
  }

  console.log("[linq-webhook] debounce: firing response for", user.id);
  await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id, trigger: "user_message" }),
  });
}
