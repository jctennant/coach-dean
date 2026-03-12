# Coach Dean — Onboarding Simulation Test Cases

**Generated:** 2026-03-12
**Method:** Subagent read all prompts verbatim from `src/app/api/onboarding/handle/route.ts`, defined 10 athlete personas with scripted messages at each step, called the real Claude API at each step using those exact prompts, and evaluated the responses.
**Rerun with:** `ANTHROPIC_API_KEY=... node scripts/simulate-onboarding.mjs`

---

## How to interpret results

Each test case has:
- **Persona** — who the athlete is and what quirks/edge cases they test
- **Transcript** — the full conversation (DEAN / ATHLETE)
- **Issues observed** — specific problems noted at the time of simulation
- **Expected behavior** — what the correct behavior should be (for regression testing)

---

## Athlete 1 — Beginner, no race goal (Sarah)

**Persona:** True beginner, just wants to run regularly, no race in mind.
**Tests:** `general_fitness` path, `no_event` flag, clean happy path.

**Scripted messages:**
- Goal: "Hi I'm Sarah, I just want to start running regularly, no races in mind"
- Race date: (skipped — no_event)
- Schedule: "Mon, Wed, Fri work best for me"
- Anything else: "nope that's everything"

**Issues observed:** None. Fastest, cleanest path through the flow.

**Expected behavior (regression):**
- Goal classified as `general_fitness` ✓
- `awaiting_race_date` skipped ✓
- `awaiting_goal_time` skipped ✓
- Schedule captured correctly ✓
- "anything else: nope" resolves as `isDone: true` and completes onboarding ✓

---

## Athlete 2 — Beginner, 5K goal (Mike)

**Persona:** Never run before, wants to do a 5K in ~3 months.
**Tests:** Beginner branch of acknowledgment copy (`experience_years < 1`), vague timeline.

**Scripted messages:**
- Goal: "Hey, I'm Mike. I've never run before but I want to do a 5K in about 3 months"
- Race date: "End of June I think, no specific date yet"
- Goal time: "no specific time goal, just want to finish"
- Schedule: "Monday, Wednesday, Friday, and maybe Sunday"
- Anything else: "nope that's it"

**Issues observed:**
- **LOW:** Race date question ("What's the date of your event?") feels formal for someone who said "about 3 months from now." Could soften for vague/beginner timelines.

**Expected behavior (regression):**
- Goal classified as `5k` ✓
- Acknowledgment uses "manageable" copy variant (beginner branch) ✓
- "just want to finish" correctly captured as `goal_time_minutes: null` ✓
- Schedule: 4 days captured ✓

---

## Athlete 3 — Intermediate, first half marathon (Lisa)

**Persona:** Intermediate runner, first half marathon in October, does yoga/strength.
**Tests:** Month-only race date, cross-training info in "anything else."

**Scripted messages:**
- Goal: "I'm Lisa, training for my first half marathon in October"
- Race date: "October, not sure of the exact date yet"
- Goal time: "I don't have a specific time, just want to finish strong"
- Schedule: "Tue, Thu, Sat, Sun"
- Anything else: "I do some yoga and strength training but nothing too structured"
- Anything else followup: "nope that's all"

**Issues observed:**
- **LOW:** "October" in first message not captured as partial race date — `awaiting_race_date` asks cold without pre-filling October.
- **MEDIUM:** After sharing yoga/strength info, Dean re-asks "Anything else?" — requires extra round-trip even though Lisa gave a complete answer.

**Expected behavior (regression):**
- Goal classified as `half_marathon` ✓
- Cross-training (yoga, strength) captured in `onboarding_data.crosstraining_tools` ✓
- "nope" on followup resolves as `isDone: true` ✓

---

## Athlete 4 — Advanced sub-3 marathoner (Tom)

**Persona:** Experienced runner, Boston Marathon, specific time goal (sub-3:00), shares training data.
**Tests:** Named race web search, goal time capture, comprehensive "anything else" answer.

**Scripted messages:**
- Goal: "Tom here. Running Boston Marathon, I want to go sub-3:00"
- Race date: (skipped — web search found Boston date)
- Goal time: "sub-3:00, that's my A goal"
- Schedule: "Mon, Tue, Thu, Fri, Sat, Sun — I run 6 days"
- Anything else: "I'm currently at 60 miles per week, easy pace around 8:30/mile"
- Anything else followup: "nothing else"

