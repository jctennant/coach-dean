import { NextResponse } from "next/server";
import { runAfter } from "@/lib/safe-after";
import { supabase } from "@/lib/supabase";
import { insertConversation, insertConversationReturningId } from "@/lib/conversations";
import { sendSMS, startTyping } from "@/lib/linq";
import { inferTimezoneFromPhone } from "@/lib/timezone";
import { trackEvent } from "@/lib/track";
import { ONBOARDING_POLLS_BY_TITLE } from "@/lib/onboarding-polls";
import crypto from "crypto";

// 120s: matches linq webhook — coaching responses can take 30-60s
export const maxDuration = 120;

/**
 * POST /api/webhooks/photon
 * Receives inbound messages from Photon (Spectrum) iMessage relay.
 * Signature: HMAC-SHA256 of raw body, keyed by PHOTON_WEBHOOK_SECRET.
 * Header: X-Spectrum-Signature
 *
 * Payload shape:
 * {
 *   event: "messages",
 *   space: { id, platform, type, phone },
 *   message: {
 *     id, platform, direction, timestamp,
 *     sender: { id: "+15550100", platform },
 *     space: { id, platform, type, phone },
 *     content: { type: "text", text: "..." }
 *              | { type: "attachment", id, name, mimeType, size? }
 *              | { type: "poll_option", option: { title }, poll: { title, options }, selected }
 *   }
 * }
 */
