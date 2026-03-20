# Coach Dean — Changelog

All notable changes to Coach Dean are tracked here. Each entry includes the user feedback or motivation that drove the change, so we have full context over time.

---

## [Unreleased]

---

## 2026-03-20 — Future-proof non-running session detection in mileage calculation

**Type:** Improvement
**Reported by:** Internal observation (during Ian bug fix session)
**User feedback:** N/A
**Root cause:** `correctMileageTotal` and the session projection loop both used a keyword exclusion regex (`/strength|mobility|yoga|bike|swim|elliptical|cross.train|rest day|hike|spin/i`) to skip non-running sessions. This required ongoing maintenance — "Master's swim", "Zwifting", "indoor trainer", "aqua jogging", "rowing" and any other novel cross-training description not in the list would silently be counted as running mileage if Claude happened to include a distance in miles. Demonstrated failure: `Zwift ride 20mi` would be counted as 20 running miles despite "bike" not matching "Zwift".
**Fix / Change:**
- Removed both exclusion regex constants (`nonRunningRe` and `nonRunSessionRe`) from `correctMileageTotal` and the session projection loop.
- Switched to positive matching: a session contributes to running mileage **only if** it has an explicit `\d+mi` marker in its label. Sessions without a mileage marker contribute zero — regardless of what the activity is called.
- Added `SESSION DISTANCE FORMAT` instruction to all three plan-generation prompt locations (system prompt session format block, `weekly_recap` user message, `initial_plan` user message): running sessions must always include distance in miles; non-running sessions must never include distance in miles, even if the distance is known (use duration instead). This is the contract that makes positive matching reliable.
- The combination of prompt instruction + positive code logic means any future cross-training description is automatically handled correctly without any code changes.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-20 — Ian's mileage errors: three root causes found and fixed

**Type:** Bug Fix (batch)
**Reported by:** Manual review of Ian's conversation thread
**User feedback:** Ian's conversation showed Dean saying "you're at 9.2 miles" after a 3.2mi run, then "12.3 miles total for the week" when the correct total was ~9.25mi — persisting even after the 3/18 `correctMileageTotal` fix.

---

### Bug A: Post-run messages stated projected week total instead of done-so-far
**Root cause:** `mileageLine` in `buildUserMessage` computed `projectedWeekMiles = weekMileageSoFar + remainingSessionMiles` and showed it in CURRENT TRAINING STATE for all triggers including `post_run`. After Ian's 3.2mi run with two 3mi runs still planned, the projection was 9.2mi. Claude used that number when saying "you're at X miles this week" despite the explicit `⚠️ WEEK-TO-DATE` instruction.
**Fix:** When `trigger === "post_run"`, return only `weekMileageSoFar` (already-completed miles); skip the projected total entirely.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Bug B: `correctMileageTotal` was disabled for `user_message` and `weekly_recap`
**Root cause:** The 2026-03-18 fix disabled `correctMileageTotal` for `post_run`, `user_message`, AND `weekly_recap` — meant to avoid double-correction on post_run, but accidentally also stopped correction on the other two triggers. When Ian replied "not running Saturday" and Dean responded with a revised plan (Sat: spin, Sun: 3mi) but kept "12.3 miles total for the week", nothing caught the error.
**Fix:** Changed exclusion to `post_run` only. `user_message` and `weekly_recap` now run through `correctMileageTotal` as intended.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Bug C: "Spin" sessions counted toward mileage total
**Root cause:** `nonRunningRe` regex (used inside `correctMileageTotal`) didn't include "spin", so spin-class sessions were treated as running sessions and their distance contributed to the computed week total.
**Fix:** Added "spin" to both `nonRunningRe` (in `correctMileageTotal`) and `nonRunSessionRe` (in the session projection loop).
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Bonus: `correctMileageTotal` pattern 2 cross-line match bug
**Root cause:** Pattern 2 used `\s*` between `mi(?:les?)?` and the total keyword, which matches newlines. A session line like "Easy 3mi\nTotal: ..." could have its session distance incorrectly modified if "Total" happened to follow on the next line.
**Fix:** Changed `\s*` to `[ \t]*` in pattern 2 — restricts match to same-line whitespace only.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-20 — Five bug fixes from March 19 conversation analysis

**Type:** Bug Fix (batch)
**Reported by:** Automated daily conversation analysis (Claude Opus, 13 users / 124 messages)
**User feedback:** N/A (analysis-detected)

---

### Issue 1: Duplicate post_run messages with contradictory mileage targets (P0)
**Root cause:** Strava sometimes sends two webhook events for the same activity within seconds. Both events arrive before either stores the activity, so both pass the `isNew` check (race condition on the DB upsert) and both fire `/api/coach/respond` with `trigger=post_run`. The two Claude calls generate independently and can produce different weekly mileage projections (40 mi vs 35 mi).
**Fix:** Added a second dedup guard in `strava/route.ts`: before firing the coaching response, query `conversations` for any `post_run` message sent to this user in the last 5 minutes. If one exists, set `suppressCoaching = true`. This catches the race condition that the `isNew` check misses.
**Files changed:** `src/app/api/webhooks/strava/route.ts`

---

### Issue 2: Raw JSON `{"on_topic": false}` leaked to athlete (P0)
**Root cause:** In `checkOffTopic` (`onboarding/handle`), the prompt instructs Claude to return `{"on_topic": true}` for on-topic or plain-text for off-topic. Occasionally Claude returns `{"on_topic": false}` (violating the prompt). The code parses the JSON, checks `=== true` (fails), and returns the full raw text including `{"on_topic": false}` as the `response` field, which is then SMS'd to the athlete verbatim.
**Fix / Change:**
- In `checkOffTopic`: when JSON parses successfully but `on_topic !== true`, strip JSON objects from the text to recover any plain-text portion. If nothing remains after stripping, default to `{ offTopic: false }` (safe: treat as on-topic rather than leaking JSON).
- Added a `sendAndStore` safety guard: if the outbound message starts with `{`, block the send and log an error. Defense-in-depth for any future JSON leakage path.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

### Issue 3: Onboarding loop re-asks already-answered questions (P1)
**Root cause:** In `handleSchedule`, when the Haiku model returns `complete: false` (e.g., "3 days" without specific days), the extracted `days_per_week` is **not saved** to `onboarding_data`. On the next message ("Most days are good, Saturday best for longs"), Haiku receives only the new message with no context about the prior "3 days" answer and re-asks for days_per_week. Additionally, the Haiku prompt didn't recognize "most days"/"most days are good" as a valid complete answer.
**Fix / Change:**
- In `handleSchedule` incomplete branch: save `days_per_week` (if extracted) to `onboarding_data` immediately, so subsequent messages have full context.
- Updated the Haiku prompt to include `ALREADY COLLECTED: days_per_week = N` when known, instructing it not to re-ask.
- Added "most days", "most days work", "most days are good", "any day", "whenever", "whenever I can", "flexible", "you pick", "you choose", "up to you", "no set days" to the complete=true examples (balanced default assigned).
- Added explicit rule that "a count alone (e.g. '3 days', 'maybe 3') is enough — mark complete and assign a balanced default" — without this, count-only answers would also loop.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

### Issue 4: Cross-training day overwritten by run in delivered plan (P1)
**Root cause:** The `initial_plan` and `weekly_recap` SCHEDULE CONSTRAINT prompts said "only put runs on training days" but didn't explicitly protect days the athlete designated for a specific cross-training activity. Claude correctly stored "swimming on Fridays" in `other_notes` but then placed an easy run on Friday anyway.
**Fix:** Added `⚠️ CROSS-TRAINING DAY PROTECTION` clause to both `initial_plan` and `weekly_recap` user messages: instructs Claude to check "Athlete preferences / notes" before placing any run, and to treat athlete-designated cross-training days as fixed — do not override with a run. Also instructs to verify that a requested count of strength sessions (e.g., "twice a week") appears in the plan.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Issue 5: URL-encoded `%20` passed through in athlete messages (P2)
**Root cause (two parts):**
1. The SMS deep-link URLs in `signup-form.tsx` and `page.tsx` used `&body=Hi%20Dean!` — `&` is wrong per RFC 5724 (should be `?`). Some OS SMS parsers don't decode the body when the separator is wrong, passing `Hi%20Dean!` as the literal message.
2. The Linq webhook message ingestion never decoded the raw body, so any URL-encoded text from any source would be stored and processed as-is.
**Fix / Change:**
- Fixed SMS URL separator `&` → `?` and removed manual `%20` encoding (`?body=Hi Dean!`) in both `signup-form.tsx` and `page.tsx`.
- Added `decodeURIComponent()` at the Linq webhook ingestion point with a try/catch fallback for malformed sequences.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/components/signup-form.tsx`, `src/app/page.tsx`

---

## 2026-03-19 — Add mile time trial as a first-class goal type

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** A mile PR goal was bucketed to "10k" by the classifier, which was wrong in two concrete ways: (1) goal pace calculation used 6.214 miles instead of 1.0 mile, producing a completely wrong target pace; (2) the coaching methodology for 10K (threshold work, aerobic volume) is fundamentally different from mile training (VO2max intervals, strides, neuromuscular speed, no traditional taper).
**Fix / Change:**
- Added `"mile"` as a goal type to the classifier output format with explicit rules: "mile PR", "mile time trial", "1 mile", "track mile", "sub-5 mile" → "mile"
- Added `"mile": 1.0` to `runGoalDistancesMiles` in both files — goal pace now computes correctly (e.g., 5:30 goal = 5:30/mi, not 0:53/mi)
- Added `formatGoalLabel("mile")` = "a mile time trial" and `formatGoalInline("mile")` = "mile time trial"
- Taper protocol: mile gets a distinct sharpening-week instruction (−30% volume, 4-6x400m) in the final 7 days instead of the standard 3-week taper protocol
- Added MILE TIME TRIAL GOAL coaching instruction to the initial_plan section: 800m/400m repeats at mile effort, strides 2-3x/week, modest total volume (25-35mi/week), interval paces derived from goal time
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-19 — Communicate Dean's features earlier in onboarding and on the landing page

**Type:** Improvement
**Reported by:** User feedback
**User feedback:** "It wasn't clear about all of the different things that she could do with Coach Dean."
**Root cause:** The welcome SMS focused on goal types but didn't mention the four differentiating features. The landing page buried Strava in a FAQ answer and never mentioned reminders.
**Fix / Change:**
- Rewrote welcome SMS to the approved copy: "I'm Coach Dean — your AI running coach, entirely over text. I can build you a personalized training plan, analyze your runs via Strava, incorporate strength and mobility work to keep you injury-free, and discuss race strategy and pacing. What are you training for?"
- Updated the fallback intro in `handleGoal` (direct-text path) to match, with a "Hey {name}!" prefix when the name is known.
- Updated landing page hero description to mention reminders and Strava analysis.
- Replaced the standalone "What Dean does" card grid with a lightweight ✓ checklist inline below the signup form in the hero — same information, less visual weight, no competition with the value prop sections below.
- TODO (deferred): Add a comparison table (Dean vs ChatGPT vs Runna) once pricing is set — Dean's differentiators include no app needed, flexibility around illness/travel/injury, reminders, and Strava analysis.
**Files changed:** `src/app/api/signup/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/page.tsx`

---

## 2026-03-19 — Token cost optimizations batch 2

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Several API calls were using Sonnet for tasks Haiku handles equally well (binary classification, date parsing, short text generation), max_tokens was 2048 for SMS outputs capped at ~640 chars, and the daily analysis cron used Opus when Sonnet is sufficient.
**Fix / Change:**
- Daily conversation analysis cron: `claude-opus-4-6` → `claude-sonnet-4-6`. Opus is 5–10× more expensive per token; Sonnet is fully capable of error detection and HTML report generation.
- Conversation history limit: `15` messages for all triggers → `15` for `user_message`, `8` for all other triggers (reminders, post_run, plan generation). Proactive triggers don't need full conversation depth.
- Main coaching response `max_tokens`: `2048` → `800` for plan triggers (`initial_plan`, `weekly_recap`), `512` for all others. SMS output is ~150 tokens; 2048 was 13× the actual output size.
- Race date extraction: `claude-sonnet-4-5-20250929` → `claude-haiku-4-5-20251001`. Parsing "June 15" or "next April" to ISO date is straightforward structured extraction.
- Training schedule extraction: `claude-sonnet-4-5-20250929` → `claude-haiku-4-5-20251001`. Extracting days of week from "Tuesday, Thursday, Saturday" doesn't need Sonnet.
- "Anything else?" response: `claude-sonnet-4-5-20250929` → `claude-haiku-4-5-20251001`. Short conversational acknowledgment at end of onboarding.
- Off-topic detection: `claude-sonnet-4-5-20250929` → `claude-haiku-4-5-20251001`. Binary on-topic/off-topic classification with a reply fallback.
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-19 — Trigger-conditional system prompt to reduce token cost

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `buildSystemPrompt` emitted the full ~18,000-char prompt for every trigger type, including ~7,300 chars of sections irrelevant to reminders (training philosophy, product capabilities, athlete philosophy references, plan deviation tone guides, etc.). At $3/M input tokens this was ~$0.006/call in dead weight for morning and nightly reminders alone.
**Fix / Change:** Added `trigger` parameter to `buildSystemPrompt`. Wrapped 6 sections in trigger-conditional guards:
- TRAINING PHILOSOPHY (6 principles): skipped for `morning_reminder`, `nightly_reminder` — reminders don't prescribe new plans, the coach already knows the philosophy
- WHEN NOT TO REPLY: only for `user_message`, `post_run`, `workout_image` — reminders and plan triggers always reply
- TONE WHEN ATHLETE RUNS FASTER / DIFFERENT WORKOUT: only for `user_message`, `post_run` — only relevant when reviewing a completed run
- PRODUCT CAPABILITIES: only for `user_message` — athletes only ask about features in conversation, not during reminders or plan generation
- STRENGTH, MOBILITY & CROSS-TRAINING: skipped for `morning_reminder`, `nightly_reminder`, `post_run` — not building a plan
- ATHLETE-STATED PHILOSOPHIES reference table: only for `user_message` — only relevant when athlete brings up a methodology in chat
Estimated savings: ~1,800 tokens/reminder call, ~1,400 tokens/post_run call.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-19 — Store and use exact goal race distance for non-standard events

**Type:** Feature / Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Non-standard race distances (e.g., a 25K, 9-mile trail race, 80K) were bucketed to the nearest standard goal type (30K, 10K, 100K) but the bucket's canonical distance was used for all downstream calculations. A 25K athlete with a 2:45 goal would get their target pace calculated over 18.64 miles (30K) instead of 15.53 miles (25K), making the pace wrong. The coach framing also didn't mention the actual distance.
**Fix / Change:**
- Added `goal_distance_miles float` column to `training_profiles` (migration 018). Backfilled with standard bucket distances for all existing rows.
- Goal classifier in `onboarding/handle` now outputs `goal_distance_miles` when a non-standard distance is mentioned (e.g., "25K" → 15.53). Standard distances return null; `completeOnboarding` fills those from the bucket lookup.
- `completeOnboarding` writes `goal_distance_miles` to `training_profiles` (exact if available, bucket standard otherwise).
- `coach/respond` pace calculation uses `profile.goal_distance_miles` first, falling back to bucket distance. For a 25K athlete targeting 2:45, the pace now reflects the actual 15.53 miles.
- System prompt goal display appends `(X miles)` when the stored distance differs from the bucket standard by more than 0.5 miles, so Claude always knows the exact race distance.
**Files changed:** `supabase/migrations/018_goal_distance_miles.sql`, `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-19 — Race distance classification overhaul (50mi/100mi + non-standard)

**Type:** Bug Fix
**Reported by:** Follow-up audit of race distance handling
**User feedback:** N/A (proactive audit triggered by b1b308cf 50K/50-miler hallucination)
**Root cause:** The goal classifier in onboarding never produced "50mi" or "100mi" as output values — only "50k" and "100k" existed in the prompt. Any athlete saying "50-mile race" had their goal stored as "50k", which propagated forward into every system prompt, taper calculation, and coaching message. The b1b308cf hallucination (50-miler called 50K) traced directly to this. Additionally: non-standard distances (25K, 80K, 9-mile) had no explicit mapping rules and could map unpredictably; ULTRA_GOALS constant was missing 50mi/100mi so onboarding skipped the wrong questions; runGoalDistancesMiles had no 50mi/100mi so goal pace couldn't be calculated; formatGoalInline (onboarding display) had no labels for those types.
**Fix / Change:**
- Goal classifier: added "50mi" and "100mi" as valid output types with explicit rules ("50 miles", "50-miler", "fifty miles" → "50mi"; "100 miles", "100-miler", "Western States", "Leadville", "UTMB" → "100mi"). Critically: added "NOT 50k" warning so the model doesn't quietly collapse 50-milers.
- Non-standard distance bucketing: added explicit rules (under 12K → "10k"; 13K–42K → "30k"; 60K–80K → "100k"; 15mi–49mi → "50mi"; 60mi–99mi → "100mi"). Added instruction to return null rather than guess "50k" for races that are clearly shorter.
- Added race_name field to classifier output: when the athlete mentions a specific named event (Western States, Dipsea, 25K Marin Headlands) or a non-standard distance, the exact name is stored in onboarding_data.race_name. The coaching system prompt then uses this for display instead of the generic bucket label — so Claude says "your 25K Marin Headlands race" not "your 30K trail race".
- ULTRA_GOALS constant: added "50mi" and "100mi" — affects onboarding step-skipping (ultra background question), fitness level assessment, and default mileage baseline.
- formatGoalInline (onboarding): added "50mi" → "50-mile ultra" and "100mi" → "100-mile ultra".
- runGoalDistancesMiles (coach/respond): added "50mi" = 50.0 and "100mi" = 100.0 miles — enables goal pace calculation for athletes who have a finish time goal.
- System prompt: `goalDisplay` now uses raceName (onboarding_data.race_name) when available, falling back to formatGoalLabel(profile.goal).
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts, scripts/test-race-distance-handling.mjs

## 2026-03-19 — March 2026 coaching accuracy batch (9 issues, P0–P2)

**Type:** Bug Fix (batch)
**Reported by:** Internal observation / session review
**User feedback:**
- (Scott, 837e368a): Coach Dean prescribed 15 miles to an athlete running 5 miles/week — a 200% jump in week one. "Give your body room to adapt without jumping too fast" appeared in the same message that tripled their volume.
- (User b1b308cf): "Reminder, I'm doing a 50 mile race not 50k"
- (User 479e43d6): "No, the week before the 16.8 was 12.84, per Strava" (Coach had cited 6.8)
- (User 479e43d6): "Also where did you get race day from, I don't remember saying I was going to do a race."
- (User 479e43d6): "I thought your original plan for the week for me was 3 miles Thursday, 4 miles Saturday" (Coach forgot its own plan)
- (Roya, 61ae5521): Asked for 5 days, got 4. Asked for 6 days, Coach ignored the request the first time.
- (Scott, 837e368a): "sure, reminders around 3pm on the day of the run" → Coach confirmed "morning" instead.
- (User 455af698): Two post-run messages ~56 minutes apart — one from coach_response, one from Strava post_run trigger. Slightly different day counts (11 vs 10 days to race).
- (User 55babb83): Weekly mileage tracker went 10mi → 12.4mi → 7mi across 3 messages on the same day.

