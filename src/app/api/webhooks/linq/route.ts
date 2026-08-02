import { NextResponse } from "next/server";
import { runAfter } from "@/lib/safe-after";
import { supabase } from "@/lib/supabase";
import { insertConversation, insertConversationReturningId } from "@/lib/conversations";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping } from "@/lib/linq";
import { inferTimezoneFromPhone } from "@/lib/timezone";
import { trackEvent } from "@/lib/track";
import type { Json } from "@/lib/database.types";
import crypto from "crypto";
import { Resend } from "resend";

// 120s: UPDATE PLAN rebuild takes 30-60s (Haiku enrichment); image path takes up to 60s
export const maxDuration = 120;

/**
 * POST /api/webhooks/linq
 * Receives inbound messages and events from Linq.
 * Webhook signature verified via HMAC-SHA256.
 * Returns 200 immediately, processes message asynchronously via after().
 *
 * Coaching messages are debounced: if a second message arrives within 10 seconds
 * of the first, only the last one triggers a response. Onboarding messages are
 * processed immediately (each step expects exactly one reply).
 *
 * Image messages (MMS) bypass the text pipeline and go through workout extraction.
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

  // Extract sender phone and message parts from the payload.
  // Webhook v2026-02-03: data is nested under payload.data
  const data = payload.data || payload;
  const messageId: string | null = data.id || null;
  // Try common field names for the chat ID. Log always so we can confirm the
  // real field name against actual payloads.
  const payloadChatId: string | null =
    data.chat_id ?? data.chatId ?? data.chat?.id ?? data.conversation_id ?? data.id ?? null;
  console.log("[linq-webhook] chatId from payload:", payloadChatId, "| top-level keys:", Object.keys(data || {}));
  const senderPhone =
    data.sender_handle?.handle || data.from_handle?.handle ||
    data.sender_handle || data.from_handle || null;
  const parts = data.parts || data.message?.parts || [];

  const textPart = parts.find(
    (p: { type: string; value?: string }) => p.type === "text"
  );
  // Decode URL-encoded characters that some SMS deep-link openers pass through
  // literally (e.g. "Hi%20Dean!" when the sms: URI body param isn't decoded by the OS).
  const rawBodyText = textPart?.value?.trim() || "";
  let body: string;
  try {
    body = decodeURIComponent(rawBodyText);
  } catch {
    body = rawBodyText; // malformed percent-sequence — use as-is
  }

  // Detect PDF parts first — Linq delivers these as type "media" with mime_type "application/pdf".
  const pdfPart = parts.find(
    (p: { type: string; mime_type?: string }) =>
      (p.type === "media" || p.type === "file") && p.mime_type === "application/pdf"
  );
  const pdfUrl: string | null = pdfPart ? (pdfPart.url || pdfPart.value || null) : null;
  const pdfFilename: string | null = pdfPart ? (pdfPart.filename || null) : null;

  // Detect image/media parts — excluding PDFs handled above.
  // Linq may use type "image", "media", or "mms".
  // Value may be in p.value, p.url, or p.media_url — try all three.
  const imagePart = parts.find(
    (p: { type: string; mime_type?: string }) =>
      (p.type === "image" || p.type === "media" || p.type === "mms") && p.mime_type !== "application/pdf"
  );
  const imageUrl: string | null = imagePart
    ? (imagePart.value || imagePart.url || imagePart.media_url || null)
    : null;

  // Log the full parts array whenever a non-text part is present so we can
  // verify the field names against real Linq MMS payloads.
  if (imagePart || pdfPart || (!body && parts.length > 0)) {
    console.log("[linq-webhook] non-text parts detected:", JSON.stringify(parts));
  }

  console.log("[linq-webhook] parsed:", {
    senderPhone,
    body: body.slice(0, 50),
    messageId,
    hasImage: !!imageUrl,
    hasPdf: !!pdfUrl,
  });

  if (!senderPhone) {
    console.warn("[linq-webhook] missing senderPhone, skipping");
    return NextResponse.json({ ok: true });
  }

  // Reject short codes, alphanumeric senders, and anything that isn't a
  // standard E.164 phone number or email address. Linq delivers these as
  // inbound messages but we can't reply to them, so processing would just
  // produce errors. Emails are allowed because iMessage users may appear with
  // their Apple ID email as the sender handle.
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderPhone);
  const isPhone = /^\+?[\d\s\-().]{7,}$/.test(senderPhone) && senderPhone.replace(/\D/g, "").length >= 7;
  if (!isEmail && !isPhone) {
    console.warn("[linq-webhook] non-E164/non-email sender, skipping:", senderPhone);
    return NextResponse.json({ ok: true });
  }

  if (!body && !imageUrl && !pdfUrl) {
    console.warn("[linq-webhook] no text, image, or PDF found in message, skipping");
    return NextResponse.json({ ok: true });
  }

  // Deduplicate by external message ID *before* entering after() — two identical
  // webhook deliveries arriving within milliseconds of each other would both pass
  // an async check since neither has inserted a conversation row yet. Checking
  // synchronously here means only the first one proceeds.
  if (messageId) {
    const { data: existing } = await supabase
      .from("conversations")
      .select("id")
      .eq("external_message_id", messageId)
      .limit(1)
      .maybeSingle();

    if (existing) {
      console.log("[linq-webhook] duplicate message (pre-after), skipping:", messageId);
      return NextResponse.json({ ok: true });
    }
  }

  // Return 200 immediately, process in background
  runAfter("linq-webhook", async () => {
    try {
      await handleInboundMessage(senderPhone, body, imageUrl, pdfUrl, pdfFilename, messageId, payloadChatId);
    } catch (err) {
      console.error("[linq-webhook] async processing error:", err);
      const { captureException } = await import("@sentry/nextjs");
      captureException(err);
    }
  });

  return NextResponse.json({ ok: true });
}

async function handleInboundMessage(
  senderPhone: string,
  body: string,
  imageUrl: string | null,
  pdfUrl: string | null,
  pdfFilename: string | null,
  messageId: string | null,
  payloadChatId: string | null
) {
  // Fire typing indicator immediately — before any DB operations.
  // payloadChatId is already extracted from the webhook payload so there's no
  // reason to wait 1-2s for user lookup / creation before the indicator appears.
  if (payloadChatId) {
    void startTyping(payloadChatId);
    // onboarding/handle and coach/respond each run their own keep-alive loop
    // that stops when the message is sent. A continuation loop here would
    // re-trigger typing *after* the response was already delivered.
  }

  // Look up user by phone number.
  // Use maybeSingle() so "no rows" returns { data: null, error: null } rather
  // than a PGRST116 error — that lets us distinguish "user not found" from a
  // real DB error (e.g. missing column) without falling into the insert path.
  // Check for opt-out before anything else — even before creating a new user.
  const normalizedBody = body.trim().toUpperCase();
  // Hard stop: exact TCPA keywords, or "STOP" as the first word with nothing meaningful after
  // (e.g. "STOP MESSAGES", "STOP TEXTING ME", "STOP ALL"). Limit to ≤30 chars to avoid
  // catching conversational mentions like "stop sending me so many plans".
  // CANCEL and UNSUBSCRIBE are intentionally excluded here — they route to coach/respond
  // which sends the Stripe portal link, so the user can cancel billing rather than just
  // opting out of SMS without cancelling their subscription.
  const isHardStop = normalizedBody === "STOP" || normalizedBody === "STOPALL" ||
    normalizedBody === "QUIT" ||
    (normalizedBody.length <= 30 && /^STOP\b/.test(normalizedBody));
  const isSoftStop = !isHardStop && /don['']?t (want|send|text)|no more (messages|texts)|stop (texting|messaging|sending|messages?)|opt.?out/i.test(body);

  const isRestart = normalizedBody === "START" || normalizedBody === "UNSTOP" || normalizedBody === "RESUME" || normalizedBody === "YES";

  if (isRestart) {
    const { data: restartUser } = await supabase
      .from("users")
      .select("id, linq_chat_id, messaging_opted_out")
      .eq("phone_number", senderPhone)
      .maybeSingle();

    if (restartUser?.messaging_opted_out) {
      await supabase.from("users").update({ messaging_opted_out: false }).eq("id", restartUser.id);
      void trackEvent(restartUser.id, "messaging_resumed");
      await sendSMS(senderPhone, "Welcome back! You're re-subscribed to Coach Dean. Just text me anytime to pick up where we left off.");
      console.log("[linq-webhook] opt-in resume from:", senderPhone);
      return;
    }
    // START from a non-opted-out user — fall through to normal handling
  }

  if (isHardStop || isSoftStop) {
    const { data: optOutUser } = await supabase
      .from("users")
      .select("id, linq_chat_id, dashboard_token")
      .eq("phone_number", senderPhone)
      .maybeSingle();

    if (optOutUser) {
      await supabase.from("users").update({ messaging_opted_out: true }).eq("id", optOutUser.id);
      void trackEvent(optOutUser.id, "messaging_opted_out");
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://coachdean.ai";
      const token = optOutUser.dashboard_token as string | null;
      const confirmMsg = token
        ? `You've been unsubscribed from Coach Dean messages. To also cancel your billing, tap here: ${appUrl}/cancel?token=${token}\n\nText START anytime to resume.`
        : "You've been unsubscribed from Coach Dean and won't receive any more messages. Text START anytime to resume.";
      await sendSMS(senderPhone, confirmMsg);
    }
    console.log("[linq-webhook] opt-out received from:", senderPhone);
    return;
  }

  const { data: user, error: lookupError } = await supabase
    .from("users")
    .select("id, onboarding_step, timezone, linq_chat_id, messaging_opted_out, reengagement_sent_at, strava_athlete_id, dashboard_token")
    .eq("phone_number", senderPhone)
    .maybeSingle();

  if (lookupError) {
    console.error("[linq-webhook] user lookup failed — aborting to avoid spurious insert:", lookupError);
    return;
  }

  // If they're opted out and it wasn't a START/STOP keyword, ignore silently.
  if (user?.messaging_opted_out) {
    console.log("[linq-webhook] message from opted-out user, ignoring:", user.id);
    return;
  }

  if (!user) {
    console.log("[linq-webhook] new user, creating:", senderPhone);

    const { data: newUser, error } = await supabase
      .from("users")
      .insert({
        phone_number: senderPhone,
        onboarding_step: "onboarding",
        timezone: inferTimezoneFromPhone(senderPhone),
      })
      .select("id")
      .single();

    if (error || !newUser) {
      console.error("[linq-webhook] error creating user:", error);
      return;
    }

    // Parse acquisition source embedded by signup-form.tsx when utm_source is present.
    // Strip the token before storing the message so Dean never sees "src=linkedin".
    const srcMatch = body.match(/\bsrc=([a-zA-Z0-9_-]{1,32})/);
    const acquisitionSource = srcMatch ? srcMatch[1] : null;
    const cleanBody = acquisitionSource ? body.replace(/\s*\bsrc=[a-zA-Z0-9_-]{1,32}/, "").trim() : body;

    void trackEvent(newUser.id, "onboarding_started", acquisitionSource ? { acquisition_source: acquisitionSource } : {});
    void trackEvent(newUser.id, "message_received", { has_image: !!imageUrl, onboarding: true });

    // Persist chatId and acquisition source for future reference
    void supabase.from("users").update({
      ...(payloadChatId ? { linq_chat_id: payloadChatId } : {}),
      ...(acquisitionSource ? { onboarding_data: { acquisition_source: acquisitionSource } } : {}),
    }).eq("id", newUser.id);

    // For new users, images before onboarding are unusual — treat as no message
    // and let onboarding start normally.
    const messageBody = cleanBody || (imageUrl ? "[Workout image received]" : "");
    await insertConversation({
      user_id: newUser.id,
      role: "user",
      content: messageBody,
      message_type: "user_message",
      external_message_id: messageId,
    });

    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/onboarding/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: newUser.id, message: messageBody, chatId: payloadChatId }),
    });

    console.log("[linq-webhook] new user routed to onboarding/handle:", senderPhone);
    return;
  }

  console.log("[linq-webhook] existing user:", user.id, "step:", user.onboarding_step);

  // Resolve the chatId: prefer what's already stored, fall back to payload.
  const resolvedChatId: string | null =
    (user.linq_chat_id as string | null) ?? payloadChatId;

  // Cache the chatId if we learned it from the payload and didn't have it yet.
  if (payloadChatId && !user.linq_chat_id) {
    void supabase
      .from("users")
      .update({ linq_chat_id: payloadChatId })
      .eq("id", user.id);
  }

  void trackEvent(user.id, "message_received", { has_image: !!imageUrl, onboarding: !!user.onboarding_step });

  // Clear any pending re-engagement state — they're back.
  if ((user as Record<string, unknown>).reengagement_sent_at) {
    void supabase.from("users").update({ reengagement_sent_at: null }).eq("id", user.id);
  }

  // PDF from an onboarded user: import as training plan via the plan_import trigger.
  if (pdfUrl && !user.onboarding_step) {
    await handlePDFPlan(user.id, senderPhone, pdfUrl, pdfFilename, body || null, messageId, resolvedChatId);
    return;
  }

  // PDF received mid-onboarding: parse and save the plan, mark has_existing_plan on
  // onboarding_data, then forward a synthetic message to the onboarding handler so
  // Dean can acknowledge the plan inline and continue the intake conversation.
  // Without this path, PDFs were silently dropped during onboarding and Dean would
  // hallucinate an acknowledgment from the inbound text alone.
  if (pdfUrl && user.onboarding_step) {
    await handlePDFDuringOnboarding(user.id, senderPhone, pdfUrl, pdfFilename, body || null, messageId, resolvedChatId);
    return;
  }

  // Image message from an onboarded user: extract workout and generate feedback.
  // Images during onboarding are unexpected — fall through to text path.
  if (imageUrl && !user.onboarding_step) {
    await handleImageWorkout(user.id, senderPhone, imageUrl, body || null, messageId, (user.timezone as string) || "America/New_York", resolvedChatId);
    return;
  }

  // --- Text message path (existing flow) ---
  const messageBody = body || "[Image received]";

  // Content-based dedup: if the exact same text body arrived from this user within
  // the last 60 seconds, it's a duplicate send (e.g. user double-tapped, Linq retry
  // with a different message ID). Skip processing to avoid double responses.
  //
  // This insert happens BEFORE the duplicate check (rather than select-then-insert)
  // to close a race window: two near-simultaneous webhook deliveries for the same
  // text could otherwise both pass a "does a matching row already exist" check before
  // either had written its row, producing two assistant replies (observed in
  // production — see 2026-07-22 changelog). Inserting first means whichever request's
  // insert commits second will always see the first one's row in its follow-up
  // duplicate check. The tie-break (`created_at < mine, or equal with a lower id`)
  // guarantees exactly one of two truly-concurrent inserts treats itself as the
  // duplicate, even if both commit within the same millisecond.
  const { id: storedMsgId, created_at: storedCreatedAt } = await insertConversationReturningId({
    user_id: user.id,
    role: "user",
    content: messageBody,
    message_type: "user_message",
    external_message_id: messageId,
  });

  if (body && storedMsgId && storedCreatedAt) {
    const contentCutoff = new Date(Date.now() - 60_000).toISOString();
    const { data: earlierSame } = await supabase
      .from("conversations")
      .select("id, created_at")
      .eq("user_id", user.id)
      .eq("role", "user")
      .eq("content", messageBody)
      .gte("created_at", contentCutoff)
      .neq("id", storedMsgId)
      .order("created_at", { ascending: true })
      .limit(5);

    const isDuplicate = (earlierSame ?? []).some((row) => {
      const rowCreatedAt = row.created_at as string;
      if (rowCreatedAt < storedCreatedAt) return true;
      if (rowCreatedAt === storedCreatedAt) return (row.id as string) < storedMsgId;
      return false;
    });

    if (isDuplicate) {
      console.log("[linq-webhook] content-dedup: same body within 60s, skipping:", user.id);
      return;
    }
  }
  const storedMsg = storedMsgId ? { id: storedMsgId } : null;

  // Feedback / refund commands — intercept before onboarding and coaching
  const isFeedback = /^FEEDBACK\b/i.test(body);
  const isRefundRequest = /^REFUND\b/i.test(body);

  if (isFeedback || isRefundRequest) {
    void sendFeedbackEmail({
      type: isRefundRequest ? "REFUND" : "FEEDBACK",
      phone: senderPhone,
      userId: user.id,
      message: body,
      hasStrava: !!user.strava_athlete_id,
    });
    void trackEvent(user.id, isRefundRequest ? "refund_requested" : "feedback_submitted");

    if (isRefundRequest || user.onboarding_step) {
      // Billing issue, or user is mid-onboarding — Dean can't action either.
      // Send a simple ack and stop. Onboarding resumes on their next message.
      const ack = isRefundRequest
        ? "Got it — I've flagged your refund request and Jake will follow up with you within 24 hours."
        : "Thanks for that — I'll pass it along!";
      await sendAndStore(user.id, senderPhone, ack, messageId);
      return;
    }
    // Fully-onboarded feedback — fall through to coaching so Dean can respond:
    // coaching adjustment if actionable, graceful handoff if it's a product suggestion.
  }

  if (user.onboarding_step) {
    // Debounce onboarding responses exactly like coaching: wait 10s so burst messages
    // (the user typing several quick lines before we've replied) collapse into one call.
    // Without this, each message fires the same step handler independently and sends
    // identical replies — the root cause of the Tomo infinite-loop incident (2026-03-24).
    console.log("[linq-webhook] onboarding debounce: waiting 10s for user", user.id);
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    if (storedMsg) {
      const { data: latestMsg } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", user.id)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (latestMsg && latestMsg.id !== storedMsg.id) {
        console.log("[linq-webhook] onboarding debounce: newer message arrived, skipping for", storedMsg.id);
        return;
      }
    }

    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/onboarding/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, message: messageBody, chatId: resolvedChatId }),
    });
    return;
  }

  // Detect "strava connection" keyword — re-auth link so users can add or remove write permission.
  const isStravaConnectionKeyword = /^strava connection$/i.test(body.trim());
  if (isStravaConnectionKeyword) {
    const writeUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;
    await sendAndStore(user.id, senderPhone, `Here's a link to update your Strava connection:\n${writeUrl}`, messageId);
    return;
  }

  // Detect "connect strava" / "add strava" / "reconnect strava" intent from fully-onboarded users
  const isStravaIntent = /\bstrava\b/i.test(body) &&
    /\b(connect|reconnect|add|link|attach|setup|sync|integrate)\b/i.test(body);
  if (isStravaIntent) {
    if (user.strava_athlete_id) {
      const writeUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;
      await sendAndStore(user.id, senderPhone, `Your Strava is already connected. If you want to update your permissions, tap here:\n${writeUrl}`, messageId);
    } else {
      const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
      await sendAndStore(user.id, senderPhone, `Here's your Strava link — tap to connect and I'll start tracking your runs:\n${stravaUrl}`, messageId);
    }
    return;
  }

  // Detect "UPDATE PLAN" — user confirming a full plan rebuild that Dean proposed.
  // Fires rebuild_plan directly, bypassing the conversational coach/respond pipeline.
  // Dean asks "Reply UPDATE PLAN to confirm" and the athlete sends this exact phrase.
  const isUpdatePlan = /^UPDATE PLAN$/i.test(body.trim());
  if (isUpdatePlan) {
    void trackEvent(user.id, "plan_rebuild_confirmed");
    // Await the fetch so after() stays alive during the 30-60s rebuild.
    // void fetch() would exit after() immediately, abandoning the request before it fires.
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, trigger: "rebuild_plan", chatId: resolvedChatId }),
    });
    return;
  }

  // Coaching flow: debounce 15 seconds so rapid multi-part messages are batched.
  // 10s was too short — users often send a second message 12-15 seconds after the first,
  // causing two independent responses that contradict each other (e.g. different mileage totals).
  console.log("[linq-webhook] debounce: waiting 15s for user", user.id);
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  // If the conversation insert failed, storedMsg is null — don't silently skip,
  // just fire the response anyway so the message isn't dropped.
  if (!storedMsg) {
    console.warn("[linq-webhook] storedMsg is null — conversation insert may have failed, firing response anyway");
  } else {
    // After the wait, check if a newer user message has arrived
    const { data: latestMsg } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (latestMsg && latestMsg.id !== storedMsg.id) {
      console.log("[linq-webhook] debounce: newer message arrived, skipping response for", storedMsg.id);
      return;
    }

    // Guard against duplicate webhook deliveries (same external_message_id).
    // If Linq delivered the same message twice and both slipped through the pre-after
    // dedup check before either inserted a conversation row, two handlers race to respond.
    // After the debounce wait, only the handler whose row has the lexicographically
    // smallest id proceeds; the other skips. The smallest id wins deterministically.
    if (messageId) {
      const { data: sameExternalRows } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", user.id)
        .eq("external_message_id", messageId)
        .eq("role", "user");
      if (sameExternalRows && (sameExternalRows as Array<{ id: string }>).length > 1) {
        const ids = (sameExternalRows as Array<{ id: string }>).map(r => r.id).sort();
        if (ids[0] !== storedMsg.id) {
          console.log("[linq-webhook] duplicate webhook delivery (post-debounce), skipping:", messageId);
          return;
        }
      }
    }

    // Also guard against double-responses when two messages arrived >15s apart (both pass
    // the newer-message check but fire coach/respond in rapid succession). If an assistant
    // reply was already sent within the last 45 seconds, the first message already triggered
    // a response — skip so we don't send two independent replies to a multi-part send.
    const cutoff = new Date(Date.now() - 45_000).toISOString();
    const { data: recentReply } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "assistant")
      .gte("created_at", cutoff)
      .limit(1)
      .maybeSingle();

    if (recentReply) {
      console.log("[linq-webhook] debounce: assistant reply sent within last 45s, skipping double-response for", storedMsg.id);
      return;
    }
  }

  // Await the fetch — void fetch() doesn't work in after() because the runtime
  // exits before the HTTP request fires. coach/respond returns 200 immediately
  // and does its work in its own after(), so this completes in milliseconds.
  console.log("[linq-webhook] debounce: firing response for", user.id);
  await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id, trigger: "user_message", chatId: resolvedChatId }),
  });
}

// ---------------------------------------------------------------------------
// Image workout handler
// ---------------------------------------------------------------------------

interface WorkoutExtracted {
  date: string | null;
  activity_type: string | null;
  distance_km: number | null;
  distance_miles: number | null;
  duration_seconds: number | null;
  average_pace_per_mile: string | null;
  average_pace_per_km: string | null;
  average_hr: number | null;
  elevation_gain_feet: number | null;
  elevation_gain_meters: number | null;
  splits: Array<{ mile?: number; km?: number; pace: string }> | null;
  calories: number | null;
  is_workout_image: boolean;
}

async function handlePDFPlan(
  userId: string,
  phone: string,
  pdfUrl: string,
  filename: string | null,
  caption: string | null,
  messageId: string | null,
  chatId: string | null
) {
  console.log("[linq-webhook] processing PDF plan for user:", userId, "filename:", filename);
  void chatId;

  await insertConversation({
    user_id: userId,
    role: "user",
    content: caption
      ? `[PDF: ${filename || "training plan"}] ${caption}`
      : `[PDF: ${filename || "training plan"}]`,
    message_type: "plan_upload",
  });

  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    const resp = await fetch(`${appUrl}/api/plan/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        content: pdfUrl,
        contentType: "pdf_url",
        filename: filename || undefined,
      }),
    });

    let result: { ok?: boolean; error?: string; message?: string };
    try {
      result = await resp.json() as typeof result;
    } catch {
      console.error("[linq-webhook] PDF plan upload non-JSON response, status:", resp.status);
      await sendAndStore(userId, phone, "That one timed out — the PDF might be too large. Try pasting the plan as text instead.", messageId);
      return;
    }

    if (!resp.ok || !result.ok) {
      const userMsg = result.message ?? "I couldn't read that PDF — make sure it has a readable text layer, or paste the plan as text.";
      console.error("[linq-webhook] PDF plan upload failed:", result.error);
      await sendAndStore(userId, phone, userMsg, messageId);
      return;
    }

    const planLabel = filename ? filename.replace(/\.pdf$/i, "") : "your training plan";
    const ack = caption
      ? `Got "${planLabel}" — I'll reference it in our sessions. ${caption}`
      : `Got "${planLabel}" — I'll reference it when giving you feedback. Ask me about any week or workout anytime.`;
    await sendAndStore(userId, phone, ack, messageId);

    void trackEvent(userId, "plan_uploaded", { source: "sms_pdf" });
  } catch (err) {
    console.error("[linq-webhook] PDF plan processing failed:", err);
    await sendAndStore(userId, phone, "Something went wrong reading that PDF. Try pasting the plan as text instead.", messageId);
  }
}

/**
 * Handles a PDF training plan received while the user is still in onboarding.
 * Parses and saves the plan, marks has_existing_plan on onboarding_data, then
 * forwards a synthetic "[PDF plan received]" message to the onboarding handler
 * so Dean acknowledges it inline without interrupting the intake conversation.
 */
