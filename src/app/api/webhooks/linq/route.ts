import { NextResponse, after } from "next/server";
import { supabase } from "@/lib/supabase";
import { anthropic } from "@/lib/anthropic";
import { sendSMS, startTyping } from "@/lib/linq";
import { inferTimezoneFromPhone } from "@/lib/timezone";
import { trackEvent } from "@/lib/track";
import crypto from "crypto";

// Allow up to 60s for image fetch + Claude vision + coach response
export const maxDuration = 60;

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
  const body = textPart?.value?.trim() || "";

  // Detect image/media parts. Linq may use type "image", "media", or "mms".
  // Value may be in p.value, p.url, or p.media_url — try all three.
  const imagePart = parts.find(
    (p: { type: string }) => p.type === "image" || p.type === "media" || p.type === "mms"
  );
  const imageUrl: string | null = imagePart
    ? (imagePart.value || imagePart.url || imagePart.media_url || null)
    : null;

  // Log the full parts array whenever a non-text part is present so we can
  // verify the field names against real Linq MMS payloads.
  if (imagePart || (!body && parts.length > 0)) {
    console.log("[linq-webhook] non-text parts detected:", JSON.stringify(parts));
  }

  console.log("[linq-webhook] parsed:", {
    senderPhone,
    body: body.slice(0, 50),
    messageId,
    hasImage: !!imageUrl,
  });

  if (!senderPhone) {
    console.warn("[linq-webhook] missing senderPhone, skipping");
    return NextResponse.json({ ok: true });
  }

  if (!body && !imageUrl) {
    console.warn("[linq-webhook] no text or image found in message, skipping");
    return NextResponse.json({ ok: true });
  }

  // Return 200 immediately, process in background
  after(async () => {
    try {
      await handleInboundMessage(senderPhone, body, imageUrl, messageId, payloadChatId);
    } catch (err) {
      console.error("[linq-webhook] async processing error:", err);
    }
  });

  return NextResponse.json({ ok: true });
}

async function handleInboundMessage(
  senderPhone: string,
  body: string,
  imageUrl: string | null,
  messageId: string | null,
  payloadChatId: string | null
) {
  // Fire typing indicator immediately — before any DB operations.
  // payloadChatId is already extracted from the webhook payload so there's no
  // reason to wait 1-2s for user lookup / creation before the indicator appears.
  if (payloadChatId) {
    void startTyping(payloadChatId);
    // Keep refreshing every 4.5s — Linq auto-clears "..." after ~5-10s without a refresh.
    // We fire 4 times to cover up to ~18s (goal step with web search can take that long).
    void (async (id: string) => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 4500));
        void startTyping(id);
      }
    })(payloadChatId);
  }

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

  // Look up user by phone number.
  // Use maybeSingle() so "no rows" returns { data: null, error: null } rather
  // than a PGRST116 error — that lets us distinguish "user not found" from a
  // real DB error (e.g. missing column) without falling into the insert path.
  const { data: user, error: lookupError } = await supabase
    .from("users")
    .select("id, onboarding_step, timezone, linq_chat_id")
    .eq("phone_number", senderPhone)
    .maybeSingle();

  if (lookupError) {
    console.error("[linq-webhook] user lookup failed — aborting to avoid spurious insert:", lookupError);
    return;
  }

  if (!user) {
    console.log("[linq-webhook] new user, creating:", senderPhone);

    const { data: newUser, error } = await supabase
      .from("users")
      .insert({
        phone_number: senderPhone,
        onboarding_step: "awaiting_goal",
        timezone: inferTimezoneFromPhone(senderPhone),
      })
      .select("id")
      .single();

    if (error || !newUser) {
      console.error("[linq-webhook] error creating user:", error);
      return;
    }

    void trackEvent(newUser.id, "onboarding_started");
    void trackEvent(newUser.id, "message_received", { has_image: !!imageUrl });

    // Persist chatId for future messages (typing indicator started above already)
    if (payloadChatId) {
      void supabase.from("users").update({ linq_chat_id: payloadChatId }).eq("id", newUser.id);
    }

    // For new users, images before onboarding are unusual — treat as no message
    // and let onboarding start normally.
    const messageBody = body || (imageUrl ? "[Workout image received]" : "");
    await supabase.from("conversations").insert({
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

  void trackEvent(user.id, "message_received", { has_image: !!imageUrl });

  // Image message from an onboarded user: extract workout and generate feedback.
  // Images during onboarding are unexpected — fall through to text path.
  if (imageUrl && !user.onboarding_step) {
    await handleImageWorkout(user.id, senderPhone, imageUrl, body || null, messageId, (user.timezone as string) || "America/New_York", resolvedChatId);
    return;
  }

  // --- Text message path (existing flow) ---
  const messageBody = body || "[Image received]";

  const { data: storedMsg } = await supabase
    .from("conversations")
    .insert({
      user_id: user.id,
      role: "user",
      content: messageBody,
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
      body: JSON.stringify({ userId: user.id, message: messageBody, chatId: resolvedChatId }),
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
    await supabase.from("conversations").insert({
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
  await supabase.from("conversations").insert({
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
      summary: extracted as unknown as Record<string, unknown>,
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
    supabase.from("conversations").insert({
      user_id: userId,
      role: "assistant",
      content: message,
      message_type: "coach_response",
      external_message_id: messageId,
    }),
  ]);
}
