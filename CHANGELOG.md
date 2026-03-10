# Coach Dean — Changelog

All notable changes to Coach Dean are tracked here. Each entry includes the user feedback or motivation that drove the change, so we have full context over time.

---

## [Unreleased]

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