**Root causes:**
1. (P0) No numerical volume cap in system prompt — Claude used race ambition (50K) to justify 15 miles, ignoring the 5 mi/week baseline. The FITNESS TIER said "be conservative" but gave no hard number.
2. (P1) "50mi" was not in formatGoalLabel, and the system prompt didn't explicitly instruct Claude to use only the stored race description — Claude substituted from context or memory.
3. (P1) No explicit rule preventing Claude from citing mileage numbers not in the WEEKLY MILEAGE table.
4. (P1) Same root cause as #2 — race goal could appear in plan without being verified against stored profile data.
5. (P2) weekly_plan_sessions persistence was in place, but user_message prompt didn't explicitly instruct Claude to quote stored sessions before offering alternatives.
6. (P2) No count-validation step in weekly_recap prompt — Claude counted wrong without a check.
7. (P2) System prompt said "specific times not supported" but didn't instruct Claude to disclose the constraint before confirming. Claude confirmed "morning" when athlete asked for 3pm.
8. (P2) CONTEXT CHECK only mentioned athlete messages; didn't cover the Strava-delay scenario where Coach already responded and Strava fires a second post_run trigger 60 min later.
9. (P2/P9) AUTHORITATIVE mileage figure should be the single source, but the week boundary drop (12.4 → 7) likely reflects a timezone or run-date edge case. The existing guards should catch it; no code change beyond the historical mileage rule.

**Fix / Change:**
1. Added ⚠️ WEEK 1 VOLUME CAP section to FITNESS TIER in buildSystemPrompt. For athletes <10 mi/week: hard cap = max(current × 1.30, 6 mi). Includes explicit example: "5 mi/week → 15 mi is 200% jump and is wrong." For null history: cap is 10 mi. Also reinforced in initial_plan user message VOLUME AND SAFETY section.
2. Added "50mi" → "a 50-mile ultra" and "100mi" → "a 100-mile ultra" to formatGoalLabel. Added ⚠️ RACE DATA RULE immediately after the Goal line in ATHLETE HISTORY: "Do NOT substitute a different distance or race type from memory or inference."
3. Added ⚠️ HISTORICAL MILEAGE RULE to MEMORY AND DATA LIMITATIONS section: cite only values from WEEKLY MILEAGE table; if a week isn't there, say "I don't have exact data for that week."
4. Same as #2 fix — RACE DATA RULE prevents fabricated races too.
5. Added PLAN CONSISTENCY block to user_message trigger: "If UPCOMING SESSIONS THIS WEEK exists in CURRENT TRAINING STATE, reference those stored sessions first — don't reconstruct from memory or guess different distances."
6. Added TRAINING DAY COUNT VALIDATION to weekly_recap SCHEDULE CONSTRAINT: count running sessions before finalizing, verify against athlete's days/week preference.
7. Added ⚠️ REMINDER TIME CONSTRAINT to PRODUCT CAPABILITIES: "If athlete requests a non-supported time (3pm, noon, etc.), immediately disclose the constraint — do NOT confirm first and correct later."
8. Updated post_run CONTEXT CHECK: explicitly covers the case where a prior coach response (not just an athlete message) already addressed this workout, explaining the Strava-delay scenario.

**Files changed:** src/app/api/coach/respond/route.ts, scripts/test-bug-fixes-mar2026.mjs

## 2026-03-18 — Fix post_run week-mileage reporting (multi-iteration)

