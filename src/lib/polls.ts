// Photon/iMessage-only polls used across onboarding and coaching. No Linq
// equivalent exists — callers must gate on isPhotonProvider() (see photon.ts)
// before sending any of these.
//
// Each poll's title doubles as the correlation key on the inbound webhook side
// (spectrum-ts poll_option payloads carry no poll id) — keep IDs and titles in
// sync if the copy ever changes.
//
// A selected option is translated into a natural-language sentence and fed into
// the normal message pipeline as if the athlete had typed it — this reuses
// existing extraction/conversation logic instead of adding a parallel
// structured-data path, and means a plain-text reply (e.g. on an older
// iOS/macOS that can't render the poll UI) works exactly the same way. Each poll
// send is followed by a one-line plain-text fallbackHint for the same reason.
//
// Only fields asked at a single fixed, deterministic point are good candidates
// here. Injury and training-days onboarding questions were considered but both
// live inside context-dependent, personalized Sonnet-generated text
// (handleDataAnalysis's Strava synthesis, the goals-stage prompt) rather than a
// fixed prompt — poll-ifying them would mean stripping a question out of
// generated text (fragile) or asking twice. Revisit if those flows are ever
// restructured to ask a fixed question independently of the surrounding text.
//
// TRAINING_DAYS_POLL (added with the awaiting_schedule_confirm checkpoint) is
// exactly that revisit: it fires from its own dedicated turn after diagnosis
// (Strava synthesis + injury intake) has already completed, not from inside
// handleDataAnalysis's generated text — so it doesn't hit the fragility above.
// Its options are a fixed yes/no, not the (dynamic, per-athlete) day list
// itself, since poll options can't be templated per-athlete.

export interface AppPoll {
  id: "goal" | "rtr_gate" | "training_days_confirm" | "strength_routine_offer";
  title: string;
  options: string[];
  /** One-line plain-text fallback appended after the poll, for clients that can't render it. */
  fallbackHint: string;
  /** Maps a selected option's title to a natural-language message for the extraction pipeline. */
  optionToMessage: (optionTitle: string) => string;
}

export const GOAL_POLL: AppPoll = {
  id: "goal",
  title: "What's your main goal right now?",
  options: ["Train for a race", "General fitness", "Coming back from injury", "Not sure yet"],
  fallbackHint: "(Or just reply: race / general fitness / coming back from injury / not sure.)",
  optionToMessage: (optionTitle) => {
    switch (optionTitle) {
      case "Train for a race":
        return "I'm training for a race.";
      case "General fitness":
        return "My goal is general fitness — no specific race.";
      case "Coming back from injury":
        return "I'm coming back from an injury.";
      default:
        return "I'm not totally sure what my goal is yet.";
    }
  },
};

// Return-to-run phase gate (coach/respond, RTR phases 1-2): fired as a separate
// bubble right after Dean's post-run coaching message, replacing the free-text
// "how did it feel?" gate question the prompt would otherwise ask (see
// coach/respond/route.ts's RTR phase 1/2 prompt block). Single dimension,
// already post-run-gated, and its answer feeds the exact same [RTR_ADVANCE]
// judgment ("2 consecutive pain-free sessions") that free text already drove —
// this only removes ambiguity in classifying THIS message, it doesn't change
// how the consecutive count itself is tracked.
export const RTR_GATE_POLL: AppPoll = {
  id: "rtr_gate",
  title: "How did that feel?",
  options: ["Pain-free", "Some pain during or after"],
  fallbackHint: "(Or just reply pain-free, or describe what you felt.)",
  optionToMessage: (optionTitle) =>
    optionTitle === "Pain-free"
      ? "That felt pain-free — no pain during or after."
      : "I felt some pain during or after that.",
};

// Schedule/preferences checkpoint (onboarding, awaiting_schedule_confirm state):
// fired once diagnosis (Strava synthesis + injury intake) is done, stating the
// Strava-inferred (or previously stated) training days and asking for a quick
// confirm/correct before the plan is generated.
export const TRAINING_DAYS_POLL: AppPoll = {
  id: "training_days_confirm",
  title: "Keep those training days?",
  options: ["Yes, that works", "I want different days"],
  fallbackHint: "(Or just tell me which days you'd rather run.)",
  optionToMessage: (optionTitle) =>
    optionTitle === "Yes, that works"
      ? "Yes, those training days work for me."
      : "I want different training days than what you suggested.",
};

// First-plan strength-routine offer (coach/respond, initial_plan trigger with an active
// injury on file): Dean asks a plain yes/no instead of dumping the full routine + poster
// straight into the plan-delivery message. The full routine is sent as its own follow-up
// once confirmed — see the (3) affirmative-reply case in the strength-routine prompt block.
export const STRENGTH_ROUTINE_POLL: AppPoll = {
  id: "strength_routine_offer",
  title: "Want a strength routine added in?",
  options: ["Yes, add it", "Not right now"],
  fallbackHint: "(Or just reply yes/no.)",
  optionToMessage: (optionTitle) =>
    optionTitle === "Yes, add it"
      ? "Yes, add the strength routine."
      : "Not right now, thanks.",
};

export const POLLS_BY_TITLE: Record<string, AppPoll> = {
  [GOAL_POLL.title]: GOAL_POLL,
  [RTR_GATE_POLL.title]: RTR_GATE_POLL,
  [TRAINING_DAYS_POLL.title]: TRAINING_DAYS_POLL,
  [STRENGTH_ROUTINE_POLL.title]: STRENGTH_ROUTINE_POLL,
};
