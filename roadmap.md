# Coach Dean — Roadmap & Improvement Log

Issues discovered through onboarding simulation (10 athletes, 2026-03-12). See `test-cases.md` for full transcripts and test methodology.

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