**Type:** Bug Fix
**Reported by:** Jake (observed on Ian's account)
**User feedback:** "Dean got confused and thought he had already done 9 this week, and will be hitting 15 total — he had only run three"
**Root cause:** Multiple compounding issues: (1) `correctMileageTotal` was rewriting correct week-to-date figures to the projected total; (2) the current activity appeared in both RECENT WORKOUTS and the user message, causing double-counting; (3) even with tags, Claude was summing run distances from different weeks; (4) `admin/trigger` wasn't forwarding `activityId` so exclusion logic never fired in tests.
**Fix / Change:** Suppressed RECENT WORKOUTS listing for post_run triggers (current activity shown in user message; history in weekly summary table is sufficient); injected week-to-date mileage as `⚠️ WEEK-TO-DATE: X mi` directly into the post_run user message so it can't be ignored; skipped `correctMileageTotal` post-processing for post_run/user_message triggers; fixed admin/trigger to forward activityId.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/admin/trigger/route.ts`

## 2026-03-18 — Fix cross-week mileage summing ("9.2 miles this week" when only 3 were run)

**Type:** Bug Fix
**Reported by:** Jake (observed on Ian's account)
**User feedback:** "Dean got confused and thought he had already done 9 this week, and will be hitting 15 total — he had only run three"
**Root cause:** `RECENT WORKOUTS` section in `buildActivitySummary` listed all runs chronologically with no week labels. Ian had 3 runs: Mar 5 (3.0mi), Mar 12 (3.0mi), Mar 18 (3.2mi). Claude summed all three = 9.2 miles and reported that as "this week's" mileage, ignoring the ⚠️ AUTHORITATIVE WEEKLY MILEAGE figure (3.3 mi) in the system prompt.
**Fix / Change:** Each entry in `RECENT WORKOUTS` now includes a `[THIS WEEK]` or `[Nwk ago]` tag. Also added a guard that marks remaining plan sessions as "optional/bonus miles — do NOT add to week total" when `weekMileageSoFar >= weekly_mileage_target`, preventing downstream projection errors.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-03-18 — Confetti effect on weekly recap when athlete hits their mileage goal

**Type:** Feature
**Reported by:** Internal / product idea
**User feedback:** N/A
**Root cause:** N/A — new feature
**Fix / Change:** When a Sunday weekly recap fires and the athlete completed ≥90% of their weekly mileage target, the final message bubble is sent with an iMessage confetti screen effect via the Linq `/chats/{chatId}/messages` endpoint. Uses `sendMessageWithEffect()` (new helper in `linq.ts`) which POSTs to the messages sub-resource with `"effect": { "type": "screen", "name": "confetti" }`. Gracefully falls back to a regular `sendSMS` send if no `chatId` is available. Effect is scoped to `weekly_recap` only — no other triggers — to avoid overuse.
**Files changed:** src/lib/linq.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-18 — Improve non-Strava user path: mileage baseline + text-tracking habit

**Type:** Feature / Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Non-Strava users received no mileage question during onboarding — `computeAvgWeeklyMileage` returned null, so the system defaulted to the "No activity data" fitness tier and treated every Strava-skipping runner as a beginner regardless of their actual fitness. The initial plan also gave no guidance on how to log workouts without Strava.
**Fix / Change:**
- New `awaiting_mileage_baseline` onboarding step (inserted after `awaiting_schedule`, before `awaiting_ultra_background`): fires only for non-Strava users who haven't already mentioned their weekly mileage. Asks "Roughly how many miles a week are you running right now?" Uses Claude Haiku to parse the number and stores it as `onboarding_data.weekly_miles`.
- `computeAvgWeeklyMileage` now falls back to `onboarding_data.weekly_miles` when the 6-week Strava average is null. This means an experienced runner who skips Strava immediately gets the correct fitness tier (MODERATE / HIGH VOLUME) from day 1 instead of beginner defaults.
- Updated `awaiting_ultra_background` question: no longer re-asks for weekly mileage when `awaiting_mileage_baseline` already captured it.
- `initial_plan` prompt: when `hasStrava = false`, instructs Dean to add a natural closing line setting the expectation that the athlete should text after each run ("Since you're not on Strava, just shoot me a text after each run — even a quick 'done' — and I'll track from there."). Sets the text-tracking habit from the very first message.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-18 — Fix bike activities polluting run mileage, double onboarding message, and range typo

**Type:** Bug Fix (3 issues)
**Reported by:** User 55babb83 (bike mileage), User 2201ddfe (double onboarding), User b1b308cf (range typo)
**User feedback:**
- "4mi bike at 4:32 average — that's solid controlled cross-training... You're at 9.8mi this week" (bike miles included in running weekly total)
- Dean sent two messages 1 min apart during onboarding, both asking "which days work best for you?"
- "That puts you at 34-26 miles total for the week" (nonsensical range after regex replacement)
**Root cause (bike):** `deduplicateActivities()` and the Strava webhook near-dupe query didn't guard against cross-type matches — a Ride could near-dupe a Run and delete it (causing mileage to drop). Separately, `buildActivitySummary`'s `roadRuns` pace-analysis filter used only pace threshold (< 12 min/mi), so bikes at ~13 mph passed and appeared in PACE ANALYSIS.
**Root cause (onboarding double-message):** Race condition between the Strava OAuth callback and the onboarding SMS handler. If the user texted while the Strava link was being authorized, both the callback (which asks the schedule question) and the `handleStrava` onboarding handler (which advances the step and also asks the schedule question) fired within seconds of each other.
**Root cause (range typo):** `correctMileageTotal` pattern 2 (`/(~?)(\d+)(\s*mi...total|this week|for the week)/`) matched the second number in a range like "34-36 miles total", replacing "36" with the calculated total (26) and producing "34-26 miles".
**Fix / Change:**
- `deduplicateActivities`: added `if (k.activity_type !== a.activity_type) return false` — activities of different types can never be near-dupes of each other
- Strava webhook near-dupe query: added `.eq("activity_type", activity.type)` so DB-level filtering prevents cross-type deletion
- `buildActivitySummary.roadRuns`: added `if (!RUN_TYPES.has(a.activity_type)) return false` before the pace threshold check
- Strava callback: before sending the schedule question to non-onboarded users, checks `conversations` for any assistant message in the last 3 minutes; if found, sends a shorter "Strava connected! Go ahead and answer that question above" instead of re-asking the same question
- `correctMileageTotal` all `totalPatterns`: added `(?<!-)` lookbehind before the number capture group — numbers immediately preceded by a dash (part of a range) are now skipped
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/webhooks/strava/route.ts, src/app/api/auth/strava/callback/route.ts, scripts/test-dedup-mileage.mjs

---

## 2026-03-18 — Fix taper mileage targets shifting between messages

**Type:** Bug Fix
**Reported by:** User b1b308cf
**User feedback:** Dean said "36 miles this week" at 14:30, then "26 miles this week" at 17:19 — same day, same taper week, different targets.
**Root cause:** The taper protocol computed peak volume from `avgWeeklyMileage` on every message. Between the two messages, `avgWeeklyMileage` changed (likely because the 6-month async import completed and shifted the rolling average), causing the taper targets to recalculate to different numbers with no acknowledgment of the change.
**Fix / Change:** Added `taper_peak_miles` column to `training_state`. The first time a user enters the taper window (≤21 days to race), the computed peak is stored and locked in. All subsequent messages use the stored peak instead of recalculating. Cleared on `initial_plan` so a new training cycle after the race gets a fresh peak.
**Files changed:** `supabase/migrations/017_taper_peak_miles.sql`, `src/lib/database.types.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-18 — Fix mid-week plan total ignoring already-completed miles

**Type:** Bug Fix
**Reported by:** User b1b308cf
**User feedback:** "That puts you at 29 miles total for the week" — actual total was 38.8mi (9.8mi already done + 8+6+5+10mi planned)
**Root cause:** `correctMileageTotal()` summed the planned session list (29mi) and compared it to Dean's stated total (also 29mi) — so |29-29| = 0, no correction triggered. The function had no knowledge of miles already completed earlier in the week, so "plan-only total = stated total" looked correct even though the true week total was 38.8mi.
**Fix / Change:** `correctMileageTotal()` now accepts `alreadyCompletedMiles`. For mid-week triggers (`post_run`, `user_message`) it receives `weekMileageSoFar`; for full-week plan triggers (`weekly_recap`, `initial_plan`) it receives 0. When a stated total matches the plan-only sum but existing miles are present, it corrects to `planned + completed`. When a stated total already matches the full week total, it's left alone.
**Files changed:** `src/app/api/coach/respond/route.ts`, `scripts/test-dedup-mileage.mjs`

---

## 2026-03-18 — System prompt cleanup: remove extraneous/stale fields, gate race prep

**Type:** Improvement
**Reported by:** Internal review
**User feedback:** N/A
**Root cause:** System prompt contained several fields that were either stale, redundant, or present for all users regardless of relevance — adding noise and potential for confusion.
**Fix / Change:**
- `ytd_run_totals` re-added with freshness label ("as of Mar 16" vs "as of Strava connect") and now refreshed weekly via the sunday-recap cron. Weekly refresh also stores `all_run_totals`. Future use: YTD milestone callouts in weekly recap ("you've hit 500 miles this year!").
- `- Fitness level:` removed from ATHLETE HISTORY — redundant with and potentially contradicting the live-computed FITNESS TIER above it.
- `- Weekly volume:` removed from ATHLETE HISTORY — duplicated `Weekly mileage target` in CURRENT TRAINING STATE.
- RACE PREPARATION & STRATEGY block (~35 lines) now gated to within 84 days of race date. For non-racers or athletes many months out, this block was prompt bloat shown on every single message.
- `weekly_recap` prompt updated to call out YTD milestones (100, 250, 500mi etc.) when the athlete crosses one, woven naturally into the recap.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/cron/sunday-recap/route.ts`

---

## 2026-03-18 — Fix weekly mileage hallucination from stale Strava stats aggregate

**Type:** Bug Fix
**Reported by:** User b1b308cf
**User feedback:** "I am not at 27 miles for the week. I'm at 10 miles" — Dean cited 26–27 miles across three consecutive messages before the athlete corrected it. Actual total was 9.8 miles.
**Root cause:** The system prompt included `recent_run_totals` from the Strava stats API — a 4-week aggregate snapshot captured at connect time and never updated. This user's snapshot showed ~27 miles over 4 weeks. Despite a "NOT this week" label, the model grabbed that aggregate and used it as the current week's total, ignoring the authoritative `computeWeekMileage()` figure of 9.8mi. The model even correctly listed the individual activities (7.4mi + 2.4mi = 9.8mi) but still cited 27 miles — a clear case of the wrong field winning over the correct one.
**Fix / Change:** (1) Removed `recent_run_totals` from the system prompt entirely — it's stale, redundant with the live WEEKLY MILEAGE section, and provably dangerous. (2) Renamed the authoritative mileage line to start with "⚠️ AUTHORITATIVE WEEKLY MILEAGE" and added explicit "do NOT use YTD, all-time, or any other aggregate" instruction. (3) Added a MILEAGE ACCURACY block at the top of the post_run trigger prompt requiring the model to read the authoritative line before writing any mileage figure.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-17 — Avoid double post-run response when athlete texted before Strava synced

**Type:** Improvement
**Reported by:** Jake (internal observation)
**User feedback:** N/A
**Root cause:** If an athlete texted Dean about their workout before Strava synced, Dean responded to the user_message. When the webhook fired minutes later, `isNew = true` so `post_run` triggered a full second response — same workout, potentially redundant or contradicting.
**Fix / Change:** Added CONTEXT CHECK to the `post_run` prompt. If the recent conversation already includes an exchange about this workout, Dean sends 1-2 sentences adding only what's new from Strava data (pace, HR, splits) rather than a full re-analysis.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-17 — Avoid redundant cron messages when Dean already covered the plan

**Type:** Improvement
**Reported by:** Jake (internal observation)
**User feedback:** "wondering if we should skip the cron if dean already mentioned what to do for tomorrow in earlier conversation"
**Root cause:** Nightly and morning reminder crons fired unconditionally even if Dean had already explicitly addressed tomorrow's/today's workout in a prior conversation that day (e.g. post-run exchange where Dean said to skip the next day due to illness). Sunday weekly recap also didn't close with Monday coverage, causing a redundant Monday morning reminder.
**Fix / Change:** (1) Added CONTEXT CHECK instruction to both `nightly_reminder` and `morning_reminder` prompts — Dean now scans recent conversation and sends a brief 1-sentence confirmation instead of a full re-plan if tomorrow/today was already addressed. (2) Updated `weekly_recap` prompt to include Monday's session clearly and close naturally with an invitation to check in after Monday. (3) Added Monday morning reminder cron skip if a `weekly_recap` was sent in the last 18 hours.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/cron/morning-reminder/route.ts`

---

## 2026-03-17 — Fix weekly mileage history on initial Strava connect

**Type:** Bug Fix
**Reported by:** Internal observation (Gwyneth's connect week)
**User feedback:** "the week my wife connected strava we only had part of her activities in the activities table, so maybe are getting the mileage for that week incorrect based on her conversation"
**Root cause:** Two bugs: (1) The synchronous activity import on connect only fetched 14 days, so `computeAvgWeeklyMileage` (which needs 6 complete prior weeks) was computed from incomplete data on the first coaching message. (2) `computeAvgWeeklyMileage` used `Object.values(weeks).slice(-6)` which — since activities are fetched newest-first — was returning the 6 *oldest* weeks in the dataset rather than the 6 most recent.
**Fix / Change:** Expanded the synchronous import on Strava connect from 14 days to 8 weeks (56 days), so both current-week mileage and the 6-week average are accurate before `initial_plan` fires. Fixed `slice(-6)` to sort week keys alphabetically (YYYY-MM-DD = chronological) before slicing, ensuring the most recent 6 weeks are always used.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-16 — Fix mileage total correction for complex interval sessions

**Type:** Bug Fix
**Reported by:** Daily conversation analysis (User 455af698)
**User feedback:** "Wait this is 25 miles not 16 fyi" / "You're right — my math was way off… That's 26 miles, not 16."
**Root cause:** `correctMileageTotal()` extracted the first mileage figure from each session line, which for complex interval sessions (e.g. "Intervals 2mi easy, 3×1mi @ 6:45, 1mi cooldown ≈7mi") grabbed "2" instead of the intended total "7". This caused the computed sum to be significantly lower than the actual planned mileage, so when Claude stated the wrong total (16 vs 26), the post-processing guard also computed ~16 and left it uncorrected.
**Fix / Change:** Updated session mileage extraction to prefer explicit total markers (`≈Xmi`, `~Xmi`, `(Xmi total)`) before falling back to the first mileage figure. Also added two more total-phrase patterns to the regex so phrasing like "weekly total: X" and "puts you at X miles" get caught and corrected.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-16 — Daily conversation analysis digest email

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** No automated way to catch coaching errors, hallucinations, or user complaints between manual review sessions.
**Fix / Change:** Added `/api/cron/analyze-conversations` — runs daily at 9am UTC. Fetches all conversations from the prior day, groups by user, and sends full transcripts to Claude Opus for analysis. Claude looks for coaching errors, data hallucinations, user corrections/complaints, onboarding friction, and positive patterns worth preserving. Results are emailed as an HTML digest via Resend to `ANALYSIS_EMAIL_TO`. Uses `RESEND_API_KEY` env var. Schedule skips if there were zero conversations.
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`, `vercel.json`, `.env.local.example`, `package.json`

---

## 2026-03-15 — Deduplicate near-identical Strava activities inflating mileage totals

**Type:** Bug Fix
**Reported by:** Luke (user feedback)
**User feedback:** "he says he's at 58 miles this week, but this is the message he got from Dean [65.6 miles last week]"
**Root cause:** Strava can create two separate activities with different activity IDs for the same physical run (e.g. watch auto-sync + manual GPX upload, start times 5 seconds apart). The webhook deduplicated same-ID events but had no guard against different-ID near-duplicates. Luke had 9 activities in the DB for a week where he ran 7 times; one duplicate (7.0mi) inflated his week total from ~58mi to ~65.6mi.
**Fix / Change:**
1. **Webhook ingestion** (`/api/webhooks/strava`): after storing a new activity, query for existing Strava activities from the same user with start times within ±2 minutes and distance within 15%. If found, keep the richer record (has HR wins); delete the weaker duplicate. Suppress the second coaching trigger regardless of which record survives.
2. **`deduplicateActivities()` helper** in `coach/respond`: strips near-duplicates from the `recentActivities` list before it's passed to `computeWeekMileage`, `buildActivitySummary`, etc. This fixes existing dupes already in the DB without requiring a backfill migration.
**Files changed:** `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-15 — Weekly plan consistency: persist schedule changes, constrain weekly_recap to training days

**Type:** Bug Fix
**Reported by:** Ian (user conversation)
**User feedback:** "I think I'm doing Tuesday or Wednesday + Thursday + Sunday as per your previous guidance (might have 2 chats going?). Saturday will likely be spin class + pickleball again." — Sunday morning said rest/hike, Sunday evening recap generated Thu/Sat/Sun instead of honoring the confirmed Tue+Thu+Sun schedule.
**Root cause:** Two issues: (1) When an athlete changes their recurring schedule mid-conversation ("I'm switching to Tue/Thu/Sun"), `training_days` in `training_profiles` was not updated — only `weekly_plan_sessions` for the current week. The next weekly_recap fired without knowing the new schedule. (2) The `weekly_recap` prompt had no explicit constraint requiring it to use stored `training_days`, so Claude would sometimes generate sessions on wrong days.
**Fix / Change:** Added `updated_training_days` field to `ExtractedProfileData` and the Haiku extraction prompt. When detected, `persistProfileUpdates` now updates `training_days` in `training_profiles`. Added `SCHEDULE CONSTRAINT` block to both `weekly_recap` and `initial_plan` prompts: "Only schedule sessions on the athlete's confirmed training days listed under 'Training days' in ATHLETE HISTORY."
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-15 — Onboarding improvements (LOW priority batch)

**Type:** Improvement
**Reported by:** Onboarding simulation (10 athletes, 2026-03-12)
**User feedback:** N/A (simulation findings)
**Root cause:** Four onboarding gaps identified: (1) month-only race date caused cold re-ask, (2) returning runners classified as general_fitness losing their fitness context, (3) stale PRs used without a staleness warning, (4) race date question felt formal for vague beginners.
**Fix / Change:**
- Added `race_month` field to `extractAdditionalFields`. If a month is mentioned but no specific date, `getStepQuestion("awaiting_race_date")` now pre-fills: "You mentioned [Month] — do you have a specific date in mind?"
- Added `return_to_running` goal type to classifier, `getSportType`, `formatGoalInline`, `isStepSatisfied` (skips race_date and goal_time steps), and acknowledgment text.
- Added `pr_year` extraction in `extractAdditionalFields`. If PR year is ≥2 years old, coaching system prompt flags: "PR data is from [year] — X years ago. Treat as a starting estimate."
- Softened `awaiting_race_date` question for beginners (experience_years < 0.5): "Do you have a specific date in mind, or is it more like 'sometime this summer'?"
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

## 2026-03-15 — Rules-based taper protocol

**Type:** Feature
**Reported by:** Conversation analysis (users 55babb83, 455af698, b1b308cf)
**User feedback:** Same timeframe before race, three users received completely different taper logic — one got a tempo run 9 days out, another got easy miles, a third got 30-35mi at 2 weeks out.
**Root cause:** Taper plans were generated entirely by the LLM from vague system prompt guidelines. No concrete volume targets existed, so output was inconsistent across users.
**Fix / Change:** Added a code-computed taper block in `buildSystemPrompt`. When `daysUntilRace <= 21` and average weekly mileage is known, a `TAPER PROTOCOL` section is injected with specific week-by-week mileage targets (computed as percentages of peak volume, varying by race distance: marathon, half, ultra, shorter). The LLM personalizes language but must use these numbers. Race week is always easy-only.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-15 — Strava data hallucination guard

**Type:** Bug Fix
**Reported by:** Conversation analysis (user 455af698)
**User feedback:** "It was a rainy trail run in Hawaii where we got lost and went farther than we thought we wanted to!!" — suggested Dean described a run that didn't match reality
**Root cause:** When `post_run` triggered with limited Strava data (no splits, no HR, no laps), Claude would infer or fabricate specific lap paces, HR values, and mile splits — presenting them as fact.
**Fix / Change:** Added `DATA AVAILABILITY GUARD` block in the `post_run` user message. For each data type (splits, laps, HR), if the data is absent in `activityData`, an explicit instruction is injected: "No [type] data was synced from Strava. Do NOT quote specific values." Claude can only reference data that's actually present.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-15 — Injury escalation protocol

**Type:** Feature
**Reported by:** Conversation analysis (multiple users)
**User feedback:** "Right knee and ankles felt very tight this session." / "Still some soreness in my right glute... sitting in airports a lot... seems to aggravate the glute as well"
**Root cause:** Dean had no mechanism to detect or escalate recurring injuries — it continued coaching normally even when the same body part was flagged session after session.
**Fix / Change:** Added `injury_body_parts text[]` column to `training_profiles`. Haiku extraction now identifies the primary body part (knee, glute, shin, etc.) from any injury mention and accumulates it in the DB. If a body part is already in `injury_body_parts` when mentioned again, the system prompt injects a RECURRING INJURY ALERT instructing Dean to (1) acknowledge the recurrence, (2) recommend rest or reduced intensity, (3) refer to a PT/sports doc.
**Files changed:** migrations/016_injury_body_parts.sql, supabase/migrations/016_injury_body_parts.sql, src/app/api/coach/respond/route.ts, src/lib/database.types.ts

## 2026-03-15 — Weekly mileage math error correction

**Type:** Bug Fix
**Reported by:** Conversation analysis (user 455af698)
**User feedback:** "Wait this is 25 miles not 16 fyi"
**Root cause:** Claude was summing weekly session distances itself — a task LLMs are unreliable at. Errors of 10+ miles were possible.
**Fix / Change:** Added `correctMileageTotal()` post-processing function that parses session lines from the generated message, sums running miles in code, and replaces any stated weekly total that differs by more than 0.4 miles. Also added a `MILEAGE ACCURACY` instruction in the system prompt requiring Claude to verify the total before writing it.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-15 — VDOT and pace zones persisted to DB

**Type:** Bug Fix
**Reported by:** Conversation analysis (user 455af698)
**User feedback:** Three different easy pace ranges in one conversation — "9:30-10:00/mi", "8:45-9:30/mi", "7:40–8:10/mi"
**Root cause:** VDOT was being recalculated by Claude from scratch each message, with Claude using web search to look up its own (inaccurate) VDOT tables. No persistent ground truth existed.
**Fix / Change:** Added `current_vdot numeric` column to `training_profiles`. Haiku extraction now fires before `buildSystemPrompt` for user messages — if a PR is mentioned, VDOT + paces are computed in code (Jack Daniels formula) and injected into the system prompt immediately. VDOT and paces are also persisted to the DB for all future sessions. System prompt includes a CRITICAL block forbidding web search or recalculation of paces.
**Files changed:** migrations/015_current_vdot.sql, supabase/migrations/015_current_vdot.sql, src/app/api/coach/respond/route.ts, src/lib/paces.ts, src/lib/database.types.ts

---

## 2026-03-14 — Fix: coach recalculating wrong VDOT via web search despite stored paces

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** Even after paces were updated to 7:41/mi in the system prompt, coach responded "For a 17:23 5K (VDOT ~54-55), your easy pace should be 8:45-9:30/mi" — still wrong.
**Root cause:** Three compounding issues: (1) `calculateVDOTPaces` didn't return the VDOT value so it couldn't be surfaced in the system prompt. (2) Training philosophy rule #3 said "use race times to assign paces" which actively invited Claude to recalculate. (3) The no-recalculate rule was a parenthetical in the paces line, not a prominent rule. Claude used web search, found incorrect VDOT tables showing 54-55, and trusted them over the system prompt.
**Fix / Change:** (1) `calculateVDOTPaces` now returns `vdot` alongside the paces. (2) The computed VDOT is passed through `buildSystemPrompt` and shown explicitly as "Athlete VDOT: X.X" in CURRENT TRAINING STATE. (3) Added a `CRITICAL — TRAINING PACES` block right after the output rules (high in the prompt) explicitly forbidding VDOT recalculation and web search for paces. (4) Fixed rule #3 to say "use the stored paces from CURRENT TRAINING STATE". After these changes, dry_run test confirmed correct response: "VDOT 58.7... Easy: 7:40-8:10/mi".
**Files changed:** src/lib/paces.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-14 — Fix: web search pre-tool reasoning leaking into SMS + VDOT recalculation guard

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** Coach Dean response started with "Looking at the VDOT tables, I need to verify the easy pace calculation for Jake's 17:23 5K time. A 17:23 5K gives a VDOT of approximately 54-55..." — internal reasoning visible in the SMS, plus wrong VDOT (should be 58.65).
**Root cause:** With `web_search_20250305`, Claude emits text blocks both before the `tool_use` block (internal reasoning) and after it (actual response). The code was concatenating ALL text blocks, so pre-search reasoning leaked into the final message.
**Fix / Change:** Find the index of the last `tool_use` block in response.content; only include text blocks that come after it. When no tool is used, `lastToolIdx === -1` so `slice(0)` keeps all blocks — no behavior change for non-search responses. Also added a system prompt note on the paces line telling the coach NOT to recalculate VDOT itself.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-14 — Fix: coach responds with stale paces when athlete shares PR mid-conversation

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "Hey, just confirming 9:30 to 10-minute should be my target easy pace. I think I told you before but my fastest 5K is 17:23 so I just want to make sure that we've got the right paces dialed in." — Coach Dean responded with VDOT 54-55 and 8:45-9:30 easy, both wrong. Correct VDOT is 58.65 → easy ~7:41/mi (~7:40-8:10 display range).
**Root cause:** `extractAndPersistProfileUpdates` ran fire-and-forget AFTER the coaching response was generated. So when the athlete shared a PR, the system prompt still contained the old stored paces and Claude had to calculate VDOT itself — getting it wrong (54-55 vs 58.65, and even that wrong VDOT produced incorrect easy pace ranges).
**Fix / Change:** Refactored into `extractProfileData` (Haiku call + parse, returns data only) and `persistProfileUpdates` (DB writes only). For `user_message` triggers, `extractProfileData` is now awaited BEFORE `buildSystemPrompt`. If race data or an easy pace is found, the in-memory `profile` is updated with freshly computed VDOT paces. The coaching response then sees correct paces. DB persistence still happens fire-and-forget after the response (no extra Haiku call — same extraction result is reused).
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-14 — Fixed elevation unit bug in laps and wrong week comparison for mileage ramp

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "I think a few things are off. That's a huge day — 11.5 miles with 1247ft of climbing. [...] Mile 11 tells the real story though — 36:15/mi pace with 333ft of gain. [...] The first thing is that it was more than 333 ft of elevation gain - I think we should check to confirm this isn't done in meters, since the elevation gain I think was actually around 1k ft for that mile. [...] I actually went over 30 mi last week too, so 31 miles isn't a 36% jump"
**Root cause (elevation):** `transformSplitForClaude` was only converting `elevation_difference` (used in Strava splits), but Strava laps use `total_elevation_gain` — a different field that was never converted. Claude saw the raw meter value and, per the glossary that says "elevation in feet", reported it as feet (333m shown as 333ft instead of 1093ft). Also switched `splits_imperial` → `splits_metric` in the webhook, since splits_metric guarantees meters for all fields (splits_imperial elevation_difference unit is ambiguous across Strava clients).
**Root cause (weekly ramp):** `weekOverWeekRampPct` was comparing the last two *completed* weeks (e.g., March 2-8 vs Feb 23-Mar 1), but Dean was misapplying it to "this week vs last week." Fixed to compare the current week's mileage (already computed as `weekMileageSoFar`) vs the last completed week — which is the comparison athletes and coaches actually care about.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/webhooks/strava/route.ts`

---

## 2026-03-13 — Added dedicated injury background step in onboarding

**Type:** Improvement
**Reported by:** Internal observation / roadmap item
**User feedback:** N/A
**Root cause:** `awaiting_anything_else` was doing double duty for injury_recovery athletes: asking for injury details AND then re-prompting "anything else?" after they answered. This felt mechanical — a focused injury Q&A immediately followed by a generic catch-all.
**Fix / Change:** Added `awaiting_injury_background` step (parallel to `awaiting_ultra_background`). Injury athletes now get a dedicated focused question ("Tell me more about the injury...") as its own step, with extraction into `injury_notes` and `can_run_now`. `awaiting_anything_else` then fires as a true catch-all for cross-training, paces, etc. — without re-asking about the injury.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-13 — Secondary race goal now stored; race date hallucination fixed

**Type:** Bug Fix
**Reported by:** Onboarding simulation (roadmap.md MEDIUM items)
**User feedback:** N/A (simulation-identified)
**Root cause:**
1. `generateRaceAcknowledgment` acknowledged secondary goals ("and we can keep that 100K in mind") in the ack text, but the `RaceInfo` type had no `secondaryGoal` field — so it was never extracted or stored. After the goal step, the secondary goal was lost unless the athlete repeated it in "anything else."
2. `generateAnythingElseResponse` passed `race_date` as a raw ISO string (`"2025-10-19"`) in its context string. Claude hallucinated "October 1st" from this, presumably rounding or misreading the date.
**Fix / Change:**
1. Added `secondaryGoal: string | null` to `RaceInfo`. Updated `generateRaceAcknowledgment` prompt to output `"secondary_goal"` field. Parsed and returned in `RaceInfo`. Stored to `onboarding_data.secondary_goal` in `handleGoal` when present.
2. Removed `race_date` from the context string in `generateAnythingElseResponse`. The goal label (e.g. "marathon") is sufficient for conversational Q&A — no specific date needed there.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-13 — Fixed capitalization bug + reduced "anything else" re-ask round-trips

**Type:** Bug Fix / Improvement
**Reported by:** Onboarding simulation (roadmap.md MEDIUM items)
**User feedback:** N/A (simulation-identified)
**Root cause:**
1. Template `\`${ackPart}${namePrefix}Which distance…\`` always capitalized "Which" regardless of what preceded it. When an ack was present, this produced "Jake, Which distance…" mid-sentence.
2. The `awaiting_anything_else` step question had no explicit "done" signal, causing 5/10 simulated athletes who gave complete answers to receive an unnecessary re-ask. `generateAnythingElseResponse` re-ask also omitted the done signal.
**Fix / Change:**
1. Changed `Which` → `which` in the multi-distance clarification template.
2. Updated `awaiting_anything_else` step question to end with "If not, just say nope!" — makes it clear in the first ask that one-shot answers are fine.
3. Updated `generateAnythingElseResponse` re-asks (both question-answer and info-share paths) to end with "Anything else? If not, just say nope!" so subsequent rounds also signal how to finish.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-13 — Fixed Dean reporting only planned sessions as weekly total (ignoring completed miles)

**Type:** Bug Fix
**Reported by:** Jake (wife's account)
**User feedback:** "Dean Erroneously Said that my wife will only be at 4 miles for the week after her Saturday run tomorrow, which itself is 4 miles" — she already had 8 miles completed (Mon 3mi + Thu 5mi), so the projected total should have been 12 miles.
**Root cause:** The general system prompt's CURRENT TRAINING STATE shows two "authoritative" fields:
1. "Mileage so far this week: 8.0 mi" (Strava-synced)
2. "THIS WEEK'S PLANNED SESSIONS (authoritative): Sat 3/14 · Easy 4mi"
With no explicit instruction to ADD them when projecting end-of-week totals, Dean treated the planned sessions alone (4 miles) as the projected week total. An explicit "add weekMileageSoFar to remaining planned sessions" instruction existed only in the `initial_plan` user message (line 1643) but not in the general system prompt, so it didn't apply to `user_message` trigger queries like "how's my week looking?"
**Fix / Change:** Extended the "Mileage so far this week" description in CURRENT TRAINING STATE to include: "when projecting end-of-week totals, always ADD this to any remaining planned sessions — never report just the planned sessions as the week total; e.g. if this is 8 mi and Saturday has 4 mi planned, the projected total is 12 mi."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-13 — Fixed calendar sessions showing tomorrow's workout instead of today's for non-UTC users

**Type:** Bug Fix
**Reported by:** Jake (Hawaii, HST = UTC−10)
**User feedback:** "What's on the calendar for today?" — Dean responded "Sat 3/14 · Long run 10mi easy" when it was actually Friday 3/13 at 3:48pm in Hawaii (1:48am Saturday UTC).
**Root cause:** The `activeSessions` filter inside `buildSystemPrompt` used `new Date()` (UTC on Vercel) to determine "today" when filtering out past sessions from the weekly plan. For a Hawaii user at 3:48pm Friday, `new Date()` returned Saturday UTC, so Saturday's session was treated as the earliest "today or future" session. The already-computed `ty/tm/td` variables (user's local date, correctly derived from their timezone) were not being used in this filter.
**Fix / Change:**
1. `activeSessions` filter now uses `new Date(Date.UTC(ty, tm - 1, td))` — the user's local today computed from their timezone — instead of `new Date()` (UTC).
2. Also fixed `extractAndPersistProfileUpdates`: added `timezone` parameter and used it for `todayName` (weekday name in extraction prompt) and `todayDateStr` (replaces `new Date().toISOString().slice(0, 10)` used for skip_date and race_date prompts). These were showing Saturday for Hawaii users when it was still Friday.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-13 — Fixed "." phantom messages and truncated responses from web search multi-block bug

**Type:** Bug Fix
**Reported by:** User (Jake's wife)
**User feedback:** "Coach Dean both wasn't answering her questions and sending just a single . or cutoff text" — e.g. Dean sent "." to "Why do side cramps happen?" and ", or slow to a walk and focus on deep breathing." to "How can I prevent side cramps?" (clearly a fragment missing its first half).
**Root cause:**
When Claude uses the `web_search_20250305` tool, it sometimes emits the **main answer** in a text block *before* calling the tool, then a continuation in a second text block *after* the search results. The code was taking only the **last text block** (assumed to be the full response), throwing away the first block entirely. So the athlete received ", or slow to a walk..." with no explanation, and "." when the trailing text block was empty.
Root comment in code ("concatenating all blocks leaks internal reasoning") was wrong for this case — Claude's "internal reasoning" text blocks with the built-in tool are rare; the real risk was the opposite: losing the substantive answer.
**Fix / Change:**
1. Concatenate all non-empty text blocks with `\n\n`, instead of taking only the last. This preserves the full answer even when Claude splits it across a tool call.
2. Added empty `coachMessage` guard (empty string now treated same as `[NO_REPLY]` — skip send). This was the fallback path that actually sent the empty body to Linq, which Linq delivered as ".".
3. Updated `user_message` trigger to handle multi-segment SMS: "If you see multiple consecutive Athlete messages at the bottom of RECENT CONVERSATION, treat them together as one thought."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-12 — Fixed wrong day name in post-run coaching messages for non-UTC users

**Type:** Bug Fix
**Reported by:** User (Jake)
**User feedback:** "Dean just told me good job on my Friday run, although today is Thursday."
**Root cause:** `buildActivitySummary` and `buildUserMessage` (post_run case) both called `toLocaleDateString("en-US", { weekday: "long", ... })` without a `timeZone` option. On Vercel (UTC server), this formats dates in UTC regardless of the athlete's timezone. Jake ran Thursday evening in Hawaii (HST = UTC−10); Strava stored the `start_date` as Friday 5am UTC. The server formatted it as "Friday." His stored timezone (`America/Denver`) was fetched but never passed into the date formatting calls.
**Fix / Change:** Added `timeZone: timezone` to both `buildActivitySummary` date formatting and the `post_run` case in `buildUserMessage`. Also added `timezone` as a parameter to `buildUserMessage` (defaulting to `"America/New_York"`) and updated the call site to pass `userTimezone`.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-12 — Capability questions in first message no longer silently dropped

**Type:** Bug Fix
**Reported by:** Onboarding simulation (Athlete 8 — Chris)
**User feedback:** "do you work with people who also do cycling? I want to train for a half marathon but also race some crits" — Dean ignored the cycling question entirely and jumped to the goal acknowledgment.
**Root cause:** `detectAndAnswerImmediate` only looked for coaching questions (pace, race-day tactics, route suggestions). Capability/service questions ("do you work with cyclists?", "do you coach beginners?") fell through as `{"no_question": true}`.
**Fix / Change:** Broadened `detectAndAnswerImmediate` prompt to explicitly cover capability and service questions alongside coaching questions. Dean now answers both types before the goal acknowledgment.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-12 — Natural responses to off-topic messages and meta-questions in all onboarding steps

**Type:** Bug Fix / Improvement
**Reported by:** User feedback
**User feedback:** "what will happen if someone says something like 'how many more questions do you have?' in one of these awaiting_cadence or awaiting_timezone steps?"
**Root cause:** `awaiting_cadence` and `awaiting_timezone` were excluded from `checkOffTopic`. Meta-questions in `awaiting_cadence` hit the Haiku "unclear" fallback which responded with "Noted — I'll keep that in mind" (wrong) and saved the message as `injury_notes` (wrong). In `awaiting_timezone`, the message was silently parsed as a city name, defaulting to America/New_York.
**Fix / Change:**
- Added `awaiting_cadence` and `awaiting_timezone` to `checkOffTopic`'s stepContext; removed from exclusion list.
- Added "meta-questions about the onboarding process" to the off-topic examples in `checkOffTopic` prompt so "how many more questions?" / "are we almost done?" are caught and answered briefly before re-asking.
- Fixed `handleCadence` unclear fallback: removed wrong "Noted — I'll keep that in mind" prefix and removed incorrect `injury_notes` DB save. Now just re-asks cleanly.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-12 — Natural conversational responses in awaiting_anything_else and other onboarding steps

**Type:** Feature / Improvement
**Reported by:** User feedback
**User feedback:** "what if the user says 'Can you build me an initial plan for my race 7 weeks away first, and then do a new plan for a race this summer?' in the awaiting_anything_else response? Then I want Dean to actually respond naturally... this could also happen in some of the other steps"
**Root cause:** `awaiting_anything_else` used a one-liner `acknowledgeSharedInfo` that wasn't even sent on the normal completion path. `awaiting_ultra_background` and `awaiting_goal_time` were excluded from `checkOffTopic`, so questions there went unanswered.
**Fix / Change:**
- New `generateAnythingElseResponse` (Sonnet): responds naturally to questions (answers + re-asks "anything else?"), acknowledges shared info + re-asks, or returns `isDone: true` for "nope/nothing/all good". Athlete stays on `awaiting_anything_else` until they signal done.
- `handleAnythingElse` rewritten to use it: training data extraction still runs in parallel so info embedded in questions is captured.
- Added `awaiting_goal_time` and `awaiting_ultra_background` to `checkOffTopic`'s stepContext — questions in those steps now get answered naturally and the original question is re-asked.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-12 — Fixed 4 onboarding bugs: named races, name persistence, intro, question answering

**Type:** Bug Fix
**Reported by:** User feedback (testing onboarding flow)
**User feedback:** "1) I would like Dean to respond if he's asked a question in the first message, and also ask his question back 2) I'm curious why his first response back wasn't the 'I'm an AI endurance coach...' 3) seems he didn't get my name from the first message 4) seems he didn't get my race from the second message"
**Root cause:**
1. (Bug 1) `detectAndAnswerImmediate` was only called when a goal was detected — questions in goal-less first messages went unanswered.
2. (Bug 2) `handleGoal` sent "Hey Jake! What are you training for?" (no intro) when name was already known. No mechanism to know if the intro had been sent by signup vs. handleGoal.
3. (Bug 3) `existingName` only read `onboarding_data.name`, not `users.name`; the name DB save used `void` (fire-and-forget), allowing race conditions or silent failures.
4. (Bug 4) Goal classifier had no rule for named race events — "Behind the Rocks trail race" returned `complete: false` because no explicit distance was provided.
**Fix / Change:**
1. Added `detectAndAnswerImmediate` call in the no-goal path when message contains "?"; answer prepended to response.
2. Signup API now sets `onboarding_data: { intro_sent: true }` on user creation. `handleGoal` checks `onboarding_data.intro_sent` to decide whether to include the intro (personalized with name if known).
3. `existingName` now falls back to `user.name` (column). Name save changed from `void` to `await`.
4. Named race classifier: named specific race/event → `complete: true` so onboarding advances. Classifier uses any explicit distance cues; falls back to "50k" placeholder for ambiguous trail races. `generateRaceAcknowledgment` now returns `distance_options` when web search finds a multi-distance event (e.g. Behind the Rocks has 10K/30K/50K/50mi) — handleGoal intercepts this and asks "Which distance are you targeting?" before advancing, rather than assuming.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/signup/route.ts`

---

## 2026-03-10 — Fixed internal reasoning leaking into coach responses

**Type:** Bug Fix
**Reported by:** Jake (testing onboarding)
**User feedback:** Dean responded with what looked like an internal Claude conversation — "Got it — I'm looking at Jake's Strava now to build week 1. I can see from the search that Behind the Rocks 30K is on March 28... Let me correct that... Looking at Jake's Strava data: 88 miles over the last 4 weeks..." — all of which was internal reasoning, not meant to be sent to the user.
**Root cause:** When web search is enabled, Claude emits multiple text blocks: one before each tool call (internal narration/reasoning) and one final block with the actual response. The code was joining ALL text blocks together, which prepended the reasoning narration to the intended message. This matched the same bug already fixed in `generateRaceAcknowledgment` (where only the last text block is used).
**Fix / Change:** Changed response extraction in `coach/respond` to use only the last text block instead of concatenating all blocks. Without web search there is only one text block so behavior is unchanged.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-10 — More conversational goal acknowledgment with race context

**Type:** Improvement
**Reported by:** Jake (testing onboarding)
**User feedback:** "It feels a bit robotic still, and I'd like him to engage a bit more conversationally" — Dean said "Love it, Jake — Behind the Rocks 30K is an 18-mile Moab trail race... I'll build your week-by-week plan, track your training via Strava, and check in after your key sessions."
**Root cause:** `generateRaceAcknowledgment` was prompted to return "ONE plain-text sentence with verified facts" — inherently dry. The wrapping template added the scripted "Love it, Jake —" opener and generic "what Dean does" boilerplate, with no awareness of race timeline or secondary goals mentioned.
**Fix / Change:** Updated `generateRaceAcknowledgment` prompt to return a 1-3 sentence warm, conversational acknowledgment that includes timeline context (if race is within 8 weeks) and any secondary goals mentioned. Removed the rigid "Love it, name —" prefix and boilerplate closer from the template.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-03-10 — Fixed weekly mileage counting non-run activities

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "Wait are you counting my bike miles in my weekly miles?" / "No I'm not. This week started with Monday. So I am at 3 miles"
**Root cause:** The Strava webhook stores ALL activity types (Run, Ride, Swim, etc.) in the `activities` table. `computeWeekMileage`, `computeAvgWeeklyMileage`, `computeCoachingSignals` (week-over-week ramp), and `buildActivitySummary` were all iterating activities without filtering by type — so bike miles were added to running totals. Gwyneth had a 5.5 mi bike ride that day, inflating her week total from 3.0 to 8.5 miles.
**Fix / Change:** Added a shared `RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"])` constant. Added `if (!RUN_TYPES.has(a.activity_type)) continue` filter to all four weekly mileage loops. Non-run activities are still stored (for cross-training context) but are now excluded from all running mileage calculations.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-10 — Plan consistency: store sessions after generation so post-run/reminders use exact distances

**Type:** Bug Fix
**Reported by:** Jake (Isaac's conversation)
**User feedback:** [Isaac conversation] Dean said "Sat · Easy 8 km" in the weekly recap, then the post-run message said "Saturday short 2 km". Also said "11 km done this week (Sunday's 14.3 + today's 5.6)" — wrong math and wrong week attribution.
**Root cause:** Two separate issues:
1. The weekly plan was ephemeral — generated by Claude during weekly_recap and not stored anywhere. When post_run fired, Claude independently recalculated remaining sessions from weekly_mileage_target, producing different distances (8km → 2km for Saturday).
2. The system prompt said "if athlete mentioned additional runs in conversation, add them to week mileage" — Claude grabbed Sunday's run (from last week, mentioned in the plan recap text) and added it to this week's total, then did wrong arithmetic.
**Fix / Change:**
- Added migration 013: `weekly_plan_sessions` JSONB column on training_state
- After initial_plan and weekly_recap generation, call `extractAndStorePlanSessions()` — a Haiku call that extracts sessions as structured JSON and stores them
- In buildSystemPrompt CURRENT TRAINING STATE, include "THIS WEEK'S PLANNED SESSIONS (authoritative)" when sessions are stored
- In post_run, morning_reminder, nightly_reminder prompts: explicitly instruct Claude to use the stored sessions' exact distances and not recalculate
- Fixed week mileage instruction: "Strava-synced; this is the authoritative number — do NOT add runs from conversation history or previous weeks"
**Files changed:** src/app/api/coach/respond/route.ts, supabase/migrations/013_weekly_plan_sessions.sql

Also handles mid-week plan changes: after every `user_message`, `maybeUpdatePlanSessions()` runs in the background — a Haiku call that checks if the exchange resulted in agreed changes (day swaps, different distances, cancellations) and updates the stored sessions if so. No-ops on normal chat.

**Note:** Migration 013 must be applied to the live DB for the `weekly_plan_sessions` column to exist. Existing rows default to `[]` and will populate on the next weekly_recap or initial_plan.

---

## 2026-03-10 — Acknowledgment at every onboarding step; Dean responds to what users actually say

**Type:** Improvement
**Reported by:** Jake (live testing)
**User feedback:** "I may switch those around depending on life" → Dean responded "An ultra — love it." with no acknowledgment. More broadly, Dean was blindly jumping to the next question at most steps without engaging with what the user shared.
**Root cause:** Four step handlers (handleRaceDate, handleGoalTime, handleUltraBackground, handleTimezone) had zero acknowledgment — they simply fired the next question. handleStrava used canned "No worries!" / "Got it —" regardless of what was said. The acknowledgeSharedInfo prompt was too narrow (didn't classify training data, privacy concerns, or alternative app mentions as "substantive").
**Fix / Change:**
- Added `acknowledgeSharedInfo()` in parallel to handleRaceDate, handleGoalTime, handleUltraBackground, handleTimezone, handleStrava
- Added `acknowledgeSchedule()` (schedule-specific, always fires) for handleSchedule success path
- Rewrote acknowledgeSharedInfo prompt to explicitly classify: training data, scheduling flexibility, privacy concerns, alternative app mentions (Garmin etc.), and direct questions as all "substantive" and worth acknowledging
- 38/38 test cases passing: substantive messages get warm specific acknowledgments; bare answers correctly return null
**Files changed:** src/app/api/onboarding/handle/route.ts, scripts/test-onboarding-acknowledgments.mjs (new)

## 2026-03-10 — Schedule acknowledgment always bridges to next onboarding question

**Type:** Bug Fix
**Reported by:** Jake (live testing)
**User feedback:** "I may switch those around depending on life" → Dean responded "An ultra — love it." with no acknowledgment of what the user said
**Root cause:** `handleSchedule` used the generic `acknowledgeSharedInfo` which returned `null` for schedule flexibility caveats (treating "I may switch those around" as too bare to warrant acknowledgment). This left the raw next-step question with no transition.
**Fix / Change:** Added `acknowledgeSchedule(message, trainingDays)` — a schedule-specific acknowledgment that always fires on successful schedule parse, always references the actual confirmed days, and explicitly handles flexibility caveats (e.g. "Works for me — we can always shuffle things around as life gets in the way."). Also updated `acknowledgeSharedInfo` prompt to explicitly classify scheduling flexibility as substantive for the incomplete-schedule path.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-03-10 — Broader onboarding: injury recovery persona + personalized second message

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Onboarding was too narrowly framed around race training. The welcome message only mentioned race distances, and the second message was a generic "Love it — a half marathon is a great goal" with no explanation of what Dean actually does. Athletes recovering from injury, newer runners, or those wanting general coaching had no clear fit.
**Fix / Change:** (1) Rewrote welcome message to mention three use cases: race training, injury recovery, and general coaching. (2) Added `injury_recovery` as a recognized goal type in the classifier with appropriate keywords (IT band, stress fracture, shin splints, return to running, etc.). (3) Made the acknowledgment (second message) situationally specific: injury recovery gets "I'll build a return-to-run plan around your recovery, not a generic schedule", newer runners get a "manageable plan to the start line" framing, experienced racers get the Strava/tracking pitch. (4) Step routing skips `awaiting_race_date` and `awaiting_goal_time` for injury recovery (no race planned). (5) `awaiting_anything_else` for injury recovery asks specifically about the injury — what it is, when it happened, current recovery status, and whether they can run at all. (6) Updated `getSportType`, `formatGoalInline`, and `formatGoalLabel` to handle `injury_recovery`.
**Files changed:** src/app/api/signup/route.ts, src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-10 — Weather-aware coaching via Open-Meteo forecast

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Dean had no awareness of upcoming weather conditions, so he'd prescribe outdoor tempo runs into thunderstorms or hard sessions on 95°F days without any adjustment.
**Fix / Change:** Created `src/lib/weather.ts` using Open-Meteo's free geocoding + forecast APIs (no API key required). Fetches 7-day daily forecast (max/min temp °F, precipitation mm, WMO weather code, max wind mph) for the athlete's city/state (already stored from Strava OAuth as `strava_city`/`strava_state` in `onboarding_data`). Notable days — extreme cold (<20°F), freezing, cold, warm (70°F+), hot (80°F+), extreme heat (90°F+), thunderstorms, heavy snow/rain, strong wind (20+mph) — are surfaced as a `WEATHER FORECAST` block in the system prompt with specific coaching implications per condition. Ideal days (45–75°F, dry, calm) are silently omitted to avoid noise. Weather is fetched only for triggers where upcoming conditions matter: `weekly_recap`, `morning_reminder`, `nightly_reminder`, `initial_plan`, `morning_plan`. Fetch errors are non-fatal (caught and ignored).
**Files changed:** src/lib/weather.ts (new), src/app/api/coach/respond/route.ts

---

## 2026-03-10 — Race proximity signals and race strategy coaching framework

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Dean had no awareness of how close a race was beyond a generic "X days away" note in the system prompt, and no structured guidance on what comprehensive race strategy coaching should cover. Athletes approaching a race weren't getting proactive prep conversations.
**Fix / Change:** Added `daysUntilRace` to `CoachingSignals` (computed from `profile.race_date`). Added four race proximity tiers to `buildCoachingSignalsBlock` with specific action instructions: 3 weeks out (start introducing strategy topics), final build/taper start (confirm pacing and nutrition plan), race week (gear, morning routine, mental strategy, contingency plans), and race day eve (lock in the plan, encourage). Also added a `RACE PREPARATION & STRATEGY` block to the system prompt covering pacing, race nutrition (carb timing, 30-90g/hr), hydration, gear, mental strategy, and contingency planning — so Dean handles both reactive questions and proactive prep well.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-10 — Proactive coaching signals: cadence, ramp rate, shoe mileage, fueling

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Dean was only coaching on what the athlete explicitly brought up. Key performance and injury-prevention signals were being ignored — cadence data was in the DB schema but not even being fetched; week-over-week ramp rate, total tracked mileage, and long effort flags weren't computed at all.
**Fix / Change:** Added `computeCoachingSignals()` function that computes 4 signals from existing activity data: (1) avg cadence across recent runs — flagged if <170 spm with instruction to suggest stride cadence cues, (2) week-over-week mileage ramp between the two most recently completed weeks — flagged if >10% with remark about tendon/bone adaptation lag, (3) total tracked miles as a shoe mileage proxy — flagged at 400+ miles to prompt a shoe check, (4) recent long effort (≥10 mi or ≥75 min in last 14 days) — triggers a fueling/hydration check-in. Results are injected as a `COACHING SIGNALS` block in the system prompt. Also extended the activities select query to fetch `average_cadence` and `gear_name` (both in schema but previously unused).
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-10 — Proactive injury follow-up in post-run feedback and reminders

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Injury notes were being stored and shown in the system prompt context, but Dean had no explicit instruction to surface them proactively. He would only address injuries if the athlete brought them up first — a missed coaching opportunity, especially after runs that might have stressed an injured area.
**Fix / Change:** Added a `PROACTIVE INJURY & CONCERN FOLLOW-UP` rule to the system prompt covering all trigger types (post-run, reminders, weekly recap). For `post_run` specifically, also inject an explicit INJURY FOLLOW-UP note into the user message when `injury_notes` is non-empty, so Dean actively checks in on the affected area after every run — even if the athlete didn't mention it.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Fixed week boundary timezone bug causing wrong mileage totals; added counting rule

**Type:** Bug Fix
**Reported by:** Jake (post-run message said "3 today + yesterday's 3 = 6 miles" when yesterday was 10.6 miles; also "4 training days left" with 5 days listed)
**User feedback:** "Dean seems to be having Sunday be the start of the week, but it should be Monday-Sunday"
**Root cause:** Two separate bugs. (1) `computeWeekMileage` and `buildActivitySummary` both used UTC midnight as the week boundary. For a Pacific time user, Monday starts at 8am UTC, meaning Sunday evening runs (after 4pm PST = midnight UTC) were counted as the new week. More critically, `buildActivitySummary` used a broken `ceil(dayOfYear/7)` formula unrelated to Monday-based weeks, causing it to group weeks differently than `computeWeekMileage` — Claude saw inconsistent totals and tried to reconcile them. (2) No prompt rule about counting a list of items and matching the stated count.
**Fix / Change:** Added `localWeekMonday(date, timezone)` helper that converts a date to the user's local timezone and returns the YYYY-MM-DD of that week's Monday. All three functions (`computeWeekMileage`, `computeAvgWeeklyMileage`, `buildActivitySummary`) now use this helper, so week groupings are consistent and timezone-aware. Added COUNTING RULE to the FORMATTING section: never state a count (e.g. "4 training days") and list items that don't match — count the items in the list first and fix the number before sending.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Programmatic mileage total correction as a post-processing safety net

**Type:** Bug Fix
**Reported by:** Ian's weekly plan ("10 miles total" when sessions only summed to 7)
**User feedback:** N/A
**Root cause:** Prompt-level mileage accuracy rules aren't reliable enough on their own — LLMs can miscalculate even when instructed to verify.
**Fix / Change:** Added `correctMileageTotal()` function that runs on every coach message before sending. Parses session list lines matching the `Mon 3/2 · ...` format, sums distances from running sessions (skipping strength/mobility/cross-training/bike/swim lines), then finds any stated weekly total (handles "Total: Xmi", "X miles total", "stays at X miles", etc.) and replaces the number if it doesn't match the computed sum. Logs a warning when a correction is made. Applied as a wrapper around `stripMarkdown` so it runs on every response.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Strengthened mileage accuracy rule to prevent stated totals mismatching plan

**Type:** Bug Fix
**Reported by:** Ian's weekly plan
**User feedback:** Message said "10 miles total" but sessions only added up to 7 miles (3mi Thu + 4mi Sun)
**Root cause:** The existing MILEAGE ACCURACY rule said to verify the sum but didn't force Claude to enumerate terms explicitly. Claude either dropped a session without updating the total, or made a basic addition error (3+4=10). LLMs are significantly more reliable at arithmetic when required to show terms before stating a result.
**Fix / Change:** Rewrote the MILEAGE ACCURACY rule in both the weekly_recap and initial_plan prompts to (1) require enumerating each running session distance and summing them before writing the total (e.g. "3 + 4 = 7 miles"), (2) explicitly state that strength/mobility/cross-training sessions contribute zero miles and must not be counted, (3) instruct Claude to omit the total entirely rather than guess if not all sessions are listed.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Session lists now sorted chronologically, not grouped by type

**Type:** Bug Fix
**Reported by:** Ian's weekly plan (strength on Tue listed after runs on Thu/Sun)
**User feedback:** Runs listed sequentially first, then strength separately — out of date order
**Root cause:** Formatting instructions for session lists didn't specify chronological ordering, so Claude defaulted to grouping by workout type (all runs, then strength/cross-training).
**Fix / Change:** Added explicit "always sort sessions in chronological order by date — never group by workout type" instruction to the session list format rules in three places: the main FORMATTING section of the system prompt, the weekly_recap prompt, and the initial_plan prompt. Updated the example session lists in all three to include a mid-week strength day to reinforce the expected order.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Fixed split/lap unit conversions; switched to imperial splits; explained splits vs laps to Claude

**Type:** Bug Fix / Improvement
**Reported by:** Internal audit
**User feedback:** N/A
**Root cause:** Strava always returns split/lap data with `distance` in meters, `average_speed` in m/s, and `elevation_difference` in meters regardless of split type. We were passing this raw to Claude with no unit labels, so Claude could misread a speed of 2.85 m/s as mph or km/h. Also storing `splits_metric` (per-km) despite the app being imperial-first.
**Fix / Change:** (1) Switched webhook storage from `splits_metric` to `splits_imperial` (one entry per mile). (2) Added `transformSplitForClaude` helper that converts each split/lap: `distance` (meters) → `distance_miles`, `average_speed` (m/s) → formatted `pace` string (M:SS/mi), `elevation_difference` (meters) → `elevation_difference_feet`; removes raw fields. (3) Applied transformation to both splits and laps before serializing for Claude. (4) Added a DATA GLOSSARY to the post_run prompt explaining that splits = auto per-mile breakdowns, laps = manual watch button presses marking intentional segments.
**Files changed:** src/app/api/webhooks/strava/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Fixed elevation displayed as meters instead of feet

**Type:** Bug Fix
**Reported by:** Jake (wife's activity — Strava showed 344ft, Dean said 105ft)
**User feedback:** "My wife's Strava says 344 feet and Dean said it was 105 feet"
**Root cause:** Strava's API returns `total_elevation_gain` in meters. We stored it correctly as meters in the DB, but displayed the raw value with a "ft vert" label in both the weekly mileage summary and the individual workout log, and passed the raw number to Claude for post-run feedback with no unit label. 105 meters = 344 feet.
**Fix / Change:** Three places converted: (1) weekly mileage summary — multiply by 3.28084 before displaying as "ft vert"; (2) individual RECENT WORKOUTS log — same conversion; (3) post_run trigger — replace `elevation_gain` (meters) with `elevation_gain_feet` (converted) in the JSON passed to Claude so it can't misread the unit.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Plans now calibrate to athlete's actual fitness tier; conservative defaults no longer override observed data

**Type:** Improvement
**Reported by:** Internal observation (friend running 43 mi/week got a conservative beginner plan)
**User feedback:** N/A
**Root cause:** Training philosophy rules were written as unconditionals ("Never rush to intensity", "Be conservative in week 1") and appeared before athlete data in the prompt, so they overrode the Strava evidence regardless of how experienced the athlete was. A single set of beginner-safe defaults applied to everyone.
**Fix / Change:** Two changes. (1) Added a "CALIBRATE TO ATHLETE'S ACTUAL FITNESS FIRST" section before the training philosophy, establishing that Strava data is ground truth and conservative defaults only apply where data is thin or the athlete is new. Softened "Never rush to intensity" to be conditional on base-building status. Updated initial_plan "Be conservative in week 1" to defer to the fitness tier instead. (2) Added `computeAvgWeeklyMileage` helper computing average over the last 6 complete weeks, and injected a FITNESS TIER block into the system prompt: <10 mi/week = base-building only; 10–30 mi/week = mixed quality + base; 30+ mi/week = match current level, skip beginner defaults. The tier message includes the computed average so Claude sees the exact number.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Post-workout check-in baked into morning and nightly reminders for non-Strava users

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Users without Strava had no proactive feedback loop after workouts. Strava users get immediate post-run coaching via webhook, but non-Strava users only received reminder previews — no "how did it go?" touchpoint.
**Fix / Change:** Morning and nightly reminder crons now check if the user had a workout the previous session (yesterday for morning, today for nightly). When yes — and only when: (1) user has no Strava connected, (2) the day was a scheduled training day, (3) no post_run message already sent, (4) the athlete hasn't already texted in — the coach sends a combined message: check-in on the previous workout + preview of the next one ("How'd yesterday's run go? Here's what's on for today. Let me know if you want to dial anything back."). Added `includeWorkoutCheckin` flag to `CoachRequest` and updated `buildUserMessage` prompts for both trigger types. Morning cron looks back 30 hours; nightly cron looks back 18 hours.
**Files changed:** src/app/api/cron/morning-reminder/route.ts, src/app/api/cron/nightly-reminder/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Better initial plans for experienced runners: pre-computed goal pace + Strava-aware format

**Type:** Improvement
**Reported by:** Internal observation (Nathan's onboarding)
**User feedback:** "Nathan is a very experienced runner just looking for some specific half marathon prep workouts versus a super specific plan — could we consider giving him a few workout suggestions rather than sending a full plan? And I don't know if we actually used the data from Nathan's Strava well — we didn't really acknowledge his history, paces, PRs etc."
**Root cause:** Three problems. (1) The system prompt showed `goal_time_minutes` but left Claude to compute goal pace — Claude calculated 6:51/mi for a 1:12 half marathon instead of 5:29/mi. (2) The `initial_plan` user message didn't instruct Claude to reference Strava data, so it built plans from scratch ignoring observed fitness. (3) The initial plan format (rigid day-by-day schedule) is wrong for experienced runners close to a race who just need quality session prescriptions.
**Fix / Change:** (1) Pre-compute goal pace (per mile + per km) in `buildSystemPrompt` for all standard running distances and inject it into ATHLETE HISTORY so Claude reads the exact number rather than calculating it. (2) Added "USE STRAVA DATA" block to the `initial_plan` prompt — explicitly instructs Claude to look at WEEKLY MILEAGE, PACE ANALYSIS, and RECENT WORKOUTS and reference observed fitness in the first bubble. (3) Added "FOCUSED WORKOUT FORMAT": when the athlete's onboarding messages indicate they want specific session prescriptions rather than a full day-by-day plan ("just help me with workouts", "I don't need a full plan", "help designing specific workouts", etc.), skip the schedule and instead provide a mileage target + 2-3 specific quality sessions with paces. Athlete intent is the primary trigger — race proximity and Strava history are supporting signals, not requirements. Added "GOAL PACE — never compute this yourself" guard to prevent Claude from recalculating and getting it wrong.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-09 — Fixed coach sending its own reasoning as SMS when no reply was needed

**Type:** Bug Fix
**Reported by:** User feedback (Jake's mom received two phantom messages)
**User feedback:** "There were two extra messages sent to my mom this morning — they look like Claude outputs: 'Looking at the conversation, the athlete's most recent message was "Perfect"...' and 'Since they just responded with "Perfect" to confirm, there's nothing left to address...'"
**Root cause:** When the athlete sent a simple closing acknowledgment ("Perfect"), `user_message` trigger always calls Claude and always sends the result. The system prompt had no instruction for when to stay silent, so Claude generated internal meta-reasoning about why it shouldn't reply — and that reasoning text was sent as actual SMS messages with no guard to stop it.
**Fix / Change:** (1) Added a "WHEN NOT TO REPLY" block at the top of the COMMUNICATION STYLE section instructing Claude to output exactly `[NO_REPLY]` (and nothing else) when the conversation has naturally concluded with a closing acknowledgment. (2) Added a check in `processCoachRequest` that detects `[NO_REPLY]` and skips all SMS sending and DB writes, logging a skip message instead.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-08 — Sunday recap for all users; one-off skip support

**Type:** Bug Fix + Feature
**Reported by:** User feedback (Ian got a Sunday morning reminder for a workout he'd agreed to skip with Dean; nightly-reminder users were getting per-day reminders instead of a weekly overview on Sundays)
**User feedback:** "ah I think at some point in Ian and Dean's conversation they said that they were going to skip the workout on Sunday this week....but the training profile days array still had sunday. How do we fix this? Separately, I want to look into the weekly check-in cron job code." / "instead of sending a nightly reminder on Sunday for monday's workout, I want to send a weekly recap only on Sunday that should include Monday's workout (and the plan for the whole week!)"
**Root cause (sunday-recap):** sunday-recap only fired for `weekly_only` cadence users in a previous iteration; correct behavior is to fire for ALL onboarded users — it replaces the nightly Monday reminder with a full weekly overview.
**Root cause (one-off skip):** No mechanism existed for Dean to acknowledge a one-off skip without permanently removing a day from `training_days`. If a user said "skip this Sunday," the training profile was unchanged and the cron fired anyway.
**Fix / Change:**
1. sunday-recap fires for all onboarded users regardless of `proactive_cadence`. Nightly-reminder now exits early on Sundays (UTC day 0) since the weekly recap covers that evening for everyone.
2. Added `skip_dates text[]` column to `training_profiles` (migration 012). When `extractAndPersistProfileUpdates` detects a skip intent (e.g. "skip Sunday", "I won't run this Saturday"), it extracts the date as `YYYY-MM-DD` via Haiku and appends it to `skip_dates`. Both morning-reminder and nightly-reminder check `skip_dates` and skip that user for that specific date, leaving `training_days` unchanged for future weeks.
**Files changed:** `src/app/api/cron/sunday-recap/route.ts`, `src/app/api/cron/morning-reminder/route.ts`, `src/app/api/cron/nightly-reminder/route.ts`, `src/app/api/coach/respond/route.ts`, `supabase/migrations/012_skip_dates.sql`, `src/lib/database.types.ts`

---

## 2026-03-08 — Removed rogue morning-workout cron firing for all Strava users

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "Gwyneth and I both got messages this morning around 6:40am MT — I don't remember signing up for morning reminders."
**Root cause:** An old Phase 2 stub cron (`/api/cron/morning-workout`) was still active in vercel.json, firing at 12:00 UTC (6am MDT) daily. It sent a `morning_plan` trigger to every user with Strava connected, with no cadence preference check, no dedup, and a TODO where the timezone check should be. This ran alongside the proper `morning-reminder` cron which does respect cadence preferences.
**Fix / Change:** Removed the `morning-workout` entry from vercel.json. The `morning-reminder` cron already handles this correctly.
**Files changed:** vercel.json

---

## 2026-03-08 — Timezone confirmation step in onboarding

**Type:** Feature + Bug Fix
**Reported by:** User feedback (Jake's friend)
**User feedback:** "Tomorrow for me is Sunday. A rest day. Your timings are on UTC I think."
**Root cause:** All US phone numbers defaulted to America/New_York regardless of actual location. Users in Pacific/Mountain timezones received date context 2-3 hours ahead of their local time, causing Dean to reference the wrong day for workouts and reminders.
**Fix / Change:**
- Added `awaiting_timezone` step to STEP_ORDER (between `awaiting_ultra_background` and `awaiting_anything_else`).
- If Strava is connected and city is available: asks for confirmation ("Based on your Strava, looks like you're in Denver, CO — is that still accurate?"). If confirmed, keeps timezone from Strava. If corrected, parses the new location.
- If Strava is connected but no city on profile: auto-satisfies (timezone already set from Strava athlete data, nothing to confirm).
- If no Strava: asks "What city are you in?" and parses response via Haiku to IANA timezone string.
- Strava callback now also captures `athlete.city` and `athlete.state` into `onboarding_data` for use in the confirmation question.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/auth/strava/callback/route.ts

---

## 2026-03-07 — Fixed post-run date confusion, duplicate messages, and manual/Strava double-counting

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "I told him I did six miles yesterday on the treadmill. Today I added my six-mile treadmill run from yesterday to Strava. He thought I did the treadmill run today on Saturday instead of Friday. He assumed I did only six miles yesterday even though I did six on the treadmill plus four with my wife. He also double sent the same message."
**Root cause:** Three separate bugs: (1) The post_run prompt said "The athlete just completed a workout" — this anchored Claude to today's date even when start_date said Friday, causing wrong day references and incorrect week mileage attribution. (2) When a user mentions a run in conversation, extractAndPersistProfileUpdates stores it as source="manual". When they later sync the same run to Strava, the upsert (on strava_activity_id) doesn't remove the manual duplicate — so both entries counted toward weekly mileage. (3) Strava sometimes sends duplicate webhook events for the same activity_id, causing two post-run coaching messages.
**Fix / Change:**
- post_run prompt now explicitly states the activity date ("Activity date: Friday, Mar 6") and instructs Claude to use the activity date, not today's, when referencing when the run happened.
- Strava webhook handler now checks if the activity already exists before upserting. If new, it also deletes any source="manual" or source="conversation" activities for the same user, date, and similar distance (within 500m) — Strava record takes precedence.
- Duplicate webhook events (same strava_activity_id, already in DB) skip the coaching response entirely.
**Files changed:** src/app/api/webhooks/strava/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-07 — Fixed weekly mileage math when athlete mentions non-Strava runs in conversation

**Type:** Bug Fix
**Reported by:** User feedback (jctennant)
**User feedback:** "It looks like Coach Dean still has some problems with math and computing how many miles I've run so far in a week. He is not including the four miles that I ran with my wife, because 19 plus 12 would be 31, but add four it would be 35."
**Root cause:** `computeWeekMileage()` only sums Strava-synced activities from the `activities` table. When the athlete mentions a run in conversation that wasn't tracked in Strava, that mileage is not reflected in the "Mileage so far this week" number passed to the LLM. Coach Dean was aware of the 4 extra miles from conversation history but still used the Strava-only total (19.2 mi) as the baseline, computing 19.2 + 12 = 31 instead of 19.2 + 4 + 12 = 35.2.
**Fix / Change:** Added a clarifying note to the system prompt on the "Mileage so far this week" line, explicitly stating that it is Strava-synced only and instructing Dean to add any conversationally-mentioned miles before computing weekly totals or projections.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-06 — Strava data in system prompt (race history, YTD/recent stats, Strava intent detection)

**Type:** Feature
**Reported by:** Internal (Jake)
**User feedback:** N/A
**Root cause:** Strava stats were stored on onboarding_data but only all-time totals surfaced in the system prompt. Race history (workout_type=1 activities) was stored in the DB but never included in the prompt. YTD and recent_run_totals were never shown. Already-onboarded users had no way to connect Strava via text.
**Fix / Change:**
- Added RACE HISTORY section to system prompt — queries activities WHERE workout_type=1, formats each as "YYYY-MM-DD: X.X mi @ M:SS/mi". Only shown when races exist.
- Expanded ATHLETE HISTORY stats block to include year-to-date and last-4-weeks totals (not just all-time) from Strava's stored stats.
- Updated `buildSystemPrompt` signature to accept `raceHistory: Array<Record<string, unknown>>` as 7th argument.
- Updated PRODUCT CAPABILITIES in system prompt: Strava is now listed as supported; Dean tells athletes to text "connect strava" if they want to link it; removed claim that no tracking exists.
- Added Strava connect intent detection in linq webhook: when a fully-onboarded user texts something like "connect strava" / "link strava" / "add strava", Dean sends the OAuth link directly (or tells them it's already connected). No coaching round-trip needed.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/webhooks/linq/route.ts

## 2026-03-07 — Strava connect in onboarding flow + post-run coaching

**Type:** Feature
**Reported by:** Internal (Jake)
**User feedback:** N/A
**Root cause:** Strava OAuth, callback, webhook, and API client were all built but the Strava connect link was never actually sent during onboarding — it was designed but not wired in.
**Fix / Change:**
- Added `awaiting_strava` step to STEP_ORDER (between `awaiting_race_date` and `awaiting_schedule`). When onboarding reaches this step, Dean sends a link to connect Strava with a note that it'll make the plan sharper. Users can also reply "skip".
- `handleStrava()` handles any SMS reply during `awaiting_strava` as a skip — marks `strava_skipped: true` in onboarding_data and advances to `awaiting_schedule`.
- Strava callback (`/api/auth/strava/callback`) now sets `strava_connected: true` in onboarding_data and personalises the post-connect SMS with the athlete's name.
- Strava webhook (`/api/webhooks/strava`) now checks `onboarding_step` — activities are still stored during onboarding but `post_run` coaching is only triggered after onboarding completes.
- Added `/api/admin/strava-subscribe` endpoint to register/view the Strava webhook subscription (one-time setup per environment).
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/auth/strava/callback/route.ts, src/app/api/webhooks/strava/route.ts, src/app/api/admin/strava-subscribe/route.ts

---

## 2026-03-07 — Remove welcome_message from nightly/morning reminder crons

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** Gwyneth received Dean's internal reasoning as SMS messages: "I don't have access to the athlete's onboarding conversation or their very first training session date in the data provided... If you're asking me to draft a hypothetical first-session message for a new athlete, I'd need: 1. Their specific goal..."
**Root cause:** `welcome_message` trigger fired on Gwyneth's first nightly reminder (because `last_nightly_reminder_date` was null = "first reminder ever"). But Gwyneth had been using the app for weeks. The prompt said "send a warm message the evening before their very first training session" — but her conversation history clearly showed she'd already done many runs. Claude got confused, didn't know how to reconcile the prompt with the data, and output its internal reasoning directly as SMS messages.
**Fix / Change:** Removed the `welcome_message` trigger entirely from both nightly and morning reminder crons. The `initial_plan` already introduces Dean and tells users they can text anytime — the welcome is redundant and actively harmful for existing users whose first reminder fires long after onboarding.
**Files changed:** src/app/api/cron/nightly-reminder/route.ts, src/app/api/cron/morning-reminder/route.ts

---

## 2026-03-07 — Fix cadence handler silently completing onboarding on off-topic messages

**Type:** Bug Fix
**Reported by:** Internal observation (Jeff's log)
**User feedback:** N/A
**Root cause:** `handleCadence` had no off-topic detection. Its fallback was "anything ambiguous → nightly". So when Jeff texted "I have a mild nagging right posterior hip strain" during the `awaiting_cadence` onboarding step, the handler classified it as "nightly", set `proactive_cadence = nightly_reminders`, and completed his onboarding — without actually answering the cadence question.
**Fix / Change:** Added "unclear" as a valid classification. If the message isn't clearly answering the reminder question, the handler now acknowledges what the user said and re-asks the cadence question instead of defaulting to nightly and completing onboarding.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-03-06 — Fix week mileage tracking to use activities table, fix date_offset for named days

**Type:** Bug Fix
**Reported by:** Catherine (Jake's wife)
**User feedback:** Dean said "you're at 9.8 mi for the week" after her Friday 3.8mi run, completely ignoring her Monday 3mi and Tuesday 3mi that she'd already reported via text.
**Root cause:** Two issues: (1) `training_state.week_mileage_so_far` was only updated for Strava activities (via `post_run` trigger), not for manually-reported runs extracted from text. The system prompt read from this stale field. (2) `extractAndPersistProfileUpdates` date_offset prompt only said "0=today, -1=yesterday" — so when a user reported a run from earlier in the week (e.g. "I ran 3mi on Monday"), Haiku would default to 0 (today) causing the activity to be saved with the wrong date or deduped incorrectly.
**Fix / Change:** (1) Added `computeWeekMileage()` helper that sums distance from the already-fetched `recentActivities` array for the current Mon–Sun UTC week. This replaces `state?.week_mileage_so_far` in the system prompt. The activities table is now the source of truth for week mileage. (2) Expanded date_offset extraction prompt to instruct the model to compute negative offsets for named days like "Monday" or "Tuesday".
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-06 — Morning reminders (day-of) added as a supported cadence option

**Type:** Feature
**Reported by:** Ian (user feedback)
**User feedback:** Ian wanted morning reminders the day-of his workouts, not the evening before. Previously Dean apologized and defaulted to nightly.
**Root cause:** Morning reminders were explicitly unsupported — `handleCadence` converted all morning preferences to `nightly_reminders` with an apology. No cron existed to send morning-of messages.
**Fix / Change:**
- New `GET /api/cron/morning-reminder` endpoint firing at 14:00 UTC (6am PST / 9am EST). Checks TODAY's training days (vs nightly which checks tomorrow). Sends `morning_reminder` trigger. Deduplicates via `last_morning_reminder_date` column.
- New `morning_reminder` trigger type in coach/respond with a prompt framed around today's session (vs nightly's "tomorrow's workout").
- `handleCadence` updated: `morning_reminders` is now a real `proactive_cadence` value. Removed the apology/fallback. Confirmation message: "I'll text you the morning of each session."
- `initial_plan` closing question updated to offer morning OR evening reminders as options.
- System prompt PRODUCT CAPABILITIES updated — morning reminders now supported.
- `vercel.json`: added `0 14 * * *` cron for `/api/cron/morning-reminder`.
- **DB migration required**: `ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS last_morning_reminder_date date;` then `npm run gen:types`.
**Files changed:** src/app/api/cron/morning-reminder/route.ts (new), src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts, vercel.json

---

## 2026-03-06 — Training philosophy: landing page section + system prompt overhaul

**Type:** Feature / Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Dean's training philosophy was implicit and inconsistently applied — athletes had no way to understand or verify why their plan was structured the way it was, and the system prompt didn't clearly prioritize frameworks.
**Fix / Change:**
- Added "Built on proven training science" section to the landing page — 3 principle cards (easy means easy / 80/20, aerobic base first, strength for durability) with named source credits (Seiler, Fitzgerald, Lydiard, Daniels, Roche). Positioned between value props and FAQ.
- Replaced vague TRAINING PHILOSOPHY bullet list in system prompt with 6 explicitly named, prioritized frameworks: Lydiard aerobic base, 80/20 polarized, VDOT pacing, periodization, Roche-influenced strength, process orientation.
- Replaced HANDLING UNKNOWN REFERENCES with a richer ATHLETE-STATED PHILOSOPHIES section: named reference map for 10+ common coaching systems (Pfitz, Hanson's, Galloway, Uphill Athlete, Born to Run, etc.) with specific guidance on alignment and tension points for each.
**Files changed:** src/app/page.tsx, src/app/api/coach/respond/route.ts

---

## 2026-03-06 — Training rationale included in initial plan and weekly recap

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Plans felt like a random schedule with no explanation of why they were structured that way. Athletes trust coaches who explain their reasoning.
**Fix / Change:** Updated `initial_plan` prompt: first bubble now includes one sentence explaining the training rationale (e.g. "Starting with all easy miles to build aerobic base before introducing quality work"). Updated `weekly_recap` prompt: first text now includes one sentence on what the week is targeting and why (e.g. "Pulling back volume slightly — week 4 is a recovery week, which is when adaptation actually happens").
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-06 — Supabase type generation wired into codebase

**Type:** Infra
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Supabase client was untyped (`createClient` with no generic), so missing/renamed DB columns were only caught at runtime. The `reengagement_sent_at` incident was a direct example.
**Fix / Change:**
- Ran `supabase gen types typescript` to generate `src/lib/database.types.ts` from live schema
- Updated `src/lib/supabase.ts` to use `createClient<Database>` — all queries now typed against actual schema
- Fixed 14 TypeScript errors surfaced by enabling types: `Json` incompatibilities in 5 files, null-safety fixes in `strava.ts` and `reengagement` cron, `unknown` activity field casts in `strava/callback`, nullable `message_type`/`distance_meters` in `coach/respond`
- Added `npm run typecheck` (tsc --noEmit) and `npm run gen:types` scripts for ongoing use
**Files changed:** src/lib/supabase.ts, src/lib/database.types.ts (new), src/lib/track.ts, src/lib/strava.ts, src/app/api/auth/strava/callback/route.ts, src/app/api/coach/respond/route.ts, src/app/api/cron/reengagement/route.ts, src/app/api/onboarding/handle/route.ts, src/app/api/webhooks/linq/route.ts, package.json

---

## 2026-03-06 — Strength, mobility & cross-training in plans

**Type:** Feature
**Reported by:** User feedback (Jake's mom — Catherine)
**User feedback:** "my mom expressed some injury history and she told me she actually wants Dean to offer to give some strength exercises / cross training to her... I think offering to add x-training and/or strength/stretching is important! let's start with strength and then add crosstraining as another option too"
**Root cause:** Plans never included strength/mobility sessions even when athletes explicitly had injury history or requested it. Dean would sometimes mention strength obliquely but never schedule it.
**Fix / Change:**
- Added STRENGTH, MOBILITY & CROSS-TRAINING section to the system prompt with injury-specific exercise libraries: piriformis/glute, IT band/knee, lower back, hip flexor, general running strength
- `initial_plan` SPORT-SPECIFIC GUIDANCE updated: if athlete has injury_notes or requested strength/mobility, replace a rest day with a tailored strength session
- `weekly_recap` prompt updated: include strength/cross-training day in week preview when appropriate
- Onboarding `awaiting_anything_else` question updated to explicitly mention strength/mobility and cross-training as options ("if you'd like strength and mobility work or cross-training included, just mention it")
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts

---

## 2026-03-06 — Send welcome message before first nightly reminder

**Type:** Feature
**Reported by:** User feedback (Jake's mom unsure she could text Dean with questions)
**Root cause:** Nothing in the onboarding or early coaching flow told users they could reach out anytime — it felt like a one-way broadcast.
**Fix / Change:** On a user's first ever nightly reminder, fire a `welcome_message` trigger through `coach/respond` before the workout reminder. Claude generates a personalised message using the athlete's full profile — references their specific goal, acknowledges any injury or concern from onboarding, and lets them know they can text anytime. Detected via `last_nightly_reminder_date` being null.
**Files changed:** `src/app/api/cron/nightly-reminder/route.ts`

---

## 2026-03-06 — Fix awaiting_cadence routing set too late, causing cadence preference to be lost

**Type:** Bug Fix
**Reported by:** Internal observation (Catherine's proactive_cadence stuck at weekly_only)
**Root cause:** `onboarding_step: "awaiting_cadence"` was set at the very end of processCoachRequest, after all plan messages were sent. If the initial_plan response (web search + plan generation + multi-bubble sends with typing delays) approached the 60s limit, this update never ran. Catherine's cadence reply then arrived with onboarding_step null, routed to coach/respond as user_message — Dean acknowledged her preference conversationally but proactive_cadence was never written to the DB.
**Fix / Change:** Moved the awaiting_cadence update to just before the Claude call, so routing is in place even if the function times out mid-send. Changed from void (fire-and-forget) to await so failures don't go undetected.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-06 — Fix PostHog shutdown timeout in serverless event tracking

**Type:** Bug Fix
**Reported by:** Internal observation (logs)
**Root cause:** `trackEvent` called `ph.shutdown()` on every event. This closes the HTTP client, so any subsequent event in the same Lambda instance uses a dead client and times out. Since the singleton isn't reset after shutdown, `getPostHogClient()` returns the closed instance on the next call.
**Fix / Change:** Removed `shutdown()` call. With `flushAt: 1` and `flushInterval: 0`, PostHog sends events immediately on `capture()` — shutdown is unnecessary and destructive in this context.
**Files changed:** `src/lib/track.ts`

---

## 2026-03-06 — Add grade-adjusted pace reasoning to coaching system prompt

**Type:** Improvement
**Reported by:** Jake Tennant (user)
**User feedback:** "I don't think doing 7:30 pace at 8% grade is going to feel easy. That feels like a very difficult pace"
**Root cause:** Claude prescribed a flat easy pace alongside a steep treadmill grade without adjusting for the grade's effect on effort. The model knows grade-adjusted pace but didn't apply the reasoning proactively — it pattern-matched to "easy interval workout → here's an easy pace" without verifying the combination made sense.
**Fix / Change:** Added a GRADE-ADJUSTED PACE section to the system prompt. Covers treadmill workouts and hilly trail runs: each 1% grade ≈ 8-12 sec/mile harder, prescribe effort first then derive the correct pace, don't borrow flat-ground paces for steep grades, and don't flag a slower trail pace as "slow" when it's grade-appropriate.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-06 — Fix webhook timeout causing messages to go unanswered

**Type:** Bug Fix
**Reported by:** Internal observation (live logs)
**Root cause:** Two issues found: (1) `void fetch()` inside `after()` doesn't work in serverless — the runtime exits before the HTTP request fires, so coach/respond was never called. (2) Even with `await fetch()`, debounce (10s) + Claude response (up to 60s) could exceed the webhook's 60s maxDuration, killing it silently.
**Fix / Change:** Made `coach/respond` return 200 immediately for all non-dry_run requests, moving all work (DB fetches, Claude, SMS) into its own `after()`. The webhook's `await fetch()` now completes in milliseconds, well within budget. dry_run still processes inline so callers get the message back.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/webhooks/linq/route.ts`

---

## 2026-03-06 — Fix messages going unanswered due to webhook timeout and debounce bug

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** Multiple users receiving no response to their messages
**Root cause:** Two issues: (1) The webhook's `after()` handler awaited the `fetch` to `coach/respond`. With debounce (10s) + Claude response (up to 60s), total execution could exceed the function's 60s `maxDuration`, causing Vercel to kill it silently — message received, no reply sent. (2) If the conversations table insert failed for any reason, `storedMsg` was null, making the debounce check (`latestMsg.id !== storedMsg?.id`) always true — every message silently skipped.
**Fix / Change:** Changed `coach/respond` fetch to fire-and-forget (`void fetch(...)`) — it's its own Vercel function with its own timeout so it runs independently. Added an explicit null check for `storedMsg` that fires the response anyway rather than silently skipping when the insert failed.
**Files changed:** `src/app/api/webhooks/linq/route.ts`

---

## 2026-03-05 — Add ultra background onboarding step for 50K+ goals

**Type:** Feature / Bug Fix
**Reported by:** Internal observation (Ohnmar's plan review)
**User feedback:** Experienced 100K runner received an under-calibrated plan because race history and current long run were never collected
**Root cause:** Onboarding asked "anything else?" as a catch-all but never explicitly asked ultra runners about their race history or current long run — the most important inputs for calibrating a 50K+ plan.
**Fix / Change:** Added a new `awaiting_ultra_background` onboarding step that fires between schedule and anything_else for 50K+ goals only. Asks: "Have you run any ultras before? And what's your current weekly mileage and longest recent long run?" Extracts `ultra_race_history`, `weekly_miles`, `current_long_run_miles`, and `experience_years` via Haiku. Race history is appended to `other_notes` so it surfaces in the coach system prompt. `current_long_run_miles` seeds the training state `long_run_target` directly when available. Step is skipped if mileage + experience were already captured in an earlier message.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-05 — Fix ultra runner plans being too conservative at onboarding

**Type:** Bug Fix / Improvement
**Reported by:** Internal observation (Ohnmar's plan review)
**User feedback:** Experienced 100K runner (Western States finisher) received a 21mi first week with a 6mi long run
**Root cause:** Four compounding issues: (1) "5-6 miles weekdays" was extracted as 5-6 total weekly miles instead of ~28mi; (2) missing experience_years defaulted fitness_level to intermediate/beginner; (3) long_run_target = 30% of weekly mileage produced a 5mi long run floor; (4) initial_plan prompt applied the same beginner conservatism regardless of goal type.
**Fix / Change:**
- weekly_miles extraction now handles "X miles per day/weekday" patterns by multiplying out (weekdays × 5, "every day" × 7)
- assessFitnessLevel now takes goal + daysPerWeek — anyone running 5+ days/week for a 50K+ is classified advanced regardless of experience_years
- weeklyMilesRaw default for ultra goals bumped from 15 to 30 when no mileage is provided
- long_run_target for ultra goals has a 10mi floor (was purely 30% of weekly mileage)
- initial_plan prompt now has an ULTRA DISTANCE GOALS section: no beginner conservatism, 10-18mi long run in week 1, time-on-feet framing, vert work from day one, finish time used to infer experience
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-05 — Fix double "Got it" at end of onboarding before plan is sent

**Type:** Bug Fix
**Reported by:** Internal observation (conversation review)
**User feedback:** N/A
**Root cause:** `handleAnythingElse` sent an `acknowledgeSharedInfo` message ("Got it — we'll build around your lifting schedule"), then immediately fired `initial_plan` which generated its own opener ("Got it, Logan..."). Two independent Claude calls, both defaulting to a "Got it" opener.
**Fix / Change:** Removed the acknowledgment send from the `!nextStep` branch of `handleAnythingElse` — the only case where `initial_plan` fires right after. The `initial_plan` prompt opener was also updated to lead with the most relevant constraint/context the athlete just shared, and explicitly told not to open with "Got it" or restate the goal. The acknowledgment is preserved in the `handleSchedule` and `nextStep` branches of `handleAnythingElse` where it bridges naturally between questions.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-05 — Fix duplicate nightly reminders being sent on consecutive days

**Type:** Bug Fix
**Reported by:** Internal observation (raw data review)
**User feedback:** N/A
**Root cause:** Two issues combined: (1) the cron had no deduplication — it only checked "is tomorrow a training day?" with no record of what was already sent. (2) `nightly_reminder` messages were saved as `message_type = "coach_response"` so there was nothing specific to query against. Any Vercel cron retry or back-to-back eligible training days would re-send without knowing a reminder had already gone out.
**Fix / Change:** Added `last_nightly_reminder_date` column to `training_profiles` (run migration below). Cron now checks this field before sending — skips with a log line if already sent today (UTC). Marks the field immediately after a successful send. Also fixed `nightly_reminder` and `weekly_recap` triggers to save their own specific `message_type` values instead of the generic `coach_response`.
**Migration:** `ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS last_nightly_reminder_date date;`
**Files changed:** `src/app/api/cron/nightly-reminder/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-05 — Make nightly reminders feel more human

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** Nightly reminders just gave the date and workout with no warmth — felt like an app notification, not a coach
**Root cause:** The `nightly_reminder` prompt was "One sentence: workout type, distance, and target pace or effort. Nothing else." — deliberately bare but too robotic.
**Fix / Change:** Updated prompt to instruct a varied opener (rotate between "Tomorrow's workout:", using the athlete's name, referencing the day, etc.) + workout details + a short warm closer (rotate through "Good luck!", "Let me know how it goes.", "Have fun out there.", etc.). Still under 480 chars, no markdown.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-05 — Handle "nothing on the calendar" gracefully during goal onboarding

**Type:** Improvement
**Reported by:** Mark (user)
**User feedback:** "Mark. Nothing on the calendar at the moment" → Dean replied with full welcome again, ignoring the context
**Root cause:** "Nothing on the calendar" → `complete: false, goal: null` → fell into the generic "what are you training for?" path with no acknowledgment of what was said.
**Fix / Change:** Added a `no_event` flag to the goal classifier. When detected, Dean responds with "No worries, [name] — having a direction still helps even without a date locked in. What kind of event are you drawn to — a 5K, half marathon, something longer, or more just general fitness?" `onboarding_step` stays `awaiting_goal` so the next reply resolves normally once they pick a direction.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-05 — Fix full welcome repeated when user gives name without intro phrase

**Type:** Bug Fix
**Reported by:** Mark (user)
**User feedback:** "Mark. Nothing on the calendar at the moment" → Dean replied with the full welcome message again
**Root cause:** The name extraction rule in `extractAdditionalFields` required an explicit intro phrase ("I'm Mark", "My name is Mark", etc.). A bare first name at the start of a message ("Mark. ...") didn't match and returned null, so the incomplete-goal path fell back to the full welcome instead of "Hey Mark! What are you training for?"
**Fix / Change:** Broadened the name extraction rule to cover many more intro patterns: bare name alone, "Mark here", "It's Mark", "Mark!", "Mark 👋", etc. Also fixed the no-name fallback — instead of re-sending the full welcome (which looks broken), Dean now asks "Sorry, didn't quite catch your name — what should I call you?" when the user has already seen the intro but we still couldn't extract a name.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-05 — Handle morning reminder requests gracefully

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** Users say they prefer morning reminders → Dean says "sure" but no morning cron exists
**Root cause:** The cadence classifier in `handleCadence` only knew "nightly" or "weekly" — "morning" fell through to "weekly" with no acknowledgment. The coach system prompt also had no knowledge of reminder timing constraints, so Claude agreed to morning reminders when asked post-onboarding.
**Fix / Change:** Added "morning" as a third classification in `handleCadence`. When detected, Dean explains morning isn't supported, defaults to nightly, saves `nightly_reminders` to the profile, and closes onboarding — no re-prompt needed. Added a PRODUCT CAPABILITIES note in the coach system prompt so Claude handles this correctly in post-onboarding conversations too.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-03-04 — Fix name extraction and welcome repeat in goal onboarding step

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "Yo Jake it's Ian 🙏" → Dean replied with the full welcome message again ("Hey! I'm Coach Dean..."), completely ignoring the self-introduction
**Root cause:** `extractAdditionalFields` was only called in the *complete* path of `handleGoal`. When goal parse returned `complete: false` (no goal), the code sent the full welcome verbatim with no name extraction — so any self-introduction in a goalless message was silently dropped. On the next message, the name still wasn't in `onboardingData`, causing the same generic welcome to be sent again.
**Fix / Change:** Moved `extractAdditionalFields` to run in parallel with the goal parse unconditionally. If a name is extracted in the incomplete path, it's saved to the DB and the response becomes "Hey {name}! What are you training for?" instead of the full intro. The full intro is now only sent when we genuinely don't know their name yet.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-04 — Acknowledge personal context in schedule onboarding step

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** "No preference really. I watch my son at home while also working... My mother in law does pick him up for a few hours between 11:30-3:30ish." → Dean replied: "Before I put your plan together — anything else worth knowing?" (completely ignored the personal context)
**Root cause:** `handleSchedule` had no acknowledgment logic — it sent the next onboarding question raw regardless of what the user shared. `acknowledgeSharedInfo` existed but was only wired into `handleAnythingElse`.
**Fix / Change:** Added `acknowledgeSharedInfo` to `handleSchedule`'s parallel Promise.all, prepending any acknowledgment to both the incomplete follow-up and the complete-path next-step question. Also generalized the `acknowledgeSharedInfo` prompt from being "anything else" step-specific to working across any onboarding step — it now triggers on any substantive personal context, lifestyle constraints, or logistical details.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-04 — Re-engagement nudges for inactive users

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Users who go silent still receive daily/weekly messages with no mechanism to reduce noise or check in.
**Fix / Change:** New daily cron (`/api/cron/reengagement`, runs at 16:00 UTC) checks for silent users and either nudges them or downgrades their cadence:
- **Nudge #1**: `nightly_reminders` users silent for 14+ days → send re-engagement message
- **Downgrade**: If no reply after 3 days → switch to `weekly_only`
- **Nudge #2**: `weekly_only` users silent for 30+ days → send a lighter check-in (repeats every 28 days of continued silence)
When any user replies, `reengagement_sent_at` is cleared so the cycle resets. Tracked in PostHog as `reengagement_nudge_sent` and `reengagement_downgraded`.
**Files changed:** `supabase/migrations/011_reengagement.sql`, `src/app/api/cron/reengagement/route.ts`, `vercel.json`, `src/app/api/webhooks/linq/route.ts`

---

## 2026-03-04 — Add onboarding flags to PostHog events

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `coaching_response_sent` was only fired from `coach/respond`, so all onboarding messages were invisible in PostHog, making the event count appear much lower than `message_received`.
**Fix / Change:** Added `coaching_response_sent` tracking inside `sendAndStore` in `onboarding/handle` with `{ onboarding: true, trigger: <step> }`. Added `onboarding: false` to the existing `coach/respond` event for symmetrical filtering. Added `onboarding: true/false` flag to `message_received` events based on whether the user has an active `onboarding_step`.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/webhooks/linq/route.ts`

---

## 2026-03-03 — Enforce one question per initial plan message

**Type:** Bug Fix
**Reported by:** User observation (Ian, Jake, Katie 7170bad2)
**User feedback:** Dean asked the evening-before-or-weekly-overview question, then immediately followed with another question (hip check-in, niggles, pelvic floor) without waiting for a response. In SMS this means one of the two questions gets ignored.
**Root cause:** The initial_plan prompt instructed Dean to address injuries/niggles as a follow-up question, which stacked on top of the cadence question already required at the end — resulting in two questions sent back-to-back.
**Fix / Change:** Added an explicit ONE QUESTION RULE to the initial_plan prompt: the closing feedback+cadence line is the only question allowed. Injury/constraint context must be stated as information ("I've kept this conservative given your hip") not as a trailing question.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-03 — Initial plan framed as a starting point, not a prescription

**Type:** Improvement
**Reported by:** User (Cathy)
**User feedback:** "I think he could have maybe gave me better advice or asked for more feedback. For example he started me at 3miles 3 times a week and my preference would be less. Like I mile. 1.5 then 2 the first week. I told him i was just starting back after being injured. I would have liked him to ask - how is this schedule? Should we start a little shorter. I told him I was 58 and coming off a back injury. Also I told him about my past piriformis issues. I would have liked some advice on that."
**Root cause:** The initial_plan prompt generated a confident, prescriptive plan rather than a collaborative starting point. It didn't invite feedback or signal that the plan was adjustable, leaving users who wanted something different with no obvious path to say so.
**Fix / Change:** Rewrote the initial_plan prompt to: (1) explicitly frame the plan as initial thinking, not a finished prescription; (2) instruct Dean to be conservative in week 1, especially for injury returnees; (3) end with a combined feedback + cadence question so the athlete is invited to react before anything is locked in. Reduced to 2 bubbles max.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-03 — Fix redundant onboarding question and reduce message spam

**Type:** Bug Fix
**Reported by:** User observation (Jake 4e7d02c9, Ian 0752992e)
**User feedback:** "Onboarding asks the same questions redundantly. Jake had already provided mileage and a 5K PR before Dean asked 'anything else worth knowing? injuries, recent races, paces' — it felt like a generic script, not a listening coach." / "Sometimes sending 3-4 messages in a row feels quite spammy."
**Root cause:** (1) `isStepSatisfied("awaiting_anything_else")` was hardcoded to always return false, so the question fired unconditionally even when mileage + fitness context was already captured. (2) The onboarding completion sequence sent up to 5 rapid-fire bubbles: acknowledgment + 2-3 plan bubbles + a standalone cadence question 6.5s later.
**Fix / Change:** (1) `awaiting_anything_else` now satisfied if weekly mileage AND race/pace data already present. (2) Cadence question folded into the `initial_plan` prompt as the last line — no longer a separate bubble. (3) Acknowledgment tightened to 1 sentence max so it doesn't front-run the plan. Net result: 3 bubbles max (acknowledgment + 2 plan bubbles) instead of 4-5.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-03 — Dean no longer fabricates product features or integrations that don't exist

**Type:** Bug Fix
**Reported by:** User observation (user b17d9dc9)
**User feedback:** "User asks how to connect Garmin, and Dean gives plausible-sounding but fabricated instructions ('look for Connected Apps... search for the coaching app'). You don't have Garmin integration. Dean should say so clearly rather than invent a setup flow that will leave the user confused."
**Root cause:** No explicit system prompt guidance about what integrations/features actually exist, so Claude filled the gap with a hallucinated but plausible-sounding answer.
**Fix / Change:** Added a PRODUCT CAPABILITIES section to the system prompt explicitly listing what Coach Dean supports (Strava only, SMS only) and what doesn't exist (Garmin, Apple Watch, Wahoo, web dashboard, etc.). Includes a specific instruction and example response for when an athlete asks about an unsupported integration.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-03 — Dean no longer fabricates dates or historical facts it can't verify

**Type:** Bug Fix
**Reported by:** User observation
**User feedback:** "Dean tells him 'Sunday Feb 23 — that's when you first reached out' when the user knows it was Feb 19. Dean then admits 'I don't have the full conversation history from Feb 23 forward.' That's a trust-destroying moment."
**Root cause:** Two issues: (1) the system prompt instructed Dean to "never be vague about dates" which encouraged confident fabrication of dates it couldn't verify; (2) no explicit instruction existed about Dean's memory limitations.
**Fix / Change:** Added a MEMORY AND DATA LIMITATIONS section to the system prompt clearly stating what Dean has access to (last 15 messages, RECENT WORKOUTS, profile, date context) and explicitly prohibiting statements about sign-up dates, first contact, or anything outside the data window. Also narrowed the "specific numbers" tone rule to only apply to paces and distances — not dates.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-03 — Workout recaps now always chronological

**Type:** Bug Fix
**Reported by:** User (Rachel)
**User feedback:** Rachel received a non-chronological recap when asking for past workouts
**Root cause:** The activity summary only gave Claude weekly aggregates, not individual workouts with dates. When asked to recap, Claude reconstructed individual workouts from conversation history which has no guaranteed order, resulting in out-of-order recaps.
**Fix / Change:** Added a `RECENT WORKOUTS (chronological, oldest first)` section to the activity summary in the system prompt. Lists up to the last 20 individual activities sorted oldest→newest with date, type, distance, pace, and elevation. Claude now always has a properly ordered workout list to reference.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-02 — Store manually-reported workouts from SMS

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Activities table was only populated via Strava webhook. If a user texted "did a 10 mile run today at 8:30 pace", Claude would respond helpfully but the workout was invisible to all future coaching context — it never appeared in weekly mileage, pace trends, or activity summaries.
**Fix / Change:** Extended the existing Haiku extraction call (already runs fire-and-forget on every user_message) to also detect reported workouts. Extracts activity type, distance, duration, pace, elevation, and date offset. Writes a synthetic row to the `activities` table with `source: "manual"` and `strava_activity_id: null`. Includes dedup check (same user, same date, within 200m distance) to avoid double-counting if Strava sends the same activity later. Migration 010 makes `strava_activity_id` nullable and adds a `source` column.
**Files changed:** src/app/api/coach/respond/route.ts, supabase/migrations/010_manual_activities.sql

---

## 2026-03-02 — Easy pace shown as range instead of exact value

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** "right now we are giving users exact paces based on VDOT. This means I get a lot of my runs at 7:44/mi pace exactly. I wonder if for easy runs we give a more round number or a range."
**Root cause:** `paces.ts` returns a single exact pace for all session types. Easy runs are effort-based and should flex with fatigue, heat, and terrain — an exact pace like 7:44/mi is counterproductive.
**Fix / Change:** Added `easyPaceRange()` helper in `paces.ts` that takes the stored exact easy pace, rounds to nearest 5 seconds, and adds 30s for the upper bound (e.g. 7:44 → 7:45–8:15/mi). Used at render time in the system prompt so the DB value stays exact. Tempo and interval paces unchanged.
**Files changed:** src/lib/paces.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-02 — Cleaner weekly plan formatting in SMS

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Weekly plan prompts asked for "day by day" sessions but didn't specify line format, so Claude wrote sessions as flowing prose — a wall of text when 4-5 sessions were packed into one 480-char bubble. Also, `stripMarkdown` didn't remove `- ` bullet prefixes, which left dangling dashes if Claude used a list format.
**Fix / Change:** Updated `initial_plan` and `weekly_recap` prompts to require one session per line using a compact format (`Mon 3/2 · Easy 5mi @ 9:30/mi`). Added bullet prefix stripping (`^[-•]\s+`) to `stripMarkdown` as a safety net.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-02 — Implement opt-out handling for STOP and natural-language unsubscribe

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No opt-out handling existed. "STOP" may have been handled at the Linq/carrier level but our DB had no record of it, and all cron jobs would keep querying and attempting to message opted-out users. Natural-language opt-outs ("I don't want messages anymore") were treated as normal messages.
**Fix / Change:** Added messaging_opted_out boolean to users table (migration 009). Webhook now detects STOP/STOPALL/UNSUBSCRIBE/CANCEL/QUIT (exact keywords) and common natural-language patterns before doing any other processing — sets the flag, sends a confirmation, and stops. Subsequent inbound messages from opted-out users are silently ignored. All three cron jobs (morning, nightly, sunday) now filter out opted-out users.
**Files changed:** supabase/migrations/009_messaging_opted_out.sql, src/app/api/webhooks/linq/route.ts, src/app/api/cron/morning-workout/route.ts, src/app/api/cron/nightly-reminder/route.ts, src/app/api/cron/sunday-recap/route.ts

---

## 2026-03-02 — Require Dean to verify mileage totals match session sum before stating them

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "Dean said 'This week we are at 28 miles' but the key sessions only added up to 19 miles"
**Root cause:** Dean generated the weekly total and the individual sessions independently without cross-checking. LLMs are prone to this — stating a round number and then listing sessions that don't add up.
**Fix / Change:** Added MILEAGE ACCURACY instruction to both the weekly_recap and initial_plan prompts: verify the sum of all listed sessions matches any stated total before including it. If unsure, omit the total rather than guess.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-02 — Fix pace calculation: extract PRs from conversation, compute VDOT correctly

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "I gave Dean my 5K PR pace (5:40/mi) and he prescribes 9:40-10+/mi for base work"
**Root cause:** Three compounding issues: (1) extractAndPersistProfileUpdates had no pace/PR extraction at all — race times mentioned in conversation were silently dropped. (2) extractAdditionalFields didn't distinguish race pace from easy pace, and didn't extract race times for VDOT computation. (3) handleAnythingElse only checked the current message for race data, not earlier-captured onboardingData, so a PR mentioned in the first message was never used for VDOT. With paces null/TBD, Dean hallucinated slow paces from fitness_level alone.
**Fix / Change:** (1) Extracted VDOT pace logic into shared src/lib/paces.ts. (2) Added recent_race_distance_km + recent_race_time_minutes to extractAdditionalFields, with explicit rules to convert pace-based PRs to race times. (3) handleAnythingElse now falls back to onboardingData for race time if the current message has none. (4) extractAndPersistProfileUpdates now extracts PRs and easy pace, computes VDOT, and updates current_easy_pace / current_tempo_pace / current_interval_pace on training_profiles.
**Files changed:** src/lib/paces.ts (new), src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-01 — Include message timestamps in conversation history passed to Dean

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "Dean thought she did intervals yesterday since she hasn't texted with him since last Tuesday, which is when she did her intervals"
**Root cause:** created_at was fetched from the conversations table but silently dropped when formatting the conversation history for the prompt. Dean saw message content with no temporal context, so a message from 6 days ago looked identical to one from yesterday.
**Fix / Change:** Each conversation message now includes a formatted timestamp (e.g. "[Tue, Feb 25 at 6:12 PM]") in the history passed to Dean, using the user's local timezone. No schema changes needed — the data was already being fetched.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-01 — Fix morning cron firing for users who haven't completed onboarding

**Type:** Bug Fix
**Reported by:** User (Jake's wife received a stray workout message with no context)
**User feedback:** "it looks like my wife just got an accidental summary message: Wednesday Mar 4: 3 mi easy, flat, HR <150 — true recovery pace after those intervals. out of nowhere."
**Root cause:** morning-workout cron queried all users with a Strava token, with no check on onboarding_step. Users mid-onboarding or in a broken completed state could receive coaching messages they had no context for.
**Fix / Change:** Added .is("onboarding_step", null) and .not("phone_number", "is", null) to the morning cron query, matching the same guards used by the nightly-reminder and sunday-recap crons.
**Files changed:** src/app/api/cron/morning-workout/route.ts

---

## 2026-03-01 — Front-load name question into Dean's first message, remove awaiting_name step

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Name was collected as a separate late-stage onboarding step (awaiting_name), making onboarding feel longer and more form-like than conversational.
**Fix / Change:** Updated the welcome message to introduce Dean, explain the value prop, and ask for the user's name and goal in one message. Removed awaiting_name from STEP_ORDER — name is now captured via extractAdditionalFields from the user's first reply. The awaiting_name handler is kept for any existing users already at that step.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-02-27 — Fix silent onboarding failure leaving users in broken completed state

**Type:** Bug Fix
**Reported by:** User (Jake's wife)
**User feedback:** User had no training_profiles row despite onboarding_step being null — never received any coaching messages
**Root cause:** `completeOnboarding` ran all three DB writes (`training_profiles` upsert, `training_state` upsert, `users` update) in a single `Promise.all`. If `training_profiles` failed (e.g. empty `training_days` array violating a constraint), the error was logged but `onboarding_step: null` still got written, permanently marking the user as complete with no profile.
**Fix / Change:** Split the writes — run `training_profiles` and `training_state` upserts first, check for errors and return early if either fails (leaving `onboarding_step` intact so the user can retry), then write `onboarding_step: null` only on success.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-02-27 — Landing page value prop revamp with real iOS screenshots

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Value prop sections used placeholder SMS mockup components with hardcoded fake conversations; titles didn't match the actual product pitch.
**Fix / Change:** Replaced SmsMockup components with real iOS screenshots (Screenshot #1-3.png from /public). Updated section titles to "A personalized plan in minutes", "Smart adjustments for injury prevention", "Ask anything, any time". Rewrote descriptions to focus on user benefit. Removed all message array constants and SmsMockup import.
**Files changed:** src/app/page.tsx

---

## 2026-02-27 — Capture context shared in any onboarding step + persist post-onboarding profile updates

**Type:** Feature / Improvement
**Reported by:** User feedback
**User feedback:** "what if I share more context on what I want in an earlier onboarding step or later on say 'Can you add some strengthening exercises to prevent IT band syndrome to my plan?' Will those be handled properly?"
**Root cause:** Two gaps: (1) `extractAdditionalFields` only ran in `handleGoal`, so context shared during race-date or schedule steps (injuries, cross-training, preferences) was silently dropped. (2) Post-onboarding messages like "add strengthening to my plan" were answered in the moment but never written back to `training_profiles` or `onboarding_data`, so next week's plan wouldn't reflect them.
**Fix / Change:**
- Updated `extractAdditionalFields` to extract `injury_notes`, `crosstraining_tools`, and `other_notes` in addition to existing fields. Now captures richer context from every step.
- `handleRaceDate` and `handleSchedule` now run `extractAdditionalFields` in parallel with their primary parse call. Extra fields are merged into `onboarding_data` and `users.name` is updated if captured.
- Added `extractAndPersistProfileUpdates()` to `coach/respond` — a fire-and-forget Haiku call that runs on every `user_message` trigger, detects new injuries / cross-training / preferences, and writes them back to `training_profiles.injury_notes`, `training_profiles.crosstraining_tools`, and `users.onboarding_data.other_notes`. Future responses and plans now automatically reflect context the athlete shares at any point.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-02-27 — Acknowledge all onboarding context and surface it in the training plan

**Type:** Bug Fix + Improvement
**Reported by:** User testing
**User feedback:** "I would like to incorporate some strengthening so I don't get IT band or shin splint issues as I increase volume — after I said this, he just said 'What's your name?' He didn't acknowledge that strengthening is important. We should make sure to extract any relevant notes the user wants incorporated into their plan and make sure the plan reflects that."
**Root cause:** (1) `handleAnythingElse` only acknowledged if `extracted.injury_notes` was non-null. Strengthening preferences, injury prevention goals, cross-training requests, and general notes triggered no acknowledgment — Dean would skip straight to the next question. (2) `other_notes` from `extractAnythingElse` was stored in `onboarding_data` but never read by `buildSystemPrompt`, so the training plan had no visibility into it. `crosstraining_tools` was also missing from the system prompt.
**Fix / Change:** Replaced the narrow `acknowledgeInjury` call with a general `acknowledgeSharedInfo` function that runs in parallel with extraction (Haiku, no added latency). It acknowledges any substantive content — strengthening, injury prevention, cross-training, race history, target paces — and returns null only for "nope"/"nothing"-type replies. The acknowledgment is prepended before the next question so the athlete feels heard before we move on. Also added `other_notes` and `crosstraining_tools` to the coach system prompt so the initial plan and all subsequent responses can see and incorporate them.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-02-27 — Fix name extraction and add race-specific acknowledgment with web search

**Type:** Bug Fix + Feature
**Reported by:** User testing
**User feedback:** "when I just texted Dean this: 'Hey Dean! I'm prepping to run the broken arrow 46k in June' he said 'Love it, Dean - a 50K ultra is a great goal....' So he thought my name was Dean even though it's not and said the wrong distance for what I'm training for."
**Root cause:** (1) `extractAdditionalFields` matched "Hey Dean!" and extracted "Dean" as the athlete's name — the rule didn't exclude greetings addressed to Coach Dean. (2) "Broken Arrow 46K" was classified as goal "50k" and acknowledged as "a 50K ultra" even though the athlete stated the specific race name and distance.
**Fix / Change:** (1) Tightened the name extraction rule to only extract names from explicit self-introductions ("I'm [name]", "My name is [name]") and explicitly exclude greetings like "Hey Dean!". (2) Added `generateRaceAcknowledgment` — a parallel Sonnet + web search call that fires alongside the existing Haiku extraction in `handleGoal`. When a specific named race is mentioned, it searches for the race and returns one sentence of real course facts (distance, elevation, terrain). The acknowledgment becomes "Love it — Broken Arrow 46K is a 46km Sierra Nevada skyrace with ~10,200ft of gain" instead of "a 50K ultra is a great goal." Falls back to the template if no specific race is found. Also added `maxDuration = 60` to the onboarding handler.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-02-26 — Fix web search response cut-off and markdown leaking into SMS

**Type:** Bug Fix
**Reported by:** User testing
**User feedback:** "Seems like it may have worked, but something cut-off the response. Message response: which will slow your pace and tax your calves differently than road running."
**Root cause:** Two issues: (1) When Claude generates text, calls the web search tool mid-response, then continues generating, the Anthropic API returns multiple `text` content blocks. We were calling `.pop()` to get the last one — throwing away the first half of the response. (2) Claude occasionally uses markdown formatting (e.g. `**Pacing strategy:**`) when processing search results despite system prompt instructions; SMS renders it literally.
**Fix / Change:** Join all text blocks (not just the last) so split responses from mid-generation searches are reconstructed. Added `stripMarkdown()` applied to every outbound message to strip `**bold**`, `*italic*`, backticks, and headers before sending. Also bumped `max_tokens` from 1024 → 2048 to give web-search-augmented responses more room.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-02-26 — Fix typing indicator: fire early and keep alive during generation

**Type:** Bug Fix
**Reported by:** User testing + Linq support clarification
**User feedback:** "Definitely nothing we need to enable though, should be gtg. Can you explain how this is implemented? would like to take another swing at this"
**Root cause:** Two issues: (1) `startTyping` was called ~12+ seconds after the user's message (10s debounce + DB queries + coach/respond boot), so the user never saw it appear promptly. (2) Most platforms auto-clear the "..." indicator after 5-10s without a refresh call — Claude generation takes 8-15s, so the indicator was expiring before the message arrived.
**Fix / Change:** (1) In the webhook: call `startTyping` immediately after resolving chatId (before the 10s debounce), so the user sees "..." within ~1-2s of sending their message. (2) In coach/respond: run a background loop that calls `startTyping` every 4.5s concurrently with Claude generation, stopping as soon as the response is ready.
**Files changed:** src/app/api/webhooks/linq/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-02-26 — Web search for race/event-specific questions

**Type:** Feature
**Reported by:** User feedback
**User feedback:** "I told Coach Dean that the race I'm doing is called the Behind the Rocks Ultra. I asked him, 'Does he know what elevation looks like for that race and how we should make sure to tailor the training towards that?' This is a good case where he could go and search up the course, find the details, and make sure that the training plan corresponds to the race I'm doing."
**Root cause:** Coach Dean had no access to current or race-specific information. When athletes mentioned a specific race or trail, he could only respond with generic advice.
**Fix / Change:** Enabled Anthropic's built-in `web_search_20250305` tool on `user_message` and `initial_plan` triggers. Claude now searches proactively when an athlete mentions a specific race, event, or trail by name, or asks about something requiring current information (course details, elevation, terrain, cutoff times). Fixed content extraction to read the last text block in the response (not just `content[0]`), since web search responses contain multiple blocks. Added system prompt guidance on when to search vs. when to rely on existing knowledge.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-02-26 — Typing indicators and read receipts via Linq API

**Type:** Feature
**Reported by:** Jake
**User feedback:** "I would like to show a read receipt after Dean receives a message via webhook. I would like to show a typing indicator while we are working on a response to send to the user. The typing indicator should show for a short time if it's a short message Dean is sending, and show for a longer time if it's a longer message."
**Root cause:** Linq exposes `/v3/chats/{chatId}/typing` (POST/DELETE) and `/v3/chats/{chatId}/read` (POST) but we weren't using them. We also had no `chatId` stored per user, which is required for all three endpoints.
**Fix / Change:** (1) Added `linq_chat_id` column to `users` (migration 008). (2) Updated `linq.ts` to add `startTyping(chatId)`, `markRead(chatId)`, and `typingDurationMs(messageLength)` — the duration helper clamps between 1.5s and 8s at ~10ms/character so short replies feel snappy and longer ones feel considered. (3) In `coach/respond`: call `startTyping` before the Claude API call, record `typingStartMs`, then after generation compute `remaining = max(0, targetDuration - elapsed)` and wait that long before sending — this means generation time counts toward the typing window so we never add unnecessary delay. After `sendSMS`, capture the returned `chatId` and persist it to the user record if not already stored. (4) In `webhooks/linq`: extract `chatId` from the inbound payload (tries `chat_id`, `chatId`, `chat.id`), call `markRead` fire-and-forget immediately so the athlete sees a read receipt, and cache the `chatId` to the user row for future use. Added full console logging of returned chatId keys so we can confirm the real field name once live payloads come through.
**Files changed:** supabase/migrations/008_linq_chat_id.sql, src/lib/linq.ts, src/app/api/coach/respond/route.ts, src/app/api/webhooks/linq/route.ts

---

## 2026-02-26 — Personalize onboarding with early name extraction + acknowledge injuries

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "Next fix: I think we need to make sure that every response from Dean (including onboarding steps) is personalized... 1) Make sure that if name is included in the first message (or any other message), that we extract that and personalize future messages. 2) I noticed that we didn't actually acknowledge Ray's injury when she first shared it. We should acknowledge it and validate that we will consider it in the training plan." [Ray's first message was "Hi Dean! My name is Ray" — Dean never extracted it and still asked "What's your name?" at the end. When Ray shared a hip labrum surgery + bone spur recovery, Dean's response was just "What's your name?" — zero injury acknowledgment.]
**Root cause:** (1) `extractAdditionalFields` (called on every goal message) did not extract name — the `name` field was missing from its extraction prompt entirely. Dean always asked `awaiting_name` regardless of whether the name had already been provided. (2) `handleAnythingElse` saved extracted injury notes to `onboarding_data` but sent no acknowledgment — it just silently advanced to the next step question. The athlete felt unheard.
**Fix / Change:** (1) Added `name` to `extractAdditionalFields` prompt; if found, saved immediately to `users.name` and `onboarding_data` in `handleGoal`. Goal acknowledgment now personalized: "Love it, Ray — a 10K is a great goal." (2) `isStepSatisfied("awaiting_name")` now returns true when `data.name` is already set — the name question is skipped entirely for users who introduced themselves early. (3) Extracted shared `completeOnboarding()` function from `handleName` so both `handleName` and `handleAnythingElse` (when name pre-known) can trigger the profile write + `initial_plan`. (4) Added `acknowledgeInjury()` Haiku helper — generates a warm, specific 1-2 sentence acknowledgment. `handleAnythingElse` now: calls `acknowledgeInjury` when injury notes are present, prepends the ack to the next step question (e.g. "That sounds really tough — I'll keep volume conservative and avoid anything that could aggravate your hip.\n\nWhat's your name?"), or sends it as a standalone message before firing the initial plan when name is already known.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-02-25 — Add event tracking via Supabase events table

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No instrumentation existed — no visibility into onboarding completion rates, drop-off by step, or message volume.
**Fix / Change:** Created `src/lib/track.ts` with a `trackEvent(userId, eventName, properties?)` utility that inserts into a new `events` table. Fails silently (logs but never throws). Instrumented 7 events: `onboarding_started` (new user created in webhook), `onboarding_step_completed` (after each successful step advance — goal, race_date, days_per_week, anything_else, name — with relevant properties), `onboarding_completed` (in `after()` alongside the initial_plan trigger), `plan_generated` (initial_plan and weekly_recap triggers, with `plan_type`), `message_received` (every inbound message with `has_image`), `workout_logged` (after image activity insert with activity_type and distance), `coaching_response_sent` (every coach/respond success with trigger type). All calls use `void trackEvent(...)` to fire-and-forget without blocking the main path.
**Files changed:** supabase/migrations/007_events.sql, src/lib/track.ts, src/app/api/webhooks/linq/route.ts, src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-02-25 — Fix day/date mismatch in coaching messages

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "It should be Thursday, Feb 26th so there's still a mismatch between the day of the week and actual date — Dean said tomorrow (Thursday, Feb 27)"
**Root cause:** `shortFormatter` produces date strings like `"Thu, Feb 26"` (comma inside the string). `upcomingDays.join(", ")` used the same comma as the list separator, producing `"Thu, Feb 26, Fri, Feb 27, Sat, Feb 28, ..."`. Claude couldn't reliably tell which commas were separators vs. part of the date format, causing it to misalign weekday names with dates by one position (associating Thursday with Feb 27 instead of Feb 26). Additionally, the next-7-days array was computed by adding raw milliseconds to `now`, which can drift in edge cases near timezone boundaries.
**Fix / Change:** Changed the list separator to `" | "` so it's unambiguous. Replaced `now.getTime() + n*86400000` with `Date.UTC(today_y, today_m, today_d + n)` — explicit calendar date arithmetic starting from today's date in the user's local timezone (derived via `Intl.DateTimeFormat("en-CA")`). This guarantees the weekday and date always align regardless of when during the day the function runs.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-02-25 — Image workout handling via Claude vision

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Inbound Linq webhook only processed `type: "text"` parts. MMS image messages were silently dropped because the handler bailed on `!body`. No path existed to log, parse, or respond to workout screenshots.
**Fix / Change:** Webhook now detects image/media parts (tries `type: "image"`, `"media"`, `"mms"` and fields `value`, `url`, `media_url`). Full parts array is logged whenever a non-text part is present so field names can be verified against real Linq MMS payloads. When an image is detected for an onboarded user: (1) image URL fetched and converted to base64, (2) passed to Claude Sonnet vision with an explicit extraction prompt asking for `date`, `activity_type`, `distance_km/miles`, `duration_seconds`, `average_pace_per_mile/km`, `average_hr`, `elevation_gain`, and `splits`, (3) extracted data stored in `activities` table with `source: "image_upload"`, (4) `training_state.week_mileage_so_far` updated, (5) `coach/respond` called with new `workout_image` trigger carrying pre-extracted data directly (no DB lookup). Non-workout images (photos, memes) are routed to the standard `user_message` coaching path. Migration 006 makes `strava_activity_id` nullable to support non-Strava activity rows. `maxDuration` on the webhook increased to 60s to accommodate image fetch + vision call.
**Files changed:** src/app/api/webhooks/linq/route.ts, src/app/api/coach/respond/route.ts, supabase/migrations/006_image_activities.sql

---

## 2026-02-25 — Collect athlete name during onboarding

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Coach Dean had no way to learn the athlete's name during onboarding — messages were personalized with "this athlete" as fallback.
**Fix / Change:** Added `awaiting_name` as the final onboarding step, after `awaiting_anything_else`. Dean asks "What's your name?" and saves the response to `users.name` via `extractName` (Claude Haiku). The completion logic (training_profiles/training_state upserts + initial_plan trigger) moved from `handleAnythingElse` into the new `handleName` handler. `handleAnythingElse` now only extracts/merges data and advances to the next step. `coach/respond` already uses `user.name` in the system prompt, so all future messages (initial plan, morning workouts, post-run feedback) are addressed by name immediately.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-02-25 — Collapse onboarding from 8 steps to 3

**Type:** Improvement
**Reported by:** Rachel
**User feedback:** "Felt like a Google form but a little worse. I didn't know how many questions, and what exactly the goal was, when I was going to get to the end of the onboarding. I also mentioned my injury in the first text, but it only responded to it a bit later and felt like it wanted to just push through the full onboarding flow without being conversational."
**Root cause:** Onboarding had 7–8 sequential steps (experience, pacing, conversational pace, cross-training, schedule, preferences) before delivering any value. Felt like a form. Injuries and side info mentioned early were ignored until the appropriate step arrived. No end in sight for the user.
**Fix / Change:** Collapsed to 3 questions: (1) race date, (2) training schedule, (3) "anything else worth knowing?" The final open-ended question captures injuries, recent race times, paces, cross-training, and anything else the user volunteers — Claude Haiku extracts all fields from free-form text. VDOT paces computed from race times if provided. Steps are auto-skipped if data was already captured in an earlier message. Removed `awaiting_experience`, `awaiting_pacing`, `awaiting_conversational_pace`, `awaiting_crosstraining`, `awaiting_preferences` steps entirely. Removed `handleExperience`, `handleInjury`, `handlePacing`, `handleConversationalPace`, `handleCrossTraining`, `handlePreferences` handlers. Added `handleAnythingElse` and `extractAnythingElse`. No wrap-up SMS — initial plan fires immediately as the response. Proactive cadence defaults to `weekly_only` (no longer asked).
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-02-25 — Fixed Dean sending wrong dates / off-by-one day errors

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "Okay, the next thing I wanna fix is I keep getting a lot of examples of Coach Dean sending dates and being off by a day or so. [example of 'Tomorrow (Thursday, Feb 27)' when today was Wednesday Feb 25]"
**Root cause:** Two issues: (1) New users who sign up via SMS never had a timezone stored — only Strava OAuth users got a timezone. This meant `user.timezone` was null, causing DATE CONTEXT to fall back to `America/New_York` regardless of where the user actually is. (2) The DATE CONTEXT only told Claude "Today is X" — Claude was then calculating relative dates ("tomorrow", "next Monday") itself and getting them wrong.
**Fix / Change:** (1) Created `src/lib/timezone.ts` with `inferTimezoneFromPhone()` — maps E.164 country codes to IANA timezones (e.g. +44 → Europe/London, +1 → America/New_York). This is called on new user insert in the Linq webhook so all SMS signups get a best-guess timezone immediately. (2) Extended DATE CONTEXT in `buildSystemPrompt` to pre-compute and explicitly list "Tomorrow: Thu, Feb 26" and "Next 7 days: ..." so Claude never has to calculate dates itself. (3) Fixed nightly-reminder fallback timezone from `America/Los_Angeles` to `America/New_York` for consistency.
**Files changed:** `src/lib/timezone.ts` (new), `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/cron/nightly-reminder/route.ts`

---

## Template for new entries:

<!--
## YYYY-MM-DD — Short description of change

**Type:** Bug Fix | Feature | Improvement | Refactor | Infra
**Reported by:** User feedback / Internal observation / Testing
**User feedback:** (paste verbatim feedback if applicable)
**Root cause:** (what was actually wrong or missing)
**Fix / Change:** (what you changed and why)
**Files changed:** (optional, list key files)
-->

---

## 2025-02-25 — Initial changelog created

**Type:** Infra
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No formal tracking of changes and user feedback
**Fix / Change:** Created CHANGELOG.md to track all changes alongside user feedback going forward
**Files changed:** CHANGELOG.md

