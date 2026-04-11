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