export async function POST(request: Request) {
  const signature = request.headers.get("x-spectrum-signature");
  const rawBody = await request.text();

  // Verify webhook signature — log the incoming value so we can confirm the
  // exact format Spectrum uses (hex vs base64, body-only vs timestamp.body).
  const timestamp = request.headers.get("x-spectrum-timestamp") ?? "";
  console.log("[photon-webhook] signature header:", signature?.slice(0, 20), "timestamp:", timestamp);

  if (process.env.PHOTON_WEBHOOK_SECRET && signature) {
    const secret = process.env.PHOTON_WEBHOOK_SECRET;
    // Spectrum uses Slack-style v0 signatures: "v0=" + HMAC-SHA256("v0:{timestamp}:{body}")
    const sigBase = `v0:${timestamp}:${rawBody}`;
    const expected = "v0=" + crypto.createHmac("sha256", secret).update(sigBase).digest("hex");

    if (signature !== expected) {
      console.warn("[photon-webhook] signature mismatch — got:", signature.slice(0, 20), "expected:", expected.slice(0, 20));
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    console.log("[photon-webhook] signature verified");
  }

  let payload: PhotonWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("[photon-webhook] invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Only process inbound messages
  if (payload.event !== "messages" || payload.message?.direction !== "inbound") {
    console.log("[photon-webhook] ignoring event:", payload.event, "direction:", payload.message?.direction);
    return NextResponse.json({ ok: true });
  }

  const message = payload.message;
  const messageId = message.id ?? null;
  const senderPhone = message.sender?.id ?? null;
  const content = message.content;

  // Extract text body. Poll answers arrive as a separate content type with no
  // free-text body — synthesize one so they flow through the same pipeline
  // (dedup, debounce, Haiku extraction) as if the athlete had typed the answer.
  let body = content?.type === "text" ? (content.text ?? "").trim() : "";
  if (content?.type === "poll_option" && content.selected) {
    const matchedPoll = content.poll?.title ? ONBOARDING_POLLS_BY_TITLE[content.poll.title] : undefined;
    body = matchedPoll ? matchedPoll.optionToMessage(content.option.title) : content.option.title;
  }

  // Attachments: Photon webhooks include metadata only (no download URL).
  // Image workout extraction requires bytes — not supported via Photon webhook.
  // Users can still log workouts via Strava.
  const hasAttachment = content?.type === "attachment";
  const attachmentMimeType = hasAttachment ? (content as PhotonAttachmentContent).mimeType : null;

  console.log("[photon-webhook] message from:", senderPhone, "body:", body.slice(0, 50), "hasAttachment:", hasAttachment);

  if (!senderPhone) {
    console.warn("[photon-webhook] missing senderPhone, skipping");
    return NextResponse.json({ ok: true });
  }

  // Use the sender's phone as the chatId — the Photon sidecar routes by phone number.
  const chatId = senderPhone;

  if (!body && !hasAttachment) {
    console.warn("[photon-webhook] empty message, skipping");
    return NextResponse.json({ ok: true });
  }

  // Deduplicate by external message ID before entering after()
  if (messageId) {
    const { data: existing } = await supabase
      .from("conversations")
      .select("id")
      .eq("external_message_id", messageId)
      .limit(1)
      .maybeSingle();
    if (existing) {
      console.log("[photon-webhook] duplicate message, skipping:", messageId);
      return NextResponse.json({ ok: true });
    }
  }

  runAfter("photon-webhook", async () => {
    try {
      await handleInboundMessage(senderPhone, body, hasAttachment, attachmentMimeType, messageId, chatId);
    } catch (err) {
      console.error("[photon-webhook] async processing error:", err);
      const { captureException } = await import("@sentry/nextjs");
      captureException(err);
    }
  });

  return NextResponse.json({ ok: true });
}

async function handleInboundMessage(
  senderPhone: string,
  body: string,
  hasAttachment: boolean,
  attachmentMimeType: string | null,
  messageId: string | null,
  chatId: string
) {
  // Fire typing indicator immediately
  void startTyping(chatId);

  const normalizedBody = body.trim().toUpperCase();

  // STOP / START handling
  const isHardStop = normalizedBody === "STOP" || normalizedBody === "STOPALL" ||
    normalizedBody === "QUIT" ||
    (normalizedBody.length <= 30 && /^STOP\b/.test(normalizedBody));
  const isSoftStop = !isHardStop && /don['']?t (want|send|text)|no more (messages|texts)|stop (texting|messaging|sending|messages?)|opt.?out/i.test(body);
  const isRestart = normalizedBody === "START" || normalizedBody === "UNSTOP" || normalizedBody === "RESUME" || normalizedBody === "YES";

  if (isRestart) {
    const { data: restartUser } = await supabase
      .from("users")
      .select("id, messaging_opted_out")
      .eq("phone_number", senderPhone)
      .maybeSingle();
    if (restartUser?.messaging_opted_out) {
      await supabase.from("users").update({ messaging_opted_out: false }).eq("id", restartUser.id);
      void trackEvent(restartUser.id, "messaging_resumed");
      await sendSMS(senderPhone, "Welcome back! You're re-subscribed to Coach Dean. Just text me anytime to pick up where we left off.");
      return;
    }
  }

  if (isHardStop || isSoftStop) {
    const { data: optOutUser } = await supabase
      .from("users")
      .select("id, dashboard_token")
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
    return;
  }

  const { data: user, error: lookupError } = await supabase
    .from("users")
    .select("id, onboarding_step, timezone, linq_chat_id, messaging_opted_out, reengagement_sent_at, strava_athlete_id, dashboard_token")
    .eq("phone_number", senderPhone)
    .maybeSingle();

  if (lookupError) {
    console.error("[photon-webhook] user lookup failed:", lookupError);
    return;
  }

  if (user?.messaging_opted_out) {
    console.log("[photon-webhook] opted-out user, ignoring:", user.id);
    return;
  }

  // Attachment from any user — Photon webhooks have no download URL.
  // Notify the user and skip processing.
  if (hasAttachment && attachmentMimeType?.startsWith("image/")) {
    if (user && !user.onboarding_step) {
      await insertConversation({
        user_id: user.id,
        role: "user",
        content: "[Image received via iMessage — no download URL available]",
        message_type: "user_message",
        external_message_id: messageId,
      });
      await sendSMS(senderPhone, "Got your image! For now, log workouts via Strava and I'll pick them up automatically. Image uploads work when messaging via the Linq number.");
      return;
    }
  }

  // New user
  if (!user) {
    console.log("[photon-webhook] new user, creating:", senderPhone);
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
      console.error("[photon-webhook] error creating user:", error);
      return;
    }

    const srcMatch = body.match(/\bsrc=([a-zA-Z0-9_-]{1,32})/);
    const acquisitionSource = srcMatch ? srcMatch[1] : null;
    const cleanBody = acquisitionSource ? body.replace(/\s*\bsrc=[a-zA-Z0-9_-]{1,32}/, "").trim() : body;

    void trackEvent(newUser.id, "onboarding_started", acquisitionSource ? { acquisition_source: acquisitionSource } : {});
    void trackEvent(newUser.id, "message_received", { has_image: false, onboarding: true });

    void supabase.from("users").update(
      acquisitionSource ? { onboarding_data: { acquisition_source: acquisitionSource } } : {}
    ).eq("id", newUser.id);

    const messageBody = cleanBody || "";
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
      body: JSON.stringify({ userId: newUser.id, message: messageBody, chatId }),
    });
    return;
  }

  console.log("[photon-webhook] existing user:", user.id, "step:", user.onboarding_step);

  void trackEvent(user.id, "message_received", { has_image: false, onboarding: !!user.onboarding_step });

  if ((user as Record<string, unknown>).reengagement_sent_at) {
    void supabase.from("users").update({ reengagement_sent_at: null }).eq("id", user.id);
  }

  const messageBody = body || (hasAttachment ? "[Attachment received]" : "");

  // Content dedup within 60s
  if (body) {
    const contentCutoff = new Date(Date.now() - 60_000).toISOString();
    const { data: recentSame } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "user")
      .eq("content", messageBody)
      .gte("created_at", contentCutoff)
      .limit(1)
      .maybeSingle();
    if (recentSame) {
      console.log("[photon-webhook] content-dedup: same body within 60s, skipping:", user.id);
      return;
    }
  }

  const { id: storedMsgId } = await insertConversationReturningId({
    user_id: user.id,
    role: "user",
    content: messageBody,
    message_type: "user_message",
    external_message_id: messageId,
  });
  const storedMsg = storedMsgId ? { id: storedMsgId } : null;

  // FEEDBACK / REFUND intercept
  const isFeedback = /^FEEDBACK\b/i.test(body);
  const isRefundRequest = /^REFUND\b/i.test(body);
  if (isFeedback || isRefundRequest) {
    void trackEvent(user.id, isRefundRequest ? "refund_requested" : "feedback_submitted");
    if (isRefundRequest || user.onboarding_step) {
      const ack = isRefundRequest
        ? "Got it — I've flagged your refund request and Jake will follow up within 24 hours."
        : "Thanks for that — I'll pass it along!";
      await Promise.all([
        sendSMS(senderPhone, ack),
        insertConversation({ user_id: user.id, role: "assistant", content: ack, message_type: "coach_response" }),
      ]);
      return;
    }
  }

  if (user.onboarding_step) {
    console.log("[photon-webhook] onboarding debounce: waiting 10s for user", user.id);
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
        console.log("[photon-webhook] onboarding debounce: newer message, skipping:", storedMsg.id);
        return;
      }
    }

    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/onboarding/handle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, message: messageBody, chatId }),
    });
    return;
  }

  // Strava connection keywords
  const isStravaConnectionKeyword = /^strava connection$/i.test(body.trim());
  if (isStravaConnectionKeyword) {
    const writeUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;
    const msg = `Here's a link to update your Strava connection:\n${writeUrl}\n\nOn the Strava screen, the "Upload activities" checkbox controls whether I add a coaching note to each run.`;
    await Promise.all([
      sendSMS(senderPhone, msg),
      insertConversation({ user_id: user.id, role: "assistant", content: msg, message_type: "coach_response" }),
    ]);
    return;
  }

  const isStravaIntent = /\bstrava\b/i.test(body) && /\b(connect|reconnect|add|link|attach|setup|sync|integrate)\b/i.test(body);
  if (isStravaIntent) {
    const stravaUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava?userId=${user.id}`;
    const notesUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/strava/write?userId=${user.id}`;
    const msg = user.strava_athlete_id
      ? `Your Strava is already connected. To update permissions, tap here:\n${notesUrl}`
      : `Here's your Strava link:\n${stravaUrl}\n\nFor coaching notes on activities:\n${notesUrl}`;
    await Promise.all([
      sendSMS(senderPhone, msg),
      insertConversation({ user_id: user.id, role: "assistant", content: msg, message_type: "coach_response" }),
    ]);
    return;
  }

  // UPDATE PLAN confirmation
  const isUpdatePlan = /^UPDATE PLAN$/i.test(body.trim());
  if (isUpdatePlan) {
    void trackEvent(user.id, "plan_rebuild_confirmed");
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, trigger: "rebuild_plan", chatId }),
    });
    return;
  }

  // Coaching debounce: 15s to batch rapid multi-part messages
  console.log("[photon-webhook] debounce: waiting 15s for user", user.id);
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  if (!storedMsg) {
    console.warn("[photon-webhook] storedMsg is null — firing response anyway");
  } else {
    const { data: latestMsg } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (latestMsg && latestMsg.id !== storedMsg.id) {
      console.log("[photon-webhook] debounce: newer message, skipping:", storedMsg.id);
      return;
    }

    if (messageId) {
      const { data: sameExternalRows } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", user.id)
        .eq("external_message_id", messageId)
        .eq("role", "user");
      if (sameExternalRows && (sameExternalRows as Array<{ id: string }>).length > 1) {
        const ids = (sameExternalRows as Array<{ id: string }>).map((r) => r.id).sort();
        if (ids[0] !== storedMsg.id) {
          console.log("[photon-webhook] duplicate webhook (post-debounce), skipping:", messageId);
          return;
        }
      }
    }

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
      console.log("[photon-webhook] debounce: assistant reply within 45s, skipping:", storedMsg.id);
      return;
    }
  }

  console.log("[photon-webhook] firing coach/respond for user:", user.id);
  await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/coach/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id, trigger: "user_message", chatId }),
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PhotonTextContent {
  type: "text";
  text: string;
}

interface PhotonAttachmentContent {
  type: "attachment";
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}

interface PhotonPollOptionContent {
  type: "poll_option";
  option: { title: string };
  poll: { title: string; options?: { title: string }[] };
  selected: boolean;
}

type PhotonContent = PhotonTextContent | PhotonAttachmentContent | PhotonPollOptionContent;

interface PhotonWebhookPayload {
  event: string;
  space?: { id: string; platform: string; type: string; phone: string };
  message?: {
    id?: string;
    platform?: string;
    direction?: string;
    timestamp?: string;
    sender?: { id: string; platform: string };
    space?: { id: string; platform: string; type: string; phone: string };
    content?: PhotonContent;
  };
}
