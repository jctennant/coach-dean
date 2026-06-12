#!/usr/bin/env node
/**
 * One-off probe to confirm Linq's OUTBOUND media schema before we build the send path
 * into linq.ts. Sends a single text + image message and prints the full API response.
 *
 * Usage (Node 20.6+ for --env-file):
 *   node --env-file=.env.local scripts/test-linq-media.mjs +1XXXXXXXXXX
 *
 * The inbound webhook parses media as parts of type "media"/"image"/"mms" with a
 * `mime_type` and the URL in `url` | `value` | `media_url`. Outbound is assumed
 * symmetric: a `{ type: "media", url, mime_type }` part alongside the text part.
 * If Linq rejects that shape, the error body tells us the real field name and we adjust.
 */

const LINQ_CHATS_URL = "https://api.linqapp.com/api/partner/v3/chats";
const TEST_IMAGE = "https://placehold.co/600x400/1a5c35/ffffff/png?text=Coach+Dean+test";

const to = process.argv[2];
if (!to) {
  console.error("Pass a destination phone number, e.g. node --env-file=.env.local scripts/test-linq-media.mjs +14155550123");
  process.exit(1);
}
const apiKey = process.env.LINQ_API_KEY;
const from = process.env.LINQ_PHONE_NUMBER;
if (!apiKey || !from) {
  console.error("Missing LINQ_API_KEY or LINQ_PHONE_NUMBER (run with --env-file=.env.local)");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

// Candidate part shapes to try, in order. First one that returns 2xx wins.
const candidates = [
  { label: "type:media + url + mime_type", part: { type: "media", url: TEST_IMAGE, mime_type: "image/png" } },
  { label: "type:image + url + mime_type", part: { type: "image", url: TEST_IMAGE, mime_type: "image/png" } },
  { label: "type:media + value + mime_type", part: { type: "media", value: TEST_IMAGE, mime_type: "image/png" } },
  { label: "type:media + media_url", part: { type: "media", media_url: TEST_IMAGE, mime_type: "image/png" } },
];

async function attempt({ label, part }) {
  const body = {
    from,
    to: [to],
    message: { parts: [{ type: "text", value: "Coach Dean media test — if you can see the image, the schema works." }, part] },
  };
  process.stdout.write(`\n── Trying: ${label}\n   payload part: ${JSON.stringify(part)}\n`);
  const res = await fetch(LINQ_CHATS_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  process.stdout.write(`   → HTTP ${res.status}\n   → body: ${text}\n`);
  return res.ok;
}

const ok = await attempt(candidates[0]);
if (!ok) {
  console.log("\nFirst shape rejected — trying fallbacks so we can read each error body:");
  for (const c of candidates.slice(1)) {
    // eslint-disable-next-line no-await-in-loop
    const success = await attempt(c);
    if (success) { console.log(`\n✅ Working shape: ${c.label}`); break; }
  }
} else {
  console.log(`\n✅ Working shape: ${candidates[0].label}`);
}
console.log("\nCheck the destination device to confirm the image actually rendered (a 2xx doesn't guarantee delivery).");