**Issues observed:**
- **MEDIUM:** Tom shared mileage + pace (exactly what Dean wanted) and still got a re-ask "Anything else?" before completing.
- **LOW:** Web search race date should return 2026 Boston, not 2025 — worth monitoring.

**Expected behavior (regression):**
- Boston Marathon detected via web search, `raceDate` pre-filled ✓
- Goal time: 180 minutes captured ✓
- Weekly miles (60) and easy pace (8:30) captured in `onboarding_data` ✓
- VDOT paces calculated from Tom's training data ✓

---

## Athlete 5 — Multiple races (Behind the Rocks 30K + 100K) (Jake)

**Persona:** Advanced athlete, named multi-distance trail race + secondary goal.
**Tests:** Multi-distance detection, secondary goal handling, distance clarification flow.

**Scripted messages:**
- Goal: "I'm Jake, I want to do the Behind the Rocks trail race in March, and then a 100K this summer"
- Distance clarification: "the 30K"
- Race date: (from web search)
- Schedule: "Tue, Wed, Thu, Sat, Sun"
- Anything else: "nope"

**Issues observed (2026-03-12 baseline):**
- **MEDIUM (BUG):** Capitalization bug — "Jake, Which distance are you targeting" (capital W mid-sentence).
- **MEDIUM:** 100K secondary goal acknowledged in ack text but not stored in `onboarding_data`. Lost after distance clarification unless re-mentioned.

**Expected behavior (regression):**
- Web search returns `distanceOptions: ["10 Mile", "30K", "50K", "50 Mile"]` ✓
- Dean asks which distance rather than guessing ✓
- After "the 30K": goal updated to `30k`, flow advances ✓
- **[NOT YET MET]** Secondary goal (100K) stored in `onboarding_data` ✗
- **[NOT YET MET]** Capitalization: "Jake, which distance" (lowercase w) ✗

---

## Athlete 6 — Injured athlete, return to running (Amy)

**Persona:** Stress fracture 6 weeks ago, recently cleared, nervous about re-injury.
**Tests:** `injury_recovery` path, injury detail collection, cautious pacing.

**Scripted messages:**
- Goal: "Hey, I'm Amy. I had a stress fracture 6 weeks ago and want to start running again carefully"
- Schedule: "I can do Mon, Wed, Fri, and maybe a light session on weekends"
- Anything else: "It was my left metatarsal. I just got cleared by my doc but I'm nervous about re-injury"
- Anything else followup: "nope that's everything"

**Issues observed:**
- **MEDIUM:** `awaiting_anything_else` for injury_recovery goals has a double-ask problem — the step asks "Tell me more about the injury…" but after Amy answers in detail, Dean re-asks "Anything else I should know?" even though she just answered a specific question. Should be a dedicated `awaiting_injury_background` step.

**Expected behavior (regression):**
- `injury_recovery` goal classified ✓
- `awaiting_race_date` skipped ✓
- `awaiting_goal_time` skipped ✓
- Injury notes stored in `onboarding_data.injury_notes` ✓

---

## Athlete 7 — Experienced ultra runner (Dan)

**Persona:** Multiple 50Ks done, wants first 100K, high mileage.
**Tests:** Ultra path, `awaiting_ultra_background` step, auto-skip of "anything else."

**Scripted messages:**
- Goal: "Dan here. I've done several 50Ks and want to do my first 100K"
- Race date: "August, no specific race yet"
- Ultra background: "I've completed five 50Ks over the past 3 years. Currently running 55 miles a week with long runs around 22 miles"
- Schedule: "Mon through Sat, I take Sundays off"
- (anything_else auto-skipped)

**Issues observed:** None. Best-tuned path in the flow.

**Expected behavior (regression):**
- Goal classified as `100k` ✓
- `awaiting_ultra_background` step fires ✓
- Ultra history and mileage extracted ✓
- `awaiting_anything_else` auto-skipped when ultra background already captures necessary data ✓

---

