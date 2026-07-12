import { anthropic } from "@/lib/anthropic";

/**
 * Convert a city/location string to an IANA timezone string using Claude Haiku.
 * Returns null if no location is detected or the result is ambiguous.
 */
export async function parseTimezoneFromLocation(location: string): Promise<string | null> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    system: `Convert the location in this message to an IANA timezone string. Return ONLY the IANA string. If no location is mentioned, return "none".

Examples:
- "San Francisco" → "America/Los_Angeles"
- "Provo, UT" → "America/Denver"
- "Denver" → "America/Denver"
- "Chicago" → "America/Chicago"
- "Columbus, OH" → "America/New_York"
- "Detroit" → "America/Detroit"
- "Indianapolis" → "America/Indiana/Indianapolis"
- "Nashville" → "America/Chicago"
- "Dallas" → "America/Chicago"
- "New York" → "America/New_York"
- "Boston" → "America/New_York"
- "Miami" → "America/New_York"
- "Seattle" → "America/Los_Angeles"
- "Phoenix" → "America/Phoenix"
- "Honolulu" → "Pacific/Honolulu"
- "Anchorage" → "America/Anchorage"`,
    messages: [{ role: "user", content: location }],
  });
  const raw =
    response.content[0].type === "text" ? response.content[0].text.trim() : "none";
  if (raw === "none") return null;
  // Accept single-slash (e.g. America/Denver) and double-slash (e.g. America/Indiana/Indianapolis)
  return /^[A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/.test(raw) ? raw : null;
}

/**
 * Infer an IANA timezone from an E.164 phone number's country code.
 * Country codes that span multiple timezones (e.g. +1 US/Canada) default
 * to the most populated timezone — good enough for scheduling purposes.
 */
export function inferTimezoneFromPhone(phone: string): string {
  if (phone.startsWith("+44"))  return "Europe/London";
  if (phone.startsWith("+353")) return "Europe/Dublin";
  if (phone.startsWith("+61"))  return "Australia/Sydney";
  if (phone.startsWith("+64"))  return "Pacific/Auckland";
  if (phone.startsWith("+49"))  return "Europe/Berlin";
  if (phone.startsWith("+33"))  return "Europe/Paris";
  if (phone.startsWith("+39"))  return "Europe/Rome";
  if (phone.startsWith("+34"))  return "Europe/Madrid";
  if (phone.startsWith("+31"))  return "Europe/Amsterdam";
  if (phone.startsWith("+46"))  return "Europe/Stockholm";
  if (phone.startsWith("+47"))  return "Europe/Oslo";
  if (phone.startsWith("+45"))  return "Europe/Copenhagen";
  if (phone.startsWith("+41"))  return "Europe/Zurich";
  if (phone.startsWith("+43"))  return "Europe/Vienna";
  if (phone.startsWith("+32"))  return "Europe/Brussels";
  if (phone.startsWith("+81"))  return "Asia/Tokyo";
  if (phone.startsWith("+82"))  return "Asia/Seoul";
  if (phone.startsWith("+86"))  return "Asia/Shanghai";
  if (phone.startsWith("+852")) return "Asia/Hong_Kong";
  if (phone.startsWith("+91"))  return "Asia/Kolkata";
  if (phone.startsWith("+65"))  return "Asia/Singapore";
  if (phone.startsWith("+971")) return "Asia/Dubai";
  if (phone.startsWith("+27"))  return "Africa/Johannesburg";
  if (phone.startsWith("+55"))  return "America/Sao_Paulo";
  if (phone.startsWith("+52"))  return "America/Mexico_City";
  if (phone.startsWith("+1"))   return "America/New_York"; // US/Canada
  return "America/New_York";
}

export interface DateFacts {
  today: string;
  yesterday: string;
  tomorrow: string;
}

/**
 * Compute today/yesterday/tomorrow (as full weekday + date strings) for the
 * given IANA timezone. Single source of truth for the two consumers that need
 * these exact strings to agree with each other: formatDateAnchor (prepended to
 * every generation turn) and checkDateConsistency (the advisory validator that
 * runs on the output, in date-consistency-check.ts).
 */
export function getDateFacts(tz: string): DateFacts {
  const now = new Date();
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const [y, m, d] = todayLocal.split("-").map(Number);
  // The y/m/d above are already the correct *local* calendar date — Date.UTC just
  // encodes them unambiguously so we can add/subtract days without DST edge cases.
  // Formatting must read them back with timeZone: "UTC", NOT the original tz: since
  // the value is midnight UTC of that date, re-applying tz here would shift it by
  // that zone's offset a second time. For any timezone behind UTC (all of the
  // Americas), that silently rolls the result back a full day — e.g. "tomorrow" in
  // America/New_York would print as today, and "yesterday" would print as two days
  // ago. This is the same reconstruction pattern used in buildSystemPrompt's
  // dateContext (route.ts) — fixed there too.
  const dayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  return {
    yesterday: dayFormatter.format(new Date(Date.UTC(y, m - 1, d - 1))),
    today: dayFormatter.format(new Date(Date.UTC(y, m - 1, d))),
    tomorrow: dayFormatter.format(new Date(Date.UTC(y, m - 1, d + 1))),
  };
}

/**
 * Compact "today/tomorrow" anchor for the given IANA timezone.
 *
 * The full DATE CONTEXT block (today, yesterday, tomorrow, next 7 days, race
 * countdown, etc.) lives early in the system prompt in coach/respond/route.ts.
 * That's fine for a direct "what day is it?" question, but it sits far ahead
 * of the trigger-specific generation instructions in the token stream — by
 * the time the model is composing relative-day language ("today", "tomorrow",
 * "Monday or Tuesday"), that anchor can get lost in the middle and the model
 * ends up improvising day arithmetic instead of reading it off a fact.
 *
 * This helper re-states just the two facts that matter for that failure mode,
 * meant to be prepended to the per-turn user message (right next to where
 * generation actually happens) rather than relying solely on the earlier,
 * more detailed system-prompt block.
 */
export function formatDateAnchor(tz: string): string {
  const { today, tomorrow } = getDateFacts(tz);
  return `[DATE ANCHOR — Today: ${today}. Tomorrow: ${tomorrow}. Any "today"/"tomorrow"/weekday reference in your reply must be consistent with these two facts — do not infer the day from earlier conversation turns or from relative math like "a few days from Friday."]`;
}
