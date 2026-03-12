# Coach Dean — Roadmap & Improvement Log

Issues discovered through onboarding simulation (10 athletes, 2026-03-12). See `test-cases.md` for full transcripts and test methodology.

---

## HIGH Priority

### [DONE] Capability questions in first message are silently dropped
**Affected:** Multi-sport athletes who ask "do you work with cyclists?" or "can you help with triathlon?" alongside their goal in the first message.
**Root cause:** `detectAndAnswerImmediate` only looked for coaching questions (pace, race-day tactics) — not capability/service questions. Returned null for "do you work with people who also do cycling?" so the question was silently dropped and Dean jumped straight to the goal acknowledgment.
**Fix:** Broadened `detectAndAnswerImmediate` to also cover capability and service questions. When a goal is detected alongside a capability question, Dean now answers the question before the acknowledgment.
**File:** `src/app/api/onboarding/handle/route.ts`

---

## MEDIUM Priority

### Capitalization bug in multi-distance clarification message
**Symptom:** "Jake, Which distance are you targeting" — capital W mid-sentence.
**Root cause:** Template string: `` `${ackPart}${namePrefix}Which distance…` `` — "Which" is always capitalized regardless of what precedes it.
**Fix:** Change `Which` to `which` in the clarification template.
**File:** `src/app/api/onboarding/handle/route.ts` (multi-distance branch in `handleGoal`)

### Secondary race goal not stored in onboarding_data
**Symptom:** Athlete mentions "Behind the Rocks 30K and then a 100K this summer" — the 100K is acknowledged in the ack text but never written to `onboarding_data`. After the distance clarification exchange, it's lost unless the athlete re-mentions it in "anything else."
**Fix:** When `generateRaceAcknowledgment` detects a secondary goal mention, extract and store it in `onboarding_data.other_notes` or a dedicated `secondary_goal` field.
**File:** `src/app/api/onboarding/handle/route.ts`

### Injury recovery "anything else" step is awkward double-ask
**Symptom:** The `awaiting_anything_else` step question already says "Tell me more about the injury…" — but after the athlete gives a detailed answer, `generateAnythingElseResponse` re-asks "Anything else I should know?" This feels mechanical right after a specific Q&A.
**Fix:** Add a dedicated `awaiting_injury_background` step (parallel to `awaiting_ultra_background`) so injury context is collected in a focused step, leaving "anything else" as a true catch-all.
**File:** `src/app/api/onboarding/handle/route.ts`

### Dean hallucinated race date in generateAnythingElseResponse
**Symptom:** Race date was 2025-10-19 in context, but Dean said "October 1st" in a conversational response.
**Fix:** Either (a) don't reference the race date by name in `generateAnythingElseResponse` context, or (b) if passed, instruct the model to quote it verbatim or omit it.
**File:** `src/app/api/onboarding/handle/route.ts` (`generateAnythingElseResponse` system prompt)

### "Anything else" requires extra round-trip for comprehensive answerers
**Symptom:** 5 of 10 simulated athletes who shared substantive info in one message (training data, injuries, cross-training) got a re-ask — even though they'd given a complete answer.
**Fix:** Update the step question to more explicitly invite a "done" signal: "Injuries, cross-training, target paces — anything else? If not, just say nope!"
**File:** `src/app/api/onboarding/handle/route.ts` (`getStepQuestion` for `awaiting_anything_else`)

---

## LOW Priority

### Month-only race date not pre-filled when asking awaiting_race_date
**Symptom:** Athlete says "in October" in first message — not captured as a race date (no day/year), so `awaiting_race_date` fires fresh without pre-filling October. Athlete repeats timing info.
**Fix:** If a month is inferred but not a full date, pre-fill the question with "You mentioned October — do you have a specific date?" rather than asking cold.
**File:** `src/app/api/onboarding/handle/route.ts` (`getStepQuestion` for `awaiting_race_date`)

### No goal type for experienced-but-returning runners
**Symptom:** A college runner returning after 5 years with no event is classified as `general_fitness`. The plan won't reflect their strong historical base + long gap.
**Fix:** Add `return_to_running` or `base_building` as a goal type in the classifier, with appropriate routing and plan framing.
**File:** `src/app/api/onboarding/handle/route.ts` (classifier prompt + `getSportType` + `formatGoalInline`)

### Stale PR data used for pace calculations without staleness flag
**Symptom:** A 1:42 half marathon PR from 5 years ago is extracted and piped into VDOT pace calculations, producing training paces that are ~60–90 sec/mile too fast.
**Fix:** `extractAdditionalFields` should capture a `race_year` or `race_recency` signal. If the race is >2 years ago, flag the paces as "estimated from older data" in the system prompt.
**File:** `src/app/api/onboarding/handle/route.ts` (`extractAdditionalFields` prompt)

### Race date question feels formal for vague beginner timelines
**Symptom:** "What's the date of your event?" hits differently for a beginner who said "about 3 months from now."
**Fix:** Soften the question for non-specific timelines: "Do you have a specific date in mind, or is it more like 'sometime this summer'?"
**File:** `src/app/api/onboarding/handle/route.ts` (`getStepQuestion` for `awaiting_race_date`)

---

## Positive findings (keep as-is)
- Ultra path (`awaiting_ultra_background`) correctly auto-skips "anything else" when background data captures what's needed
- `no_event: true` and `injury_recovery` paths route correctly
- Multi-distance race detection (Behind the Rocks) worked perfectly
- Capitalization bug aside, the multi-distance clarification message was well-formed and natural
