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
