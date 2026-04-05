/**
 * One-time admin script: send a direct message to a specific user by partial user ID.
 * Usage: node scripts/send-message-to-user.mjs <userId-prefix> "<message>"
 *
 * Example:
 *   node scripts/send-message-to-user.mjs 7a704281 "Hey Lori! Sorry for the delay..."
 */

import { createClient } from "@supabase/supabase-js";

const [, , userIdPrefix, message] = process.argv;

if (!userIdPrefix || !message) {
  console.error("Usage: node scripts/send-message-to-user.mjs <userId-prefix> \"<message>\"");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LINQ_CHATS_URL = "https://api.linqapp.com/api/partner/v3/chats";

async function sendMessage(phoneNumber, chatId, text) {
  const apiKey = process.env.LINQ_API_KEY;
  const from = process.env.LINQ_PHONE_NUMBER;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Try chat endpoint first if we have a chatId
  if (chatId) {
    const res = await fetch(`${LINQ_CHATS_URL}/${chatId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: { parts: [{ type: "text", value: text }] },
      }),
    });
    if (res.ok) {
      console.log("[linq] sent via chatId", chatId);
      return true;
    }
    console.warn("[linq] chatId send failed, falling back to phone:", res.status, await res.text());
  }

  // Fall back to creating a new chat via phone number
  const res = await fetch(LINQ_CHATS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to: [phoneNumber],
      message: { parts: [{ type: "text", value: text }] },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[linq] send failed:", res.status, json);
    return false;
  }
  console.log("[linq] sent via phone number");
  return true;
}

// Look up the user
// Fetch all users and filter client-side by ID prefix (admin script only)
const { data: allUsers, error } = await supabase
  .from("users")
  .select("id, name, phone_number, linq_chat_id");
const users = (allUsers ?? []).filter(u => u.id.startsWith(userIdPrefix));

if (error || !users?.length) {
  console.error("User not found:", error?.message ?? "no results for prefix " + userIdPrefix);
  process.exit(1);
}
if (users.length > 1) {
  console.error("Multiple users match prefix", userIdPrefix, "— be more specific:", users.map(u => u.id));
  process.exit(1);
}

const user = users[0];
console.log(`Sending to ${user.name} (${user.phone_number}) — id: ${user.id}`);
console.log(`Message: "${message}"`);

const ok = await sendMessage(user.phone_number, user.linq_chat_id, message);
if (ok) {
  // Also log to conversations table
  await supabase.from("conversations").insert({
    user_id: user.id,
    role: "assistant",
    content: message,
    message_type: "manual_admin",
  });
  console.log("Done — message sent and logged.");
} else {
  console.error("Failed to send message.");
  process.exit(1);
}
