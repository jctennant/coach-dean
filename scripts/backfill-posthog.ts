/**
 * One-time script: replay all existing Supabase events into PostHog.
 * Preserves original timestamps so events appear at the correct point in time.
 *
 * Usage:
 *   npx tsx scripts/backfill-posthog.ts
 */

import { PostHog } from "posthog-node";
import { createClient } from "@supabase/supabase-js";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!POSTHOG_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing env vars. Make sure .env.local is loaded.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ph = new PostHog(POSTHOG_KEY, {
  host: "https://us.i.posthog.com",
  flushAt: 100,
  flushInterval: 0,
});

async function run() {
  let offset = 0;
  const pageSize = 500;
  let total = 0;

  while (true) {
    const { data, error } = await supabase
      .from("events")
      .select("user_id, event_name, properties, created_at")
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error("Supabase error:", error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      ph.capture({
        distinctId: row.user_id,
        event: row.event_name,
        properties: row.properties ?? {},
        timestamp: new Date(row.created_at),
      });
    }

    total += data.length;
    console.log(`Queued ${total} events...`);
    offset += pageSize;
    if (data.length < pageSize) break;
  }

  await ph.shutdown();
  console.log(`Done — ${total} events sent to PostHog.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
