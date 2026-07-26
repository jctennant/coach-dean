// Photon/iMessage-only onboarding polls. No Linq equivalent exists — callers must
// gate on isPhotonProvider() (see photon.ts) before sending any of these.
//
// Each poll's title doubles as the correlation key on the inbound webhook side
// (spectrum-ts poll_option payloads carry no poll id) — keep IDs and titles in
// sync if the copy ever changes.
//
// A selected option is translated into a natural-language sentence and fed into
// the normal onboarding pipeline as if the athlete had typed it — this reuses
// the existing Haiku extraction/Sonnet conversation logic instead of adding a
// parallel structured-data path, and means a plain-text reply (e.g. on an older
// iOS/macOS that can't render the poll UI) works exactly the same way. Each poll
// send is followed by a one-line plain-text fallbackHint for the same reason.
//
// Only fields asked at a single fixed, deterministic point in the conversation are
// good candidates here. Injury and training-days questions were considered but
// both live inside context-dependent, personalized Sonnet-generated text
// (handleDataAnalysis's Strava synthesis, the goals-stage prompt) rather than a
// fixed prompt — poll-ifying them would mean stripping a question out of
// generated text (fragile) or asking twice. Revisit if those flows are ever
// restructured to ask a fixed question independently of the surrounding text.

export interface OnboardingPoll {
  id: "goal";
  title: string;
  options: string[];
  /** One-line plain-text fallback appended after the poll, for clients that can't render it. */
  fallbackHint: string;
  /** Maps a selected option's title to a natural-language message for the extraction pipeline. */
  optionToMessage: (optionTitle: string) => string;
}

export const GOAL_POLL: OnboardingPoll = {
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

export const ONBOARDING_POLLS_BY_TITLE: Record<string, OnboardingPoll> = {
  [GOAL_POLL.title]: GOAL_POLL,
};
