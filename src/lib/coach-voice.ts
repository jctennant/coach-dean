/**
 * Dean's voice: who he sounds like, and when humor is allowed.
 *
 * The persona target is a coach five to ten years older than the athlete — enough
 * experience to be trusted, close enough in age to text like a peer rather than an
 * institution. Warm when the moment earns it, dry rather than jokey, never deferential.
 *
 * The humor rules are lifted from Poke's leaked prompt, which throttles humor rather
 * than encouraging it ("never force jokes when a normal response would be more
 * appropriate", "never make multiple jokes in a row unless the user reacts positively
 * or jokes back"). Poke can afford an unthrottled bit because it's a general assistant
 * with no stakes. Dean has stakes: a punchline landing on "my shin is killing me" is
 * not a tone miss, it's a trust failure. So the throttle here is structural, not
 * instructional — `computeHumorGate` reads context the system already knows (injury,
 * pain, race proximity, whether there's any rapport yet) and the prompt block simply
 * doesn't invite humor when the gate is closed. The model is never asked to read the
 * room on its own.
 */

export interface VoiceContext {
  /** Athlete has a flagged active injury on their profile. */
  activeInjury: boolean;
  /** Athlete is on an injury hold (no running prescribed). */
  injuryHold: boolean;
  /** Athlete raised pain/soreness/injury on this turn specifically. */
  askedAboutInjury: boolean;
  /** Days until the primary race, if there is one. */
  daysUntilRace: number | null;
  /** Total prior messages exchanged — a proxy for whether any rapport exists yet. */
  messageCount: number;
}

/**
 * Build a VoiceContext from the raw rows route.ts already has in scope. Lives here so
 * the prompt-building site and the send-time gate derive the gate from one definition
 * instead of two hand-kept copies that can drift apart.
 */
export function buildVoiceContext(params: {
  profile: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
  upcomingRaces?: Array<Record<string, unknown>>;
  askedAboutInjury?: boolean;
  messageCount: number;
  /** IANA timezone, for computing days-until-race in the athlete's local day. */
  timezone: string;
}): VoiceContext {
  const raceDate = params.upcomingRaces?.[0]?.race_date;
  let daysUntilRace: number | null = null;
  if (typeof raceDate === "string" && raceDate) {
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: params.timezone }).format(new Date());
    const raceMs = new Date(`${raceDate.slice(0, 10)}T12:00:00Z`).getTime();
    const todayMs = new Date(`${todayStr}T12:00:00Z`).getTime();
    if (!Number.isNaN(raceMs)) daysUntilRace = Math.round((raceMs - todayMs) / 86_400_000);
  }
  return {
    activeInjury: !!params.profile?.active_injury,
    injuryHold: !!params.state?.injury_hold_since,
    askedAboutInjury: !!params.askedAboutInjury,
    daysUntilRace,
    messageCount: params.messageCount,
  };
}

export interface HumorGate {
  allowed: boolean;
  /** Why humor is suppressed — for telemetry and for the voice validator. */
  reason: string | null;
}

/** Rapport threshold: humor from a near-stranger reads as a bit, not as warmth. */
const RAPPORT_MIN_MESSAGES = 6;
/** Race week — the athlete is nervous and wants competence, not comedy. */
const RACE_PROXIMITY_DAYS = 7;

export function computeHumorGate(ctx: VoiceContext): HumorGate {
  if (ctx.injuryHold) return { allowed: false, reason: "injury_hold" };
  if (ctx.activeInjury) return { allowed: false, reason: "active_injury" };
  if (ctx.askedAboutInjury) return { allowed: false, reason: "pain_raised_this_turn" };
  if (ctx.daysUntilRace !== null && ctx.daysUntilRace >= 0 && ctx.daysUntilRace <= RACE_PROXIMITY_DAYS) {
    return { allowed: false, reason: "race_week" };
  }
  if (ctx.messageCount < RAPPORT_MIN_MESSAGES) return { allowed: false, reason: "no_rapport_yet" };
  return { allowed: true, reason: null };
}

/**
 * The VOICE block. Deliberately short — per CLAUDE.md, persona belongs in one concise
 * place rather than accumulating as rules scattered across triggers.
 */
export function buildVoiceBlock(gate: HumorGate): string {
  const humor = gate.allowed
    ? `HUMOR — allowed here, but throttled:
- Dry and understated. A wry aside, not a setup and punchline. Original, never a joke anyone has heard before.
- One at most, and only when a normal response wouldn't land better. If the last thing you said was already light, play this one straight.
- Never two in a row unless the athlete jokes back first. If they answer flatly, drop it and stay dropped.
- Never at the athlete's expense, and never about their pace, weight, body, or a session they missed.
- Never announce it ("here's a joke", "lol"). If it isn't funny on its own it isn't funny.`
    : `HUMOR — not here. This turn is about ${humorSuppressionPhrase(gate.reason)}. Be warm and human, but play it straight. A joke lands badly on this and reads as not listening.`;

  return `VOICE:
You're a coach five to ten years older than this athlete. You've been at this long enough that nothing surprises you, and you talk like it — direct, unhurried, no need to prove anything. You're texting a person you know, not writing them a report.
- Warmth is earned, not default. When they do something genuinely good, say so plainly and specifically. When they don't, don't reach for something nice to say. Never flatter, never gush, never open with praise as a social lubricant.
- Confident, not deferential. You have an opinion. Give it. Don't hedge every call or hand decisions back to them that they're paying you to make.
- Contractions, plain words, short sentences. Never corporate ("circle back", "reach out", "happy to help"), never customer-service ("I apologize for any confusion", "Great question!").
- Say the thing. Don't preface it, don't recap it afterward, don't ask permission to say it.

${humor}`;
}

function humorSuppressionPhrase(reason: string | null): string {
  switch (reason) {
    case "injury_hold":
    case "active_injury":
      return "an injury they're actively dealing with";
    case "pain_raised_this_turn":
      return "pain they just raised with you";
    case "race_week":
      return "a race that's days away";
    case "no_rapport_yet":
      return "an athlete you barely know yet";
    default:
      return "something that needs a straight answer";
  }
}
