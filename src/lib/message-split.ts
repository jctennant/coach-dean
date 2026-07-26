/**
 * Split a long reply into iMessage-sized chunks (≤ MAX_MSG_CHARS each).
 *
 * Strategy:
 *   1. Split on blank lines (paragraph breaks) — prompts are written to use these.
 *   2. If any paragraph still exceeds MAX_MSG_CHARS, split further at sentence boundaries.
 *
 * Each chunk is meant to be sent as a separate text message with its own typing
 * indicator, so it feels like a real person sending a few short follow-up texts
 * instead of one long block. Shared by coach/respond and onboarding/handle so both
 * SMS-sending paths break up long replies the same way.
 */
export const MAX_MSG_CHARS = 480;

export function splitIntoMessages(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_MSG_CHARS) return [trimmed];

  const chunks: string[] = [];
  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  let current = "";

  for (const para of paragraphs) {
    if (para.length > MAX_MSG_CHARS) {
      // Flush current buffer first
      if (current) { chunks.push(current); current = ""; }

      // Split long paragraph at sentence boundaries
      const sentences = para.match(/[^.!?…]+(?:[.!?…]+\s*|$)/g) ?? [para];
      for (const raw of sentences) {
        const s = raw.trim();
        if (!s) continue;
        if (!current) {
          current = s;
        } else if (current.length + 1 + s.length <= MAX_MSG_CHARS) {
          current += " " + s;
        } else {
          chunks.push(current);
          current = s;
        }
      }
    } else if (!current) {
      current = para;
    } else if (current.length + 2 + para.length <= MAX_MSG_CHARS) {
      // Fits in the same bubble — join with a single newline (not blank line)
      current += "\n" + para;
    } else {
      chunks.push(current);
      current = para;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.length > 0);
}