async function handlePDFDuringOnboarding(
  userId: string,
  phone: string,
  pdfUrl: string,
  filename: string | null,
  caption: string | null,
  messageId: string | null,
  chatId: string | null
) {
  console.log("[linq-webhook] onboarding PDF plan for user:", userId, "filename:", filename);

  await insertConversation({
    user_id: userId,
    role: "user",
    content: caption
      ? `[PDF: ${filename || "training plan"}] ${caption}`
      : `[PDF: ${filename || "training plan"}]`,
    message_type: "plan_upload",
    external_message_id: messageId,
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  try {
    const resp = await fetch(`${appUrl}/api/plan/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, content: pdfUrl, contentType: "pdf_url", filename: filename || undefined }),
    });

    let result: { ok?: boolean; error?: string; message?: string };
    try {
      result = await resp.json() as typeof result;
    } catch {
      console.error("[linq-webhook] onboarding PDF upload non-JSON response, status:", resp.status);
      await sendAndStore(userId, phone, "That PDF timed out on my end — try again, or just describe the plan here and I'll work alongside it.", messageId);
      return;
    }

    if (!resp.ok || !result.ok) {
      console.error("[linq-webhook] onboarding PDF upload failed:", result.error);
      const userMsg = result.message ?? "I couldn't read that PDF — make sure it has a readable text layer, or describe the plan here and I'll work alongside it.";
      await sendAndStore(userId, phone, userMsg, messageId);
      return;
    }

    void trackEvent(userId, "plan_uploaded", { source: "sms_pdf_onboarding" });
  } catch (err) {
    console.error("[linq-webhook] onboarding PDF processing failed:", err);
    await sendAndStore(userId, phone, "Something went wrong reading that PDF. Try again, or describe the plan here and I'll work alongside it.", messageId);
    return;
  }

  // Forward a synthetic message to onboarding/handle so Dean acknowledges the
  // plan and continues intake naturally.
  const planLabel = filename ? filename.replace(/\.pdf$/i, "") : "their training plan";
  const captionNote = caption ? ` They also said: "${caption}".` : "";
  const syntheticMessage = `(system: received the PDF "${planLabel}" and stored it as plan context. Acknowledge you've got the plan and will reference it in coaching, then continue the intake with the next question.${captionNote})`;

  await fetch(`${appUrl}/api/onboarding/handle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, message: syntheticMessage, chatId }),
  });
}

async function handleImageWorkout(
  userId: string,
  phone: string,
  imageUrl: string,
  caption: string | null,
  messageId: string | null,
  timezone: string,
  chatId: string | null
) {
  console.log("[linq-webhook] processing image workout for user:", userId, "url:", imageUrl);

  // 1. Fetch the image and convert to base64
  let base64: string;
  let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" = "image/jpeg";
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    base64 = Buffer.from(buffer).toString("base64");
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("png")) mediaType = "image/png";
    else if (ct.includes("webp")) mediaType = "image/webp";
    else if (ct.includes("gif")) mediaType = "image/gif";
  } catch (err) {
    console.error("[linq-webhook] image fetch failed:", err);
    await sendAndStore(userId, phone, "I couldn't load that image — can you try sending it again?", messageId);
    return;
  }

  // 2. Extract structured workout data via Claude vision
  // Compute today's date in the user's local timezone so relative labels like
  // "Today" or "Yesterday" in the app screenshot resolve to the correct date.
  const todayLocal = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // en-CA gives YYYY-MM-DD format natively

  const extracted = await extractWorkoutFromImage(base64, mediaType, todayLocal);

  if (!extracted.is_workout_image) {
    // Not a workout screenshot — store message and route to standard coaching
    console.log("[linq-webhook] image is not a workout screenshot, routing to coach");
    const content = caption || "[Image]";
    await insertConversation({
      user_id: userId,
      role: "user",
      content,
      message_type: "user_message",
      external_message_id: messageId,
    });
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, trigger: "user_message", chatId }),
    });
    return;
  }

  // 3. Build a human-readable summary of the extracted workout to store in the conversation
  const workoutSummary = formatWorkoutSummary(extracted, caption);
  await insertConversation({
    user_id: userId,
    role: "user",
    content: workoutSummary,
    message_type: "user_message",
    external_message_id: messageId,
  });

  // 4. Store the activity in the activities table
  const distanceMeters = extracted.distance_km
    ? extracted.distance_km * 1000
    : extracted.distance_miles
      ? extracted.distance_miles * 1609.34
      : null;

  const elevationGain = extracted.elevation_gain_meters
    ?? (extracted.elevation_gain_feet ? extracted.elevation_gain_feet * 0.3048 : null);

  const averagePace = extracted.average_pace_per_mile || extracted.average_pace_per_km || null;

  const startDate = extracted.date
    ? new Date(extracted.date + "T00:00:00").toISOString()
    : new Date().toISOString();

  const { data: activity } = await supabase
    .from("activities")
    .insert({
      user_id: userId,
      source: "image_upload",
      activity_type: extracted.activity_type || "Run",
      distance_meters: distanceMeters,
      moving_time_seconds: extracted.duration_seconds,
      average_heartrate: extracted.average_hr,
      average_pace: averagePace,
      elevation_gain: elevationGain,
      start_date: startDate,
      summary: extracted as unknown as Json,
    })
    .select("id")
    .single();

  console.log("[linq-webhook] stored image activity:", activity?.id);
  void trackEvent(userId, "workout_logged", {
    source: "image_upload",
    activity_type: extracted.activity_type,
    distance_miles: extracted.distance_miles ?? (extracted.distance_km ? extracted.distance_km * 0.621371 : null),
  });

  // 5. Update training state with this week's mileage
  if (distanceMeters) {
    const distanceMiles = distanceMeters / 1609.34;
    const { data: state } = await supabase
      .from("training_state")
      .select("week_mileage_so_far")
      .eq("user_id", userId)
      .single();

    await supabase
      .from("training_state")
      .update({
        week_mileage_so_far: (state?.week_mileage_so_far || 0) + distanceMiles,
        last_activity_date: startDate.split("T")[0],
        last_activity_summary: {
          type: extracted.activity_type || "Run",
          distance_miles: Math.round(distanceMiles * 100) / 100,
          pace: averagePace,
          hr: extracted.average_hr,
          source: "image_upload",
        },
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  // 6. Fire coaching response with pre-extracted data (no DB lookup needed)
  await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      trigger: "workout_image",
      imageActivity: extracted,
      chatId,
    }),
  });
}

/**
 * Use Claude vision to extract structured workout data from an image.
 * Handles screenshots from Strava, Garmin, Apple Fitness, Nike Run Club, etc.
 */
async function extractWorkoutFromImage(
  base64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  todayDate: string // YYYY-MM-DD in the user's local timezone
): Promise<WorkoutExtracted> {
  const empty: WorkoutExtracted = {
    date: null,
    activity_type: null,
    distance_km: null,
    distance_miles: null,
    duration_seconds: null,
    average_pace_per_mile: null,
    average_pace_per_km: null,
    average_hr: null,
    elevation_gain_feet: null,
    elevation_gain_meters: null,
    splits: null,
    calories: null,
    is_workout_image: false,
  };

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            {
              type: "text",
              text: `Extract workout data from this image. It may be a screenshot from Strava, Garmin, Apple Fitness, Nike Run Club, or a similar app. Respond with ONLY valid JSON, no other text.

Today's date is ${todayDate}. Use this to resolve relative date labels in the image:
- "Today" → ${todayDate}
- "Yesterday" → one day before ${todayDate}
- Any other relative label → calculate from ${todayDate}

Output format:
{
  "is_workout_image": true|false,
  "date": "YYYY-MM-DD" | null,
  "activity_type": "Run"|"TrailRun"|"Ride"|"Walk"|"Swim"|"Workout"|null,
  "distance_km": number | null,
  "distance_miles": number | null,
  "duration_seconds": number | null,
  "average_pace_per_mile": "M:SS" | null,
  "average_pace_per_km": "M:SS" | null,
  "average_hr": number | null,
  "elevation_gain_feet": number | null,
  "elevation_gain_meters": number | null,
  "splits": [{"mile": number, "pace": "M:SS"} | {"km": number, "pace": "M:SS"}] | null,
  "calories": number | null
}

Rules:
- is_workout_image: true only if this is clearly a workout/activity summary screenshot
- date: extract from the image if visible. Use YYYY-MM-DD format.
- distance: extract whichever unit is shown and leave the other null. Do not convert.
- duration_seconds: convert from any format (e.g. "47:23" → 2843, "1:12:05" → 4325)
- average_pace_per_mile / average_pace_per_km: extract whichever is shown. Format as M:SS (e.g. "9:06", "4:45").
- splits: include if a splits table is visible. Use the same unit (mile or km) as shown.
- If this is not a workout screenshot (photo, meme, etc.), set is_workout_image: false and all other fields to null.`,
            },
          ],
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "{}";
    console.log("[linq-webhook] vision extraction:", text.slice(0, 200));

    // Strip markdown code fences if present
    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error("[linq-webhook] vision extraction failed:", err);
    return empty;
  }
}

/** Build a plain-text summary of extracted workout data for conversation storage. */
function formatWorkoutSummary(w: WorkoutExtracted, caption: string | null): string {
  const lines: string[] = ["[Workout image]"];
  if (w.activity_type) lines.push(`Type: ${w.activity_type}`);
  if (w.date) lines.push(`Date: ${w.date}`);
  if (w.distance_miles) lines.push(`Distance: ${w.distance_miles.toFixed(2)} mi`);
  else if (w.distance_km) lines.push(`Distance: ${w.distance_km.toFixed(2)} km`);
  if (w.duration_seconds) {
    const h = Math.floor(w.duration_seconds / 3600);
    const m = Math.floor((w.duration_seconds % 3600) / 60);
    const s = w.duration_seconds % 60;
    const dur = h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
    lines.push(`Duration: ${dur}`);
  }
  if (w.average_pace_per_mile) lines.push(`Avg pace: ${w.average_pace_per_mile}/mi`);
  else if (w.average_pace_per_km) lines.push(`Avg pace: ${w.average_pace_per_km}/km`);
  if (w.average_hr) lines.push(`Avg HR: ${w.average_hr} bpm`);
  if (w.elevation_gain_feet) lines.push(`Elevation: ${w.elevation_gain_feet} ft`);
  else if (w.elevation_gain_meters) lines.push(`Elevation: ${w.elevation_gain_meters} m`);
  if (w.splits?.length) {
    const splitLines = w.splits.map((s) =>
      "mile" in s ? `  Mile ${s.mile}: ${s.pace}` : `  km ${s.km}: ${s.pace}`
    );
    lines.push(`Splits:\n${splitLines.join("\n")}`);
  }
  if (caption) lines.push(`Note: ${caption}`);
  return lines.join("\n");
}

async function sendAndStore(userId: string, phone: string, message: string, messageId: string | null) {
  await Promise.all([
    sendSMS(phone, message),
    insertConversation({
      user_id: userId,
      role: "assistant",
      content: message,
      message_type: "coach_response",
      external_message_id: messageId,
    }),
  ]);
}

async function sendFeedbackEmail(opts: {
  type: "FEEDBACK" | "REFUND";
  phone: string;
  message: string;
  userId: string;
  hasStrava: boolean;
}) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!resendApiKey || !adminEmail) {
    console.warn("[linq-webhook] RESEND_API_KEY or ADMIN_EMAIL not set, skipping feedback email");
    return;
  }

  const preview = opts.message.replace(/^FEEDBACK[:\s]*/i, "").trim().slice(0, 80);
  const isRefund = opts.type === "REFUND";
  const subject = isRefund
    ? `[REFUND REQUEST] ${opts.phone}`
    : `[FEEDBACK] ${opts.phone} — "${preview}"`;

  const badgeColor = isRefund ? "#dc2626" : "#2563eb";
  const badgeLabel = isRefund ? "REFUND REQUEST" : "FEEDBACK";
  const messageText = opts.message.replace(/^FEEDBACK[:\s]*/i, "").trim();
  const timestamp = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
      <h1 style="font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 4px;">
        Coach Dean · User ${badgeLabel}
      </h1>
      <p style="color: #6b7280; font-size: 13px; margin-top: 4px;">${timestamp}</p>

      <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
        <tr>
          <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; font-weight: 600; width: 120px;">Type</td>
          <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">
            <span style="background: ${badgeColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;">${badgeLabel}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; font-weight: 600;">Phone</td>
          <td style="padding: 8px 12px; border: 1px solid #e5e7eb; font-family: monospace;">${opts.phone}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; font-weight: 600;">User ID</td>
          <td style="padding: 8px 12px; border: 1px solid #e5e7eb; font-family: monospace; font-size: 12px; color: #6b7280;">${opts.userId}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background: #f9fafb; border: 1px solid #e5e7eb; font-weight: 600;">Strava</td>
          <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${opts.hasStrava ? "✓ Connected" : "Not connected"}</td>
        </tr>
      </table>

      <h2 style="font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #374151;">Message</h2>
      <blockquote style="margin: 0; padding: 12px 16px; background: #f9fafb; border-left: 4px solid ${badgeColor}; border-radius: 0 4px 4px 0; font-size: 15px; line-height: 1.6; color: #1a1a1a;">
        ${messageText}
      </blockquote>

      <hr style="margin-top: 32px; border: none; border-top: 1px solid #e5e7eb;" />
      <p style="color: #9ca3af; font-size: 11px;">Reply to this user via Linq · ${opts.phone}</p>
    </div>
  `;

  try {
    const resend = new Resend(resendApiKey);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Coach Dean <noreply@coachdean.ai>",
      to: [adminEmail],
      subject,
      html,
    });
    if (error) {
      console.error("[linq-webhook] feedback email failed:", error);
    } else {
      console.log("[linq-webhook] feedback email sent:", opts.type, opts.phone);
    }
  } catch (err) {
    console.error("[linq-webhook] feedback email error:", err);
  }
}
