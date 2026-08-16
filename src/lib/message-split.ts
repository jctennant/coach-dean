/**
 * Split a reply into iMessage-sized bubbles.
 *
 * Strategy:
 *   1. Split on blank lines (paragraph breaks) — ALWAYS, regardless of total length.
 *      A blank line is the author's explicit "this is a new text", so it is honored
 *      whether the whole reply is 200 characters or 900.
 *   2. If any resulting bubble still exceeds MAX_MSG_CHARS, split it further at
 *      sentence boundaries as a fallback.
 *
 * Each chunk is sent as a separate text message with its own typing indicator, so it
 * reads like a real person sending a few short follow-up texts instead of one long
 * block. Shared by coach/respond and onboarding/handle so both SMS-sending paths
 * break up replies the same way.
 *
 * Before 2026-08-16 this early-returned the whole string whenever it was under
 * MAX_MSG_CHARS, which silently merged paragraph breaks back into one bubble — the
 * coaching prompt tells Dean he can split into 2-3 messages with a blank line, and
 * for any reply under the limit (i.e. most of them) the transport was undoing it.
 * onboarding/handle had already grown a local `forceParagraphSplit` flag to work
 * around exactly this; that flag is gone now that the default behavior is correct.
 */
export const MAX_MSG_CHARS = 320;

export function splitIntoMessages(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks: string[] = [];

  // Blank lines are bubble boundaries, always. Each paragraph starts its own bubble;
  // paragraphs are never merged together, even when two short ones would fit in one.
  for (const para of trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    // Multi-line blocks are structured lists (the one-session-per-line schedule format
    // the coaching prompt mandates). The prompt tells Dean to keep those as one
    // unbroken block, so they are never sentence-split, even over the limit — a
    // schedule fragmented mid-list is worse than a single long bubble.
    if (para.length <= MAX_MSG_CHARS || para.includes("\n")) {
      chunks.push(para);
      continue;
    }
    // Overlong single-paragraph prose — fall back to packing sentences up to the limit.
    const sentences = para.match(/[^.!?…]+(?:[.!?…]+\s*|$)/g) ?? [para];
    let current = "";
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
    if (current) chunks.push(current);
  }

  return chunks.filter((c) => c.length > 0);
}
