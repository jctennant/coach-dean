// Reminder Agent — focused system prompt for morning_reminder and nightly_reminder triggers.
// Omits all analytics, training philosophy, VDOT formulas, and activity history that are
// irrelevant when Dean is just checking in or nudging the athlete about their day.

export interface SecondaryRace {
  race_name: string;
  race_date: string;
  priority: "B" | "C";
  daysUntilRace: number;
}

export interface ReminderContext {
  trigger: "morning_reminder" | "nightly_reminder";
  athleteName: string;
  goal: string;
  raceDate: string | null;
  raceName: string | null;
  daysUntilRace: number | null;
  secondaryRaces: SecondaryRace[];
  todayStr: string;
  timezone: string;
  weekNumber: number;
  totalWeeks: number | null;
  phase: string;
  weeklyMileageTarget: number;
  weekMileageSoFar: number;
  plannedSessions: Array<{ day: string; date: string; label: string }>;
  injuryNotes: string | null;
  injuryHoldActive: boolean;
  recentMessages: Array<{ role: string; content: string; created_at?: string | null }>;
  preferredUnits: "miles" | "km";
}

function fmtSessions(sessions: ReminderContext["plannedSessions"]): string {
  if (!sessions.length) return "No sessions scheduled this week.";
  return sessions.map(s => `${s.day} ${s.date}: ${s.label}`).join("\n");
}

function fmtConversation(messages: ReminderContext["recentMessages"]): string {
  const last5 = messages.slice(-5);
  if (!last5.length) return "(no recent conversation)";
  return last5
    .map(m => {
      const ts = m.created_at ? new Date(m.created_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      const speaker = m.role === "user" ? "Athlete" : "Coach";
      return `[${ts}] ${speaker}: ${m.content}`;
    })
    .join("\n");
}

export function buildReminderDynamic(ctx: ReminderContext): string {
  const unitLabel = ctx.preferredUnits === "km" ? "km" : "mi";
  const mileageSoFar = ctx.preferredUnits === "km"
    ? (ctx.weekMileageSoFar * 1.60934).toFixed(1)
    : ctx.weekMileageSoFar.toFixed(1);
  const mileageTarget = ctx.preferredUnits === "km"
    ? (ctx.weeklyMileageTarget * 1.60934).toFixed(1)
    : ctx.weeklyMileageTarget.toFixed(1);

  const raceCountdown = ctx.raceDate && ctx.daysUntilRace !== null
    ? `\nRace: ${ctx.raceName ?? "Goal race"} on ${ctx.raceDate} — ${ctx.daysUntilRace} days away.`
    : "";

  const secondaryRaceBlock = ctx.secondaryRaces.length > 0
    ? ctx.secondaryRaces.map(r => {
        if (r.priority === "B" && r.daysUntilRace <= 14) {
          return `B RACE — ${r.race_name} in ${r.daysUntilRace} days: treat like a mini-taper week. Reduce volume 10-15%, keep 1 quality session, prioritize sleep and easy days leading in.`;
        }
        if (r.priority === "B") {
          return `Upcoming B race: ${r.race_name} on ${r.race_date} (${r.daysUntilRace} days away). No taper changes yet — continue normal training.`;
        }
        if (r.priority === "C" && r.daysUntilRace <= 7) {
          return `C RACE — ${r.race_name} in ${r.daysUntilRace} days: keep it as a quality workout effort. No taper, no special prep — treat it as a hard training day.`;
        }
        return `Upcoming C race: ${r.race_name} on ${r.race_date}`;
      }).join("\n")
    : "";

  const injuryLine = ctx.injuryHoldActive
    ? "\nINJURY HOLD ACTIVE: Athlete is not running. No run-related nudges."
    : ctx.injuryNotes
    ? `\nInjury notes: ${ctx.injuryNotes}`
    : "";

  const planBlock = ctx.injuryHoldActive
    ? ""
    : `\nCURRENT WEEK (Week ${ctx.weekNumber}${ctx.totalWeeks ? ` of ${ctx.totalWeeks}` : ""} — ${ctx.phase} phase):
Target: ${mileageTarget}${unitLabel} | Completed so far: ${mileageSoFar}${unitLabel}

This week's sessions:
${fmtSessions(ctx.plannedSessions)}`;

  return `TODAY: ${ctx.todayStr} | Timezone: ${ctx.timezone}${raceCountdown}

ATHLETE: ${ctx.athleteName} | Goal: ${ctx.goal}${injuryLine}
${secondaryRaceBlock ? `\n${secondaryRaceBlock}` : ""}${planBlock}

RECENT CONVERSATION:
${fmtConversation(ctx.recentMessages)}

OUTPUT CONTRACT:
- NO SIGN-OFFS. Message ends on the coaching point — never "Let me know if you have questions", "You've got this!", or any form-letter ending.
- NO GENERIC OPENERS. Never "Great week!" or praise not tied to a specific observation.
- Keep it brief — 1–2 SMS bubbles maximum. This is a check-in, not a coaching session.
- If the athlete's week is on track, acknowledge it specifically (which session, how far along). If behind, gently note what's left without pressure.
- Separate bubbles with a blank line if splitting.`;
}
