/**
 * Deterministic replacement for the PUNCTUATION prompt rule (cap at one em dash
 * per message) — that rule kept losing to the model's default "clause — payoff"
 * habit even after being tightened twice (2026-07-20, 2026-07-21), including
 * back-to-back messages with two or three em dashes each. Prompt text alone
 * wasn't a strong enough constraint, so this makes zero em dashes structurally
 * guaranteed instead of relying on Claude to remember a style rule turn after
 * turn. Every "X — Y" is split into "X. Y" (Y recapitalized) — this matches the
 * dominant real-world pattern (a clause followed by its payoff/elaboration as a
 * separate sentence).
 */
export function normalizeEmDashes(text: string): string {
  if (!text.includes("—")) return text;
  return text
    .split("—")
    .map((part, i) => {
      const trimmed = part.trim();
      if (i === 0) return trimmed;
      return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
    })
    .reduce((acc, part) => {
      if (!acc) return part;
      if (!part) return acc;
      const needsPeriod = !/[.!?:,]$/.test(acc.trim());
      return `${acc}${needsPeriod ? "." : ""} ${part}`;
    }, "");
}
