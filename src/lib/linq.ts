const LINQ_CHATS_URL = "https://api.linqapp.com/api/partner/v3/chats";

function getConfig() {
  if (!process.env.LINQ_API_KEY)
    throw new Error("Missing LINQ_API_KEY");
  if (!process.env.LINQ_PHONE_NUMBER)
    throw new Error("Missing LINQ_PHONE_NUMBER");

  return {
    apiKey: process.env.LINQ_API_KEY,
    from: process.env.LINQ_PHONE_NUMBER,
  };
}

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Send an SMS/iMessage via Linq.
 * Returns the chatId extracted from the response (null if not present or on error).
 * The chatId is used for typing indicators and read receipts.
 */
export async function sendSMS(
  to: string,
  body: string
): Promise<{ chatId: string | null }> {
  const { apiKey, from } = getConfig();

  const response = await fetch(LINQ_CHATS_URL, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      from,
      to: [to],
      message: {
        parts: [
          {
            type: "text",
            value: body,
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Linq API error:", response.status, errorText);
    throw new Error(`Linq API error: ${response.status}`);
  }

  const json = await response.json();

  // Log the full response so we can confirm the correct field name against real payloads.
  console.log("[linq] sendSMS response:", JSON.stringify(json));

  // Try common field name patterns. Linq sends `to` as an array so the response
  // may be an array or nested under data[]. Try both top-level and array shapes.
  const first = Array.isArray(json) ? json[0] : (json?.data?.[0] ?? json?.chats?.[0] ?? null);
  const chatId: string | null =
    json?.chat_id ??
    json?.chatId ??
    json?.chat?.id ??
    first?.chat_id ??
    first?.chatId ??
    first?.chat?.id ??
    first?.id ??
    json?.id ??
    null;

  console.log("[linq] sendSMS chatId resolved:", chatId);

  return { chatId };
}

/**
 * Show a typing indicator in the user's iMessage thread.
 * Call this before starting to generate a response.
 * The indicator is automatically cleared when a message is sent.
 */
export async function startTyping(chatId: string): Promise<void> {
  const { apiKey } = getConfig();
  try {
    const res = await fetch(`${LINQ_CHATS_URL}/${chatId}/typing`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    if (!res.ok) {
      console.warn("[linq] startTyping failed:", res.status, await res.text());
    } else {
      console.log("[linq] startTyping ok:", res.status);
    }
  } catch (err) {
    console.error("[linq] startTyping error:", err);
  }
}

/**
 * Share Coach Dean's contact card in a chat so the user can save him as a contact.
 * The contact card must be configured in the Linq dashboard first.
 * No request body needed — just POST to the endpoint.
 */
export async function shareContactCard(chatId: string): Promise<void> {
  const { apiKey } = getConfig();
  try {
    const res = await fetch(`${LINQ_CHATS_URL}/${chatId}/share_contact_card`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    if (!res.ok) {
      console.warn("[linq] shareContactCard failed:", res.status, await res.text());
    } else {
      console.log("[linq] shareContactCard ok:", res.status);
    }
  } catch (err) {
    console.error("[linq] shareContactCard error:", err);
  }
}

/**
 * Mark all messages in a chat as read.
 * Call this when we receive an inbound message so the user sees a read receipt.
 */
export async function markRead(chatId: string): Promise<void> {
  const { apiKey } = getConfig();
  try {
    const res = await fetch(`${LINQ_CHATS_URL}/${chatId}/read`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    if (!res.ok) {
      console.warn("[linq] markRead failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[linq] markRead error:", err);
  }
}

/**
 * Calculate how long the typing indicator should be visible based on
 * the length of the message Dean is about to send.
 *
 * Returns the *target* duration in ms. Subtract however long generation
 * already took to get the remaining wait before sending.
 *
 * Calibrated so short replies feel snappy and longer ones feel considered:
 *   100 chars  → ~1.5s
 *   250 chars  → ~2.5s
 *   500 chars  → ~5.0s
 *   800+ chars → 8.0s (cap)
 */
export function typingDurationMs(messageLength: number): number {
  return Math.min(8000, Math.max(1500, messageLength * 10));
}
