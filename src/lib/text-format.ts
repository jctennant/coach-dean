/**
 * Deterministic replacement for the PUNCTUATION prompt rule (cap at one em dash
 * per message) — that rule kept losing to the model's default "clause — payoff"
 * habit even after being tightened twice (2026-07-20, 2026-07-21), including
 * back-to-back messages with two or three em dashes each. Prompt text alone
 * wasn't a strong enough constraint, so this makes zero em dashes structurally
 * guaranteed instead of relying on Claude to remember a style rule turn after
 * turn.
 *
 * Em dashes come in two grammatically different shapes, and they need different
 * replacements:
 *
 *   TERMINAL (one dash in a sentence) — a clause followed by its payoff. Becomes
 *   two sentences: "Easy pace today — the legs need it." → "Easy pace today. The
 *   legs need it."
 *
 *   PAIRED (two dashes in one sentence) — an interruption inside a sentence that
 *   continues afterward. Becomes commas: "If there's soreness — even at rest —
 *   cross-train." → "If there's soreness, even at rest, cross-train."
 *
 * Before 2026-08-16 every dash took the terminal path, so a paired dash was
 * shattered into a fragment plus orphans — the athlete received "If there's any
 * soreness still hanging around. Even at rest. Cross-training only this week."
 * where a complete sentence was written. Periods are handled per sentence so a
 * message mixing both shapes gets each one right.
 */

/** Split into sentences, keeping each terminator attached to its sentence. */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?…]*(?:[.!?…]+|$)/g)?.filter((s) => s.length > 0) ?? [text];
}

/** "X — Y" → "X. Y" with Y recapitalized. */
function terminalSplit(before: string, after: string): string {
  const head = before.trim();
  const tail = after.trim();
  // No clause before the dash — the payoff now opens the sentence, so it capitalizes.
  if (!head) return tail ? `${tail.charAt(0).toUpperCase()}${tail.slice(1)}` : tail;
  if (!tail) return head;
  const needsPeriod = !/[.!?:,]$/.test(head);
  return `${head}${needsPeriod ? "." : ""} ${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
}

/** "X — Y — Z" → "X, Y, Z" — the interruption stays inside the sentence. */
function parentheticalJoin(before: string, inner: string, after: string): string {
  const head = before.trim().replace(/[,;:]$/, "");
  const mid = inner.trim().replace(/^[,;:]|[,;:]$/g, "");
  const tail = after.trim().replace(/^[,;:]\s*/, "");
  if (!mid) return terminalSplit(head, tail);
  if (!head) return `${mid.charAt(0).toUpperCase()}${mid.slice(1)}, ${tail}`.trim();
  if (!tail) return `${head}, ${mid}`;
  return `${head}, ${mid}, ${tail}`;
}

function normalizeSentence(sentence: string): string {
  const parts = sentence.split("—");
  if (parts.length === 1) return sentence;

  // Consume dashes in pairs (parenthetical) and fall back to a terminal split for
  // a trailing odd one. An even count is entirely paired; an odd count is pairs
  // followed by one clause-payoff dash.
  let result = parts[0];
  let i = 1;
  while (i < parts.length) {
    const remaining = parts.length - i;
    if (remaining >= 2) {
      result = parentheticalJoin(result, parts[i], parts[i + 1]);
      i += 2;
    } else {
      result = terminalSplit(result, parts[i]);
      i += 1;
    }
  }
  return result;
}

export function normalizeEmDashes(text: string): string {
  if (!text.includes("—")) return text;
  // Per line, so a session list's line structure survives; per sentence within a
  // line, so pairing is judged inside one sentence rather than across the message.
  return text
    .split("\n")
    .map((line) =>
      line.includes("—")
        ? splitSentences(line)
            .map((s) => {
              const lead = s.match(/^\s*/)?.[0] ?? "";
              const trail = s.match(/\s*$/)?.[0] ?? "";
              return lead + normalizeSentence(s.trim()) + trail;
            })
            .join("")
        : line
    )
    .join("\n");
}
