/**
 * Output shaping — makes reply length a decision Dean commits to BEFORE writing,
 * then enforces it in code.
 *
 * Background: brevity was previously prompt-only ("Keep responses under 480
 * characters", COMMUNICATION STYLE in coach/respond). Nothing checked it, so it
 * degraded the way every uncheckable instruction degrades. Compare `stated_facts`,
 * where the model echoes its numbers, code compares them to ground truth, and a
 * mismatch costs one retry — facts got a mechanism, length got a sentence.
 *
 * This is the same mechanism applied to shape. `deliver_message` takes a required
 * `shape` argument; Dean picks it first, writes to it, and `checkShape` rejects a
 * message that blows its own declared budget. The point is not the character count —
 * it's that choosing a shape is a separate, explicit act from writing prose, which is
 * the "output-shaping step" that persona prompts alone don't reliably produce.
 *
 * Deliberately NOT a hard truncation: cutting a coach's message mid-sentence can drop
 * an injury instruction. Over-budget costs one focused rewrite, and if that fails the
 * original sends (fail-open, matching response-gate.ts and the fact gate).
 */

/** Reply shapes, smallest first. Budgets are per whole message, across all bubbles. */
export const SHAPE_BUDGETS = {
  /** One line, no analysis. Acknowledgments, confirmations, quick answers. */
  ack: 120,
  /** A couple of sentences — one observation or one answer. The common case. */
  brief: 320,
  /** Multi-bubble. Plans, recaps, genuine multi-part questions, injury guidance. */
  full: 700,
} as const;

export type MessageShape = keyof typeof SHAPE_BUDGETS;

export const SHAPE_NAMES = Object.keys(SHAPE_BUDGETS) as MessageShape[];

export function isMessageShape(v: unknown): v is MessageShape {
  return typeof v === "string" && (SHAPE_NAMES as string[]).includes(v);
}

/**
 * A shape budget is only meaningful if it's the model's own commitment, so an absent
 * or unrecognized shape is not silently coerced to the strictest one — it falls back
 * to `full` (no effective constraint) and the caller logs it. Guessing tight on a
 * missing field would truncate injury guidance.
 */
export function resolveShape(raw: unknown): { shape: MessageShape; declared: boolean } {
  return isMessageShape(raw) ? { shape: raw, declared: true } : { shape: "full", declared: false };
}

export interface ShapeViolation {
  shape: MessageShape;
  budget: number;
  actual: number;
}

/**
 * Compare a delivered message against its declared shape budget. Returns null when it
 * fits. A 10% grace band absorbs the model landing a few characters over a target it
 * otherwise respected — the goal is catching paragraphs sent as `ack`, not policing
 * a 6-character overrun into a retry that costs a round-trip.
 */
export function checkShape(message: string, shape: MessageShape): ShapeViolation | null {
  const actual = message.trim().length;
  const budget = SHAPE_BUDGETS[shape];
  if (actual <= Math.ceil(budget * 1.1)) return null;
  return { shape, budget, actual };
}

/**
 * tool_result text handed back to Dean on an over-budget delivery. Names the concrete
 * overrun and points at what to cut, and explicitly protects the safety content — a
 * "make it shorter" instruction with no carve-out is exactly how an injury gate
 * question gets dropped.
 */
export function buildShapeCorrection(v: ShapeViolation): string {
  return (
    `Rejected: you declared shape "${v.shape}" (budget ${v.budget} characters) but the message is ` +
    `${v.actual} characters.\n\n` +
    `Re-deliver it. Either cut it to fit ${v.budget}, or — if the content genuinely requires the ` +
    `space — call deliver_message again with the shape that honestly matches what you need to say.\n\n` +
    `Cut in this order: sign-offs and closing invitations, restated numbers the athlete can already ` +
    `see, context they didn't ask for, generic encouragement. Keep every pace, distance, date, and ` +
    `any injury or safety question exactly as written — those are never what makes a message too long.`
  );
}

/**
 * The athlete's own texting register, computed from their recent inbound messages.
 *
 * From Poke's leaked prompt: "Match response length to the user's messaging style. If
 * user sends few words, don't respond with multiple sentences." Stated as a prompt
 * rule that's a vibe; the input is right there in the conversation table, so it's
 * computed here and passed in as a fact instead.
 *
 * Returns null when there isn't enough signal to say anything — an absent block is
 * better than a confidently wrong one.
 */
export function inferAthleteStyle(recentInboundTexts: string[]): string | null {
  const texts = recentInboundTexts.map((t) => t.trim()).filter(Boolean).slice(-8);
  if (texts.length < 3) return null;

  const avgWords =
    texts.reduce((sum, t) => sum + t.split(/\s+/).length, 0) / texts.length;
  const usesEmoji = texts.some((t) => /\p{Extended_Pictographic}/u.test(t));

  const register =
    avgWords <= 4
      ? "Very terse — a few words per message. Match it: one short line back, no elaboration unless they asked a real question."
      : avgWords <= 15
      ? "Conversational and fairly short. Match it: a sentence or two is the right size for a normal reply."
      : "Writes longer, detailed messages. They'll read a fuller reply, but still lead with the answer.";

  const emojiLine = usesEmoji
    ? "They use emoji, so an occasional one back reads natural."
    : "They don't use emoji. Don't use any.";

  return `HOW THIS ATHLETE TEXTS (from their recent messages — mirror it):\n${register}\n${emojiLine}`;
}
