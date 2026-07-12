/**
 * Temporary kill-switch: while RESTRICT_TO_PHONES is set (comma-separated
 * E.164 numbers), every cron that fires coach/respond or calls the LLM
 * directly is scoped to just those phone numbers. Unset the env var to
 * resume normal operation for all users.
 */
export function getRestrictedPhones(): string[] | null {
  const raw = process.env.RESTRICT_TO_PHONES;
  if (!raw || !raw.trim()) return null;
  const phones = raw.split(",").map((p) => p.trim()).filter(Boolean);
  return phones.length > 0 ? phones : null;
}