## Athlete 8 — Multi-sport, capability question in first message (Chris)

**Persona:** Cyclist + runner, asks if Dean works with cyclists alongside stating a goal.
**Tests:** Capability question alongside goal at `awaiting_goal`, cross-training context.

**Scripted messages:**
- Goal: "Hi I'm Chris! Quick question first — do you work with people who also do cycling? I want to train for a half marathon but also race some crits"
- Race date: "June 15th"
- Goal time: "no specific time goal"
- Schedule: "Mon, Wed, Fri running — Tue, Thu cycling"
- Anything else: "nope"

**Issues observed (2026-03-12 baseline):**
- **HIGH (BUG):** Dean completely ignored "do you work with people who also do cycling?" — jumped straight to half marathon acknowledgment. `detectAndAnswerImmediate` only catches coaching questions, not capability questions.

**Expected behavior (regression):**
- **[NOT YET MET — HIGH priority fix]** Capability question answered before goal acknowledgment ✗
- Goal classified as `half_marathon` ✓
- Cycling cross-training captured ✓

---

## Athlete 9 — Returning college runner, no event yet (Rachel)

**Persona:** Ran in college, 5-year gap, wants to get back into it, has old PR.
**Tests:** `no_event` flag with experienced runner, stale PR data, returning-runner persona.

**Scripted messages:**
- Goal: "I'm Rachel. I used to run in college but haven't in 5 years. I'm not signed up for anything yet but want to get back into it"
- Race date: (skipped — no_event)
- Schedule: "Tue, Thu, Sat, Sun"
- Anything else: "I had a 1:42 half marathon PR back in college but I know I'm nowhere near that now"
- Anything else followup: "nope that's all"

**Issues observed:**
- **LOW:** Classified as `general_fitness` — no goal type captures "experienced-runner-with-long-gap returning to running." Plan will be less tailored than it could be.
- **LOW:** 1:42 half PR (5 years old) extracted and used for VDOT pace calculations without staleness flag. Produces paces ~60–90 sec/mile too aggressive.

**Expected behavior (regression):**
- `no_event: true` triggers, goal set to `general_fitness` ✓
- Old PR data extracted ✓
- **[NOT YET MET]** Stale PR flagged / paces softened ✗

---

## Athlete 10 — Asks a planning question in "anything else" (Jordan)

**Persona:** Marathon runner, asks about sequencing plans in "anything else."
**Tests:** `generateAnythingElseResponse` question handling, race date in conversational context.

**Scripted messages:**
- Goal: "I'm Jordan, training for a fall marathon"
- Race date: "October 19th"
- Goal time: "around 3:45"
- Schedule: "Mon, Wed, Thu, Sat, Sun"
- Anything else: "Can you build the plan for my race first, then we'll do a base-building block after?"
- Anything else followup: "sounds good, nothing else from me"

**Issues observed:**
- **MEDIUM:** Dean said "October 1st" in conversational response when race date was October 19th. `generateAnythingElseResponse` hallucinated a different date.

**Expected behavior (regression):**
- Planning question answered and re-ask "Anything else?" fires ✓
- "nothing else" resolves `isDone: true` ✓
- **[NOT YET MET]** Race date quoted correctly (October 19th, not October 1st) ✗

---

## Summary Table

| # | Athlete | HIGH | MEDIUM | LOW | Overall |
|---|---------|------|--------|-----|---------|
| 1 | Sarah (beginner, no goal) | — | — | — | ✅ Clean |
| 2 | Mike (beginner 5K) | — | — | 1 | ✅ Minor |
| 3 | Lisa (first HM) | — | 1 | 1 | ⚠️ |
| 4 | Tom (sub-3 Boston) | — | 2 | — | ⚠️ |
| 5 | Jake (BTR + 100K) | — | 2 | — | ⚠️ |
| 6 | Amy (injury) | — | 1 | — | ⚠️ |
| 7 | Dan (ultra 100K) | — | — | — | ✅ Clean |
| 8 | Chris (cycling + HM) | 1 | — | — | ❌ Bug |
| 9 | Rachel (returning runner) | — | — | 2 | ✅ Minor |
| 10 | Jordan (planning question) | — | 1 | — | ⚠️ |
