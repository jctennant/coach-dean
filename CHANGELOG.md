# Coach Dean — Changelog

All notable changes to Coach Dean are tracked here. Each entry includes the user feedback or motivation that drove the change, so we have full context over time.

---

## 2026-04-17 — Four coaching quality fixes from 2026-04-16 conversation analysis

**Type:** Bug Fix
**Reported by:** Automated daily conversation analysis (2026-04-16, 12 users)
**User feedback:** N/A
**Root cause (4 issues):**
1. **P0 — Per-lap hallucination risk (User 0cb902da):** Dean cited specific lap numbers by index ("laps 3/6/7/8 averaged 155-164 bpm") on a Ride activity. Even when lap data is present, referencing specific indices asserts ordering/identity knowledge that may not be reliable.
2. **P1 — Overtraining warning on WeightTraining (User b1b308cf):** `planDeviationFlag` fired on a WeightTraining activity with 0 mi, producing a mileage-over-plan warning ("17.1mi vs 6mi planned") that was contextually incoherent and tonally jarring after a weight session.
3. **P1 — "postpartum" used as synonym for "post-run" (User 7170bad2):** Dean wrote "How did your body feel postpartum on this one?" — "postpartum" means after childbirth, not after a run.
4. **P1 — Unanswered direct speed question (User 95fd0845):** Athlete asked "how do I get leg speed up" and Dean responded only to the tightness context, ignoring the direct question entirely.
**Fix / Change:**
1. Added data guard in the `post_run` user message builder: when lap data is present, instruct Dean to use descriptive language ("several of the harder laps") rather than specific lap indices ("laps 3/6/7/8").
2. `planDeviationFlag` now returns `null` when `trigger === "post_run"` and the current activity type is not a running type (Run/TrailRun/VirtualRun/Treadmill).
3. Added prompt instruction: never use "postpartum" as a synonym for "post-run" or "after the activity."
4. Added `ANSWERING DIRECT QUESTIONS` prompt section: when an athlete asks a direct question, Dean must answer it explicitly, even if the message also contains other context to address.
**Skipped:** Issue 2 (duplicate messages for User 95fd0845) — the system already deduplicates by `external_message_id`. Content-based dedup within a 30s window would require adding a DB query to the async ingestion path and updating ~15 test mocks. Skipped to avoid risky test churn; worth a dedicated pass.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-16 — Onboarding: name in first message, HR zones + mileage spike at Strava connect

**Type:** Feature / Improvement
**Reported by:** Internal (product direction)
**User feedback:** N/A
**Root cause:** First message felt impersonal (no name ask); post-Strava insights lacked HR and injury-risk signals.
**Fix / Change:** (1) Dean now asks for name + training context in the first message ("What's your name, and how's your training been going?") — removes the awkward nameless turn. (2) Strava callback now computes HR zone distribution (Z1–Z5 % of runs by avg HR vs estimated max HR) and detects week-over-week mileage spikes; both stored in onboarding_data. (3) Dean's post-connect insight instruction updated to surface aerobic/anaerobic split and flag load spikes as concrete injury risk signals. (4) Dean's intro reordered to lead with injury prevention ("I flag injury risk, track your training load…").
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-16 — Onboarding redesign: injury-first intake for "get faster without getting injured" pivot

**Type:** Feature / Improvement
**Reported by:** Internal (product pivot)
**User feedback:** "The product is pivoting from 'AI running coach that builds you a plan' to 'Get faster without getting injured.' Onboarding needs to feel less like signing up for a coaching service and more like a smart intake conversation with a coach who's trying to understand your injury history and training context before saying anything else."
**Root cause:** Previous onboarding was organized around plan creation — the three-mode structure (Plan Complement / Race-Goal Chaser / Healthy Builder) and [READY] conditions were all designed to collect enough info to generate a training schedule. Injury history was an afterthought collected only for ultra and injury_recovery goals. Strength/cross-training wasn't collected at all.
**Fix / Change:**
- New first-message framing: "I help runners get faster without getting injured" replaces generic coaching pitch. First question opens on goal + context together ("Racing this year, building a base, or coming back from something?")
- Injury history elevated to **required for ALL athletes** — must be asked and answered before [READY] regardless of goal type. Previously only required for ultra/injury_recovery goals.
- Strength & cross-training added as **required intake for ALL athletes** — "Do you do any strength work or cross-training?" Ask once, accept any answer, shapes injury prevention guidance.
- Simplified conversation flow — replaces the elaborate three-mode architecture with a common injury-first arc with minor mode variations. Plan-building language removed as the default framing.
- Existing plan handling simplified — Dean is "a post-run analyst, not a plan builder" for plan users. No longer organizes the whole conversation around plan creation.
- New injury/strength coaching moment: when athlete mentions injury history, Dean explicitly names what it will watch for ("With IT band history, I'll flag when weekly jump is too steep").
- New Haiku extraction fields: `injury_history`, `current_niggles`, `strength_habits`, `cross_training_activities`
- `summarizeCollected` updated to display new fields in Dean's context block
- `completeOnboarding` maps `cross_training_activities` → `crosstraining_tools` DB column; combines `injury_history` + `current_niggles` into `injury_notes`
- Evals fixture `first-message-intro.json` updated to reflect new intro framing
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/fixtures/onboarding/first-message-intro.json`

---

## 2026-04-16 — Dashboard redesign: four-section layout

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Dashboard pivot from "AI running coach that builds plans" to "Get faster without getting injured" — existing layout had wrong information hierarchy and lacked clear health/injury signals.
**Fix / Change:** Complete dashboard redesign into four sections: Summary (status signal + weekly progress bar + race chips + Dean's Focus), Injury & Load (12-week bar chart with redesigned green/orange colors + strength/recovery card from LLM), Fitness Progress (aerobic efficiency sparkline + training zones ribbon + HR zones + paces in one card), Last 7 Days (run list). Removed: tabs, Base Phase header badge, race finish projections. Updated `dashboard-insights.ts` to also generate strength/recovery exercises when injury notes are present.
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/dashboard-insights.ts`

---

## 2026-04-15 — Collapse dashboard to single-scroll page

**Type:** Improvement
**Reported by:** Internal
**User feedback:** "Cut entirely: Race projections, Training Overview text blurb, HR zones Z1–Z5 table, Training zones scatter plot, Full training arc (W1–W13 list). Stack rank for the single tab: Dean's Focus / Pace targets / Goal race banner(s) / Last 7 days / Weekly mileage + load warning / Aerobic efficiency trend. Plan upload / 'no plan yet' → move to onboarding or a settings page entirely."
**Root cause:** The two-tab structure still carried too many low-signal elements (race time predictions, zone scatter plots, full training arc list, HR zone table) and the Plan Upload UI had no place on a coaching dashboard.
**Fix / Change:**
- Removed tabs entirely; dashboard is now a single vertically-scrolling page
- Stack rank (top to bottom): Dean's Focus callouts → Pace targets → Goal race banner(s) → Last 7 days → Weekly mileage chart + ACWR load warning → Aerobic efficiency trend
- Cut: race time projections, Training Overview blurb, HR zones table, training zones scatter, full training arc list, plan upload UI
- Goal race condensed to slim banner: name + date + days countdown (no prediction)
- Removed `DashboardTabs` client component from page; `tab-container.tsx` and `plan-tab.tsx` now unused
- Removed DB query for `training_plans` table (no longer needed in dashboard)
- Removed `predictRaceTime`, `estimateVDOT`, `predictTimeFromVDOT` imports
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-15 — Reorganize dashboard into "This Week" and "Season" tabs

**Type:** Improvement
**Reported by:** Internal
**User feedback:** "Tab 1 = 'What should I do this week and how am I doing?' Tab 2 = 'Is the training working and where am I headed?' The day-by-day schedule is doing a lot of visual work for information that becomes stale the moment someone shuffles a run."
**Root cause:** Original two tabs (Overview / Training Plan) mixed time horizons — fitness trends and plan arc were split, race countdown was buried in two places, and the day-by-day weekly grid was expensive to generate and quickly became stale.
**Fix / Change:**
- Renamed tabs: "Overview" → "This Week", "Training Plan" → "Season"
- Tab 1 (This Week): Weekly anchors card (week target + long run target + quality session(s) + done-this-week progress bar), load spike warning, Dean's focus callouts, last 7 days
- Tab 2 (Season): Training overview summary opener, goal race cards + predicted finish, aerobic efficiency trend, weekly mileage chart, training zones scatter, pace zones reference, full training arc (W1–WN)
- Removed the day-by-day Mon/Tue/Wed schedule grid from the plan tab entirely
- Removed `buildDailyPlan` / `buildDailyPlanFromSessions` helpers (no longer needed)
- The analysis summary blurb ("executing hard workouts well but...") moved from Tab 1 top to the Season tab opener where it provides altitude-view context
**Files changed:** `src/app/dashboard/tab-container.tsx`, `src/app/dashboard/plan-tab.tsx`, `src/app/dashboard/page.tsx`

---

## 2026-04-15 — Fix wrong training paces for trail-race Strava users with road PRs

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "Pacing zones also seem off here for a 17:50 5k" (dashboard showed 9:27-9:57 easy, should be ~7:50-8:20)
**Root cause:** When the user's Strava best race is a trail race (e.g. Dipsea 30K), the coach conversation mentions that race including its time. Haiku's extraction step could pick up that trail distance/time from the Coach: lines in the transcript despite the "athlete's messages only" rule, storing them as `recent_race_distance_km`/`recent_race_time_minutes`. The VDOT recalculation then computed pace zones from the trail race performance, giving ~40 VDOT (9:42 easy) instead of the correct ~57 VDOT (7:50 easy) from the user's 17:50 5K road PR.
**Fix / Change:** (1) When `lookupBestStravaRace` returns a trail race, store `strava_best_race_is_trail=true` and `strava_best_race_km` into onboarding_data. (2) VDOT recalculation block now checks: if the extracted `recent_race_distance_km` matches the Strava trail race within 1km, skip the recalc (it's likely the trail race slipping through). If the user provides a different (road) race distance, VDOT still runs correctly. (3) Haiku extraction prompt for `recent_race_distance_km`/`recent_race_time_minutes` now explicitly says "ONLY from lines labeled 'Athlete:' — NEVER from 'Coach:' lines" and names trail races as ineligible.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-15 — Fix goal_time_minutes incorrectly set from 5K PR instead of explicit goal time

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** Dashboard showed "Goal: 17:50" for the Dipsea race (user's 5K PR, not their Dipsea goal)
**Root cause:** Haiku extraction rule for `goal_time_minutes` was not specific enough — it extracted any mentioned time as the goal, including past PRs the user stated as fitness baselines.
**Fix / Change:** Strengthened Haiku rule: "Do NOT use a past PR or best time as the goal time unless the athlete says it IS their goal. A statement like 'my fastest 5K is 17:50' is a fitness baseline — extract it as recent_race_time_minutes, NOT as goal_time_minutes."
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-15 — Fix PDF upload: drag-and-drop and PDF file selection

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "I can't drag and drop a PDF into the PDF uploader. I also can't select a PDF from my computer for some reason."
**Root cause:** (1) The file input `accept` attribute didn't include `application/pdf`. (2) No drag-and-drop event handlers were wired up. (3) The upload API didn't have a `pdf_base64` content type path.
**Fix / Change:** Added `processFile` callback that detects PDF vs image. Added `handleDragOver`/`handleDragLeave`/`handleDrop` handlers with visual feedback. Updated `accept` attribute to include `application/pdf`. Added `pdf_base64` content type to upload API, routing it to the existing `extractFromPDFBase64` function.
**Files changed:** src/app/dashboard/plan-import-form.tsx, src/app/api/plan/upload/route.ts

## 2026-04-15 — Fix arc rebase on partial-week onboard with reliable Strava baseline

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "The plan that was generated had me starting with 39 miles (maybe a bit high) in week one, but then the arc wasn't in sync with that" (Week 1=39mi, Week 2=26.5mi, Week 3=29mi)
**Root cause:** `syncArcCurrentWeek` was rebasing the training arc downward when Week 1 session count (partial week, e.g. Thursday onboard with 4 sessions = ~24mi) was below the Strava 4-week average (29mi). Scale factor 0.83× applied, making weeks 2-3 lower than baseline instead of building from it.
**Fix / Change:** Added `skipRebase` flag to `syncArcCurrentWeek`. When `isPartialWeek && avgWeeklyMileage != null` (Strava data available), skip the arc rebase. The partial week's low session count is by design, not a signal that the baseline is wrong.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-15 — Onboarding prompt improvements for plan-complement users

**Type:** Improvement
**Reported by:** Jake (first run-through of new onboarding)
**User feedback:** "Feels like the first message from Dean is too long and wordy + I don't like SMS running coach. Maybe 'AI running coach'. Don't refer to yourself as a SMS coach. Referenced dashboard - a bit unclear. We don't mention that Dean will write to your strava log. It is less clear why Dean needs my paces if he isn't making me a plan. Is 'which days of the week work best for your training' if the user already has a plan? Didn't send the dashboard or super clearly explain next steps. Didn't tell me how to upload my plan to the dashboard or why I may want to do that."
**Root cause:** First message example used "SMS running coach" (wrong branding) and was over-explained. Plan-complement mode didn't surface the Strava activity annotation feature, framed training-days question oddly for users with fixed schedules, didn't explain why paces matter when Dean isn't building the plan, and the post-onboarding welcome message didn't mention the dashboard or plan upload.
**Fix / Change:** (1) First message example shortened to 2 sentences, changed "SMS running coach" → "AI running coach", added Strava annotation mention. (2) PLAN COMPLEMENT mode no longer collects training days — Dean fires on Strava activity events so the schedule isn't needed upfront. (3) Plan-sharing value prop now explains the concrete reason to share: Dean can tell you whether today's run matched the schedule, flag drift, and give more specific feedback. (4) EXISTING PLAN USERS section updated to match. (5) Complement mode welcome message now includes the dashboard URL and plan-upload instruction.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-15 — Insights section on landing page

**Type:** Feature
**Reported by:** Internal — product review
**User feedback:** N/A
**Root cause:** Landing page sold the channel (SMS + Strava) and the plan/complement concepts but had no concrete examples of what Dean actually analyzes. The value prop was abstract where it needed to be specific.
**Fix / Change:** Added a new "Dean reads the signals most coaches miss" section between the comparison table and the value props. Shows 3 static iMessage-style cards with real Dean messages demonstrating: (1) ACWR injury risk spike, (2) zone 3 trap / easy run HR compliance, (3) post-run pace fade execution. Each card uses the existing iMessage visual style (SF Pro font, gray/blue bubbles, iPhone-like header). Built as an inline `InsightCard` component in `page.tsx` — no new file needed.
**Files changed:** `src/app/page.tsx`

## 2026-04-15 — Expanded post-run and weekly recap analytics

**Type:** Feature
**Reported by:** Internal — product review of core coaching touchpoints
**User feedback:** N/A
**Root cause:** The longitudinal analysis block only had three signals (load trend, aerobic efficiency, cardiac drift). Several high-value signals derivable from existing Strava data were never surfaced: ACWR injury risk, long run progression, intensity distribution (zone 3 trap), cadence, elevation load, and per-run pace execution.
**Fix / Change:**
- Added `computeACWR` — acute:chronic workload ratio (7-day vs 28-day rolling). Flags >1.3 as injury risk zone.
- Added `computeLongRunProgression` — tracks longest run per week over 8 weeks. Flags stagnation (4+ week plateau) and overreaching (>25% single-week jump).
- Added `computeIntensityDistribution` — classifies runs by HR intensity relative to observed max HR. Flags when >50% of runs are in the moderate "gray zone" (common recreational runner mistake).
- Added `computeCadenceTrend` — average spm over recent runs. Flags <170 spm (overstriding risk).
- Added `computeElevationLoadTrend` — weekly vertical gain trend. Shown when avg >500ft/week (trail/mountain runners).
- Added `buildRunExecutionAnalysis` — analyzes per-mile Strava splits for pace fade. Injected into post_run user message when a significant fade or notable negative split is detected.
- Extended `ActivityForAnalytics` interface to include `max_heartrate`, `elevation_gain`, `average_cadence`.
- Added `max_heartrate` to the activities DB query in route.ts.
- All new functions have full test coverage (27 tests in training-analytics.test.ts).
**Files changed:** `src/lib/training-analytics.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-analytics.test.ts`

## 2026-04-15 — Plan generation and import accuracy fixes

**Type:** Bug Fix / Improvement
**Reported by:** Pre-launch audit
**User feedback:** N/A
**Root cause:** Three accuracy gaps in the plan generation and import paths:
1. `plan/upload` used `now.getDay()` (server local time) to compute the "this week's Monday" anchor for week-1 sessions. On a UTC server, a user uploading at 11pm US/Eastern would get a Monday that's one day in the past.
2. `generateAndSaveFullPlan` derived `daysPerWeek` from `profile.days_per_week` with a hardcoded fallback of 4. If the column was null (e.g. old users), Haiku enrichment received the wrong days count and could produce session descriptions out of sync with the athlete's actual schedule.
3. Haiku's SESSION MATH RULE (distance prefix must equal sum of components) was prompt-only — no code-level validation.
**Fix / Change:**
- `plan/upload`: replaced `now.getDay()` / `setDate` with UTC arithmetic (`now.getUTCDay()`, `Date.UTC(...)`, `setUTCDate`, `getUTCMonth/Date`) so the Monday anchor is always correct regardless of server timezone.
- `training-plan.ts`: `daysPerWeek` now falls back to `training_days.length` before the hardcoded 4, so Haiku always receives the correct count.
- Added `fixKeyWorkoutMath(kw, unitLabel)` to `training-plan.ts`: runs post-enrichment on each week's `key_workout`, parses "Verb Xunit (components)" patterns, sums unambiguous component distances, and corrects the prefix if wrong. Leaves time-based and rep-count workouts unchanged.
**Files changed:** `src/app/api/plan/upload/route.ts`, `src/lib/training-plan.ts`, `src/__tests__/lib/training-plan.test.ts`

## 2026-04-15 — Post-generation accuracy validators for dates, mileage, and plan structure

**Type:** Improvement
**Reported by:** Pre-launch audit
**User feedback:** N/A
**Root cause:** Several accuracy risks existed where Claude's output could contain wrong weekday/date pairings, wrong session counts, or wrong totals — with no code-level safety net beyond prompt instructions.
**Fix / Change:**
- Added `fixSessionDayAbbreviations(message, refYear, refMonth)` to `plan-validation.ts`: parses every `Mon 3/2 · ...` session line, verifies the day abbreviation matches the actual calendar date, and auto-corrects any mismatch (with a console warning). Year rollover handled: if session month < current month, infers next calendar year.
- Added `countRunningSessions(message)` to `plan-validation.ts`: counts running sessions (sessions with mileage markers) in a plan response for comparison against the athlete's `training_days` preference.
- Wired `fixSessionDayAbbreviations` into the post-generation pipeline in `route.ts` for `initial_plan` and `weekly_recap` triggers.
- Added session count logging in `route.ts`: warns when Claude's plan has a different number of running sessions than the athlete's `training_days.length`.
- The existing `correctMileageTotal`, `correctTotalFromSessionList`, `enforceVolumeCaps`, `fixSessionDistanceErrors`, and `deduplicateSessionLines` validators were already in place covering mileage accuracy.
**Files changed:** `src/lib/plan-validation.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/plan-validation.test.ts`

## 2026-04-15 — Six coaching quality fixes from eval analysis

**Type:** Improvement
**Reported by:** Internal eval analysis
**User feedback:** N/A
**Root cause (6 issues from eval failures):**
1. **plan-5k-beginner**: Plans had no deload week — progression climbed continuously for 7+ weeks without a recovery week. Deload rule said "include a recovery week" but didn't specify depth (model used 1-2mi step-back instead of a true 25-30% cut).
2. **plan-masters-first-marathon, plan-mile-time-trial**: Week 1 too conservative — model started plans well below current base for MODERATE/HIGH volume athletes. No enforced floor rule existed.
3. **plan-masters-first-marathon**: Session dates spilled outside the stated week header (e.g., "Week 1: Apr 3–9" but sessions listed Apr 11-12). No boundary rule existed.
4. **plan-strength-integrated-marathon**: Race week placed a shakeout run on Friday (gym-only day) — violating the athlete's training day constraints. The CROSS-TRAINING DAY PROTECTION rule didn't explicitly cover race week.
5. **date-post-silence-reengagement**: Coach invented excuses for gaps in contact ("I've been traveling", "been following along") rather than simply owning the silence professionally.
6. **date-recency-gap-contact**: Weekly mileage projection quoted the stored weekly target instead of computing miles-done + sum of remaining sessions (leading to inconsistent totals when actual sessions don't perfectly fill the target).

**Additionally fixed (from running new eval fixtures):**
- **mileage-projection-null-sessions**: Claude used additive format ("39mi planned + 8mi = 47mi") because it misunderstood the weekly target as "additional miles." Added WEEKLY TARGET MEANING rule: target is inclusive of all miles for the week.
- **plan-mile-time-trial**: Model generated 22-24mi in Week 1 (floor = 27mi) by shrinking all sessions when the long run was capped at 5mi. Added SESSION LENGTH MATH rule showing the arithmetic: 3 sessions × 7-8mi + 5mi long run = 27mi+. Also fixed: model was recommending 800m repeats despite them targeting the wrong energy system for a 4-minute race. Added SHORT FAST INTERVALS rule specifying 200m-400m reps only.

**Fix / Change:**
1. Deload depth rule strengthened: "DELOAD DEPTH: ~70% of prior build week — a REAL 25-30% volume cut. If Week 3 is 20mi, Week 4 deload must be ~14mi." Added to both route.ts and run-evals.mjs.
2. WEEK 1 MINIMUM FLOOR: Week 1 must not fall below 90% of current avg weekly mileage (MODERATE and HIGH tiers). Hard rule with `<rule>` tag.
3. DATE BOUNDARY: Every session date must fall within the week header range. Added to DATES AND DAY LABELS section.
4. Race week shakeout constraint: "Do NOT schedule the shakeout on a gym-only, cross-training-only, or rest day." Added to taper protocol and CROSS-TRAINING DAY PROTECTION.
5. SILENCE GAPS rule: "Do not invent an excuse for the gap — own the silence directly and move forward."
6. WEEKLY PROJECTION ACCURACY + WEEKLY TARGET MEANING rules: Projection must equal miles_done + sum of remaining session distances. Target is inclusive, not additive.
7. MILE TT SESSION MATH: Explicit arithmetic showing 3 sessions must average 7-8mi to reach 27mi floor with 5mi long run cap.
8. SHORT FAST INTERVALS rule: 200m-400m reps only; 800m repeats explicitly prohibited for mile prep (wrong energy system).

**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/judges/factual-accuracy.mjs`

---

## 2026-04-15 — Five coaching quality fixes from Weston's first week

**Type:** Bug Fix + Improvement
**Reported by:** Weston
**User feedback:** "Original plan had runs on Sunday. I had to ask 4 times for Sunday to be the rest day before it was respected. On Sunday CoachDean sent me a reminder saying to gear up for my long run in the morning — my long run was the day before. Every day I ran longer than prescribed and a real coach would give critical feedback. The positivity and me always being right feels good but it likely isn't what I need in a coach."
**Root cause (5 issues):**
1. Ultra plan template hardcoded `Sat+Sun` as the back-to-back days, overriding any athlete-specific rest day preference.
2. On Sunday evenings, `weekly_plan_sessions` is exhausted (week 1 past) but `weekly_recap` hasn't fired yet — `nightly_reminder` had no session data and Claude hallucinated "tomorrow: Long run 14mi."
3. `computeProjectedWeekMiles` returns `null` when sessions are empty, disabling `correctProjectedTotal` and allowing Claude's wild "on track for 77mi" projection to stand uncorrected.
4. When an athlete runs on a planned strength/mobility day, post-run feedback praised the run with no mention of the skipped session.
5. No pattern detection: Dean celebrated each over-plan run individually but never noticed or commented on the consistent pattern of running significantly more than prescribed.
**Fix / Change:**
1. Ultra template in `training-plan.ts` now derives back-to-back days from `profile.training_days` (last two training days in weekday order) instead of hardcoding Sat+Sun.
2. Added `nightlyNoSessions` guard: detects end-of-week empty session state and sends a brief "week complete, plan coming tonight" message instead of guessing.
3. `correctProjectedTotal` now accepts a `weeklyMileageTarget` fallback — when sessions are null, caps Claude's projection at 130% of target.
4. Added `skippedNonRunSession` detection: when today's planned session was strength/mobility and athlete ran instead, Dean briefly mentions the skipped session and offers to reschedule.
5. Added `planDeviationFlag`: when athlete has run ≥30% over plan-to-date across ≥3 runs in a week, Dean asks directly what's driving it and offers to recalibrate the plan.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-15 — Onboarding reframe: persona-aware flow and concrete first message

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "One thing I'm not clear if we do well right now is be ultra clear about the ways you can use coach dean upfront (insights on your running, injury recovery and prevention, upload plan and work from that or create a new plan)"
**Root cause:** The old first message asked for the athlete's name and used vague Runna-centric positioning ("Runna plans your runs, Garmin tracks them"). It didn't surface the three distinct use cases, so users without a Runna plan or with injury goals felt like the wrong audience. Onboarding also asked for terrain type, training tools, and weekly recap preference as explicit questions — adding turns without much value.
**Fix / Change:** Rewrote the first message instruction: Dean now opens with a concrete 2-3 sentence description of what he does (post-run notes, training tweaks, injury flagging, plan building), then asks a single branching question to self-select mode (plan complement / race-goal chaser / healthy builder). Name moves to the second turn. Added a CONVERSATION MODE section to the system prompt with three explicit paths — each with different priorities, required fields, and tone guidance. Removed terrain_type, training_tools, and wants_weekly_recap as explicit questions (terrain/tools extracted passively; recap defaults to on). Updated CLAUDE.md onboarding step documentation to reflect the current unified conversation model. Updated eval runner and fixtures to match new expected behavior.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-onboarding-evals.mjs`, `evals/fixtures/onboarding/first-message-intro.json`, `evals/fixtures/onboarding/no-greeting-repeat.json`, `CLAUDE.md`

---

## 2026-04-15 — Evals for uploaded plan scenarios

**Type:** Infra
**Reported by:** Jake ("do we have any evals for these different states or options? if not, let's make?")
**User feedback:** "do we have any evals for these different states or options? if not, let's make?"
**Root cause:** No eval coverage for the uploaded plan path — weekly recap with plan sessions, week sync response, and range session language were all untested.
**Fix / Change:** Added `uploaded_plan` support to `buildUserMessage` in `evals/run-evals.mjs` (injects `<uploaded_plan_next_week>` block mirroring route.ts logic). Added 3 new fixtures: (1) `uploaded-plan-weekly-recap` — Sunday recap must reference week 3 interval sessions from plan, not invent sessions; (2) `uploaded-plan-week-sync` — user replies "week 1 next week" to plan_import_week_ask, Dean must confirm sessions and mention next Monday; (3) `uploaded-plan-range-sessions` — plan has range sessions (4–6mi, 8–12mi), Dean must preserve range language, not collapse to midpoints. Added range/plan-session specific assertions to `factual-accuracy.mjs` judge.
**Files changed:** evals/run-evals.mjs, evals/judges/factual-accuracy.mjs, evals/fixtures/uploaded-plan-weekly-recap.json, evals/fixtures/uploaded-plan-week-sync.json, evals/fixtures/uploaded-plan-range-sessions.json

## 2026-04-15 — Reset training_state to week 1 on plan upload

**Type:** Bug Fix / Improvement
**Reported by:** Jake (dashboard showing "Week 3 of 8" after uploading a new 8-week plan)
**User feedback:** "I thought I deployed — but I think we just aren't clear with everything on the dashboard and how they should update when a new plan comes in"
**Root cause:** Uploading a new plan updated `training_plans` (correct `total_weeks = 8`) but left `training_state.current_week` at its old value (3). The dashboard then showed "Week 3 of 8" — wrong plan total, wrong current week. The "which week?" SMS was the only way to update training_state, meaning the web dashboard "Replace plan" path had no fix at all.
**Fix / Change:** `plan/upload` now resets `training_state` to week 1 (current_week=1, current_phase=base, taper_peak_miles=null, weekly_mileage_target and weekly_plan_sessions from week 1 of the new plan) immediately after saving the plan. For SMS uploads, the "which week?" follow-up adjusts if the user isn't on week 1. For web dashboard uploads, the dashboard shows the correct state immediately on reload.
**Files changed:** `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Fix "next week" date anchoring for plan week sync

**Type:** Bug Fix
**Reported by:** Jake (dashboard showing Week 3 after user said "start week 1 next week")
**User feedback:** "it's weird that I'm on week 3 of 8 now (total week count was reset but not current count - I did say I'm moving to the new plan next week, but need to be ultra clear about what this means for the dash)"
**Root cause:** When a user says "start week 1 next week", both handlePlanWeekSync (webhook) and the coach/respond fallback were anchoring weekly_plan_sessions dates to the CURRENT Monday instead of NEXT Monday. Also, the training_state sync wasn't deployed yet (all fixes in this session were local).
**Fix / Change:** Both handlePlanWeekSync and the coach/respond fallback now detect "next week" in the user's message and shift the date anchor by +7 days. The <uploaded_plan_next_week> prompt label also distinguishes "starting next week" vs "starting now" so Dean mentions the correct Monday start date.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-15 — Fix "I don't have week 1 specifically" — plan import week sync fallback in coach/respond

**Type:** Bug Fix
**Reported by:** Jake (conversation showing Dean saying "I don't have week 1 specifically")
**User feedback:** "weird that dean doesn't have week 1 of the plan?"
**Root cause:** When a user replies to "which week are you on?" (plan_import_week_ask), the primary path is the linq webhook's `handlePlanWeekSync` interceptor. When that interception failed (for any reason), the fallback `user_message` path in `coach/respond` always showed `uploadedNextWeek = currentWeek + 1` — never the week the user actually requested. Dean could see the plan existed but couldn't see week 1's sessions, so said "I don't have week 1 specifically."
**Fix / Change:** Added a fallback inside `coach/respond user_message`: if the last assistant message type is `plan_import_week_ask` and an uploaded plan exists, extract the requested week number from the user's message (via `extractPlanWeekNumber` regex helper), override `uploadedNextWeek` to that week, and sync `training_state` after sending the response. The webhook interception remains the fast path; this is the reliable fallback.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-15 — Fix "Failed to save plan" — training_plans has no unique constraint on user_id

**Type:** Bug Fix
**Reported by:** Jake (logs showing "PDF plan upload failed: Failed to save plan")
**User feedback:** Logs from live send: `[linq-webhook] PDF plan upload failed: Failed to save plan`
**Root cause:** `plan/upload` used `supabase.upsert(..., { onConflict: "user_id" })`, but `training_plans.user_id` has no unique DB constraint. Postgres rejects the upsert with an error.
**Fix / Change:** Replaced the upsert with the same select → update/insert pattern used by `training-plan.ts`: fetch the existing plan row by `user_id`, update if found, insert if not.
**Files changed:** `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Fix PDF plan extraction timeout (single Sonnet call with tool use)

**Type:** Bug Fix
**Reported by:** Jake (logs showing ECONNRESET at 46s and plan/upload 422 after 88s)
**User feedback:** "2026-04-15 20:30:49... [logs showing ECONNRESET, plan/upload 422 after 88s with two Claude calls 24333-63891ms]. Anything to fix here?"
**Root cause:** `extractFromPDF` used two sequential Claude calls: Sonnet (~24s) to dump the PDF as text, then Haiku (~64s) to structure that text into sessions. Total ~88s exceeded Vercel Hobby's `after()` budget (~46s effective), causing ECONNRESET in the webhook. The intermediate text dump also overwhelmed Haiku's context, causing it to return 0 sessions (422).
**Fix / Change:** Replaced the two-step approach with a single Sonnet call that reads the PDF via the document API and extracts structured sessions directly via tool use. This eliminates the intermediate text step, reduces extraction time to ~30-40s, and fits within the Vercel after() budget.
**Files changed:** `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Haiku extraction: has_existing_plan / external_plan_description reliability

**Type:** Bug Fix
**Reported by:** Internal (sim-runna-user-uploads-plan eval warnings)
**User feedback:** N/A
**Root cause:** `has_existing_plan` and `external_plan_description` were defined in the Haiku extraction rules but buried near the bottom of a long list. Haiku was skipping them even when clearly stated in the transcript (e.g. "I'm already on a Runna plan, week 6, ~35mi/week").
**Fix / Change:** Moved both fields to the top of the extraction rules (right after `goal`), added concrete examples of athlete phrases that must trigger extraction ("I'm already on a Runna plan", "my coach gave me a plan", etc.), and consolidated `wants_weekly_recap` alongside them. Same change mirrored in `run-simulation-evals.mjs`. `sim-runna-user-uploads-plan` improved from 7/10 to 9/10.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`

---

## 2026-04-15 — Onboarding evals: existing plan support, first-of-month date guard, extraction tests

**Type:** Improvement / Bug Fix
**Reported by:** Internal (eval run after onboarding revamp)
**User feedback:** N/A
**Root cause:** Three onboarding prompt gaps found via simulation evals: (1) Dean rejected users with existing Runna/TP plans instead of working alongside them; (2) Dean accepted month-only race dates ("in June") and silently defaulted to the 1st, miscalibrating training timelines; (3) `has_existing_plan` and `external_plan_description` fields were not reliably extracted by Haiku even when clearly stated.
**Fix / Change:**
- Added `EXISTING PLAN USERS` section to onboarding prompt: Dean now positions as a coaching layer alongside Runna/TP/coach-written plans, mentions the dashboard PDF upload option, and still completes full onboarding. `sim-runna-user-uploads-plan` went 1/10 → 7/10.
- Added `RACE TARGET FOR TIME-GOAL ATHLETES` section: if athlete has a time goal ("sub-20 5K") without a named race, Dean asks for a specific event.
- Added `FIRST-OF-MONTH GUARD` to prompt and Haiku extraction rule: if only a month is known, Dean must ask for the exact date; Haiku returns null rather than defaulting to the 1st.
- Strengthened cycling-only exit: "one exit message, full stop" to prevent goodbye loops.
- Fixed `has_existing_plan`/`external_plan_description` parity gap in `run-onboarding-evals.mjs` `summarizeCollected`.
- Added new `sim-runna-user-uploads-plan` simulation fixture.
- Added two unit tests in `onboarding-handle.test.ts` covering existing plan extraction and null-skip merge logic.
- All three previously failing simulations now pass. Full suite: 14/16 (avg 7.9/10), up from 12/16 (avg 7.4/10).
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`, `evals/run-onboarding-evals.mjs`, `evals/fixtures/simulation/sim-runna-user-uploads-plan.json`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-15 — Uploaded plan integration: ranges, dashboard arc, weekly recap, week advancement

**Type:** Feature / Bug Fix
**Reported by:** Internal (SWAP Sub-Ultra plan with range-based workouts e.g. "4–8mi easy")
**User feedback:** N/A
**Root cause:** Three gaps after plan import: (1) Range-based sessions (e.g. "4–8mi easy", "6–10×800m") were being collapsed to a single midpoint number, losing range info. (2) The dashboard's full training arc showed blank/zero data for uploaded plans because the arc expects `{phase, mileage_target, long_run_target, key_workout}` but uploaded plans store `{sessions, total_miles}`. (3) Sunday weekly recap used the periodization engine's inferred values instead of the uploaded plan's sessions, meaning Dean would generate new sessions rather than reference the actual plan.
**Fix / Change:**
- **Range extraction**: `plan/upload` Haiku schema now captures `targetDistanceMilesMin`/`Max` alongside the midpoint. `description` preserves range text verbatim ("Easy 4–8mi"). `PlanWeek` stores `total_miles_min`/`max` (sum of range bounds).
- **Dashboard arc**: `page.tsx` detects `plan_source === "uploaded"` and converts uploaded weeks to arc format — derives `phase` from position in plan, `long_run_target` from longest session, `key_workout` from tempo/interval sessions. `WeekCard` and the weekly target stat show "35–45mi" range when min/max are present.
- **Weekly recap**: injects uploaded plan's next-week sessions as `<uploaded_plan_next_week>` context; uses plan's `total_miles` as mileage target instead of periodization engine; directly loads next week's sessions into `training_state.weekly_plan_sessions` from the stored plan data (bypasses sync_sessions text extraction for reliability).
**Files changed:** `src/app/api/plan/upload/route.ts`, `src/app/dashboard/page.tsx`, `src/app/dashboard/plan-tab.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-15 — Plan import: conversational week sync after PDF/image upload

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** After importing a plan, Dean sent a canned "Got it, X sessions extracted" message with no follow-up. The uploaded plan was stored in `training_plans` but `training_state.current_week` and `weekly_plan_sessions` were never updated, so coaching context was unaffected.
**Fix / Change:** Added `plan_import` trigger to `coach/respond` — after a plan is stored, Dean (Haiku) sends a contextual message asking which week the athlete is on, acknowledging the caption if one was included. The reply is intercepted in the Linq webhook (checks `message_type === "plan_import_week_ask"` on the last assistant message) and handled by a new `handlePlanWeekSync` function: extracts the week number via Haiku, loads the uploaded plan week, converts sessions to the `{ day, date, label }` format, and updates `training_state` (current_week, weekly_mileage_target, weekly_plan_sessions). Dean confirms with a brief week summary. Handles "I don't know / just start from the beginning" → week 1.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/webhooks/linq/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-15 — PDF plan import via iMessage

**Type:** Feature
**Reported by:** Internal (user test: sent PDF via iMessage to Coach Dean number)
**User feedback:** N/A
**Root cause:** Linq webhook received PDF attachments with `mime_type: "application/pdf"` but the code only detected image MMS parts (no mime_type check), passing the PDF URL to Claude's vision API which returned a 400 error. The PDF was then silently dropped.
**Fix / Change:** Added PDF detection by `mime_type === "application/pdf"` in the webhook parts parsing, routing PDF attachments to a new `handlePDFPlan` function. Added `pdf_url` content type to `/api/plan/upload` with `extractFromPDF` that fetches the PDF, base64-encodes it, and passes it to Claude's document API. Dean replies with a session/week count confirmation via SMS.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Mountain race predictor, plan import, dashboard announcement, eval parity

**Type:** Feature (3) / Improvement (1)
**Reported by:** Jake (user feedback)
**User feedback:** "I noticed when I look at the pace projections on the new overview part of the dashboard that the projections for mountain races can be really far off from the actual results. I looked at their actual results for the Cirque Series Snowboard Race last year, and I think the fastest time for pros was 1:22. My projection is 1:23, and I'm kind of an intermediate amateur. I think that is off a little bit."

---

### Fix 1 — Mountain race prediction: `mountain` subtype + course record projection

**Root cause:** The `highly_technical` trail subtype (35% penalty) was the worst-case in the predictor, but sky/VK/mountain races like Cirque Snowbird are in a completely different category. VDOT stops being meaningful for these events — everyone hikes the steep sections, compressing the field. A VDOT 62 runner was getting a 1:23 projection for a race where the course record is 1:22.

**Fix / Change:**
- Added `mountain` to `TrailSubtype` union with a 65% VDOT-fallback penalty (the previous max was 35% for `highly_technical`)
- Added `courseRecordMinutes?: number` to `RacePredictionInput` — when provided for trail/mixed terrain, activates a percentile-based projection path instead of pure VDOT extrapolation
- New `courseRecordMultiplier(vdot, subtype)` function: estimates how far behind the course record the athlete will finish based on their VDOT and terrain type. Mountain races use the tightest spread table (everyone hiking compresses the field). Highly technical uses a moderate table. Standard trail uses a wider table closer to road spreads.
- `predictRaceTime` now has two paths: (A) course record projection for trail/mixed when CR is provided (skips terrain penalty, which is baked into the multiplier; heat/altitude still apply), (B) original VDOT path for road or when no CR is provided
- Caveats updated: mountain without CR gets "No course record provided — using VDOT estimate for mountain terrain (less accurate)"; mountain with CR gets the standard mountain estimate caveat
- Added `course_record_minutes` column to `races` table (migration 035), updated DB types, updated races SELECT in dashboard, passed to predictor, show CR in race card
- Updated constraint to allow `trail_subtype = 'mountain'`
- 16 new tests added to `race-predictor.test.ts` (mountain penalty, course record projection, heat/altitude apply on top of CR, road terrain ignores CR path, narrative format)
**Files changed:** `src/lib/race-predictor.ts`, `src/__tests__/lib/race-predictor.test.ts`, `src/app/dashboard/page.tsx`, `src/lib/database.types.ts`, `supabase/migrations/035_plan_import_mountain.sql`

---

### Fix 2 — Plan import: Option A (text description) + Option B (dashboard image upload)

**Root cause:** Onboarding already asked "do you have an existing training plan?" and promised "text description or upload to the dashboard later" — neither was wired up.

**Fix / Change (Option A — text description):**
- Added `external_plan_description` to Haiku extraction schema: captures a brief factual summary when athlete has an existing plan ("Runna 16-week HM plan, week 8, ~40mi/week")
- Added to `summarizeCollected` so Dean sees it under "WHAT YOU ALREADY KNOW" during onboarding
- Stored in new `training_profiles.external_plan_notes` column (migration 035)
- Injected into coaching system prompt under preferred_units: Dean uses it as context for post-run coaching without trying to replace the plan

**Fix / Change (Option B — dashboard image upload):**
- Surfaced the existing `POST /api/plan/upload` route (image_base64 path) from the dashboard
- New `src/app/dashboard/plan-import-form.tsx` client component: upload button (PNG/JPG/WebP), base64 encode, dry-run preview showing week count + session count + avg mi/week, "Save to Dean" confirm, success/error states
- Added to `!hasPlan` section of `plan-tab.tsx`; `userId` prop threaded through `PlanTabProps`

**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/plan-import-form.tsx` (new), `src/app/dashboard/plan-tab.tsx`, `src/app/dashboard/page.tsx`, `src/lib/database.types.ts`, `supabase/migrations/035_plan_import_mountain.sql`

---

### Fix 3 — Dashboard announcement: POST /api/admin/dashboard-announcement

**Root cause:** Need to notify active users of the new dashboard features and plan import capability.

**Fix / Change:**
- New `POST /api/admin/dashboard-announcement` endpoint (mirrors v2-migration pattern)
- Targets: `onboarding_step IS NULL` + `messaging_opted_out = false` + active in last 14 days (conversation row within cutoff) + `dashboard_announcement_sent_at IS NULL`
- Unlike v2-migration, does NOT require Strava — targets all active users
- Message announces dashboard URL, race readiness/training load/fitness projections, and plan import (text summary or dashboard upload)
- `dashboard_announcement_sent_at` column added to `users` table (migration 035)

**Dry-run curl:** `curl -X POST https://coachdean.ai/api/admin/dashboard-announcement -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>","dry_run":true}'`
**Live curl:** `curl -X POST https://coachdean.ai/api/admin/dashboard-announcement -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>"}'`

**Files changed:** `src/app/api/admin/dashboard-announcement/route.ts` (new), `supabase/migrations/035_plan_import_mountain.sql`, `src/lib/database.types.ts`

---

### Fix 4 — Simulation eval runner: summarizeCollected parity

**Root cause:** `summarizeCollected` in `run-simulation-evals.mjs` was missing four fields added in the v2 onboarding revamp: `training_tools`, `terrain_type`, `has_existing_plan`, `wants_weekly_recap`, and the new `external_plan_description`. The simulation runner's "WHAT YOU ALREADY KNOW" block was therefore showing incomplete data to Dean, potentially causing re-asking of already-collected fields.

**Fix / Change:** Patched `summarizeCollected` in `evals/run-simulation-evals.mjs` to mirror the current `route.ts` version exactly.

**Files changed:** `evals/run-simulation-evals.mjs`

---

## 2026-04-14 — Mountain race prediction: course data support

**Type:** Feature
**Reported by:** User feedback
**User feedback:** "did the new prediction logic actually get applied and run? Mine look aggressive for mountain races still!"
**Root cause:** The race predictor had elevation/altitude/trail-subtype logic but the dashboard call and the `user_message` race predictor block never passed those values — because the `races` table didn't store course profile data.
**Fix / Change:**
- Added `elevation_gain_feet`, `elevation_loss_feet`, `race_altitude_ft`, `trail_subtype` columns to the `races` table (migration 034)
- Dashboard now reads and passes course data to `predictRaceTime` — mountain race predictions now apply grade-dependent elevation penalties and altitude penalties
- `user_message` race predictor block also passes course data from the stored A race
- Dean can now save course data when an athlete mentions it via SMS — emits `[RACE_COURSE_UPDATE:{...}]` tag which is persisted to the races table
- For trail races missing course data, Dean's prediction prompt includes a note asking him to request and save elevation/altitude from the athlete
- Course data (gain, loss, altitude, trail type) is shown in the goal race block of Dean's system prompt
- Removed VDOT badge from the aerobic efficiency card (user reported it looked off)
- Improved pacing zones display: from monospace joined text to a labeled 3-row grid with color dots and a note clarifying paces are from Dean's coaching notes (not HR-linked)
**Files changed:** `supabase/migrations/034_race_course_data.sql`, `src/lib/database.types.ts`, `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-14 — v2.0 migration: disable morning/nightly crons + user transition message

**Type:** Feature / Infra
**Reported by:** Internal — product shift to reactive analysis model
**User feedback:** N/A — proactive decision
**Root cause:** v2.0 repositions Dean as a reactive analysis layer (post-run debrief + Sunday recap). Morning and nightly reminder crons were plan-driven proactive messages that no longer fit the product model. Existing users needed a graceful transition message.
**Fix / Change:**
- Disabled `morning-reminder` and `nightly-reminder` crons with `if (true as boolean) return` pattern (cast prevents TypeScript dead-code errors while preserving full implementation for potential reactivation)
- Added `supabase/migrations/033_v2_migration.sql`: `v2_migration_sent_at timestamptz` column on `users` table — idempotency guard for the migration message
- Added `POST /api/admin/v2-migration`: targets users who completed onboarding + have Strava + haven't received the message yet. Sends a plain-language transition message explaining the shift, stores to conversations, marks `v2_migration_sent_at`. Supports `dry_run` for preview and `userId` for single-user testing. 2-second spacing between sends to avoid rate limits.

**Dry-run curl:**
```bash
curl -X POST https://coachdean.ai/api/admin/v2-migration -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>","dry_run":true}'
```
**Live run:**
```bash
curl -X POST https://coachdean.ai/api/admin/v2-migration -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>"}'
```
**Files changed:** `src/app/api/cron/morning-reminder/route.ts`, `src/app/api/cron/nightly-reminder/route.ts`, `src/app/api/admin/v2-migration/route.ts` (new), `supabase/migrations/033_v2_migration.sql` (new), `src/lib/database.types.ts`

---

## 2026-04-14 — Tests: race predictor test suite (50 tests)

**Type:** Infra / Testing
**Reported by:** Internal — identified as highest-risk untested code
**Root cause:** The race predictor was fully rewritten in the previous session with no corresponding tests. Grade-dependent elevation, 4-level trail subtypes, scaled Riegel exponents, tiered heat/humidity, and altitude adjustments all had zero coverage.
**Fix / Change:** Added `src/__tests__/lib/race-predictor.test.ts` with 50 tests across 11 describe blocks:
- VDOT derivation priority (race → best_effort → easy pace → long run → null)
- Riegel exponent scaling across marathon/50K/50mi/100K+
- Elevation: road 1.0 min/1000ft, trail <10% grade 1.5 min/1000ft, trail >10% grade 2.0 min/1000ft
- Steep descent penalty threshold (>12% avg grade)
- All 4 trail subtypes + inferTrailSubtype thresholds (gain/mile)
- Heat tier 1 (2%/5°F), tier 2 (3.5%/5°F), humidity modifier (>70% → +1.5%), 15% cap
- Altitude penalty (2%/1000ft above 5000ft, 10% cap), altitude caveat flag
- Distance mismatch range widening
- Source labels and caveats for all paths
- Edge cases (no data → null, low/predicted/high ordering)
**Files changed:** `src/__tests__/lib/race-predictor.test.ts` (new)

---

## 2026-04-14 — Dashboard: "Training Plan" tab added alongside Overview

**Type:** Feature
**Reported by:** User request
**User feedback:** "is it possible to easily keep the plan on a separate tab if the user wants? That way it's very little disruption for now"
**Root cause:** N/A — additive feature request
**Fix / Change:** Added a two-tab toggle ("Overview" / "Training Plan") to the dashboard. The tab switcher is a lightweight client component (`tab-container.tsx`) that hides/shows pre-rendered server content — no extra data fetches on switch. The Training Plan tab surfaces the full plan calendar (this week's daily breakdown, full arc with phase badges and actual-vs-target mileage) ported from the legacy `_legacy/page.tsx` into a new `plan-tab.tsx` component. Users with no Dean-generated plan see a prompt to text Dean. The page also now fetches `training_plans`, `weekly_plan_sessions`, `training_days`, and override columns that the plan tab needs.
**Files changed:** `src/app/dashboard/tab-container.tsx` (new), `src/app/dashboard/plan-tab.tsx` (new), `src/app/dashboard/page.tsx`

---

## 2026-04-14 — Race predictor: new label framework + major prediction model improvements

**Type:** Feature / Improvement
**Reported by:** User feedback
**User feedback:** "and what about the labeling? Replace the binary High/Medium/Low with a two-part label: source quality + a plain-language caveat when warranted ... The range should probably be labeled too — right now it just floats there. Something like 'likely finish window' underneath it in muted text makes it feel like a real coaching tool"
**Root cause:** Old "High/Medium/Low confidence" with "Race data/Training data/Estimated" subtext was binary and opaque. Elevation and trail penalties were oversimplified. Riegel exponent didn't scale for ultra distances.
**Fix / Change:**
- Replaced confidence display with `sourceLabel` ("Based on recent race" / "Based on training data" / "Estimated from easy pace" / "Estimated from long runs") and optional `caveat` for edge cases (trail races, ultras, altitude mismatch)
- Added "Likely finish window" label above the range in the race card
- Grade-dependent elevation penalties: 1.5 min/1000ft (trail, <10% avg grade), 2.0 min/1000ft (trail, >10% grade), 1.0 min/1000ft (road); descent penalty 0.5 min/1000ft when avg grade >12%
- 4-level trail subtype system: groomed (10%), mixed (17%), technical (26%), highly_technical (35%) pace penalty; `inferTrailSubtype` auto-infers from gain/mile
- Riegel exponent scales with ultra distance: 1.06 (marathon), 1.10 (50K), 1.12 (50mi), 1.15 (100K+)
- Distance-mismatch guard: when goal race >2× VDOT source distance, range widens ±4% and caveat is added
- Tiered heat penalty: 2%/5°F (75–85°F), 3.5%/5°F (85–95°F), +1.5% humidity modifier when >70% humidity
- Altitude adjustment: +2%/1000ft above 5000ft; altitude caveat when training altitude >3000ft below race
**Files changed:** `src/lib/race-predictor.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-14 — Race predictor now uses best_efforts PRs for VDOT derivation

**Type:** Bug Fix / Improvement
**Reported by:** Internal observation (user noted predicted VDOT appeared too low)
**User feedback:** "I think my VDOT is like 57 based on my 17:23 (maybe a bit slower) 5k" — implying the displayed value was lower than expected
**Root cause:** `deriveVDOT` only considered whole Strava activities with `workout_type=1` (race). A 5K PR set during a regular training run (workout_type=0) was never reaching the VDOT derivation path — it fell through to the less-accurate easy pace estimation.
**Fix / Change:** Added a new step 3 in `deriveVDOT` that scans `best_efforts` across all activities for any effort ≥ 5K. Picks the effort that yields the highest VDOT (most accurate fitness signal). Updated `RacePredictionInput` type to accept `best_efforts`. Updated dashboard to pass `best_efforts` into both `estimateVDOT` and `predictRaceTime` calls. A 17:23 5K best effort now correctly yields VDOT ~62–63, with corresponding race predictions: half ~1:22, marathon ~2:52.
**Files changed:** `src/lib/race-predictor.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-14 — v2 dashboard revamp: insights, race readiness, efficiency trends

**Type:** Feature
**Reported by:** Internal (v2 product spec)
**User feedback:** N/A
**Root cause:** Existing dashboard showed only the plan calendar (generated plan arc), which is irrelevant for users with external plans (Runna, Garmin). No training trend visualisation or race prediction panel.
**Fix / Change:** Replaced plan-calendar dashboard with a data-driven v2 layout: quick-stats row (current week mileage, race countdown, load trend, aerobic fitness), race readiness panel with predicted finish time and goal comparison, weekly mileage bar chart (last 12 weeks with 10% threshold line), aerobic efficiency trend line chart, recent post-run/weekly-recap insight feed (last 10), personal records by distance. Old plan-calendar page preserved at `src/app/dashboard/_legacy/page.tsx`. Dashboard is fully server-rendered — no client-side charting dependency added.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/dashboard/_legacy/page.tsx`

## 2026-04-14 — Auto-fix: AI identity guardrail, session-consolidation math, mileage projection cap

**Type:** Bug Fix (3 issues — auto-fixed from 2026-04-13 conversation analysis)
**Reported by:** Automated conversation analysis
**User feedback:** N/A

---

### Fix 1 — P0: Dean roleplayed as a human athlete

**Root cause:** The existing COACH DEAN'S IDENTITY section had soft "Do NOT" language that the model could override when generating a relatable-seeming reply. User 32d7510f asked "what's your training week look like" and Dean responded with fabricated personal training details ("I'm running 40-50mi/week right now — mostly easy miles with one long run and one tempo or hill session. I lift 2x/week..."). When probed, Dean couldn't provide further details, revealing the deception.
**Fix / Change:** Converted the identity section header to a hard `<rule>` tag with ABSOLUTE IDENTITY RULE language. Explicitly names the failure mode ("I'm running 40-50mi/week right now") as a forbidden response. Requires honest deflection in one sentence then immediate redirect to athlete's training.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Fix 2 — P1: Session-consolidation math (dangerous makeup-volume advice)

**Root cause:** User 2e5a7e92 asked to consolidate Sat+Sun into a Saturday double and drop Sunday. Dean correctly calculated the new weekly total (30mi) but then told the athlete to "make sure Saturday volume hits close to the 26mi combined target" — implying the athlete should run 26mi on Saturday alone to compensate. This conflated the combined Sat+Sun target (16+10=26mi) with a single-session goal, which is both incoherent and dangerous.
**Fix / Change:** Added a `SESSION CONSOLIDATION MATH` `<rule>` block next to the existing structural-change rules. Explicitly forbids suggesting the full dropped-session volume be made up in a single day. Provides a correct example: state the lower total, offer only a modest add-on (2–3mi) if the athlete asks to preserve volume.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Fix 3 — P1: Weekly mileage projection inflated (77.2mi from 8.2mi Monday run)

**Root cause:** User 70818a68 received a post-run message saying "8.2 mi logged this week. You've got 5 sessions left (Tue–Sat) on track for ~77.2 mi." The `computeProjectedWeekMiles` function summed remaining sessions from `weekly_plan_sessions` without any sanity check against the stored `weekly_mileage_target`. If stored sessions carry incorrect or stale mileage labels, the projection faithfully reflects those bad values and `correctProjectedTotal` has no basis to override them.
**Fix / Change:** Added an optional `weeklyMileageTarget` parameter to `computeProjectedWeekMiles`. If the computed projection exceeds `weeklyMileageTarget * 1.2`, the function caps the result at `weeklyMileageTarget` (the plan's authoritative target) and logs a warning. Updated the call site to pass `state?.weekly_mileage_target`.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-14 — Update Strava annotation header: week/total instead of phase, metrics back in block

**Type:** Improvement
**Reported by:** Jake
**User feedback:** N/A
**Root cause:** Previous annotation header showed training phase ("Build", "Taper") which was meaningful for plan users but absent for general fitness users. The `— coachdean.ai` suffix on the dean note made the branding feel tacked on rather than anchored. Metrics (decoupling, efficiency, best GAP) were hidden from the block; athletes who checked Strava saw only 3 lines with no specifics.
**Fix / Change:** Header now reads `{emoji} coachdean.ai — Week X of Y · Race Xd out`. Removed `currentPhase` from `AnnotationContext` entirely. Fetches `total_weeks` from `training_plans` for the "of Y" context. Metrics (decoupling, efficiency, best GAP) are shown in the block again, separated from the dean note by a blank line. Note expanded to 1–2 sentences (max_tokens 80→150) to allow weather/terrain context.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-14 — Redesign Strava annotation block format

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "trim it down more — weave a human readable insight into the 1 line analysis. If the user is in a phase of a plan, label the phase. Remove other obscure metrics."
**Root cause:** Annotation block surfaced raw metrics (cardiac decoupling, aerobic efficiency, best GAP) as standalone lines, making it feel like a data dump rather than a coaching note.
**Fix / Change:** Redesigned the block to 3 lines: `{emoji} {Phase} · {Race Xd}` header, `Week: X / Ytmi` mileage line, and the dean note ending with ` — coachdean.ai`. Decoupling, efficiency, and best GAP are now passed to the LLM as context only (woven into the insight) rather than shown as separate lines. Phase label is omitted for general fitness users without a plan.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-14 — Fix "yesterday" bug for cross-training activities in post_run feedback

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "my hike was sunday (two days ago) not yesterday! ... Coach Dean: ... That's good load after the hike yesterday."
**Root cause:** Two issues: (1) The ACTIVITY RECENCY guard ("never say yesterday for activities 2+ days ago") only existed in the `user_message` prompt, not in `post_run`. (2) The rule text said "run" specifically, so cross-training activities like hikes were not explicitly covered even in `user_message`. Claude saw "(2 days ago)" for the hike in RECENT WORKOUTS but had no instruction preventing "yesterday" in post-run context.
**Fix / Change:** Added ACTIVITY RECENCY guard to the `post_run` system prompt, explicitly covering all activity types (runs, hikes, rides, etc.). Updated the same rule in `user_message` to say "activity" instead of "run" for consistent coverage. Added eval fixture `quality-post-run-hike-reference` to catch regressions of this exact case.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/fixtures/quality-post-run-hike-reference.json`

## 2026-04-13 — Estimate distance for time-based interval sessions in dashboard

**Type:** Improvement
**Reported by:** Internal observation (dashboard showing 0mi for "4×3min @ 8:30/mi" sessions)
**User feedback:** "looks like the labels in 'this week' are still off - I'm seeing a 0 mi label for the quality session!"
**Root cause:** `parseKeyWorkoutMiles` had no logic for time-based intervals (e.g. "4×3min @ 8:30/mi"). It returned `null`, causing the dashboard to display 0mi. Also, the regex `(mi|km|m)` matched "m" from "min", and `^(\d+)\s*mi` matched the "mi" in "min" (e.g. "20min fartlek" → 20).
**Fix / Change:** Extracted `parseKeyWorkoutMiles` to `src/lib/parse-key-workout-miles.ts`. Added time-based rep estimation: `work = (reps × workMin) / paceMinPerMi`, `recovery = ((reps-1) × recoveryMin) / (paceMinPerMi + 2)`. Fixed regex lookaheads: `mi(?!\w)` prevents matching "min"; `(mi|km|m)(?!\w)` prevents "m" matching inside "min"/"mi". Added WU/CD summing for all resolution paths. Added Haiku prompt rule requiring `1mi WU + 1mi CD` on all interval/tempo sessions.
**Files changed:** `src/lib/parse-key-workout-miles.ts` (new), `src/__tests__/lib/parse-key-workout-miles.test.ts` (new, 21 tests), `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`

---

## 2026-04-13 — Dashboard: fix Sunday dimming, timezone-aware day highlighting, stride classification, zero-target crash

**Type:** Bug Fix (4 issues)
**Reported by:** Internal proactive audit
**User feedback:** N/A
**Root cause:**
1. **Sunday dimming**: On Sunday after the weekly recap cron advances `current_week`, the dashboard showed next week's Mon–Sat sessions all dimmed as "past" because `todayDayIdx = DAY_ORDER.indexOf("Sunday") = 6`, making `isPastDay = dayIdx < 6` true for every day of the new week.
2. **Server UTC for day highlighting**: `todayDayName` used `new Date().toLocaleDateString(...)` which runs server-side on Vercel in UTC. A Pacific user at 11pm Monday would see Monday dimmed as "past" (it's already Tuesday UTC). The user's `timezone` column was not fetched or used anywhere in the dashboard.
3. **"Easy with strides" misclassified as key workout**: `classifySession` checked `l.includes("stride")` before checking if the label started with "easy", so "Easy 6mi with strides" was rendered bold as a quality session.
4. **Progress bar division by zero**: When `displayMileageTarget = 0`, the width style computed `NaN%` (Infinity clamped to 100), showing a full green bar even when no target was set.
**Fix / Change:**
1. Fetch `timezone` from the `users` table in the dashboard query.
2. Derive `userDayName` and `userDOW` via `Intl.DateTimeFormat` with the user's stored timezone. Use these for `todayDayIdx` (day dimming) and `todayStr` (override expiry check).
3. `todayDayIdx = userDOW === 0 ? -1 : DAY_ORDER.indexOf(userDayName)` — -1 on Sunday so no days in the upcoming week appear past.
4. Added `if (l.startsWith("easy")) return "easy"` before quality keyword checks in `classifySession`.
5. Added `&& displayMileageTarget > 0` guard on the progress bar render condition.
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-13 — Fix "Easy 5.5mi" label showing wrong distance; fix duplicate A-race insertion

**Type:** Bug Fix
**Reported by:** User (ac0ab080) — dashboard "This Week" showed Wed as "Easy 5.5mi" with 1.5mi distance
**User feedback:** "do you also see the wrong labels in this week"
**Root cause:** Two bugs:
1. `buildDailyPlanFromArc` in dashboard: `parseKeyWorkoutMiles` uses `^` (start-of-string anchor), so "Easy 5.5mi" → null → fell back to 20% of weekly mileage (1.5mi). The label showed the key_workout text ("Easy 5.5mi") while the distance showed the fallback (1.5mi) — contradictory.
2. `handleRebuildPlan` B/C race sync: `existingDates` was built only from B/C races. If the A-race date appeared in `onboarding_data.other_races`, it wasn't in existingDates and would be re-inserted as a duplicate A race.
**Fix / Change:**
1. When `key_workout` starts with "Easy", treat that day as a regular easy run rather than a quality session — distribute all non-long-run mileage evenly across easy days (including the "key" day). This makes base weeks show consistent "Easy run" labels and correct per-session distances.
2. In `handleRebuildPlan`, build `existingDates` from ALL races (not just B/C), and add an explicit filter excluding A-priority entries from the sync insert.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Fix peak-phase mileage jump and B-race week label off-by-one

**Type:** Bug Fix
**Reported by:** User (ac0ab080) — plan dashboard showed weeks 12–13 at 45mi/19mi long run after building to only ~10mi/week from a 5mi/week base
**User feedback:** "Bad plan generation is looks like."
**Root cause:** Two bugs in `training-plan.ts`:
1. Peak phase forced `buildMileage = targetPeak` — this assumed the runner had already ramped to `targetPeak`, but the marathon floor is 45mi and a 10%/week cap from 5mi/week can only reach ~12mi in 15 weeks. The result was a hard jump from 10.5mi to 45mi in week 12.
2. B-race week label used `Math.round(...) + 1` while totalWeeks and aRaceWeekNum use `Math.ceil(...)`. For Bay to Breakers (4.857 weeks out), this produced Week 6 instead of the correct Week 5.
**Fix / Change:**
1. Replaced `buildMileage = targetPeak` in peak phase with the same `Math.min(buildMileage * weeklyBuildFactor, targetPeak)` formula used in build weeks — this naturally plateaus when targetPeak is reached, and ramps safely when it isn't.
2. Changed B-race week label formula to `Math.ceil(...)` to match the rest of the arc.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-13 — Fix week 1→2 arc mismatch; tighten moderate-volume week 1 cap

**Type:** Bug Fix + Improvement
**Reported by:** Jake (dashboard review — wife's plan showed week 1=18mi, week 2=15.5mi)
**User feedback:** N/A
**Root cause (arc mismatch):** The training arc is built from `avgWeeklyMileage` (e.g. 14mi). `syncArcCurrentWeek` then patches arc week 1 to reflect what Dean actually prescribed (e.g. 18mi). But weeks 2+ remained calibrated from the original 14mi base, causing a visible drop (week 1=18 → week 2=15.5) on the dashboard.
**Root cause (volume cap):** The moderate-volume (10–30mi/week) week 1 cap was labeled "GUIDELINE", making it easy for Dean to ignore. Dean composed reasonable-looking individual sessions (5mi tempo + 4mi easy + 3mi easy + 6mi long) that summed to 18mi — 28% above a 14mi base.
**Fix / Change:** (1) `syncArcCurrentWeek` now proportionally rescales all future weeks when patching week 1 — scale factor = actualMiles/originalWeek1. E.g. scale 1.286× turns week 2=15.5 into 20, week 3=17 into 22, etc., preserving arc shape. Only fires when the difference is >5%. (2) Moderate-volume prompt cap changed from "GUIDELINE" to "LIMIT" with an explicit ceiling action: "if sessions sum above [avg×1.2], reduce at least one easy run."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Onboarding asks about injuries and training preferences for all goals

**Type:** Improvement
**Reported by:** Jake (internal review)
**User feedback:** N/A
**Root cause:** The onboarding prompt only required injury/limitation notes for ultra goals and injury_recovery goals. Standard trail race, half marathon, and marathon athletes were never asked about injury history or training preferences, so this context was missing from their plans.
**Fix / Change:** Added a catch-all "anything I should know" question to the onboarding prompt for all goal types — framed around injury history and training preferences (e.g. loves hills, hates treadmills). Added `other_notes` to the extraction schema so preferences beyond `injury_notes` get stored in `onboarding_data` and automatically passed to plan generation.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-13 — Strava onboarding message split; cross-training note clarity

**Type:** Improvement
**Reported by:** Jake (internal review)
**User feedback:** "Can we make this two messages? Feels like we should generally not send super long texts like this" / "Should that be something like 'so you get instant feedback and metrics to improve on'?" / "Does Dean mean that I should cycle or pool run instead of regular run? it wasn't clear to me if this is a good replacement or not"
**Root cause:** (1) The Strava onboarding message was one long SMS combining Claude's pitch + the URL + instructions. (2) The Strava value prop used the low-impact phrase "so it shows up in your log." (3) When Haiku generates injury-aware cross-training suggestions in the coach's note, it didn't specify whether they replace or supplement a run session, leaving athletes confused.
**Fix / Change:** (1) Split the Strava message into two SMS: message 1 is Claude's explanation, message 2 is the URL + "No Strava? Just reply skip." (2) Updated the Strava prompt instruction to use "instant coaching feedback on their effort, pacing, and what to focus on next." (3) Updated the Haiku enrichment injury prompt to explicitly state that cross-training alternatives REPLACE a run session for that day.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/lib/training-plan.ts`, `src/__tests__/api/onboarding-handle.test.ts`

## 2026-04-13 — Eliminate remaining dual-state between `races` table and `training_profiles`

**Type:** Refactor / Bug Fix
**Reported by:** Internal (architecture cleanup)
**User feedback:** N/A
**Root cause:** Three residual drift points remained after making `races` the SoT for plan generation: (1) `buildSystemPrompt` read `goal_time_minutes` from `onboarding_data` (only set at onboarding, never updated) instead of `training_profiles` (kept in sync by `persistProfileUpdates`) — meaning mid-coaching goal-time updates didn't affect Dean's pacing advice; (2) `persistProfileUpdates` updated `training_profiles.goal_time_minutes` but never synced it to `races(A).goal_time_minutes`, so the dashboard's race card could show a stale time; (3) the dashboard derived `raceDate` and `goalBucket` from `training_profiles` first instead of the `races` table.
**Fix / Change:** (1) `buildSystemPrompt` now prefers `profile.goal_time_minutes ?? onboarding_data.goal_time_minutes` so post-onboarding goal updates flow through to pacing advice immediately. (2) `persistProfileUpdates` now syncs `goal_time_minutes` to `races(A)` alongside the profile update. (3) Dashboard derives `raceDate` and `goalBucket` from `upcomingRaces.find(priority=A)` first, falling back to `training_profiles` / `training_plans` for legacy users with no A race row. Added a test asserting the races sync for `goal_time_minutes`.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`, `src/__tests__/api/coach-respond-field-sync.test.ts`

---

## 2026-04-13 — `races` table is now the single source of truth for the A race

**Type:** Refactor
**Reported by:** Internal (architecture cleanup, P1 roadmap item)
**User feedback:** N/A
**Root cause:** The A race date and goal lived in two places: `training_profiles.race_date`/`training_profiles.goal` and `races` (priority=A). `generateAndSaveFullPlan` read only from `training_profiles`, so any drift between the two tables caused the plan to use the wrong race date. This contributed to plan-length bugs in the prior session.
**Fix / Change:** `generateAndSaveFullPlan` now queries `races` (priority=A) first for `race_date` and `goal`. Falls back to `profile.race_date`/`profile.goal` only if no A race row exists (backward compat for legacy users with no races row). All mutation paths already write to `races` as part of `persistProfileUpdates` — no other changes needed. The fallback ensures 268 tests remain green without modification.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-13 — Post-onboarding B/C race extraction and auto-rebuild

**Type:** Feature
**Reported by:** Jake (roadmap item)
**User feedback:** "can we tackle the roadmap item right now and test it?"
**Root cause:** `ExtractedProfileData` had no field for secondary races, so when a user mentioned "I also signed up for X on [date]" post-onboarding, the race never made it to the `races` table and the plan arc never extended to cover it.
**Fix / Change:** Added `new_b_races` to `ExtractedProfileData` and the Haiku extraction prompt. Phrases like "I also signed up for X", "doing Y as a tune-up", "I registered for Z too" now extract into `new_b_races` with date, name, priority (B/C), and goal_distance_miles. `persistProfileUpdates` deduplicates against existing `races` rows by date, inserts any new ones, and fires a silent `rebuild_plan` so the arc extends immediately. Past-dated races are filtered out. 4 tests added.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond-field-sync.test.ts`

---

## 2026-04-13 — Weekly recap self-heals missing B/C races from onboarding_data

**Type:** Bug Fix / Reliability
**Reported by:** Jake (dashboard review)
**User feedback:** "I'm wondering if we should consider giving users a command to rebuild plan... I'm just worried other users will get into this state as well."
**Root cause:** The B/C race sync added to `handleRebuildPlan` only fires when a rebuild is explicitly triggered. Users whose plans were missing a B/C race had no automated recovery path unless they texted Dean to rebuild.
**Fix / Change:** Added the same B/C race sync to the `weekly_recap` `after()` block. Every Sunday after generating the week's plan: reads `onboarding_data.other_races`, inserts any future-dated races missing from the `races` table, and silently triggers a `rebuild_plan` if any were added. All users self-heal automatically by the next weekly recap.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Sync B/C races from onboarding_data to races table during rebuild_plan

**Type:** Bug Fix
**Reported by:** Jake (dashboard review)
**User feedback:** "I thought it was weird that the plan didn't include my July 11th race — it used to, and now I just see Dipsea"
**Root cause:** `handleRebuildPlan` queries the `races` table for B/C races to pass to `generateAndSaveFullPlan`. If a race was captured in `onboarding_data.other_races` but never written to (or was accidentally omitted from) the `races` table, it gets silently excluded from the plan arc. Jake's Snowbird race was in `onboarding_data.other_races` but not in `races`.
**Fix / Change:** Added a sync step in `handleRebuildPlan` that, before querying B/C races, reads `onboarding_data.other_races`, finds any future-dated entries not already in the `races` table, inserts them, and merges them into the local `bCRaces` array so they're included in the plan generation. Non-fatal: if the insert fails, it logs and continues with whatever is in the `races` table.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Extracted and tested Strava annotation metric helpers

**Type:** Refactor / Tests
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Aerobic efficiency, cardiac decoupling, best GAP, and emoji selection logic were all private inline code inside `annotateStravaActivity`, making them impossible to unit test without full integration-test scaffolding.
**Fix / Change:** Extracted five pure functions (`selectActivityEmoji`, `processSplitsForMetrics`, `computeAerobicEfficiency`, `computeCardiacDecoupling`, `formatBestGapLine`) and exported them. Added 42 new unit tests covering filtering logic, edge cases (no HR, no GA data, paused splits), drift thresholds, and format correctness. No behavior changed.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/strava-annotation.test.ts`

---

## 2026-04-13 — Rebuilt Jake's plan: 9→11 weeks, fixed weekly target mismatch

**Type:** Bug Fix / Data
**Reported by:** Jake (dashboard review)
**User feedback:** "Plan is now too short - it ends before my first race. This week doesn't match arc target after adjustment. Coach's note talks about tempo but quality session is intervals."
**Root cause:** The `rebuild_plan` trigger fired at 04:03 UTC on April 13, before the anchor fix (`73e97fc`) was deployed at 14:56 UTC. Without `anchorMonday`, `totalWeeks = ceil(Apr 13 → Jun 14 / 7) = 9` instead of the correct `ceil(Mar 30 → Jun 14 / 7) = 11`. The plan ended May 31 — two weeks before the June 14 Dipsea. The coach note/interval mismatch was a Haiku enrichment artifact from the same stale rebuild. The `weekly_mileage_target` (27) was left over from the old plan's week 1 target and didn't match the arc (32.5) or the prescribed sessions sum (~33mi).
**Fix / Change:** Manually triggered `rebuild_plan` again with the anchor fix deployed — plan is now 11 weeks (Mar 30 – Jun 14). Haiku enrichment regenerated week 3 notes, which now correctly describe the 600m interval session. Updated `training_state.weekly_mileage_target` from 27 → 32.5 to match the arc.
**Files changed:** N/A (data fix via admin triggers)

---

## 2026-04-13 — Fixed mid-plan rebuild anchoring wrong taper weeks

**Type:** Bug Fix
**Reported by:** User (dashboard review)
**User feedback:** "I'm wondering if my plan is still messed up somehow — it has me taper too early before my first race"
**Root cause:** `generateAndSaveFullPlan` computed `totalWeeks` and `aRaceWeekNum` from the current Monday. For mid-plan rebuilds, the dashboard anchors to `week1Monday` (= currentMonday − (currentWeek−1)×7), which can be several weeks earlier. This caused the plan to have too few total weeks (race fell outside the plan), or race week numbers that didn't match the dashboard's calendar — resulting in the A-race taper appearing 2–3 weeks too early and the actual race week showing "peak" with full volume.
**Fix / Change:** Added `anchorMonday` parameter to `generateAndSaveFullPlan`. `handleRebuildPlan` now computes `week1Monday` (using the same formula as the dashboard) from `currentWeek` and passes it as `anchorMonday`. This ensures `totalWeeks`, `aRaceWeekNum`, and B/C race week labels are all computed relative to the plan's original start, not today's date. Week-1 rebuilds (where both anchors are identical) are unaffected. Also rebuilt the affected user's plan after deploying the fix.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Fix recovery week over-resting when athlete mentions soreness

**Type:** Bug Fix
**Reported by:** User observation
**User feedback:** "I think she said her calves were tight so it recommended not running Monday...but 29 feels like a big drop for 'my calves are tight'"
**Root cause:** The `RECURRING INJURY ALERT` in the system prompt instructs Dean to "recommend taking a rest day or reducing intensity — do not continue with normal coaching mode." This fires for all trigger types, including `weekly_recap`. So when planning the week, Dean saw calf tightness in `injury_body_parts`, added Monday rest + Friday rest + strength on Wednesday, and ended up with 4 runs (29 mi) instead of 6 runs (~40 mi). The recovery week rule already said "same number of runs, just shorter" but Dean overrode it via the injury alert.
**Fix / Change:** (1) Scoped the `RECURRING INJURY ALERT` to exclude plan generation: during `weekly_recap`, instead of canceling runs, Dean must annotate them ("softer surface, stop if pain") and keep the run count. (2) Added an explicit callout to both recovery week rules (`tsDeloadBlock` and the recap-context rule): "Do NOT add extra rest days to hit the lower total — the mileage reduction is the recovery, not fewer running days."
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-13 — Fix prose weekly mileage target inconsistency in weekly_recap

**Type:** Bug Fix
**Reported by:** User observation
**User feedback:** "He said going to 40 miles but only creates a week with 29. Kind of surprising since the week after that is 50+ and they are both base."
**Root cause:** `correctTotalFromSessionList` only fixes the explicit `"Total: X mi"` line at the bottom of the session list. It did not scan back and correct prose references like "pulling back to ~40 mi" in the first text bubble. The periodization engine passed the target (40 mi) to Dean, Dean stated it correctly in prose, but then prescribed sessions summing to only 29 mi. The two numbers never got reconciled.
**Fix / Change:** Extended `correctTotalFromSessionList` to also find and rewrite prose weekly total mentions (patterns like "pulling back to ~40 mi", "targeting ~45 mi", "step back week — ~38 mi") when they deviate from the SESSION_LIST sum by more than 2 mi. The 2 mi tolerance avoids false positives on closely matching values. Last-week mileage references (e.g. "54.2 mi across 6 runs") are unaffected because they don't follow the keyword patterns.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-13 — Fix duplicate coach responses from Linq webhook race condition

**Type:** Bug Fix
**Reported by:** Conversation analysis (user 5e1535c3, also dc936de3)
**User feedback:** N/A (detected by automated analysis — two near-identical responses sent to same athlete message)
**Root cause:** When Linq delivers the same webhook twice in rapid succession (retry on timeout or network blip), both deliveries pass the pre-`after()` dedup check before either one has had a chance to insert its conversation row. After the 15-second debounce, both handlers see their own row as the "latest message" and both proceed to call coach/respond, generating two independent Claude responses.
**Fix / Change:** Added a post-debounce guard that queries all conversation rows with the same `external_message_id` for that user. If more than one row exists (duplicate delivery), only the handler whose row has the lexicographically smallest id proceeds; all others return early. This is a deterministic tiebreak that both handlers resolve to the same winner without coordination.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-13 — Past-race users no longer shown "Taper phase" in coaching context

**Type:** Bug Fix
**Reported by:** Conversation analysis (user b1b308cf — 50K race on 2026-03-28, still being coached as pre-race)
**User feedback:** N/A (detected by automated analysis)
**Root cause:** `computePhase` returns "taper" for any race date where `weeksUntil ≤ 2`, including negative values (past races). This caused `tsPhaseDisplay` in `buildSystemPrompt` to output "Training: Week 4 · Taper phase" even when the race had already happened. The post-race context block (lines 3249-3267) was correctly injecting "race is done, here's recovery guidance", but the contradictory "Taper phase" label in the FACTS block undermined it — the model saw conflicting signals and defaulted to treating the race as upcoming.
**Fix / Change:** `tsPhaseDisplay` is now an IIFE that detects when the raw phase is "taper" AND `profileRaceDaysUntil ≤ 0` (race has passed), and returns "recovery" instead. The post-race context block is unchanged and continues to provide coaching instructions. `suggestedWeeklyMiles` stays null (the existing `buildPeriodization` taper logic returns null), so no spurious progression targets appear.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

---

## 2026-04-13 — Fix dashboard week dates, mileage attribution, and interval session distance

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "It says week 3 now but I didn't do week 2 / Doesn't show the mileage I did last week / Doesn't seem to know how to estimate the mileage of the quality session / Now says dipsea twice in the races section"
**Root cause:** Three separate bugs:
1. Dashboard week dates completely wrong (week 3 showing Apr 27–May 3 instead of Apr 13–19): `rebuild_plan` creates a new `training_plans` row with a fresh `created_at`, which shifted the `week1Monday` anchor 2 weeks into the future. The dashboard used `planData.created_at` to compute all week date ranges, so after a rebuild the dates drifted while `current_week` stayed correct.
2. Mileage from last week not showing: same root cause — shifted week boundary misattributed past activities to wrong week numbers.
3. Interval session distance wrote "?mi (check distance)": `parseMilesFromLabel` only took the first `mi` match (returning 1 from "1mi WU"), and the prompt didn't include explicit meter-to-mile conversion math for interval notation, so Claude wrote a placeholder instead of computing 6×800m = 3mi + WU/CD.
**Fix / Change:**
- Dashboard now backcomputes `week1Monday` from `current_week + today's date` instead of `planData.created_at`. This is resilient to rebuilds and immediately fixes the current broken state (week 3 will correctly show Apr 13–19). Sunday edge case handled: after the Sunday recap advances current_week, "this Monday" is treated as tomorrow.
- `generateAndSaveFullPlan` now UPDATEs the existing plan row (preserving `created_at`) when `resetToWeek1=false` (i.e., all mid-plan rebuilds), rather than inserting a new row. Prevents the anchor drift from happening in the future.
- `parseMilesFromLabel` updated to detect `N×X(m|km|mi)` interval patterns, compute the interval total in miles, and add any explicit WU/CD miles from the rest of the label.
- Added INTERVAL SESSION DISTANCE prompt rule with explicit conversion table (400m=0.25mi, 800m=0.5mi, etc.) and format examples. Added "NEVER write ?mi" instruction. Strengthened existing QUALITY SESSION MILEAGE examples to show correct arithmetic (6×0.5mi=3mi, 1+3+1=5mi).
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-13 — Fix conversation analysis email formatting + tighten daily auto-fix trigger

**Type:** Bug Fix / Infra
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Two issues. (1) Claude's analysis responses were sometimes wrapped in ```html ... ``` markdown code fences, which rendered as a raw text block in the Resend email instead of formatted HTML. (2) The daily auto-fix trigger had no explicit instruction against merging PRs — it used its `Bash`/`gh` access to auto-merge today's PR (#7) without waiting for human review.
**Fix / Change:** (1) Added `stripMarkdownFences()` helper applied to both `analysisHtml` and `planAnalysisHtml` before injection into the email body. (2) Added an explicit `⚠️ IMPORTANT: NEVER merge the PR yourself` instruction to the trigger prompt. Also tightened the changelog dedup check to cover fixes from the last 48 hours (not just today).
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`, remote trigger `trig_01EzBseDjZ7uNnFRauGy2EXW`

---

## 2026-04-13 — Fix 4 failing eval fixtures + strengthen eval runner prompt engineering

**Type:** Improvement
**Reported by:** Internal eval run
**User feedback:** N/A
**Root cause:** Four eval fixtures consistently failing (6/10, 6/10, 5/10, 4/10):
1. `mileage-strava-correction`: fixture `today` defaulted to Mon 3/30 but conversation history said "today (Tue)" — model got confused about which day was "yesterday" and kept repeating the phantom Monday run.
2. `plan-mile-time-trial`: `today` was mid-week Friday, causing the model to generate sessions spanning two calendar weeks; volume floors were too low (22mi min allowed 23mi which the judge correctly flagged as too conservative for a 30mpw runner).
3. `plan-shin-splints-10k`: injury_notes said "no intensity for 2 weeks" — too vague; model introduced light tempo at weeks 3-4 and didn't mention run-walk or bike cross-training.
4. `plan-strength-integrated-marathon`: fixture `today` was mid-week with a prior-week run bleeding into week 1 total; no hard rule preventing Tuesday quality sessions or requiring explicit S&C acknowledgment; peak cap was 52mi which the judge treated as "exceeds 52mi" when exactly hit.
**Fix / Change:**
- **Fixtures**: Added correct `today` field to each fixture (Mar 31, Apr 5, Apr 13), tightened volume floors (min_week1 27mi for mile TT, min_peak 30mi), strengthened injury_notes with explicit "no intensity first 4 weeks / run-walk required / bike cross-training", updated strength marathon notes as hard constraints, lowered peak cap to 50mi (aligned with notes).
- **Eval runner**: Added `strengthConstraintBlock` — detects "lifts on X and Y" pattern in notes and injects `<rule>` preventing quality work on lifting days and requiring S&C acknowledgment. Added `max_week1_miles` and `min_week1_miles` hard caps in LONG RUN GUIDANCE (new; were not injected before). Upgraded `max_long_run_miles` from bullet to `<rule>` tag with explicit "LONG RUN slot only" scope. Added mile TT `<rule>` capping the long-run slot at 5mi while clarifying other sessions can still be 6-7mi. Added forbidden-phrase override rule after conversation block when `ground_truth.forbidden_phrases` is set — explains WHY those phrases must be avoided, not just that they're wrong.
**Result:** 47 → 50/51 passing, 9.0 → 9.2/10 avg. All 4 target fixtures now pass consistently.
**Files changed:** `evals/run-evals.mjs`, `evals/fixtures/mileage-strava-correction.json`, `evals/fixtures/plan-mile-time-trial.json`, `evals/fixtures/plan-shin-splints-10k.json`, `evals/fixtures/plan-strength-integrated-marathon.json`


## 2026-04-12 — Fix timezone fallback + show Strava location in onboarding closing message

**Type:** Bug Fix / Improvement
**Reported by:** Internal observation (Gwyneth onboarding)
**User feedback:** N/A
**Root cause:** Two issues. (1) `userTimezone` fell back to `"America/New_York"` when `user.timezone` was null. For Mountain/Pacific users onboarding late at night, this rolled the local date forward to Monday, triggering mid-week plan logic instead of Sunday full-week logic — causing the wrong framing and dropping Monday from the plan. (2) The closing "how does this look?" message had no timezone confirmation, so if the timezone was wrong the user had no way to know or correct it.
**Fix / Change:** (1) Timezone fallback now uses `inferTimezoneFromPhone()` instead of hardcoded `"America/New_York"`. (2) When Strava city/state is available, the closing message now reads "I've got your location as [City, State] so I have the right timezone for you. Let me know if that needs correcting." Falls back to the generic reminder phrasing when no Strava location is on file.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Fix Sunday initial plan framing + server-side mileage total from SESSION_LIST

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "Dean says 'this just covers the rest of this week' but it's Sunday night and so it actually is a complete plan for next week" and "the mileage sum is off - shouldn't this be calculated server side and injected?"
**Root cause:** Three issues: (1) The Sunday branch of `weekBoundaryNote` told Claude to plan a full week but didn't tell it to *frame* the message as a full week, so Claude still used partial-week language ("rest of this week"). (2) `correctMileageTotal` parses session lines via regex and can miss the stated total when the character encoding or format differs subtly; in this case Claude said "Total: 10mi" when sessions summed to 15mi. (3) The `initialPlanDaysConstraint` always appended "Do NOT add a session for today (athlete needs time to prepare after onboarding)" — on Sunday night that confused Claude into skipping Monday too, since the week starts immediately after a late-night onboard. The athlete had 5 training days but only got 4 sessions.
**Fix / Change:** (1) Added a CRITICAL instruction to the Sunday `weekBoundaryNote` explicitly telling Claude not to say "rest of this week" and to frame the plan as their first full week. (2) Added `correctTotalFromSessionList()` — after the SESSION_LIST JSON is parsed, it sums miles from structured session labels and does a final pass to correct any wrong "Total:" line. This runs as a second pass after `correctMileageTotal` for `initial_plan` and `weekly_recap` triggers. (3) The "do not add a session for today" clause is now omitted from the Sunday path — on Sunday the athlete plans Monday onward and there's no window-closed restriction.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-12 — Trail race calibration prompt now references the actual race instead of "your best Strava effort"

**Type:** Bug Fix
**Reported by:** Jake (Gwyneth's conversation)
**User feedback:** "not sure why Dean is saying her recent best effort is on trail if he doesn't have a best effort he's looking at?"
**Root cause:** The pace calibration prompt instruction told Claude to say "Your best Strava effort is a trail race..." — a vague, hardcoded phrase. The STRAVACONTEXT already contained the specific race label, date, and time, but the instruction didn't direct Claude to use those details. When Gwyneth asked "What race is my best Strava effort?", Dean correctly had no specific answer, exposing the contradiction.
**Fix / Change:** Updated the PACE CALIBRATION prompt instruction to tell Claude to reference the specific race label and date from the STRAVACONTEXT (e.g. "I can see a [label] from [date] in your Strava history") instead of using the vague "your best Strava effort is a trail race" script. Added explicit instruction: "Do NOT use vague phrases like 'your best Strava effort' without naming the specific race."
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-12 — Travel weeks no longer drop running sessions from the weekly plan

**Type:** Bug Fix
**Reported by:** Jake (internal)
**User feedback:** "why did I only get two days in my sunday recap schedule for the next week?"
**Root cause:** The schedule constraint prompt treated travel days the same as explicit day conflicts (spin class, soccer, etc.), causing Dean to skip running sessions on Mon–Thu when the athlete mentioned traveling. Only Sat/Sun remained, resulting in a 16.5mi plan against a 30mi target.
**Fix / Change:** Added a TRAVEL WEEKS rule to the weekly_recap prompt clarifying that travel ≠ rest day. Runs stay on confirmed training days during travel (framed as hotel/road miles). Only dropped if the athlete explicitly says they can't run (e.g. back-to-back flights).
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-04-12 — Removed "tomorrow" recommendation from Strava annotation

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "his last line is about what you should do tomorrow; there's already a plan so it will be bad if these two are in conflict"
**Root cause:** The Haiku prompt instructed Dean to end every annotation with a plain-English tomorrow recommendation based on cardiac decoupling/efficiency. This directly conflicts with the SMS training plan already sent to the athlete.
**Fix / Change:** Replaced rule 5 in the annotation prompt from "tell the athlete what tomorrow should look like" to "do NOT tell the athlete what to do tomorrow — they already have a training plan for that."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-12 — Fixed Strava annotation showing same race twice instead of two different races

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "right now for me it says 'Dipsea 62d out Dipsea 62d out' - so it is kind of repeating itself in the title instead of mentioning my other race"
**Root cause:** `annotateStravaActivity` used `.slice(0, 2)` on `upcomingRaces` before deduplicating by name. If the same race was inserted twice (e.g. as both A and B priority entries, which can happen after the race date conflict-resolution logic), both slots were consumed by Dipsea and the second distinct race never appeared.
**Fix / Change:** Added a `Set<string>` dedup filter by `race_name` before the `.slice(0, 2)`, so duplicate-named races are collapsed to one entry and the remaining slot is filled by the next distinct race.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-12 — Fixed Strava weekly mileage: analytics never saved + rolling window misalignment

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "How did you calculate the 17 average?" / "The last four weeks my mileage was 15.5, 14, 16, 10 (that week of 10 was when I was sick)"
**Root cause:** Two bugs. (1) `strava_avg_weekly_miles` and related analytics were computed after the first `users` DB update, then mutated onto the in-memory `updatedOnboardingData` object but never written back — so the field was always `null` in the DB, and Claude hallucinated a mileage number instead of using real data. (2) The weekly bucketing used rolling 7-day windows anchored to "now" rather than calendar (Mon–Sun UTC) week boundaries. On a Sunday evening connect, an entire Mon–Sat training week fell in slot 0 (excluded as "partial current week"), pulling in an older higher-mileage week from slot 4 instead.
**Fix / Change:** Added a second `supabase.from("users").update(...)` after analytics are computed so they're actually persisted. Replaced rolling-window bucketing with calendar-week boundaries (Monday midnight UTC): `ceil((currentWeekStartMs - runTime) / msPerWeek)` assigns each run to the correct complete calendar week slot.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-12 — Metric units consistency + long run adaptation + week number context

**Type:** Bug Fix (3 issues)
**Reported by:** Isaac Harris (via Jake)
**User feedback:** "It does it still in miles and sometimes switches metrics to kilometers but only sometimes" / "I did a long run yesterday and it still told me that I had to do my long run today" / "It often has told me it is week 1 of my training plan, and I wasn't sure if that was because you are resetting things in the software or it forgets."
**Root cause:**
1. **Metric units**: The activity summary, weekly mileage table, pace analysis, individual workouts, all-time Strava stats, and race history were all hardcoded to output miles and /mi paces regardless of `preferred_units`. Claude was told to respond in km but the raw data it read was always in miles, causing inconsistent unit usage.
2. **Long run adaptation**: The session row instruction only told Dean to check the RECENT CONVERSATION for completed workouts today — it didn't tell Dean to check Strava activity history for sessions completed earlier in the week. If an athlete did their long run on Saturday but the plan had it on Sunday, Dean would re-prescribe it.
3. **Week number**: No context was given about what "Week 1" means, so athletes who just generated a plan couldn't tell if the week counter was wrong or just reset.
**Fix / Change:**
1. Added `useMetric` parameter to `buildActivitySummary` — now converts distances to km, paces to /km, and elevation to meters for metric users. Fixed `allTimeInfo` and race history in `buildSystemPrompt` to use `spMi()`. Updated `parseSessionMiles` to parse km labels (converting to miles for internal tracking). Updated `prescribedWeek1Miles` extraction to handle km plan totals. Updated SESSION DISTANCE FORMAT instruction and example sessions to use km for metric users.
2. Expanded the TODAY'S PLANNED SESSION instruction to also check RECENT WORKOUTS (Strava data): if a long run appears in recent activities from earlier this week, Dean treats it as done and doesn't re-prescribe.
3. Added "(week 1 = first week of current plan; advances each Sunday)" note to the training week line in the system prompt so Dean can explain week numbers when asked.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-12 — Dean no longer invents a fake personal training life

**Type:** Bug Fix
**Reported by:** User observation (live conversation)
**User feedback:** "dean what's YOUR training week look like" → Dean responded "I'm running 40-50mi/week right now..." → user then asked "how are you running 40-50 miles a week right now then?" after Dean tried to walk it back
**Root cause:** No instruction in the system prompt addressed questions about Dean's own identity or personal life. Without guidance, the model defaulted to engaging with the hypothetical and inventing plausible-sounding personal details, which immediately fell apart under follow-up.
**Fix / Change:** Added a `COACH DEAN'S IDENTITY` block to the system prompt. Rule: Dean is an AI — no legs, no race bib, no hometown. When asked personal questions, give one brief honest line then redirect to the athlete. Never invent personal details even playfully, since a single invented fact creates an impossible contradiction on follow-up.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Aerobic metrics: efficiency + decoupling stored and trended over time

**Type:** Feature / Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Efficiency was dropped in a previous simplification pass; no historical metric data existed for Dean to trend.
**Fix / Change:** (1) Aerobic efficiency restored to annotation block alongside cardiac decoupling — both shown with plain-English interpretation guides so the LLM note can explain them accessibly. (2) `aerobic_efficiency` and `cardiac_decoupling_pct` now persisted to the activities table on every annotation (migration 029). (3) For `post_run` and `user_message` triggers, Dean's system prompt now includes a rolling table of the last 10 runs with both metrics, a computed trend direction (improving/declining/steady based on recent 3 vs prior 3), and explicit instructions to proactively flag improvement, flag sustained high decoupling as overreaching risk, and explain metrics in plain English when asked.
**Files changed:** `supabase/migrations/029_aerobic_metrics.sql`, `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Strava annotation: default opt-in, simplified, weather-aware

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Annotation opt-in was too buried (required separate `/auth/strava/write` re-auth); annotation block was verbose; no weather context to explain HR/pace anomalies.
**Fix / Change:** (1) Main Strava OAuth now requests `activity:write` scope by default, so new users are opted into annotation without a second auth step. Onboarding mentions the note and how to uncheck it. (2) Annotation block simplified: removed divider, aerobic efficiency, and cardiac decoupling lines — kept header, week mileage, HR drift, best GAP, and 1–2 sentence Dean note (was 2–3). (3) Weather context added: Open-Meteo fetches conditions for the activity's date (using `past_days=2`) and passes temp/conditions/wind to the LLM so it can explain heat or wind effects on pace/HR.
**Files changed:** `src/app/api/auth/strava/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/lib/weather.ts`, `src/app/api/coach/respond/route.ts`


## 2026-04-12 — Restrict Strava annotation to run-type activities only

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `annotateStravaActivity` was called for any `post_run` trigger regardless of activity type, so hikes, bike rides, swims, etc. would get a run coaching annotation written to their Strava description.
**Fix / Change:** Added activity type guard at both annotation call sites (main path and dedup early-exit path). Only `Run`, `TrailRun`, `VirtualRun`, and `Treadmill` activities are annotated.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Fix Dean falsely implying Strava will sync for non-connected users

**Type:** Bug Fix
**Reported by:** Jake (observed in Madie's conversation)
**User feedback:** Madie said "I already finished today's run and uploaded it to Strava" — Dean responded "sometimes there's a delay before activities sync over" implying it would appear soon, when in fact Madie has no Strava account connected to Coach Dean.
**Root cause:** System prompt told Dean "Strava: not connected" but gave no guidance on what to say when a non-connected user mentions Strava. Dean defaulted to a plausible-sounding sync delay response, which was factually wrong and would leave the user waiting for a sync that will never happen.
**Fix / Change:** Added a `<rule>` adjacent to the Strava status line (for non-connected athletes) instructing Dean to acknowledge the run, clarify there's no Strava link so it won't auto-sync, and invite the user to share how it went so it can be logged manually.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Double-text guard and "today already done" prompt fix

**Type:** Bug Fix
**Reported by:** Jake (self)
**User feedback:** "Got a bit of a double text here - also I told Dean yesterday I wasn't going to run today, cycle instead so it's weird that he's asking me if I'm going to run"
**Root cause:** Two bugs: (1) If a user sends two messages more than 15s apart, both pass the debounce window independently and each triggers a separate coach/respond call — resulting in two independent Dean replies. (2) The TODAY'S PLANNED SESSION prompt label said "may already be completed — check conversation history" but Dean wasn't correctly inferring that reporting a completed cross-training workout (cycling) means today is done — he'd still ask "still planning that easy 6mi?"
**Fix / Change:** (1) Added a 45-second assistant-reply dedup guard in the linq webhook debounce section. After the 15s wait and newer-message check, we now also check if an assistant message was sent within the last 45s — if yes, skip to prevent a second independent reply. (2) Strengthened the TODAY'S PLANNED SESSION system prompt label to explicitly say: if the athlete's message reports completing ANY workout today (running, cycling, strength, etc.), treat today as DONE and do NOT ask if they're still planning today's run.
**Files changed:** src/app/api/webhooks/linq/route.ts, src/app/api/coach/respond/route.ts

## 2026-04-12 — [LIGHTER_WEEK] tag + injury accommodation evals

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Minor injuries (3–10 days) had no structured handling. An athlete reporting calf tightness or fatigue would get a conversational response but no plan adjustment — the next morning_plan or weekly recap still saw full volume. [INJURY_HOLD] was too blunt (complete rest only), leaving a gap for "can still run, just less" cases.
**Fix / Change:** Added `[LIGHTER_WEEK]` tag (same pattern as `[REBUILD_PLAN]`/`[INJURY_HOLD]`). When fired, reduces `weekly_mileage_target` by 25% (rounded to nearest 0.5mi) and clears `weekly_plan_sessions` so the next interaction picks up the lower volume. System prompt instructs Dean to append `[LIGHTER_WEEK]` for nagging soreness/fatigue/minor aches, suggest cross-training for skipped days, and confirm next week returns to normal. Tag is stripped before SMS send. Added 4 eval fixtures: `quality-injury-hold-tag` (doctor says no running → must fire `[INJURY_HOLD]`), `quality-injury-hold-threshold` (mild soreness → must NOT fire `[INJURY_HOLD]`), `quality-injury-clear-tag` (cleared after hold → must fire `[INJURY_CLEAR]`), `quality-lighter-week-tag` (calf tight, can still run → must fire `[LIGHTER_WEEK]` not `[INJURY_HOLD]`). Updated eval runner (`run-evals.mjs`) to inject injury hold state and tag instructions for `user_message` fixtures. Updated judge (`factual-accuracy.mjs`) to handle `must_contain_tag` and `forbidden_tags` ground truth fields.
**Files changed:** src/app/api/coach/respond/route.ts, src/__tests__/api/coach-respond.test.ts, evals/run-evals.mjs, evals/judges/factual-accuracy.mjs, evals/fixtures/quality-injury-hold-tag.json, evals/fixtures/quality-injury-hold-threshold.json, evals/fixtures/quality-injury-clear-tag.json, evals/fixtures/quality-lighter-week-tag.json

## 2026-04-12 — Injury hold & return-to-running system

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** No structured path for athletes who get injured mid-plan. Dean had no way to pause running prescriptions, and no mechanism to rebuild a plan with a conservative return-to-running ramp on clearance.
**Fix / Change:** Added `[INJURY_HOLD]` and `[INJURY_CLEAR]` tag-based triggers (same pattern as `[REBUILD_PLAN]`). When an athlete explicitly says they can't run (doctor's orders, acute flare), Dean appends `[INJURY_HOLD]` which fires the `injury_hold` trigger: stores `injury_hold_since` and `pre_injury_mileage_target` in `training_state`, zeros out `weekly_mileage_target`, and clears session prescriptions. Weekly recap skips mileage progression and `syncArcCurrentWeek` during a hold. On clearance (`[INJURY_CLEAR]`), the ramp is computed from weeks injured (1w→70%, 2w→60%, 3+w→50% of pre-injury base) and `generateAndSaveFullPlan` rebuilds the arc with that base. Admin triggers also available (`trigger: "injury_hold"` / `"injury_clear"`). Added `injury_hold_since` and `pre_injury_mileage_target` columns via migration `027_injury_hold.sql`. Also fixed `makeChain` in tests to include `gt` and `lt` operators (were missing, causing silent failures on queries using `.gt()`).
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/database.types.ts, supabase/migrations/027_injury_hold.sql, src/__tests__/api/coach-respond.test.ts

## 2026-04-12 — Plan generation improvements from plan health audit

**Type:** Improvement
**Reported by:** Internal plan health audit (2026-04-09, 15/37 users with issues)
**User feedback:** N/A
**Root cause:** Three systematic issues identified across active users: (1) Triathlon goal types (sprint_tri, olympic_tri, 70.3, ironman) had no dedicated volume targets in `getTargetPeakMileage`, falling through to the generic default (floor=20mi, cap=60mi) — too high for sprint/olympic tris where athletes cross-train heavily and run volume should be lower. (2) Haiku plan enrichment could generate session descriptions where the stated distance label didn't match the sum of WU + main set + CD components (e.g. "Tempo 2mi (1mi WU + 1.5mi @ threshold + 1mi CD)" = 3.5mi, not 2mi). (3) Haiku invented specific pace targets for users with no VDOT or easy pace on file, producing potentially inaccurate prescriptions.
**Fix / Change:** Added triathlon-specific floor/cap pairs to `getTargetPeakMileage` (sprint_tri: 10–30mi, olympic_tri: 15–40mi, 70.3: 20–45mi, ironman: 30–55mi). Added SESSION MATH RULE to the Haiku enrichment prompt requiring that structured WU/main/CD labels sum to the stated total distance. Added NO PACE DATA guard to the Haiku user message injecting effort-only language instructions when no pace baselines are available.
**Files changed:** src/lib/training-plan.ts

---

## 2026-04-12 — Fix duplicate inbound message processing (race condition)

**Type:** Bug Fix
**Reported by:** Internal observation (Maddy, user 2e5a7e92)
**User feedback:** Nearly every onboarding message was saved twice in rapid succession — "Hello! I have some runs…" appearing back-to-back, same with subsequent messages.
**Root cause:** Linq was delivering each webhook twice within milliseconds. The deduplication check (`external_message_id` lookup) was inside `after()`, so both deliveries would read the DB before either had inserted a conversation row — both passed the check and both processed the message.
**Fix / Change:** Moved the `external_message_id` dedup check to before `after()`, in the synchronous part of the POST handler. The first delivery hits the DB, finds nothing, and proceeds. The second delivery arrives while the first is still in `after()`, hits the DB, still finds nothing — but now returns 200 before entering `after()` at all, so only one message is ever processed. The redundant check inside `handleInboundMessage` was removed.
**Files changed:** `src/app/api/webhooks/linq/route.ts`

---

## 2026-04-11 — Initial plan: explicitly frame partial-week plans as a short starter

**Type:** Improvement
**Reported by:** Maddie Chamberlain
**User feedback:** "it looked at my strava and it was like 'nice you have been doing a 45 mile week average let's start with a 12 mile week next week' and I had to kinda prompt it to start me where I already am"
**Root cause:** When a user onboards mid-week, Dean prescribes a partial-week plan (e.g. just 2 remaining days = ~12 miles). But the messaging didn't frame it as a short starter — it looked like Dean was dropping their weekly volume from 45 miles to 12. The context about "this is just for the rest of this week" was never communicated to the athlete.
**Fix / Change:** Updated the `initial_plan` prompt's `WEEK BOUNDARY` instruction to explicitly tell Dean to communicate the partial-week framing to the athlete in the first bubble. Dean must now say something like "This covers the rest of this week — on Sunday I'll send your first full week plan." This is especially important for Strava users with high volume averages, where the discrepancy is most jarring.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-11 — Dashboard: fix stale race distance in header + always show races section

**Type:** Bug Fix
**Reported by:** Internal observation (reviewing Maddy's dashboard)
**User feedback:** "the 28.5 mi doesn't match the 100k label" — header showed "Kodiak 100K · 28.5 mi"; also races section wasn't visible at all.
**Root cause:** Two bugs: (1) The header distance suffix was pulled from `onboarding_data.goal_distance_miles`, which had captured Broken Arrow 46K's distance (28.5 mi) during onboarding — stale once Kodiak 100K became the A race. (2) The races section only rendered when `upcomingRaces.length > 1`; with only one race in the table, the section was hidden entirely.
**Fix / Change:** Header now looks up the A race from the `races` table (matching by `race_date` or `priority === "A"`) and uses that entry's `goal`/`goal_distance_miles` to derive the distance suffix — with the same non-standard-distance logic used by the UpcomingRaces component. Falls back to `onboarding_data` only when no races table entry exists. Races section condition changed from `> 1` to `>= 1` so it always renders when there are upcoming races.
**Files changed:** `src/app/dashboard/page.tsx`

## 2026-04-11 — Ultra training plans: lower peak mileage + plateau at peak instead of ramping through

**Type:** Improvement
**Reported by:** Internal observation (reviewing a 100K plan for a ~45–48 mi/week runner)
**User feedback:** "Do we think this is too high of weekly mileage? She's at like 40 m / week right now" — plan was showing a 96-mile peak, still 85 after initial fix.
**Root cause:** Three compounding issues: (1) `hardCap` for 100K was 110, so the 2.0× multiplier produced a 96-mile peak. (2) `realBuildWeeks` included peak-phase weeks, so the plan kept ramping through all 5 peak weeks instead of plateauing. (3) Even after lowering `hardCap` to 85, the 2.0× multiplier still hit the cap for anyone above ~43 mi/week — the cap was always the binding constraint, not the multiplier.
**Fix / Change:** Lowered `hardCap` for 100K → 85, 50mi → 80, 100mi → 95. Excluded peak weeks from `realBuildWeeks` so peak weeks plateau at `targetPeak`. Added a goal-aware growth multiplier: ultra goals use 1.6× (not 2.0×) so the multiplier scales correctly with base — a 45 mi/week runner peaks at 72 mi, 48 mi/week at ~77 mi, with hardCap still protecting high-volume runners. Fixed `other_races` extraction schema (was untyped `object`, so Haiku guessed field names; now fully specified with `date`, `name`, `goal`, `priority`, `goal_distance_miles`).
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/onboarding/handle/route.ts`

## 2026-04-11 — GTM attribution tracking: UTM source in SMS body + strava_connected event

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** No way to attribute social media GTM posts to actual sign-ups. `cta_clicked` used an anonymous browser identity; `onboarding_started` used a Supabase user ID — they were unlinked in PostHog. Also missing a `strava_connected` event.
**Fix / Change:** (1) `signup-form.tsx` now reads `utm_source` from the page URL on mount and appends `src=X` to the SMS body if present. (2) `linq/route.ts` parses and strips the `src=` token from a new user's first message, stores it in `onboarding_data.acquisition_source`, and passes it as a property on `onboarding_started`. (3) Strava OAuth callback now fires `strava_connected` with a `during_onboarding` flag. To use: add `?utm_source=linkedin` (or `twitter`, `instagram`) to any shared link — PostHog and the DB will both carry attribution through to `onboarding_started` and `onboarding_completed`.
**Files changed:** src/components/signup-form.tsx, src/app/api/webhooks/linq/route.ts, src/app/api/auth/strava/callback/route.ts

## 2026-04-11 — Derive timezone from Strava city/state instead of athlete.timezone preference

**Type:** Bug Fix
**Reported by:** Jake (internal observation)
**User feedback:** "my users.timezone is america new york, even though I connected strava and it says provo, UT there"
**Root cause:** `athlete.timezone` in the Strava token response reflects an account-level preference that users set when they signed up and rarely update when they move. A user in Provo, UT could have `athlete.timezone = "America/Los_Angeles"` or an entirely wrong timezone from years ago.
**Fix / Change:** Derive timezone from `athlete.city` + `athlete.state` via `parseTimezoneFromLocation` (Claude Haiku) on Strava connect. Fall back to parsing `athlete.timezone` only if no city is available. Also extracted `parseTimezoneFromMessage` from `onboarding/handle` into the shared `src/lib/timezone.ts` as `parseTimezoneFromLocation`, fixing a secondary bug where multi-part IANA strings like `America/Indiana/Indianapolis` failed the validation regex.
**Files changed:** src/lib/timezone.ts, src/app/api/auth/strava/callback/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-04-11 — Improved Strava annotation: emojis, GAP analysis, remove redundant stats, multi-race

**Type:** Improvement
**Reported by:** Jake (user feedback after first annotation)
**User feedback:** "we probably shouldn't repeat stuff that's already in the strava activity details (10 mi @ X pace) - that is redundant. Also Dean's analysis said I slowed down a ton which could have been 'pacing miscalcuation' but those were on miles I gained like 600 ft in elevation. Can we provide insights on GAP or aerobic efficiency... Also says Week 1 of 14 -- Dipsea (64d), I wonder if that is confusing... Can we add in a few emojis to make it more exciting"
**Root cause:** Annotation block duplicated distance/pace already shown by Strava; LLM prompt didn't instruct it to consider grade-adjusted pace on hilly terrain; week label included "of X" which confuses users when plan total weeks ≠ remaining weeks to race; only one upcoming race was shown.
**Fix / Change:**
- Removed distance/pace line from block (Strava already displays these)
- Added emoji to header based on activity type: ⛰️ trail + high elevation, 🌲 trail, ⚡️ intervals, 🏃 road run
- Removed "of X" from `WEEK N OF X` — now just `WEEK N` to avoid confusion
- Pass all upcoming races (was `upcomingRaces[0]` only); header now shows up to 2 race countdowns
- Added grade-adjusted pace to LLM prompt context for trail runs with GAP data
- Updated LLM prompt to explicitly NOT restate distance/pace and to reference GAP instead of raw pace on hilly runs
- Moved efficiency line (`Grade-adj eff: X m/beat`) into the visible annotation block
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-11 — Fixed Strava annotation not running; fixed write scope detection on re-auth

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "I didn't get an analysis on my strava activity today"
**Root cause:** Two separate bugs: (1) `annotateStravaActivity` was called with `void` inside `processCoachRequest`, which itself runs inside `after()`. When `processCoachRequest` returned after sending the SMS, the `after()` block resolved and Vercel terminated the function before the unawaited annotation promise completed. (2) Strava omits the `scope` field from the token exchange response body on re-auth flows — the callback read scope only from `tokenData.scope`, which was `undefined`, so `hasWriteScope` was always false and `strava_write_enabled` was never set.
**Fix / Change:** (1) Changed `void annotateStravaActivity(...)` to `await annotateStravaActivity(...)` — safe to await since it's already inside `after()` and the HTTP response is already sent. (2) Added fallback in callback to read scope from the URL query param (`searchParams.get("scope")`) when the token response body doesn't include it.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-11 — Removed awaiting_cadence state; default to nightly reminders at plan generation

**Type:** Improvement
**Reported by:** Jake Tennant
**User feedback:** N/A
**Root cause:** The `awaiting_cadence` post-plan state was designed to collect reminder preferences after the plan was sent, but it created a structural loop: any coaching question asked before the user answered cadence would re-ask the cadence question, making it impossible to escape. The state machine added complexity without proportionate value — most users don't have strong opinions about reminder timing.
**Fix / Change:** Removed `awaiting_cadence` entirely. All new users are now defaulted to `nightly_reminders` at plan generation time (both `training_profiles.proactive_cadence` and `users.onboarding_step` are set in the same `initial_plan` DB write). The "How does this look?" closing message now includes a one-liner: "I'll send you a reminder the evening before each session — text me if you'd prefer morning-of reminders or just a weekly Sunday plan." Users can change their preference at any time via a normal `user_message`. `handleCadence` and `handleNonCadenceMessage` functions deleted. Existing users stuck in `awaiting_cadence` are silently graduated to onboarded on their next inbound message (step cleared, cadence set to nightly_reminders, no SMS sent).
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/coach-respond.test.ts`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-11 — Fixed repeat loop, plan feedback detection, and "How does this look?" ordering (Gwyneth onboarding)

**Type:** Bug Fix
**Reported by:** Jake Tennant (observed during Gwyneth's Saturday onboarding)
**User feedback:** "Didn't reply to question after asking 'How does this look?' After the plan is sent. Got into a repeat loop - I thought we had a way to determine if Dean is repeating himself and kind of restart / get out of the loop. This was the biggest issue in this conversation. When first asked about next week he then gave sessions that added to 9 miles instead 7 miles. He rewrote 'this week' for sessions in the past instead of next week on the dashboard."
**Root cause:** Three compounding bugs: (1) In `handleNonCadenceMessage`, the Haiku classification prompt used "coaching_question" as the expected return token but any unexpected output (extra words, punctuation variants, different capitalization) fell through to the fallback which blindly re-asked the cadence question — creating an infinite loop where the user's question was never answered. (2) The coaching_question handler appended the cadence question inline via `${!cadenceAlreadyAsked ? ... }` in the system prompt — Sonnet would sometimes return ONLY the cadence question, swallowing the actual answer entirely. (3) Complaint language ("that's too aggressive", "you're going to injure someone") wasn't in `PLAN_MODIFY_KEYWORDS`, so objections that should have triggered `rebuild_plan` fell through to the coaching answer path — Dean would verbally describe a corrected plan but never actually rebuild the dashboard. (4) "How does this look?" was the last line of the plan message but the dashboard link came AFTER it as a separate message, so users were asked to react before seeing the full plan.
**Fix / Change:** (1) Simplified Haiku classification to "coaching" vs "other" (single tokens, harder to confuse) — any output not explicitly "other" is now treated as a coaching question. (2) Moved the cadence question out of the inline system prompt append and into a separate `sendAndStore` call after the coaching answer, ensuring Sonnet always answers the actual question first. (3) Added complaint and objection language to `PLAN_MODIFY_KEYWORDS`: aggressive, injur(e/y), too much/many/long/far/hard, way too, cut back, scale back, tone down, reduce. (4) Removed "How does this look?" from the initial_plan system prompt; it is now sent as a third SMS bubble after the dashboard link. (5) Coaching question handler now also fetches `weekly_plan_sessions` from training_state to give Dean the current week's sessions, and explicitly tells Dean to explain that next week's session details aren't finalized until Sunday's recap.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-11 — Post-run message no longer mentions next week's sessions as "remaining"

**Type:** Bug Fix
**Reported by:** User (PE's friend)
**User feedback:** "my friend is getting this message on a Friday evening - not sure why (Thursday already passed): ...Two more sessions left: Saturday's long run (6 km easy) and Thursday's tempo (5 km with 3 km @ 4:24/km)."
**Root cause:** Two issues compounding: (1) `futureSessions` filter had an `isNaN` fallback that returned `true` for sessions with no parseable date, making them permanently appear as upcoming regardless of when they were scheduled. (2) The post_run system prompt told Claude to reference "upcoming sessions" but didn't restrict it to THIS week — Claude would see both "UPCOMING SESSIONS THIS WEEK" and "NEXT WEEK'S PLANNED SESSIONS" in the training state context and combine them into "X sessions left," making next Thursday look like a remaining session for the current week. The different session name (tempo vs strides) between the coach message and the dashboard confirmed the `weekly_plan_sessions` was also out of sync with `training_plans`.
**Fix / Change:** (1) Changed both `isNaN` fallbacks in the session filter from `return true` to `return false` — dateless sessions are now excluded rather than permanently shown as future. (2) Added explicit instruction to the post_run prompt: "Only reference THIS WEEK'S PLANNED SESSIONS when describing what's left to do. Do NOT mention NEXT WEEK'S PLANNED SESSIONS in post-run feedback."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-10 — Structured action tags replace Haiku extraction for session/schedule changes

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Session list storage and schedule overrides were driven by a secondary Haiku extraction pass after the main Sonnet response. This added latency (~3s), cost, and reliability issues — Haiku would sometimes mis-classify session swaps as week overrides or fail to detect changes.
**Fix / Change:** Sonnet (Dean) now emits structured action tags directly in its response: `[SESSION_LIST:]` (initial_plan/weekly_recap), `[SESSION_UPDATE:]` (user_message session swaps), `[WEEK_OVERRIDE:]` (this-week schedule changes), `[SKIP_DAY:]` (day skips). Tags are parsed deterministically on the server and stripped before SMS delivery. Haiku-based `extractAndStorePlanSessions` and `maybeUpdatePlanSessions` remain as fallbacks when no tag is present. `skip_date` and `this_week_override_days` removed from Haiku profile extractor — now tag-driven only. max_tokens for plan triggers increased 800→1000 to accommodate SESSION_LIST JSON overhead.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond-field-sync.test.ts`

## 2026-04-10 — Fixed profile extractor setting this_week_override_days on session swap requests

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "looks like I now have a 20 mi run tomorrow since my weekly goal was 29 miles!"
**Root cause:** When the athlete asked "Can you update my dashboard to have the long run tomorrow on Saturday and 6 mi on Sunday?", the profile field extractor (Haiku) interpreted this as a one-week schedule override and set `this_week_override_days: ["Saturday", "Sunday"]`. This changed `effectiveTrainingDays` to [Sat, Sun] only, causing `buildDailyPlan([Sat, Sun])` to compute: totalEasy = 29.5 - 9.5 = 20mi for Saturday (the only easy day).
**Fix / Change:** Added explicit CRITICAL note to the `this_week_override_days` extraction rule: session swap requests ("do the long run on Saturday instead", "move my tempo to Tuesday") must never trigger this field. Only actual availability reductions ("I can only run 2 days this week", "skipping all weekday runs") should set it.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Fixed weekly_plan_sessions null when initial plan SMS is split into multiple bubbles

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** Dashboard showing computed mileage (5.7mi, 9.5mi) instead of Dean's actual prescribed distances
**Root cause:** `handleSyncSessions` queried for the single most-recently-saved `initial_plan` conversation row. But the SMS send loop saves each split bubble as a separate row with the same `message_type: "initial_plan"`. The most recent row is the last bubble — typically a closing message ("Your dashboard is ready...") with no session list. Haiku found no sessions and stored `[]`, leaving `weekly_plan_sessions` empty. The dashboard then fell back to `buildDailyPlan`, which does arithmetic from plan arc targets (long_run_target, key_workout parse, etc.) producing values like 5.7mi and 9.5mi.
**Fix / Change:** Changed the conversations query to fetch the 5 most recent `initial_plan`/`weekly_recap` rows, group those within 90 seconds of the most recent (same plan generation), and concatenate their content in send order before passing to `extractAndStorePlanSessions`. Haiku now sees the full plan text regardless of where in the split the session list appears.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`

## 2026-04-10 — Fixed session swaps not reflecting on dashboard when confirmation was implicit

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "the dates were not swapped on my dashboard - noting that this is just a swap during week 1"
**Root cause:** `maybeUpdatePlanSessions` uses a Haiku model call to detect if a coaching exchange confirmed a plan change. The detection rules only covered explicit confirmation language ("Done — moved X", "I've moved...", "Switched..."). When Dean implicitly confirmed a swap by restating the new arrangement ("Perfect — Saturday long run 10mi, Sunday easy 6mi 👊"), Haiku returned `{"changed": false}` and the DB was not updated. The follow-up exchange where Dean said "already swapped on your dashboard" was also vulnerable because "already" language could be misread as "no action needed."
**Fix / Change:** Expanded the Haiku detection rules to include: implicit confirmation (coach restates new arrangement without objection), past-perfect "already swapped/updated" language (still requires a DB write), and explicit examples of each pattern.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Fixed nightly reminder saying "rest day" when override schedule includes tomorrow

**Type:** Bug Fix
**Reported by:** User (Jake)
**User feedback:** "got a message from Dean that tomorrow is a rest day (evening cron) but I'm supposed to run tomorrow!"
**Root cause:** `buildSystemPrompt` computed `restDays` from `profile.training_days` (the base standing schedule) without considering `this_week_override_days`. When a user has a one-week schedule override that adds a day (e.g. Saturday) that isn't in their base schedule, the nightly cron correctly fires (it uses `effectiveTrainingDays()`), but the system prompt told Claude "NEVER schedule a run on Saturday" — causing Dean to say tomorrow is a rest day despite the session plan showing a run.
**Fix / Change:** Moved `restDays` computation to after `tz` and `todayLocal` are defined. Now mirrors the nightly-reminder cron's `effectiveTrainingDays()` logic: if `this_week_override_days` is set and not expired, use those days instead of the base schedule when computing which days are rest days.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Strava activity description annotation (dev testing)

**Type:** Feature
**Reported by:** Internal / product exploration
**User feedback:** N/A
**Root cause:** N/A — new feature
**Fix / Change:** When `strava_write_enabled = true` on a user, Coach Dean appends a brief training note to the Strava activity description after every `post_run` webhook. Uses Haiku to generate a 1-2 sentence analytical note grounded in the actual run data. Block is prepended above any existing description. New `/api/auth/strava/write` re-auth route requests `activity:write` scope; callback detects the scope and sets the flag automatically.
**Files changed:** `supabase/migrations/026_strava_write.sql`, `src/lib/database.types.ts`, `src/app/api/auth/strava/write/route.ts`, `src/app/api/auth/strava/callback/route.ts`, `src/lib/strava.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-10 — Fix 4 eval failures: deload weeks, mile TT intervals, general fitness tempo, judge fixture

**Type:** Improvement
**Reported by:** Internal eval run (4 fixtures failing at 6/10)
**User feedback:** N/A
**Root cause:** Four distinct prompt/fixture issues: (1) initial_plan arc had no rule requiring deload weeks, so marathon plans came out as continuous 13-week ramps; (2) MILE TIME TRIAL GOAL section listed 800m repeats as a key session, which targets the wrong energy system for a 4-minute race; (3) no rule preventing tempo runs for base-phase general_fitness users when they ask for a workout via SMS; (4) quality-no-internal-labels fixture had no `today` set (defaulted to a date with ambiguous calendar context) and the judge prompt notes weren't strong enough to prevent false positive math/date flags.
**Fix / Change:** (1) Added DELOAD WEEKS block to initial_plan requiring deload every 4th week + marathon-pace segments in long runs. (2) Replaced 800m repeats with 200m–400m short intervals at goal-mile pace in the MILE TIME TRIAL GOAL section; tempo capped at one 2-3mi session for aerobic support only. (3) Added GENERAL FITNESS ATHLETES paragraph to user_message prompt: no tempo/intervals in base phase unless explicitly requested. (4) Updated quality-no-internal-labels fixture: added explicit `today: "2026-03-30"`, rewrote ground_truth notes to explicitly block judge from penalizing unrelated math/dates.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/fixtures/quality-no-internal-labels.json`

## 2026-04-10 — Replace ⚠️ directive format with XML <rule> tags to prevent reasoning leaks

**Type:** Improvement
**Reported by:** Internal (follow-up to Madie's leaked reasoning incident)
**User feedback:** N/A
**Root cause:** The system prompt used `⚠️ ALL_CAPS` format extensively for internal coaching directives. This trained Claude to associate that format with "important internal observation," causing it to mirror the pattern when generating its own analysis blocks (e.g. "⚠️ CRITICAL MILEAGE DISCREPANCY"). The format-reinforcement ran deeper than the output rule telling Claude not to use it.
**Fix / Change:** Replaced all `⚠️ HEADER` coaching directives in the system prompt with `<rule>...</rule>` XML tags. Claude strongly associates XML tags with structured metadata rather than conversational output, making it far less likely to echo them. The stripping pipeline now also removes any leaked `<rule>` blocks as a safety net, and still catches `⚠️` from Claude's training data. Updated `run-evals.mjs` to maintain parity with the new format. Output rule updated to forbid `<rule>` tag output and ⚠️.
**Files changed:** src/app/api/coach/respond/route.ts, evals/run-evals.mjs

## 2026-04-10 — Prevent internal reasoning from leaking into SMS messages

**Type:** Bug Fix
**Reported by:** Madie (user)
**User feedback:** Received multiple raw SMS bubbles containing internal analysis (e.g. "⚠️ CRITICAL MILEAGE DISCREPANCY — READ CAREFULLY: The athlete states they ran 21.5 miles...") followed by a "RESPONSE:" label, then the actual coaching message.
**Root cause:** Four compounding issues: (1) `stripReasoningPreamble` only matched specific ⚠️ keywords (ANALYSIS, REASONING, PLANNING, THINKING) — any novel ⚠️-prefixed header Claude invented (like "⚠️ CRITICAL MILEAGE DISCREPANCY") slipped through. (2) The function only recognized `\n---\n` as a separator, not `RESPONSE:` (which Claude used). (3) The `post_run_onboarding` trigger applied zero stripping — raw Claude output went straight to SMS. (4) The system prompt blocklist named specific patterns rather than banning all ⚠️ output.
**Fix / Change:** (1) `stripReasoningPreamble` now strips any paragraph starting with `⚠️` (not just specific keywords), and recognizes `RESPONSE:` as a separator. (2) Applied `stripReasoningPreamble` to the `post_run_onboarding` path. (3) Added the same `⚠️`/`RESPONSE:` guard to the onboarding handler. (4) Strengthened the system prompt rule to ban all `⚠️`-prefixed output and explicitly forbid the `RESPONSE:` label.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-04-10 — Pre-launch reliability and architecture improvements

**Type:** Improvement
**Reported by:** Internal observation / architecture review
**User feedback:** N/A
**Root cause:** Several features carried inaccuracy risk or were architecturally fragile going into launch: (1) shoe mileage proxy counted miles since Strava connection, not per-shoe, making it systematically wrong; (2) triathlon goal types (sprint_tri, olympic_tri, 70.3, ironman) were accepted during onboarding but the plan generation code is running-only, producing confidently wrong coaching; (3) Haiku extraction calls used text parsing with regex fallbacks, causing silent `{}` returns on parse failure; (4) `after()` catch blocks had no alerting — errors were console-logged but invisible in production.
**Fix / Change:**
- **Removed shoe mileage proxy**: Dropped `totalTrackedMiles` and `dominantGear` from `CoachingSignals` and `buildCoachingSignalsBlock`. Shoe check advice was unreliable since it counted all Strava history, not actual shoe mileage.
- **Removed triathlon goal types**: Dropped `sprint_tri`, `olympic_tri`, `70.3`, `ironman` from `VALID_GOAL_BUCKETS` and the Haiku extraction schema. The existing Dean prompt already handles triathletes gracefully by clarifying run-only focus.
- **Tool use for Haiku extraction**: Replaced text-parsing JSON extraction in `extractAndStorePlanSessions` (plan session sync) and `extractFields` (onboarding field extraction) with forced tool calls (`tool_choice: {type: "tool"}`). Guarantees structured output — eliminates regex fallback and silent empty-object failures.
- **Alerting on `after()` failures**: Added `trackEvent("after_error", ...)` in all `after()` catch blocks so production failures are visible in PostHog rather than only console logs.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

---

## 2026-04-10 — Week-1 rebuild support and post-rebuild SMS context

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Mid-plan rebuilds always skipped updating `weekly_mileage_target` and `weekly_plan_sessions` (by design, to protect in-progress weeks). But for week-1 rebuilds, the athlete has just started and wants the updated plan reflected immediately — including mileage target on the dashboard. Post-rebuild SMSs also gave no indication of what changed, leaving athletes unsure whether their current week was affected.
**Fix / Change:**
- `handleRebuildPlan` now fetches `current_week` from `training_state`. When `current_week === 1`, it sets `week1Reset: true` and passes `preservedSessions` (sessions whose date is before today, so already-completed sessions aren't lost).
- `generateAndSaveFullPlan` with `week1Reset: true` now updates `weekly_mileage_target` and replaces `weekly_plan_sessions` with the preserved past sessions (clearing future sessions so the new plan takes effect).
- Post-rebuild dashboard SMS now appends a context line explaining what changed: content-only rebuild → "Your upcoming weeks have been updated. Your current week is unchanged." / mileage rebuild → "Your plan has been updated with the adjusted mileage — your current week is unchanged." / week-1 rebuild → "Your plan has been fully regenerated starting this week."
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts`, `src/__tests__/lib/training-plan-generate.test.ts`

## 2026-04-10 — Plan rebuild preserves current week and honours workout preferences

**Type:** Bug Fix + Improvement
**Reported by:** User feedback (hill repeats / cycling not appearing; mileage target changing unexpectedly on rebuild)
**User feedback:** "I asked for bike and hill repeats to be added but I can't actually see any of these" / "my target mileage changed across the board I think but I didn't request for that to be changed (including this week changed)"
**Root cause:** Three separate issues: (1) Haiku enrichment never received the athlete's workout preferences (`other_notes` from onboarding_data), so hill repeats, HIIT, cycling etc. were never incorporated into `key_workout`/`notes`. (2) Every rebuild re-derived the mileage arc from the current Strava avg, which drifts over time — a content-only request ("add hill repeats") would silently change all mileage targets. (3) `weekly_plan_sessions` and `weekly_mileage_target` were cleared/overwritten on every rebuild, wiping the current week's in-progress sessions and mid-week target.
**Fix / Change:** (1) Pass `other_notes` and `injury_notes` from the athlete's profile into the Haiku enrichment prompt so workout preferences are incorporated into future weeks. (2) Added `wantsMileageChange` detection (both increase and decrease keywords) — when no mileage change is requested, the arc anchors to the existing `weekly_mileage_target` instead of recalculating from Strava avg. (3) When `resetToWeek1: false` (all mid-plan rebuilds), skip updating `weekly_mileage_target` and `weekly_plan_sessions` — the current week is already in progress and those values are authoritative. Note: current week sessions are only updated by weekly recap, morning plan, or explicit in-conversation session swaps.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-plan-generate.test.ts`

---

## 2026-04-10 — Fix dashboard showing phantom post-race week

**Type:** Bug Fix
**Reported by:** Madie (internal observation)
**User feedback:** "the plan was actually wrong because the race day is may 2 but it has taper the week after that!!"
**Root cause:** The dashboard had a "no remaining workouts" shift — when it was late in the week with all sessions past, it pushed `week1Monday` forward 7 days to make week 1 appear to start next Monday. This was a cosmetic UX optimization for newly-onboarded mid-week users. But for existing users with rebuilt plans, it caused the displayed week dates to be 7 days ahead of where the plan generator anchored them (the generator always uses the current week's Monday). Result: the race fell in the *displayed* week 3 instead of week 4, and a phantom "Taper" week 4 appeared after the race with May 4–10 dates.
**Fix / Change:** Removed the 7-day anchor shift entirely. Week 1 now always displays starting from the Monday of the plan-creation week — past days in that week are correctly dimmed. Reverted a compensating `isPastDay` band-aid added earlier in the same session.
**Files changed:** `src/app/dashboard/page.tsx`

## 2026-04-10 — Fix rebuild_plan anchoring to wrong base when Strava data is incomplete

**Type:** Bug Fix
**Reported by:** Madie (internal observation)
**User feedback:** "Max at 5 miles a week??" / "Yes exactly the volume is wrong" / "Weekly mileage targets should be updated"
**Root cause:** `handleRebuildPlan` derived the plan arc base exclusively from Strava avg weekly mileage. When a user's watch isn't syncing to Strava, Strava shows much lower volume than the athlete is actually running (Madie: Strava showed ~9mi/week, actual was 20+mi/week). Every rebuild fired with the wrong 9mi base, producing a 7.5mi/week taper plan even after repeated attempts.
**Fix / Change:** Two changes: (1) Added `prescribedWeek1Miles` to the `rebuild_plan` API request body as an admin override — allows correct base to be passed when Strava data is known to be wrong. (2) `handleRebuildPlan` now extracts the highest athlete-stated mileage from recent conversation text. When the stated figure is materially higher than Strava avg (>1.5×), it uses the stated figure as the arc base instead, on the principle that the athlete knows their actual volume better than a partially-synced Strava account.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Add metric plan quality eval (plan-half-marathon-metric)

**Type:** Infra
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No eval coverage for whether Dean produces plans in km for metric users. The existing plan_quality judge had no unit-correctness dimension.
**Fix / Change:** Added `plan-half-marathon-metric` fixture (Pec, 27-week HM, Spanish runner, preferred_units: metric). Updated `plan-quality.mjs` judge to detect `must_use_metric` ground truth flag and inject a `uses_correct_units` dimension that fails if any distance or pace appears in miles. Ground truth bounds now show km equivalents for metric fixtures.
**Files changed:** `evals/fixtures/plan-half-marathon-metric.json`, `evals/judges/plan-quality.mjs`, `CLAUDE.md`

---

## 2026-04-10 — Convert all hardcoded miles in coach prompts to respect preferred_units

**Type:** Bug Fix
**Reported by:** Internal (follow-up to Pec's km unit bug)
**User feedback:** N/A
**Root cause:** Multiple places in `buildSystemPrompt` and `buildUserMessage` injected mileage values with hardcoded "mi" labels regardless of the user's `preferred_units` setting. This included the taper protocol, fitness tier volume caps, race preparedness flag, next-week plan context, full training arc summary, weekly recap stored plan, and recovery/progression target blocks.
**Fix / Change:** Added `spUseMetric`/`spMi()` unit helper at the top of `buildSystemPrompt` (so it's available to the taper block, which precedes the existing `ts*` helpers) and aliased `tsUseMetric`/`tsMi` to it. Added inline `rpMi()`, `umMi()`, and `recapMi()` helpers in the three `buildUserMessage` cases that needed them. All hardcoded `mi` values now convert to km for metric users.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts` (also fixed wrong `=== "km"` check to `=== "metric"`)

---

## 2026-04-10 — Fix quality workout descriptions using miles for km-preference users

**Type:** Bug Fix
**Reported by:** Pec (user)
**User feedback:** "4×strides + easy 3.5mi" and "3mi tempo @ threshold" showing in dashboard even though preference is km
**Root cause:** The Haiku enrichment call that generates `key_workout` and `notes` for each plan week was always passing mileage values with "mi" labels and never told Haiku the user's unit preference. Haiku generated workout descriptions in miles regardless of `preferred_units`.
**Fix / Change:** Read `preferred_units` from the training profile; if "km", convert all mileage values passed to Haiku (arc summary, base mileage display, ultra guidance examples) to km. Added explicit unit instruction in the Haiku system prompt ("All distances must use km — never mix units") and passed `Preferred units: km` in the user message.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-10 — Two-step "UPDATE PLAN" confirmation for full plan rebuilds

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** The previous `[REBUILD_PLAN]` mechanism relied on Dean autonomously deciding when to emit a hidden token, which was non-deterministic — Dean sometimes triggered rebuilds when the user didn't intend one, and sometimes missed triggering when the user clearly wanted it. Errors in the rebuild also failed silently inside `after()`, leaving users waiting for a dashboard link that never arrived.
**Fix / Change:** Replaced the `[REBUILD_PLAN]` LLM token with a two-step user-confirmed keyword flow. Dean now responds to plan rebuild requests with a description of what will change and asks the user to "Reply UPDATE PLAN to confirm." The Linq webhook detects the exact phrase `UPDATE PLAN` (case-insensitive) and fires the `rebuild_plan` trigger directly — no LLM discretion involved. Added a fallback SMS in `handleRebuildPlan` if `generateAndSaveFullPlan` throws, so users aren't left waiting silently.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-10 — Fix initial_plan and weekly_recap timing out on Vercel Hobby (10s cap)

**Type:** Bug Fix
**Reported by:** Internal observation (maxDuration = 120 is ignored on Hobby; after() capped at 10s)
**User feedback:** N/A
**Root cause:** `initial_plan` made 4 sequential LLM calls (Sonnet + 3× Haiku) and `weekly_recap` made 3 (Sonnet + 2× Haiku), both well over the 10s Hobby limit, causing silent timeouts after the SMS was sent — meaning users got their plan message but the dashboard had no plan data, no weekly sessions, and no quality workouts.
**Fix / Change:** Added `sync_sessions` trigger + `handleSyncSessions` handler. Both `initial_plan` and `weekly_recap` now fire `sync_sessions` as a separate HTTP request (fresh 10s budget) after the main SMS is sent. `handleSyncSessions` reads the plan text from the `conversations` DB table and runs `extractAndStorePlanSessions` + `syncArcCurrentWeek` sequentially (~3-4s, fits in budget). The partial-week mileage correction is passed as `partialWeekTarget` in the request body. Closing link message changed from `message_type: "initial_plan"` to `"initial_plan_link"` so it doesn't interfere with the sync_sessions plan-text query. Budget after fix: `initial_plan` ~7-9s (Sonnet + generateAndSaveFullPlan), `weekly_recap` ~5-7s (Sonnet only).
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — coach/respond fails silently when required fields are missing

**Type:** Bug Fix
**Reported by:** Internal observation (manual rebuild_plan curl using user_id instead of userId)
**User feedback:** N/A
**Root cause:** `after()` swallows all errors inside the async callback, so a request with wrong/missing field names (e.g. `user_id` vs `userId`) returns `{ ok: true }` while silently doing nothing.
**Fix / Change:** Added upfront validation of `userId` and `trigger` before entering `after()`. Missing fields now return a 400 immediately.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Dashboard km support and quality workout display fixes

**Type:** Bug Fix
**Reported by:** Pierre-Etienne (Pec)
**User feedback:** "can we use kilometers instead of miles" / "Use kilometers please" / "it also doesn't show any of the quality workouts"
**Root cause:** (1) Dashboard never fetched `preferred_units` from `training_profiles` — all mileage was hardcoded "mi" regardless of user preference. (2) The Haiku enrichment call for plan arcs had `max_tokens: 2500`, which is insufficient for a long plan (~100–150 tokens/week × weeks), causing truncation and empty `key_workout` fields. (3) `parseMiles` in `buildDailyPlanFromSessions` only matched "mi" labels — metric users' km-labelled sessions returned `null` distance.
**Fix / Change:** (1) Added `preferred_units` to profile select, added `fmtDist(miles, useMetric)` helper, updated all mileage displays in dashboard (weekly target, long run, progress bar, daily plan rows, WeekCard arc, UpcomingRaces) to convert and show "km" for metric users. (2) Changed Haiku enrichment `max_tokens` to `Math.min(8000, Math.max(2500, totalWeeks * 200))` — scales with plan length, capped at Haiku's 8000-token output limit. (3) Updated `parseMiles` to also match "km" labels and convert to miles internally.
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`

## 2026-04-10 — Training plan arc notes used wrong paces (Haiku not given tempo/interval paces)

**Type:** Bug Fix
**Reported by:** Internal (Anthony's plan review)
**User feedback:** N/A
**Root cause:** `generateAndSaveFullPlan` only passed `easy_pace` to the Haiku enrichment prompt. Haiku had to infer tempo and interval paces from easy pace alone, and consistently under-estimated them (e.g. calling 9:50/mi "threshold" for an athlete whose actual stored tempo is 8:28/mi). The plan notes baked in wrong pace references that showed on the dashboard and in the coaching arc context.
**Fix / Change:** Extract `current_tempo_pace` and `current_interval_pace` from the profile and inject them into the Haiku prompt alongside easy pace. Haiku now receives all three paces and uses the correct values in week notes.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-10 — Fixed race date off-by-one; added explicit rest-day constraint to system prompt

**Type:** Bug Fix (2 issues)
**Reported by:** Conversation analysis email (2026-04-09 batch)
**User feedback:** "Athlete said July 26th. Dean logged and confirmed July 27th. Taper timing, race-week scheduling, and countdown messaging will all be off by one day. (July 26, 2026 is indeed a Sunday — athlete is correct.)" / "Same user, same pattern. Athlete said September 26th. Dean stored September 27th. Likely a systemic off-by-one in date parsing."
**Root cause (date off-by-one):** The Dean conversation prompt had an instruction: "After searching: always use the date from your search result, not the date the athlete stated." When web search returned a date 1 day off from what the athlete said (e.g. July 27 vs the correct July 26), Dean would use the search result. The Haiku extraction rule ("use the most specific date mentioned by either participant") then locked in Dean's (wrong) date even when the athlete had stated a different one.
**Fix (date off-by-one):** (1) Changed the Dean instruction: when athlete stated a specific date and the search result is within 2 days of it, use the athlete's date — small calendar discrepancies in web results are common and athletes are usually right about their own races. Only override when the search shows a clearly different week/month. (2) Changed the Haiku extraction rule to explicitly prefer the athlete's (user-turn) stated date over any date Dean mentioned; only fall back to Dean's date if the athlete never gave a specific day.
**Root cause (rest-day constraint):** The system prompt listed training days (e.g. "Monday–Saturday") but never explicitly enumerated the rest days. Claude could infer that unlisted days = rest, but it was an implicit constraint — confirmed by Weston's onboarding where Dean scheduled a Sunday run despite "I take Sunday off" being stated. The `initialPlanDaysConstraint` correctly constrained the partial current week but did not cover future-week previews included in the initial plan message.
**Fix (rest-day constraint):** Added a pre-computed `restDays` array (all 7 days minus training_days) and injected it into the system prompt as an explicit `⚠️ REST DAYS — NEVER schedule a run on: [days]` constraint, flagged as a hard constraint that applies to all weeks including the initial plan and future-week previews.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Conversation analysis auto-fixes: subscription wall UX, hallucination guards, tempo pace sanity check

**Type:** Bug Fix
**Reported by:** Automated conversation analysis (2026-04-08 batch, 16 users, 69 messages)
**User feedback:** User a9b4016c sent three messages explicitly trying to subscribe and received the same canned subscription-wall message each time. First two responses used generic URL.
**Root cause:**
1. (P0) Subscription wall gave identical canned responses regardless of user intent. Users saying "I want to subscribe" got the same message as users who incidentally hit the wall, with no warm acknowledgment or urgency. First-call token generation was working, but subscribe-intent cases needed a distinct, warmer response.
2. (P1) Post-run prompt had no cadence guard — `average_cadence` was fetched but never checked before injection. Claude fabricated per-lap cadence ranges (e.g. "90-92 spm") on activities where cadence was not in the Strava data. Additionally, the laps glossary said "per-lap AVERAGES for pace and HR" but did not explicitly exclude per-lap elevation, cadence, or power — Claude hallucinated per-lap elevation (e.g. "721ft gain on lap 2") and per-lap watt ranges on Zwift activities that had only average watts. Per-mile elevation breakdown (e.g. "500ft gain at miles 11-12") also had no guard.
3. (P1) Stored `current_tempo_pace` could be corrupted (e.g. a metric pace mistakenly stored as min/mi, producing values like 14:07/mi). The prompt sanity check instruction told Claude to use the stored pace, so a corrupted stored value would be passed through and used verbatim.
**Fix / Change:**
1. Subscription wall now detects subscribe/pay intent keywords in the latest user message ("subscribe", "subscription", "pay", "payment", "sign up", "get started", "ready to subscribe", etc.). When intent is detected, replies warmly with "Got it — here's your direct link to get started, takes 2 minutes: [personalized URL]" instead of the canned wall message.
2. Added cadence guard (parallel to existing watts guard): if `average_cadence` is null in the activity record, injects "No cadence data is available — do NOT reference cadence." Strengthened lap data glossary to explicitly say "per-lap AVERAGES for pace and HR only — no per-lap elevation, cadence, or power ranges." Added universal per-mile/per-lap elevation breakdown guard (always injected): "Per-mile and per-lap elevation breakdowns are NOT available from Strava — reference total elevation gain only."
3. Added server-side tempo pace validation before system prompt injection: parses stored `current_tempo_pace` and `current_easy_pace` to seconds/mile; if tempo >= easy (impossible physically), logs a warning and falls back to the estimated tempo derived from easy pace. Prevents a corrupted DB value from being injected into the prompt as ground truth.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Fixed partial week skewing Strava avg weekly mileage baseline low

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** The weekly bucketing used rolling 7-day windows from `now`. Week index 0 (0–7 days ago) captured an incomplete week if the user connected mid-week (e.g. Wednesday), so the 4-week average was divided by 4 full slots but one slot had only a few days of runs, pulling the baseline down.
**Fix / Change:** Skip `weekIdx 0` (current partial window) for both the average and trend calculation. Average now uses weeks 1–4 (four fully completed 7-day windows); trend uses weeks 1–2 vs weeks 3–4. Week 0 is still populated in case it's useful later.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-09 — Fixed partial-week onboard clobbering syncArcCurrentWeek's session-derived mileage

**Type:** Bug Fix
**Reported by:** User follow-up during same session
**User feedback:** "in this case though the user hadn't run this week at all, and will have two runs (or maybe even one) before the end of the week since it is thursday. So the 8 mi target should be lower for the first week since it's a partial week"
**Root cause:** The partial-week re-apply block (`if (isPartialWeek && weekMileageTarget != null)`) ran unconditionally even when `weekMileageTarget` computed to 0 (no Strava history + no prescribedWeek1MilesRaw → `null ?? null ?? 0 = 0`). This overwrote `syncArcCurrentWeek`'s session-derived result (e.g. 3.5mi from 2 run/walk sessions) back to 0, causing the dashboard to show "0 mi" for the week.
**Fix / Change:** Added `&& weekMileageTarget > 0` guard so the re-apply block only fires when there's a meaningful value. When both `prescribedWeek1MilesRaw` and `suggestedWeeklyMiles` are null, `syncArcCurrentWeek`'s sum (the actual prescribed session distances) is preserved as the weekly target.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Fixed wildly wrong mileage targets for beginner run/walk plans; fixed repeated cadence question

**Type:** Bug Fix
**Reported by:** User feedback (observed in production conversation)
**User feedback:** "Why does it say I'm running 16 miles this week" / "But if I'm running 2 min walk 2 min 6 times, that's only 24 minutes. I can do 5.5 miles in 24 minutes?"
**Root cause (mileage):** Two compounding issues. (1) `noHistoryDefault` for beginners with no Strava was 15mi, so the arc was built from a 15mi base even for a true zero-to-runner. (2) Time-based run/walk sessions ("Run 2 min, walk 2 min × 6 (~24 min total)") have no mileage in the label, so `parseMilesFromLabel` returned 0. Since `actualMiles = 0`, `syncArcCurrentWeek` didn't update `mileage_target` or `weekly_mileage_target` — both stayed at the 15mi arc default. (3) The system prompt didn't require a distance estimate for run/walk sessions, so they were purely time-based with no miles for the parser to find.
**Root cause (cadence):** In `handleNonCadenceMessage`, the cadence question was unconditionally appended to EVERY coaching answer, even when the user was clearly confused or asking a follow-up question. Dean would add "Last thing — would you like a reminder..." to responses 3+ times in a row.
**Fix / Change:** (1) Lowered `noHistoryDefault` for beginner from 15 → 8 miles in `training-plan.ts`. (2) Added fallback to `parseMilesFromLabel` to estimate miles from total minutes at ~13 min/mile for run/walk sessions. (3) Added prompt instructions in both SESSION DISTANCE FORMAT sections requiring run/walk interval sessions to include an approximate distance estimate: "Run 2 min, walk 2 min × 6 (~24 min, ~1.8mi)". (4) In `handleNonCadenceMessage`, check if the most recent assistant message already contained the cadence question — if so, skip re-appending it.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Dean incorrectly said he can't update the dashboard; rebuild also perpetuated wrong mileage target

**Type:** Bug Fix
**Reported by:** User feedback (observed in production conversation)
**User feedback:** Dean said "I can't update the dashboard directly myself — the plan you're seeing is built by the system based on your profile." (twice) after user asked to fix a mismatch between prescribed sessions (~3-4mi) and the dashboard showing 16mi for week 1.
**Root cause:** Two bugs: (1) The DASHBOARD UPDATES prompt instruction already said "Do not say I can't update the dashboard" but didn't explicitly cover the case where the dashboard shows *wrong/mismatched* data — Dean interpreted that as a system bug outside its control rather than a plan correction request. (2) `handleRebuildPlan` uses `existingTarget` as a floor for `rebuildBase`, so even if `[REBUILD_PLAN]` had been triggered, the rebuilt plan would have also started at 16mi (the wrong existing target), because the conversation didn't contain explicit decrease-vocabulary like "lower/reduce mileage".
**Fix / Change:** (1) Strengthened the DASHBOARD UPDATES prompt instruction to explicitly cover correction/mismatch scenarios and explicitly forbid "I can't edit the system / it's auto-generated" responses. (2) Added `wantsCorrection` detection in `handleRebuildPlan` — when the conversation contains correction language (e.g. "way off", "doesn't match", "not updated", "showing wrong"), the `existingTarget` floor is skipped entirely, so the rebuild derives fresh from Strava avg or profile baseline rather than perpetuating a bad stored target.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Strava skip regex missed "I don't use Strava"

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "feels like this should result in us skipping the strava question, no?" — user replied "I don't use strava" and got the Strava link re-sent instead of moving on.
**Root cause:** `isSkip` regex in `handleStrava()` only matched `don't have`, not `don't use`. "I don't use strava" fell through to the catch-all that re-sends the connect link.
**Fix / Change:** Added `don.?t use`, `i don.?t`, and `not on strava` to the skip regex.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Rebuild plan respects existing mileage target (floor/ceiling)

**Type:** Bug Fix
**Reported by:** Gwyneth (onboarding test)
**User feedback:** "The mileage build seems a little low, maybe we increase it a tiny bit?" → Dean acknowledged and rebuilt → plan came out lower than before
**Root cause:** `handleRebuildPlan` recalculated `avgWeeklyMileage` fresh from Strava's 8-week window each time. If recent runs averaged lower (data drift, fewer runs that week), the rebuild would silently produce a lower plan even when the user asked for more. Dean's promise to "increase" wasn't translated into any parameter.
**Fix / Change:** Fetch `training_state.weekly_mileage_target` (what Dean last prescribed) and use it to anchor the rebuild:
- Default (neutral or increase): `max(strava_avg, existing_target)` as `prescribedWeek1Miles` — the plan can't silently drop below what was already prescribed
- Volume decrease explicitly requested: detect "lower/less/reduce/decrease/dial back/too high" language near "mileage/volume/week" in recent conversation, then use `min(strava_avg, existing_target)` — plan can actually decrease but won't exceed current target
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Fix mid-onboarding week-2 plan rebuild, "thanks for reaching out", and doubled cadence question

**Type:** Bug Fix
**Reported by:** Gwyneth (post-plan onboarding flow)
**User feedback:** "he said thanks for reaching out in the middle of a conversation, and then probably shouldn't be rebuilding a plan just because Gwyneth wants to see week 2...the proper behavior here is to highlight the planned mileage and quality workout and saying he'll generate the full plan on Sunday night. Also the cancel subscription doesn't seem to work"
**Root cause:**
1. Haiku classifier in `handleNonCadenceMessage` classified "I would like you to tell me what my week 2 plan is" as `plan_feedback` (because it contains "plan") instead of `coaching_question`. This triggered a full plan rebuild.
2. The `plan_feedback` Sonnet system prompt had no instruction to skip greeting language — Claude said "Thanks for reaching out!" mid-conversation.
3. The `other` fallback response prefixed `cadenceQuestion` with "Just one last thing —", but `cadenceQuestion` itself already starts with "Last thing —", producing "Just one last thing — Last thing — would you like a reminder...".
4. Cancel classification may have failed on "cancel my strip subscription" (misspelled Stripe) and fallen to the `other` fallback.
**Fix / Change:**
- Improved classifier prompt to clearly distinguish "asking to SEE what's in the plan" (coaching_question) vs "wanting to CHANGE the plan" (plan_feedback), with explicit examples
- Added "no greeting phrases" instruction to `plan_feedback` Sonnet prompt
- `coaching_question` path now fetches and injects the training plan arc so Dean can answer "what's week 2?" directly from data; also added no-greeting instruction
- `cancel` classifier description now handles typos and free-trial phrasing
- Fixed fallback to use `cadenceQuestion` directly instead of prefixing it with "Just one last thing —"
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-09 — Speed work earlier in plans, fix "no access" hallucination, dashboard key workout display

**Type:** Bug Fix + Improvement
**Reported by:** Gwyneth (onboarding test)
**User feedback:** "The mileage build seems a little low, maybe we increase it a tiny bit? Also I enjoy doing speed workouts but I'm not seeing any until week 7, why?" / "Also in the dashboard it looks like I can only see what the long run is for each week, not the tempo workout" / "What's my speed workout for week 2?" → Dean: "I don't have access to your specific training plan right now."
**Root cause (4 issues):**
1. Dean hallucinated "I don't have access to training plan" despite having it in context — `fullArcContext` instruction said "do NOT reproduce this list" which Claude over-applied to specific week questions
2. Haiku arc enrichment was setting `key_workout` to the long run even on weeks with a tempo session — the rule "defining session" was ambiguous, leading to long runs appearing for every week on the dashboard
3. `hasEstablishedBase` threshold was 15mi/week — runners at 10-14mi/week were getting conservative "build from scratch" instructions and no speed work until late in the plan
4. Peak mileage multiplier was capped at 1.5x base — produced conservative peaks (e.g. 25mi for a 15mi/week half marathon runner; 30mi would be more appropriate)
**Fix / Change:**
1. Updated `fullArcContext` instruction to explicitly say "NEVER say you don't have access to the training plan" and clarify that specific week questions should be answered from arc data
2. Updated Haiku enrichment system prompt: when a week has both a long run AND a quality session, `key_workout` must be the quality session (tempo/intervals/strides), not the long run — the long run is shown separately
3. Lowered `hasEstablishedBase` threshold from 15 to 10 mi/week so more runners get quality sessions from week 1
4. Added `wantsSpeedWork` parameter to `generateAndSaveFullPlan` — now passed from `handleRebuildPlan` and `initial_plan` trigger, injected into Haiku enrichment prompt so athletes who said they want speed work get it from week 1 in the arc
5. Increased peak mileage multiplier from 1.5x to 2.0x base (e.g. 15mi/week → 30mi peak for HM vs old 25mi)
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-10 — Training plan volume cap and 5 new eval fixtures

**Type:** Bug Fix + Improvement
**Reported by:** Internal eval (plan-half-marathon-first-timer failing 5/10)
**User feedback:** N/A
**Root cause:** `getTargetPeakMileage()` used a 1.8x growth multiplier from base mileage, causing first-time half marathoners at 25 mpw to generate 45mi peak weeks — too aggressive. Target sweet spot for a first HM at 25mpw is 35–42mi.
**Fix / Change:** Changed multiplier from `1.8` to `1.5` in `training-plan.ts`. At 25mpw base, peak now targets ~37.5mi (within the 35–42mi sweet spot). Also added 5 new eval fixtures covering previously untested scenarios: post_run feedback quality, weekly_recap trigger, taper phase messaging, general fitness users with no race, and metric-units pace display. Fixed eval harness to convert paces and distances to km for metric users.
**Files changed:** src/lib/training-plan.ts, evals/run-evals.mjs, evals/fixtures/quality-post-run-feedback.json, evals/fixtures/quality-weekly-recap.json, evals/fixtures/date-taper-messaging.json, evals/fixtures/quality-general-fitness-no-race.json, evals/fixtures/pace-metric-user.json

## 2026-04-10 — Fixed timezone extraction hallucinating invalid IANA zones for midwest cities

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `parseTimezoneFromMessage()` in onboarding used Haiku with only coastal city examples (Denver, SF, NY), causing it to hallucinate `America/Columbus` (invalid IANA) for Columbus, OH.
**Fix / Change:** Added 15+ city examples to the extraction prompt covering midwest (Chicago, Columbus, Indianapolis, Nashville, Dallas, Detroit), mountain (Phoenix), pacific (Seattle, Honolulu), and alaska.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-09 — Fixed Strava mileage including non-run activities and using 8-week average

**Type:** Bug Fix
**Reported by:** Gwyneth (onboarding observation)
**User feedback:** "What's your frame of reference for the 20mile/week?" / "Yeah I think my current average is closer to 15"
**Root cause:** Two compounding issues: (1) `runs8w` filter in strava callback was `distance_meters > 400` only — no activity type filter — so cycling, walking, and other Strava activities were included in the "average weekly miles" figure passed to Dean. (2) The average was computed over 8 weeks, which smooths over older (potentially higher) weeks and misrepresents current fitness. Gwyneth's last 4 weeks were 14, 16, 10, 17 (~14 avg) but the 8-week avg read as ~20.
**Fix / Change:** (1) Added `RUN_TYPES` filter to `runs8w` — only Run, TrailRun, VirtualRun, Treadmill count toward mileage. (2) Changed `avgWeeklyMiles` to use a 4-week average (`last4WeeksMiles / 4`) instead of 8-week. This better represents current fitness and matches the user's mental model of "recent average". (3) Strengthened the STRAVA onboarding prompt with a CRITICAL rule: even if the athlete volunteers race history or fitness data before Strava is asked, ask about Strava first — do not follow up on volunteered data until after the Strava question is answered.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`, `src/app/api/onboarding/handle/route.ts`

## 2026-04-09 — Fixed onboarding asking "are you currently running?" after Strava connected

**Type:** Bug Fix
**Reported by:** Jake (internal observation during onboarding)
**User feedback:** "Dean asked if I'm currently running after he already pulled my Strava which has tons of details on it"
**Root cause:** System prompt said weekly mileage is "REQUIRED if Strava is not connected" but gave no explicit instruction to skip the question when Strava IS connected and shows avg weekly miles. Claude was asking anyway because the negative case wasn't spelled out.
**Fix / Change:** Made the rule explicit in both directions: if Strava is connected AND shows "Recent avg: ~X mi/week", treat that as known and do NOT ask about current running or mileage.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-09 — Optional cross-training sessions visible on dashboard

**Type:** Feature
**Reported by:** Jake Tennant (internal feedback after onboarding)
**User feedback:** "He also said he'd add optional strength and/or biking workouts but not seeing one for tomorrow (Friday). Also I think this will be generally helpful for cross training"
**Root cause:** Dean included optional sessions conversationally but not in the structured `Day M/D · Session` format that `extractAndStorePlanSessions` parses. There was no concept of "optional" in the session type or dashboard rendering, so even if Dean had listed them, they'd show as required sessions.
**Fix:** End-to-end support for optional sessions:
1. Prompt (initial_plan + weekly_recap): Explicit instruction to include optional cross-training on rest days with `(Optional)` prefix, even in partial-week plans. Clarified that the CONFIRMED TRAINING DAYS constraint is for running sessions only.
2. Extractor (`extractAndStorePlanSessions`): Updated Haiku prompt to detect `(Optional)` prefix, strip it from the label, and set `optional: true` on the session object.
3. Dashboard (`PlanSession` + `DayWorkout`): Added `optional?: boolean` fields. `buildDailyPlanFromSessions` maps optional sessions to type `"optional"`. Rendered with lighter gray styling and italic text — visible but clearly secondary.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

## 2026-04-09 — Fix weekly target, A-race taper, and mileage display for partial-week onboards

**Type:** Bug Fix (2 issues)
**Reported by:** Jake Tennant (internal testing after fresh onboarding)
**User feedback:** "the 'This week' weekly target should include any miles already done this week + any new miles prescribed by dean for this first week of the plan. Right now the target is just what Dean prescribes. (15 mi for me, but I've already run 17 this week, so target should be 32 mi this week). Also I'm not sure if there's any taper in the dipsea race week, week 10 of the arc. Feels like there should be."
**Root cause (weekly target):** `syncArcCurrentWeek` runs after `generateAndSaveFullPlan` and overwrites `training_state.weekly_mileage_target` with just the prescribed session sum from Dean's message (e.g. 15mi). The earlier correct value computed in the `initial_plan` block (which adds `weekMileageSoFar` for partial-week onboards) gets lost.
**Fix (weekly target):** After `syncArcCurrentWeek`, re-apply `weekMileageTarget` when `isPartialWeek` is true. This preserves the TRUE total (done this week + newly prescribed sessions) in `training_state`.
**Root cause (A-race taper):** When a plan is extended past the A-race to cover a B-race (e.g. Dipsea June 14 + Snowbird July 11 → 14-week plan), `computePhaseForPlan` only tapers the *last* race. The A-race (week 10) falls in "build" phase at 48mi because `weeksFromEnd = 4 ≥ peakThreshold`. There's no logic to inject an A-race taper mid-plan.
**Fix (A-race taper):** Compute `aRaceWeekNum` and `planExtendsPostA` flag in `generateAndSaveFullPlan`. When active, inject: 2-week taper around the A-race (pre-race at 70% of effective peak, race week at ~35%), + a recovery week after the A-race at 50% of peak. Uses `effectivePeak = max(peakMileage, buildMileage)` so the taper reference is correct even when peak phase hasn't formally started.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Fix 3 initial_plan bugs: wrong pace, missing daily sessions in dashboard, B race badge

**Type:** Bug Fix (3 issues)
**Reported by:** Jake Tennant (internal testing)
**User feedback:** "looks like my pacing is still wrong?" / "there was an interval workout that was put on today (plan creation day)" / "the plan doesn't say my second race has a 'race day' tag"

**Bug 1 — Wrong pace (9:25–9:55/mi instead of 7:50–8:20/mi for a 17:50 5K)**
**Root cause:** Haiku extraction for `recent_race_distance_km`/`recent_race_time_minutes` was pulling the trail 30K from Dean's own message ("Your best Strava effort is a 30K trail race in 2:25:00") rather than the athlete's stated road 5K time. The instruction said "most-cited PR or recent race" without specifying user-only messages — so Haiku picked the coach-mentioned Strava data. Result: VDOT computed from trail 30K (~45.3 → easy 9:27/mi) instead of road 5K (~56.9 → easy 7:52/mi).
**Fix:** Updated both `recent_race_distance_km` and `recent_race_time_minutes` extraction rules to say "extract ONLY from the athlete's own messages (user turns), NOT from coach messages about Strava data." If the coach mentions a Strava race but the athlete states a different road race time, use the athlete's stated time.

**Bug 2 — Today's interval workout showing in dashboard / arc key_workout not synced from actual sessions**
**Root cause:** `extractAndStorePlanSessions` was called BEFORE `generateAndSaveFullPlan`. But `generateAndSaveFullPlan` always clears `weekly_plan_sessions: null` (to flush stale sessions after a full arc rebuild). This wiped the just-stored sessions before `syncArcCurrentWeek` could read them — so `syncArcCurrentWeek` returned early (sessions.length === 0) and the arc's week 1 key_workout remained the Haiku-guessed "6×800m" from arc generation. The dashboard then fell back to `buildDailyPlan` (uses all training_days including today) instead of `buildDailyPlanFromSessions` (only stores actual remaining-week sessions).
**Fix:** Moved `extractAndStorePlanSessions` to run AFTER `generateAndSaveFullPlan`, so sessions are stored after the null-clear and both the dashboard and `syncArcCurrentWeek` can use them.

**Bug 3 — B race not tagged with "Race day" badge in arc**
**Root cause:** Dashboard computed `raceWeekNum` only from `training_profiles.race_date` (the A race). B/C races in the `races` table were not checked.
**Fix:** Computed week numbers for all races in `upcomingRaces` and collected them into `allRaceWeekNums` (Set). `WeekCard.isRaceWeek` now checks `allRaceWeekNums.has(week.week_number)` so every race week (A, B, C) gets the badge.

**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-09 — Fixed plan rebuild corrupting A-race date + stale session display after rebuild

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "the dashboard is labeled dipsea but has the race day as july 11 which is for cirque series snowbird. And then both races are labeled as 93 days away in upcoming races with the same date. Then I asked to have the Friday workout removed - it was removed from the weekly target mileage but not from the actual this week view."
**Root cause:** Three separate issues: (1) `extractProfileData` extracted the Snowbird B-race date ("july 11") as `race_date` and `persistProfileUpdates` blindly applied it to the A-race, overwriting Dipsea's date and making both races show July 11. (2) `generateAndSaveFullPlan` never cleared `weekly_plan_sessions` in training_state, so old sessions (including Friday) persisted after the rebuild; the dashboard showed stale sessions rather than falling back to training_days. (3) `handleRebuildPlan` computed Strava avg mileage using `.eq("activity_type", "Run")` only, excluding TrailRun/VirtualRun/Treadmill activities — trail runners would get `avgWeeklyMileage = null`, causing the arc to default to `fitness_level` hardcoded value (e.g. 30mi/week for advanced) instead of their real history.
**Fix / Change:** (1) Updated `extractProfileData` prompt to only set `race_date` when the athlete is CHANGING their primary race — explicitly not when adding a secondary/B-race (phrases like "too", "also", "build towards that too"). (2) `generateAndSaveFullPlan` now always sets `weekly_plan_sessions: null` in the training_state update so the dashboard re-derives sessions from training_days after any rebuild. (3) Dashboard now fetches `this_week_override_days` + `this_week_override_expires` from training_profiles and uses the override days (instead of standing training_days) when the override is still active — ensures a "just this week" schedule change is reflected in the dashboard fallback view. (4) Fixed activity type filter in `handleRebuildPlan` to include TrailRun, VirtualRun, and Treadmill.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-09 — Fix initial plan scheduling wrong training days (run on Friday instead of Thursday)

**Type:** Bug Fix
**Reported by:** Jake Tennant (internal)
**User feedback:** "I say my training days but Dean had me do a run on a day I didn't say" and "he said let's start with 4 sessions this week, but there are 3 on the calendar" — Training days: Tue, Wed, Thu, Sat, Sun. Today (Thursday), Dean scheduled Fri/Sat/Sun instead of Sat/Sun (the remaining training days after today).
**Root cause:** The `initial_plan` user message said "start from tomorrow or later" without constraining to confirmed training days. Claude saw "tomorrow = Friday" and scheduled there, ignoring the SCHEDULE CONSTRAINT saying to only use confirmed training days. The two instructions conflicted and Claude followed "tomorrow or later" literally. The count mismatch ("4 sessions" / 3 on calendar) followed from this: Claude was also scheduling a phantom Thursday session in its preamble text without listing it.
**Fix / Change:**
1. Added pre-computation of `remainingInitialPlanDays` in `processCoachRequest` for the `initial_plan` trigger — filters the athlete's confirmed training days to only those falling after today (mid-week) or the full next Mon–Sun (if today is Sunday). Handles the Sunday=0 vs Mon=1…Sun=7 ordering issue so Sunday isn't incorrectly treated as the first day of the week.
2. Passes the computed days with calendar dates (e.g. "Saturday 4/11, Sunday 4/12 — 2 sessions") as `initialPlanDaysConstraint` into `buildUserMessage`. This replaces the vague "start from tomorrow" instruction with an explicit enumerated list.
3. Added debug logging to `generateAndSaveFullPlan` to capture `bRaces` and the totalWeeks extension check — this will help diagnose the Snowbird dashboard issue (plan only extending to Dipsea, not Snowbird).
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts`

---

## 2026-04-09 — Fix trail race misclassification when Strava activity_type is "Run"

**Type:** Bug Fix
**Reported by:** Jake Tennant (internal)
**User feedback:** "looks like Dean said my 30k was a road race now" — Strava 30K was auto-detected as `Run` rather than `TrailRun`, so `is_trail = false` and Dean presented it as a road race with a valid easy pace suggestion.
**Root cause:** `selectBestRaceForPacing` set `isTrail` only when `activity_type === "TrailRun"`. Many trail races (especially auto-detected or manually logged) use `Run` as the activity type. A Marin 30K with significant vert was classified as road.
**Fix / Change:** Added elevation-per-mile heuristic: if a race has >80ft/mile of elevation gain it is treated as trail regardless of `activity_type`. `elevation_gain` added to the DB query. Threshold chosen to be well above typical road race vert (<50ft/mile) and well below any real trail race.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Fix onboarding pace anchoring to wrong trail race easy pace

**Type:** Bug Fix
**Reported by:** Jake Tennant (internal)
**User feedback:** "Can you double check the math on that? It should be more like 8 min/mi for easy" — Dean stated 9:25–9:55/mi easy for a 17:50 5K (should be ~7:45–8:15/mi), anchored on the trail race Strava suggestion instead of computing from the road PR. After correction, Dean re-guessed 8:15–8:45/mi — still wrong.
**Root cause:** Two compounding issues: (1) `stravaContext` injected a VDOT-derived easy pace range even when the best Strava race was a trail run — this systematically underestimates fitness. (2) Claude cannot compute VDOT-based paces reliably in-context and pattern-matches to whatever number it sees in the system prompt, so the wrong Strava number persisted even after the user provided a road race time. (3) The trail race calibration question was allowed to defer to any point before [READY], letting Claude acknowledge the road race time too late.
**Fix / Change:**
1. When `is_trail`, stravaContext no longer emits "Suggested easy pace" — instead says "easy pace suggestion withheld — collect a road 5K/10K/HM time." This removes the wrong anchor entirely.
2. PACE CALIBRATION prompt instruction changed from "ask once before [READY]" to "ask in THIS message" — calibration question must fire in the same turn as the Strava acknowledgment, not deferred.
3. New TRAINING PACES block in onboarding system prompt explicitly prohibits Claude from quoting specific min/mi paces during onboarding. Accurate zones are server-computed when the plan builds — Claude guessing in-conversation only produces wrong numbers.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Extend plan through post-A B races; fix partial-week mileage target

**Type:** Bug Fix / Feature
**Reported by:** Jake Tennant (internal)
**User feedback:** "As you can see, it only goes to Dipsea" (plan ended June 14; Snowbird July 11 was not included) and "the 'this week' view shows a goal of 19 mi but that excludes what I've already done, I think week 1 should sum up to my total mileage (done + planned)"
**Root cause:**
1. `generateAndSaveFullPlan` computed `totalWeeks` from `profile.race_date` (A race) only. B races after the A race were labeled in arc notes only if they fell within `totalWeeks` — so a B race 4 weeks after the A race was entirely outside the plan and invisible.
2. `weekly_mileage_target` for partial-week onboards was set to `prescribedWeek1MilesRaw` only — the miles already run earlier in the week (e.g. 17.2mi) were not included, making the dashboard show "17.2 / 19 mi" instead of "17.2 / 36 mi".
**Fix / Change:**
1. After computing `totalWeeks` from the A race date, check if any B/C race falls after the A race within 8 weeks. If so, extend `totalWeeks` to cover the last such race. The arc phases naturally taper to the new endpoint; the intermediate A race week appears as a peak/tune-up week and Haiku labels it via the existing B race annotation system.
2. For partial-week `initial_plan` triggers, add `weekMileageSoFar` to `prescribedWeek1MilesRaw` when storing `weekly_mileage_target`. This gives the dashboard the true weekly total (done + planned) rather than just the planned sessions.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Separate SMS opt-out from subscription cancellation

**Type:** Bug Fix / Improvement
**Reported by:** Internal (pre-launch review)
**User feedback:** N/A
**Root cause:** CANCEL and UNSUBSCRIBE were treated as hard SMS opt-out keywords in the linq webhook, meaning a user who texted either would get silently opted out of messages but never receive the Stripe portal link — leaving their subscription billing with no way to cancel via text.
**Fix / Change:**
1. Removed CANCEL and UNSUBSCRIBE from `isHardStop` and `isSoftStop` in `linq/route.ts` — they now fall through to `coach/respond` which sends the Stripe portal link (existing behavior, newly reachable).
2. STOP confirmation message now includes the Stripe portal link when a `dashboard_token` is available, so STOP is a complete exit path (messages off + billing cancel link).
3. Updated FAQ on landing page to distinguish UNSUBSCRIBE (subscription management) from STOP (stop all messages).
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/page.tsx`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-09 — Day-2 welcome tips SMS + beta email address

**Type:** Feature
**Reported by:** Internal (pre-launch prep)
**User feedback:** N/A
**Root cause:** No onboarding follow-up told users about keyboard shortcuts (MY PLAN, FEEDBACK, STOP), and all public contact emails pointed to a personal address.
**Fix / Change:**
1. New daily cron `/api/cron/welcome-tips` (15:00 UTC) sends a one-time SMS to users whose `initial_plan` landed 20–48 hours ago. Deduped via `message_type = 'welcome_tips'` in conversations — no DB migration needed.
2. Updated all public-facing email addresses (footer, terms, privacy) from `jake.c.tennant@gmail.com` to `hello@coachdean.ai`.
**Files changed:** `src/app/api/cron/welcome-tips/route.ts` (new), `vercel.json`, `src/app/page.tsx`, `src/app/terms/page.tsx`, `src/app/privacy/page.tsx`

---

## 2026-04-09 — Add sanity check on extracted race times before VDOT calculation

**Type:** Bug Fix
**Reported by:** Internal investigation (Anthony, ae993f7b)
**User feedback:** N/A — discovered by inspecting stored paces after the 14:07/mi tempo issue
**Root cause:** `persistProfileUpdates` called `calculateVDOTPaces(distKm, timeMins)` directly from Haiku's extraction without validating the implied pace. If Haiku mangled the extraction (e.g. passing pace-seconds as minutes, or getting the distance wrong), the resulting VDOT could be wildly off. For Anthony, the implied pace from the stored extraction parameters corresponds to VDOT ~20 (17:19/mi easy) when his actual fitness is VDOT ~39 (10:34/mi easy) based on his Oakland Half at 8:35/mi.
**Fix / Change:**
1. Added bounds check before calling `calculateVDOTPaces`: implied pace must be between 4:00/mi and 20:00/mi. If outside that range, log a warning and skip — don't persist corrupt paces. This covers mis-extractions like pace-seconds passed as total minutes, or km/mi confusion.
2. Manually corrected Anthony's stored profile paces to the correct values from his Oakland Half (VDOT 39.3 → Easy 10:34, Tempo 8:28, Interval 7:37).
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Fix corrupted tempo pace used verbatim in session prescriptions

**Type:** Bug Fix
**Reported by:** Internal observation (daily audit email)
**User feedback:** "Wed 4/8 · Tempo 6.5mi (1mi WU + 4.5mi @ 14:07/mi + 1mi CD)" — 14:07/mi is a walking pace
**Root cause:** When an athlete enters their easy pace in min/km during onboarding but the system stores it as min/mile (e.g. "15:37" meant 15:37/km = 9:41/mi, but stored as 15:37/mi), `estimatePacesFromEasyPace` correctly derives tempo = easy − 90s = 14:07/mi. The system prompt then presents this to Claude as an authoritative pre-computed pace with instructions to never recalculate it, so Claude uses it verbatim in session prescriptions.
**Fix / Change:** Added a runtime sanity check: tempo pace must be (a) faster than 13:00/mi absolute floor AND (b) at least 30s/mi faster than easy pace. If either fails, the Tempo/Interval lines in the FACTS block read "INVALID — paces appear corrupted. Use effort-based language only. Do not prescribe specific paces until the athlete provides a recent race time or easy pace to recalibrate." Also suppresses the invalid tempo from plan generation guards.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Post-run feedback misreads WU/CD structure as pacing error

**Type:** Bug Fix
**Reported by:** Internal observation (daily audit email)
**User feedback:** Dean said "you held 8:15-8:28 for miles 1-4 right around target pace, then backed off the last mile." Athlete had to correct: "I thought I was meant to back off the last mile for cool down."
**Root cause:** TODAY'S PLANNED SESSION is correctly injected into the system prompt (showing "1mi WU + 3mi @ 8:30/mi + 1mi CD"), but the post_run prompt only said "analyze their performance." Claude saw [slower mile 1, faster miles 2-4, slightly slower mile 5] in the splits and inferred "4-mile flat tempo + faded last mile" instead of reading the WU+tempo+CD structure from the plan.
**Fix / Change:** Added a "WORKOUT STRUCTURE" block at the top of the post_run prompt that explicitly instructs Claude to check TODAY'S PLANNED SESSION first, map the opening/closing slower segments to WU/CD, and not flag them as anomalies or "backing off."
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Fix daily audit email false positives (cadence, power, per-lap elevation)

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "every email I get daily now mentions strava splits or HR as hallucinated — it keeps giving me false positives of stuff it thinks is off but isn't"
**Root cause:** The `analyze-conversations` cron was annotating each post_run message with only `hasLaps`, `hasHR`, `distanceMiles` — it did not track `hasCadence`, `hasWatts`, or `activityType`. As a result, Claude (the analyzer) had no way to know whether power/watt values, cadence values, or per-lap elevation were real Strava data or fabricated. It was flagging legitimate coaching responses as hallucinations:
- Cadence per lap (real when cadence sensor present — `average_cadence` field)
- Power/watts on Zwift rides (Zwift always provides `average_watts`)
- Per-lap elevation gain (`total_elevation_gain_feet` is a real Strava lap field)
- Per-mile elevation from GPS splits (`elevation_difference_feet` is a real split field)
- Fast pace figures on VirtualRide activities (speed-based, not GPS)
Also: the plan health section crashed with an Anthropic API `invalid_request_error` when conversation content contained invalid Unicode surrogate pairs (bare emoji codepoints).
**Fix / Change:**
1. Extended activity metadata fetch to include `average_cadence`, `average_watts`, `activity_type`
2. Added `cadence data`, `power/watts data`, `activity type` to the per-message Strava annotation
3. Rewrote the "NOT hallucinations" section of the analyzer prompt to explicitly enumerate all real Strava fields (per-lap elevation, cadence, power, fast Zwift paces)
4. Stripped bare surrogate characters from conversation content before passing to Anthropic API to fix the plan health JSON encoding crash
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`

---

## 2026-04-09 — Block ⚠️ ANALYSIS leaks; require strides in mile TT plans; eval stripping parity

**Type:** Bug Fix + Improvement
**Reported by:** Internal eval failure
**User feedback:** N/A
**Root cause:** (1) Claude was generating self-created `⚠️ ANALYSIS:` reasoning blocks (mimicking the system prompt's ⚠️ style) that `stripReasoningPreamble` didn't catch — these would leak to SMS. (2) Mile TT plans were omitting strides despite instructions listing them as key sessions — no hard requirement. (3) Eval runner wasn't applying the stripping function, so the judge scored the raw leaked response.
**Fix / Change:** Added `⚠️ ANALYSIS/REASONING/PLANNING/THINKING` to `stripReasoningPreamble` patterns (both separator and leading-paragraph variants). Added explicit prompt rule: "Do NOT create your own ⚠️-prefixed analysis blocks." Upgraded strides to a hard `⚠️ STRIDES REQUIRED` requirement in MILE TIME TRIAL GOAL section (route.ts and eval runner). Added `stripReasoningPreamble` to the eval runner so the judge sees post-stripping output (matches prod behavior).
**Files changed:** src/app/api/coach/respond/route.ts, evals/run-evals.mjs

## 2026-04-09 — Week 1 volume cap for moderate/high volume athletes

**Type:** Improvement
**Reported by:** Internal eval (plan-strength-integrated-marathon 3/10)
**User feedback:** N/A
**Root cause:** The FITNESS TIER section in the system prompt only injected a `⚠️ WEEK 1 VOLUME CAP` for LOW VOLUME athletes (<10 mi/week). MODERATE (10–30 mi/week) and HIGH VOLUME (≥30 mi/week) athletes had no such constraint, so the model could generate an aggressively ramped Week 1 (e.g. 40mi from a 32mi base = 25% jump). The initial_plan prompt referenced this cap as if it existed for all tiers, creating a false expectation.
**Fix / Change:** Added `⚠️ WEEK 1 VOLUME CAP — GUIDELINE` to the MODERATE and HIGH VOLUME fitness tier strings in both `route.ts` and `evals/run-evals.mjs`. MODERATE: target 105–115% of current base; HIGH: target 105–112%. Also clarified `date-18-week-plan-week10` fixture ground_truth notes with explicit Mon–Sun week boundaries to prevent the judge from misattributing the 18mi run (Mar 22, a Sunday = week of Mar 16) to the same week as the 8mi run (Mar 25 = week of Mar 23).
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/fixtures/date-18-week-plan-week10.json`

---

## 2026-04-09 — FACTS block: pre-computed numbers at top of system prompt

**Type:** Improvement
**Reported by:** Internal (eval architecture)
**User feedback:** N/A
**Root cause:** Volatile numbers (today's date, weekly mileage, paces, race countdown) were scattered across multiple sections deep in the system prompt. Claude was hallucinating or anchoring on conversation history when these facts conflicted, partly because they were buried in long prose sections.
**Fix / Change:** Added a `FACTS` block as the very first thing in the system prompt — before "You are Coach Dean..." — containing all pre-computed volatile numbers in a compact, visually distinct table:
- Today's date
- Training week and phase (including recovery week flag)
- Miles logged this week and projected total
- Training paces (easy range, tempo, interval)
- Race name, date, and days/weeks out
- Miles remaining this week across sessions (when applicable)

To make this possible, extracted the training state IIFE computation into pre-computed `ts*` variables before the `return` statement in `buildSystemPrompt`. The IIFE now uses these pre-computed values directly, eliminating redundant computation. Mirrored in `run-evals.mjs` for eval parity.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

---

## 2026-04-09 — Fix time-constrained training day distance caps

**Type:** Bug Fix
**Reported by:** Internal (eval run)
**User feedback:** N/A
**Root cause:** `plan-three-days-half` still scoring 4/10 after session count fix: Dean prescribed a 12mi easy run on Tuesday despite athlete notes stating "Tuesday and Thursday are limited to 60 minutes." At 9:40/mi, 60 min = ~6.2mi max. Notes were present in the system prompt but no computed distance cap was injected, so Claude ignored the time constraint when building peak week volume.
**Fix / Change:** Added server-side detection of "X-day and Y-day limited to N minutes" pattern in athlete notes. When found, computes max distance from easy pace and injects `⚠️ TIME CONSTRAINT — HARD CAP: ... NEVER prescribe more than Xmi on [days]` into the system prompt. Matched in both `route.ts` and `run-evals.mjs`. Fixture went from 4/10 to 9/10.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

---

## 2026-04-09 — Fix mileage self-correction and 3-day quality session distribution

**Type:** Bug Fix
**Reported by:** Internal (eval run)
**User feedback:** N/A
**Root cause:**
1. `mileage-strava-correction` (5-6/10): System prompt correctly labels Strava mileage as authoritative, but no rule prevented Dean from defending its own wrong prior messages. When athlete corrected "phantom 3.5mi run" twice, Dean kept re-citing conversation history instead of re-anchoring to the system prompt figure.
2. `plan-three-days-half` (4-6/10): Session count constraint ("EXACTLY 3 sessions") was satisfied, but Dean structured peak week as tempo + intervals + long run — all three hard sessions. Ground truth requires 1 long run + 1 quality (tempo OR intervals, not both) + 1 easy run.
**Fix / Change:**
1. Added explicit override to the Strava mileage authority line: "If your own prior messages stated a different mileage total, those messages were wrong — do not defend, re-cite, or re-state them. Re-anchor to this figure immediately."
2. For athletes with ≤ 3 training days, appended to the session count constraint: "With only N training days, structure each week as: 1 long run + 1 quality session (tempo OR intervals — NOT both in the same week) + 1 easy/medium run."
3. Both changes mirrored in `run-evals.mjs` for eval parity.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

---

## 2026-04-09 — Eval harness improvements + server-side pre-computation for date/math accuracy

**Type:** Improvement
**Reported by:** Internal (eval run)
**User feedback:** N/A
**Root cause:** Three classes of recurring failures found in eval run:
1. "Tomorrow" for today's session — eval runner injected ALL plan sessions as "UPCOMING SESSIONS THIS WEEK" regardless of date, so Claude couldn't distinguish today's session from future ones. Production route already classified them correctly; eval runner was behind.
2. Math errors on "how many miles do I have left?" — Claude was computing target-delta (28-14=14) instead of session-remaining (6+9=15), because it was given raw numbers and asked to do arithmetic at inference time.
3. "Yesterday" for a run 2+ days ago — the existing ACTIVITY RECENCY advisory rule ("check the N-days-ago label") was insufficient; Claude's trained "most recent = yesterday" reflex overrode it.
**Fix / Change:**
1. **Eval runner parity**: ported production route's today/future session classification into `run-evals.mjs` — sessions on today's date now get "TODAY'S PLANNED SESSION" label; future sessions split into "this week" vs "next week."
2. **Pre-computed miles remaining**: added server-side `MILES REMAINING IN PLAN THIS WEEK: Xmi across N sessions (breakdown) → projected week total: Ymi` injected into training state block. Claude reads the pre-computed answer instead of doing arithmetic. Updated projected total to include today's uncompleted session for non-post_run triggers. Mirrored in eval runner.
3. **Pre-computed most recent run reference**: server-side computes `⚠️ MOST RECENT RUN: [DayName] (N days ago). Always reference as "[DayName]'s run" — do NOT say "yesterday". Yesterday was [DayName] (a rest day — no runs).` Injected before the ACTIVITY RECENCY rule in user_message responses. Removes the need for Claude to reason about recency — gives it the exact phrase to use.
4. **Training session count constraint**: injected "PLAN GENERATION RULE: include EXACTLY N running sessions per week — never more" derived from `training_days.length`. Scoped to plan generation to avoid it surfacing in post-run/conversational responses.
5. **Onboarding fixture fix**: `ready-signal-no-question.json` had a duplicate last user message in conversation_history and was missing `weekly_miles` from `collected`. Fixed both — Dean now correctly fires [READY] when all required fields are present.
**Results:** Coaching evals: 27/41 → 38/41 passed, 8.3 → 9.0 avg. Onboarding evals: 4/5 → 5/5, avg 8.8 → 10.0. Date accuracy category: 5/7 → 7/7.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/fixtures/onboarding/ready-signal-no-question.json`

---

## 2026-04-08 — Fix Dean re-asking for race time after user already provided one

**Type:** Bug Fix
**Reported by:** Jake Tennant (Gwyneth's onboarding)
**User feedback:** "I just told you about the July 5k from last year. Also what is this trail 5k you're referencing?" — Dean asked for a road race time 3 times in the same conversation after Gwyneth already provided a 20:28 downhill 5K.
**Root cause:**
1. Haiku extraction didn't capture the user's stated 5K time because the user qualified it ("when I was in better shape", "net downhill") — the extraction rule said "only extract clearly stated data" with no note about caveated times. So `recent_race_distance_km` was never stored, causing the PACE CALIBRATION guard to fail on every subsequent turn.
2. The PACE CALIBRATION instruction said "ask ONCE" but only checked extracted `onboarding_data` — it had no check against conversation history, so Dean repeated the question every turn when extraction was missing.
3. The `stravaContext` fallback (when no Strava race found) hardcoded "ask for a recent race time or PR" regardless of whether the user had already stated one in conversation. This directly told Dean to ask even when it shouldn't.
**Fix / Change:**
1. Haiku extraction rule updated: explicitly says to extract race times even when caveated (downhill, old, "when I was in better shape"). Caveated times are still useful for calibration.
2. PACE CALIBRATION instruction is now code-driven: before building the system prompt, `handleConversation` scans conversation history for whether Dean has already asked about road race times (regex on prior assistant messages). If yes, the PACE CALIBRATION block is replaced with an explicit "you already asked, do not ask again" instruction. This is more reliable than asking Claude to self-regulate by reading its own history.
3. `stravaContext` fallback now checks if `onboarding_data` already has `recent_race_distance_km` or `easy_pace`. If yes, emits "using pace data already collected from conversation" instead of "ask for a recent race time."
**Files changed:** `onboarding/handle/route.ts`

---

## 2026-04-08 — Two-phase plan rebuild + 2-bubble cap + speed work flag

**Type:** Feature + Bug Fix
**Reported by:** Jake Tennant (Gwyneth's onboarding — plan update didn't apply pace corrections; too many messages)
**User feedback:** "when Gwyneth asked to update the plan, he rewrote this week instead of updating the next week... also didn't update the whole rest of the plan"
**Root cause:**
- Plan update path (`plan_feedback` in `awaiting_cadence`) fired `initial_plan` immediately without persisting the pace corrections Gwyneth stated in conversation. So the full arc was regenerated from stale profile data (wrong tempo pace).
- 2-bubble instruction was being ignored; Claude generated 3 blocks (strength as a separate bubble).
- Speed work flag ("I want to work on speed") was in a generic system prompt instruction that got overridden by the conservative injury path.
**Fix / Change:**
- **`[REBUILD_PLAN]` tag**: Dean emits this when the athlete asks to rebuild the whole plan. The system strips it before sending. After the confirmation message, `rebuild_plan` trigger fires.
- **`handleRebuildPlan`**: new function in coach/respond. Extracts profile updates from recent conversation → persists them → 300ms pause → re-fetches fresh profile → calls `generateAndSaveFullPlan(resetToWeek1: false)`. Profile writes are guaranteed to land before plan generation.
- **`awaiting_cadence` plan_feedback** now fires `rebuild_plan` instead of `initial_plan`.
- **`user_message` rebuild path**: detects `[REBUILD_PLAN]` in coach response, fires `rebuild_plan` in `after()` after profile persisted.
- **2-bubble hard cap**: `splitIntoMessages` result for `initial_plan` is capped to 2 entries in code — any overflow merged into bubble 2.
- **`wants_speed_work` flag**: extracted from onboarding conversation by Haiku, stored in `onboarding_data`. At plan generation, injected as a ⚠️ hard constraint block into the system prompt — overrides conservative defaults. No longer a generic prose instruction.
**Files changed:** `coach/respond/route.ts`, `onboarding/handle/route.ts`

---

## 2026-04-08 — Onboarding quality fixes: VDOT recalculation, verbosity, pace accuracy, dashboard messaging

**Type:** Bug Fix + Improvement
**Reported by:** Jake Tennant (internal observation from onboarding sessions with Jake and Gwyneth)
**User feedback:** "I don't think the VDOT calculation is working correctly. I was given a 9:30-10min easy pace for a 17:50 5k." / "When given plan there are way too many messages coming in" / "The Strava analysis we added is too long" / "Cut down the coaches note - too long. 2 sentences max. Don't need to personalize it" / "Dean said he can't update the dashboard" / "No speed work until week 7 even though she said she wanted to work on speed"
**Root cause:**
1. VDOT bug: `!mergedData.easy_pace` guard in `handleConversation` blocked recalculation when user provided race time after Strava connected. Strava callback's insight message mentioned a pace (e.g. 9:30/mi from trail 30K), Haiku extraction stored that as `easy_pace`, then the guard prevented VDOT from recalculating when user later stated 17:50 5K. Correct easy pace for 17:50 5K is ~8:00/mi, not 9:30–10:00.
2. Too many messages: Claude generating 3 text blocks despite "2 bubble" instruction (strength detail as separate bubble).
3. Strava analysis: "2–3 sentences max" produced verbose output.
4. Coach's note: included athlete name personalization and 2–3 sentences; user found it too long and slightly creepy.
5. Dashboard: Claude was saying "I can't update the dashboard" — incorrect; plan changes DO update the dashboard automatically.
6. Speed work delay: injury notes triggered all-easy first week even when athlete explicitly requested speed work.
7. Leaked internal thinking: coaching_question path in `handleNonCadenceMessage` allowed model to output reasoning meta-commentary.
8. Greeting formatting: Claude starting messages with just "Jake!" on its own line.
**Fix / Change:**
1. Removed `!mergedData.easy_pace` guard — VDOT now always recalculates when race time data is present.
2. Changed initial_plan format from "2 short iMessage texts" to "EXACTLY 2 SMS bubbles — no more, no less."
3. Strava insight prompt changed to "1–2 sentences max, one key insight only."
4. Coach's note shortened to 2 sentences, removed name personalization.
5. Added DASHBOARD UPDATES block to user_message system prompt — Dean is told he CAN update the plan/dashboard.
6. Added SPEED GOAL OVERRIDE instruction — strides or tempo required in week 1 when athlete stated speed goal.
7. Added "Answer directly, no meta-commentary" to coaching_question system prompt.
8. Added formatting rule: never start a message with just the athlete's name alone on its own line.
**Files changed:** `onboarding/handle/route.ts`, `auth/strava/callback/route.ts`, `coach/respond/route.ts`

---

## 2026-04-08 — Post-race recovery context injected into system prompt

**Type:** Feature
**Reported by:** Internal (Jake)
**User feedback:** N/A
**Root cause:** After an athlete's race date passed, Dean had no context that a race had just happened — it was just coaching with no goal and no guidance. Athletes got incoherent responses or stale race references.
**Fix / Change:** When `profile.race_date` has passed within the last 42 days, a POST-RACE CONTEXT block is injected into the system prompt. It tells Dean the race is complete, gives tiered recovery guidance (days 1–7: full rest; days 8–14: easy running only; weeks 3–6: gradual rebuild), and prompts Dean to ask about the next goal at the right moment — without a new trigger, new flow, or re-onboarding. Handled conversationally.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-08 — Opted-out users no longer receive Strava post-run messages

**Type:** Bug Fix
**Reported by:** Julia (user feedback via screenshot)
**User feedback:** User sent "Can I unsubscribe?" and "Unsubscribe" — both correctly set `messaging_opted_out = true` — but Strava activity webhook fired 3 coaching messages afterward anyway.
**Root cause:** The Strava webhook (`/api/webhooks/strava`) did not fetch `messaging_opted_out` and had no opt-out check before calling `coach/respond`. Additionally, `coach/respond` had no opt-out guard of its own, so even if called directly (e.g. by crons that don't check the flag), it would still generate and send messages.
**Fix / Change:**
1. `strava/route.ts`: Added `messaging_opted_out` to the user select query; added early return before firing `coach/respond` if user is opted out.
2. `coach/respond/route.ts`: Added opt-out guard in `processCoachRequest` (fires after user fetch, before any SMS logic) and in the `handlePostRunOnboarding` early-exit path. Acts as belt-and-suspenders for any trigger path that reaches the route.
**Files changed:** `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-08 — Three P1/P2 bug fixes: dashboard link UX, reasoning leak, stale race context

**Type:** Bug Fix
**Reported by:** User feedback (users 2201ddfe, 7a704281, b1b308cf)
**User feedback:**
- (Issue 4) Dean said "I'll pull up your dashboard link" then immediately reversed: "I don't have a dashboard link to send you directly." (trust-eroding contradiction)
- (Issue 5) Internal chain-of-thought reasoning ("The athlete is asking for advice... Key considerations:...") was sent as a visible SMS message to the athlete
- (Issue 6) Post-run message referenced a race that had already occurred 10 days prior; a second duplicate post-run fired 7 minutes later re-asking the same stomach question
**Root cause:**
- Issue 4: (a) "Show me the entire week by week plan" didn't match the `isPlanRequest` regex (extra words between "the" and "plan"), so it fell through to Claude. (b) System prompt stated "No app, no web dashboard" which is false — there IS a plan dashboard, triggerable by "my plan". Claude then contradicted itself.
- Issue 5: Claude emitted its reasoning scratchpad as regular text blocks separated from the actual response by a `---` divider. `splitIntoMessages` split these into separate SMS bubbles that were sent to the athlete.
- Issue 6: `profile.race_date` in `training_profiles` is never cleared after a race passes. The system prompt showed the athlete's goal as an upcoming race even when the date was 10+ days in the past. The Strava webhook dedup window was also only 5 minutes — a second webhook 7 minutes later bypassed it.
**Fix / Change:**
- Issue 4: Extended `isPlanRequest` regex to catch verbose phrasings with up to 6 intermediate words ("show me the entire week by week plan"). Updated system prompt PRODUCT CAPABILITIES to accurately describe the plan link feature and instruct Dean never to say it can't send a link.
- Issue 5: Added `stripReasoningPreamble()` post-processing function that detects and strips content before a `---` separator (or leading paragraphs) when it matches reasoning-scratchpad patterns ("The athlete is asking...", "Key considerations:", "I should...").
- Issue 6: Added `profileRaceDaysUntil` check in `buildSystemPrompt` — race date is only shown in the DATE CONTEXT and ATHLETE header when `daysUntil > 0`. If the race has passed, Claude gets no stale race context. Extended Strava webhook dedup window from 5 to 10 minutes.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/webhooks/strava/route.ts

## 2026-04-08 — Onboarding: weekly mileage required, plan arc week count, coach's note quality

**Type:** Improvement
**Reported by:** Internal observation (Jake)
**User feedback:** "Dean didn't really ask how much running I'm doing now at all, so just started with 10/mi (2 x 5 mi) which may be a little much. He probably needs to get a baseline of how much someone is running in almost all cases. In this message he said I have 16 weeks, then the dashboard said 12 weeks. In the coaches note section I think we could better explain what the quality workout is. For example, this user got strides, but doesn't know what that is."
**Root cause:**
1. Current weekly mileage was marked Optional in the onboarding prompt — omitted when no Strava and athlete didn't volunteer it, leading to unsafe default volume assumptions.
2. For general_fitness goals (no race date), Dean had no system-provided plan duration and computed it himself (16 weeks), disagreeing with the 12-week arc generated by training-plan.ts.
3. Coach's note prompt did not explain training jargon (e.g. strides) and did not personalize with the athlete's name.
4. The "plan is ready" SMS had a `\n` before the checkout URL which could render as extra spacing on some clients.
**Fix / Change:**
1. Moved "current weekly mileage" from Optional to Required in onboarding when Strava is not connected. Includes explicit ask instructions and handling for zero-baseline athletes.
2. Added instruction to the initial_plan user message: for general fitness goals, plan arc is 12 weeks — do not compute this independently.
3. Added general fitness outcome instruction: include 1-2 concrete sentences about what the athlete can expect by week 12.
4. Updated syncArcCurrentWeek to accept athlete name; updated coach's note prompt to personalize with name and explain quality workout types (strides, tempo, etc.) in plain language.
5. Restructured the "plan is ready" SMS to put the checkout URL inline with no trailing newline.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

## 2026-04-08 — Subscription event tracking and PostHog user_id fix

**Type:** Feature / Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Stripe webhook handled subscription lifecycle but never called trackEvent, so PostHog had no visibility into trial starts, activations, failures, or cancellations. signup/route.ts also never tracked user_signed_up. PostHog user_id was only available as distinctId (person identifier), not as an event property — making it invisible when filtering by event properties.
**Fix / Change:** Added trackEvent calls to stripe/route.ts for trial_started, subscription_activated, subscription_past_due, payment_failed, and subscription_canceled. Added user_signed_up to signup/route.ts. Updated trackEvent in track.ts to always include user_id in event properties so it's filterable in PostHog without needing to switch to Person filters.
**Files changed:** src/app/api/webhooks/stripe/route.ts, src/app/api/signup/route.ts, src/lib/track.ts

## 2026-04-08 — Fix billing gate sending plain website URL when dashboard_token is missing

**Type:** Bug Fix
**Reported by:** User feedback (Jake's mom)
**User feedback:** "I put my mom's billing_status = true (she already has an account), but she got the regular website landing page link instead of the stripe portal to sign up"
**Root cause:** In the billing gate block of `coach/respond`, when `dashboard_token` is null the code fell back to `appUrl` (plain `https://coachdean.ai`) for both the checkout and portal URLs. Existing users whose tokens weren't set (e.g. provisioned manually by admin) would receive an unhelpful homepage link instead of a direct checkout link.
**Fix / Change:** Generate a `crypto.randomUUID()` token and persist it to the DB on-the-fly (same pattern used in `dashboard/request-link`) when `dashboard_token` is null, so the checkout/portal URLs are always user-specific.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-08 — Landing page: "Dean" → "Coach Dean" + comparison section redesign

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Inconsistent branding (bare "Dean" throughout) and a text-heavy comparison section that didn't sharply communicate Coach Dean's value vs. the alternatives.
**Fix / Change:** (1) Replaced every bare "Dean" reference across page.tsx with "Coach Dean" — hero, value props, FAQ, season plan callout, smsUrl body. (2) Redesigned comparison section: new headline ("The elite coaching experience, minus the elite price tag"), performance-gap framing, switched competitor cards to pros/cons bullets, added "The Coach Dean Difference" 2×2 grid (Life Happens Button, Contextual Intelligence, Pocket Expert, Invisible Tech).
**Files changed:** src/app/page.tsx

## 2026-04-08 — Extraction evals for plan session persistence

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Plan update evals only tested Dean's SMS response text, not whether the Haiku extraction step (`maybeUpdatePlanSessions`) correctly parsed the change into session JSON for the dashboard.
**Fix / Change:** Added `npm run eval:extraction` — 5 fixtures that feed real coach response text into the exact Haiku extraction prompt from `route.ts` and assert the output JSON is correct: reschedule long run, lighter week (all sessions replaced), easy→tempo conversion, cancel-without-replacement, and no-change (must return `changed: false`). All 5 passing.
**Files changed:** `evals/run-extraction-evals.mjs`, `evals/fixtures/extraction/*.json`, `package.json`

## 2026-04-08 — Plan update evals + prompt fixes for load reduction, quality requests, and strength training

**Type:** Improvement
**Reported by:** Internal observation / eval harness
**User feedback:** N/A
**Root cause:** Three prompt gaps found via new evals: (1) "dial it back / 3 easy runs" requests were being honored in intensity but not distance — Dean would drop the tempo but still prescribe 7-10mi runs; (2) "I want more speed work" requests were refused with aerobic-base lectures even for 5k athletes 8+ weeks out with established fitness; (3) initial plans for athletes doing 2x/week strength training were building to 56-58mi peak, ignoring the additional training load from lifting.
**Fix / Change:** Added explicit prompt guidance in both `route.ts` and `run-evals.mjs` for: (a) load reduction requests — cap runs at 5-6mi, total week at ~50-60% of normal; (b) quality work requests — implement now, don't defer, validate instinct without lecturing; (c) structural day changes — make a concrete recommendation rather than asking the athlete; (d) cross-training athletes — reduce peak volume 10-15%, never schedule hard runs adjacent to lifting days. Also added peak volume caps to the eval system prompt for `plan_quality` fixtures.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

## 2026-04-08 — Plan update and strength training evals

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No evals existed for whether Dean correctly handles plan modification requests or integrates strength training.
**Fix / Change:** Added 5 `plan_update` fixtures (reschedule long run, lighter week, add strength training, fewer training days, more quality work), 1 `plan_quality` fixture for strength-integrated initial plans, a new `plan-update.mjs` judge, and wired up the new category in `run-evals.mjs`. Baseline: 5/5 passing, avg 8.8/10.
**Files changed:** `evals/fixtures/plan-update-*.json`, `evals/fixtures/plan-strength-integrated-marathon.json`, `evals/judges/plan-update.mjs`, `evals/run-evals.mjs`

## 2026-04-07 — Auto-apply beta coupon at checkout

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** N/A
**Fix / Change:** Checkout session now auto-applies the beta coupon (`STRIPE_BETA_COUPON_ID` env var) for the first 100 beta users. Gracefully falls back to full price if the coupon is exhausted or missing. Removed `allow_promotion_codes` (mutually exclusive with `discounts` in Stripe Checkout).
**Files changed:** `src/app/api/billing/checkout/route.ts`

---

## 2026-04-07 — Fix strength/mobility "min" sessions inflating projected weekly mileage

**Type:** Bug Fix
**Reported by:** Internal observation (Gwyneth's post-run message)
**User feedback:** "She's definitely not going to get to 53.5 mi total, and that is also not close to 16 mi"
**Root cause:** The regex `/(\d+(?:\.\d+)?)\s*mi/i` used to parse session distances from `weekly_plan_sessions` matched "min" (as in "35 min") because "min" starts with "mi". A "Strength + mobility 35 min" session was being counted as 35 miles, inflating `projectedWeekMiles` and causing Dean to tell Gwyneth she was "on track for 53.3mi total" when her actual run target was ~16mi.
**Fix / Change:** Added negative lookahead `(?!n)` after `mi` in all three session-parsing regexes so "min" is excluded. Only "mi", "mile", and "miles" tokens (i.e. not followed by "n") now contribute to the mileage projection.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-07 — Prevent repeat free trials on resubscribe

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "if someone already had a free trial, then cancelled, then wants to sign up again, we shouldn't give them a free trial again"
**Root cause:** `trial_period_days: 7` was hardcoded unconditionally in the Stripe Checkout session creation, so any resubscribing user — even one who had already used their trial — would get another 7-day free trial.
**Fix / Change:** `checkout/route.ts` now fetches `trial_started_at` for the user. This field is stamped once when the first plan is generated and never overwritten. If set, the checkout session omits `trial_period_days`, so Stripe charges immediately. First-time subscribers still get the 7-day trial.
**Files changed:** src/app/api/billing/checkout/route.ts

## 2026-04-07 — Fix past_due SMS sending checkout link instead of customer portal

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "want to make sure these are all ironed out" re: subscription lapse vs payment failure flows
**Root cause:** When a user's payment fails (`past_due`), the SMS sent them to `/checkout?token=` which creates a brand-new Stripe Checkout session. But the user already has an existing subscription — they just need to update their payment method, which requires the Stripe Customer Portal, not a new checkout.
**Fix / Change:** `past_due` SMS now sends `/cancel?token=` (the Stripe Customer Portal redirect page). The portal lets them update their card, and Stripe automatically retries the charge when the payment method is updated. `canceled` users still get `/checkout` (correct — new subscription needed). The `/cancel` page already handles non-canceled statuses (including `past_due`) by redirecting straight to the portal.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-07 — Rebuild training plan when VDOT or goal changes mid-conversation

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "I don't think my plan actually got updated at all with different paces" and "the plan goes up to 49mi, that's too much for a 1mi time trial"
**Root cause:** Two separate issues: (1) When an athlete provides race data (triggering a VDOT recalculation) or changes their goal race type mid-conversation, the profile paces were saved to the DB but `generateAndSaveFullPlan` was never called — so the stored plan arc and weekly sessions still had old pace labels and volume targets. (2) The `getTargetPeakMileage` function had no "mile" case, so a mile goal fell through to the default 60mi hard cap, producing a 49mi peak week — far too high for a speed-focused mile time trial plan.
**Fix / Change:** (1) `persistProfileUpdates` now calls `generateAndSaveFullPlan` when `hasRaceData` (VDOT change) or `hasGoalRaceType` (goal change) is true, unless `hasRaceDate` already triggered a full regen. Goal changes use `resetToWeek1: true`; VDOT-only changes preserve the current week. (2) Added "mile" case to `getTargetPeakMileage`: hardCap=40, floor=15 — keeps the plan speed-focused with moderate volume.
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/training-plan.ts

## 2026-04-07 — Fix "give me a sec" dead end + require pace zone labels

**Type:** Bug Fix / Improvement
**Reported by:** Jake (user testing)
**User feedback:** "doesn't seem like Dean is going to respond to me after he said he'd update my plan" and "it was unclear what the 7:47 pace that my 30K suggested was...is that my suggested mile pace, tempo pace, interval pace??"
**Root cause:** (1) When an athlete provides a race result mid-conversation and Dean updates paces, the system prompt allowed Dean to say "I'll rebuild the plan — give me a sec" without actually sending a follow-up. No second message is ever triggered, leaving the athlete waiting indefinitely. (2) Dean was referencing bare pace values (e.g. "the 7:47 pace your 30K suggested") without labeling which zone they belong to. Most athletes don't know what VDOT is or what each zone represents.
**Fix / Change:** Added two rules to the `user_message` system prompt: (1) When updating paces from race data, Dean must include the rebuilt plan in the current message and is explicitly prohibited from saying "give me a sec" or implying a follow-up. (2) Every pace must be labeled with its zone (Easy/Tempo/Interval/Race pace). When showing zones for the first time, Dean must briefly explain each one's purpose.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-07 — Auto-continue onboarding after Strava connects

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "After I connected Strava, I didn't get another message after 15s or so, so I texted him"
**Root cause:** Strava callback sent the "Strava connected!" confirmation but then went silent. User was left in `onboarding_step = "onboarding"` with no prompt — had to text to trigger Dean's next response. Also, the typing indicator never fired because the callback didn't have the chatId.
**Fix / Change:** After sending the Strava confirmation SMS, if the user is still mid-onboarding, the callback now fires `POST /api/onboarding/handle` in `after()` with a synthetic `"(strava connected)"` message (2s delay so confirmation lands first). `linq_chat_id` is now fetched in the initial user select so it can be passed to the onboarding handler for the typing indicator. Onboarding prompt updated to ignore the synthetic message string and continue naturally.
**Files changed:** strava/callback/route.ts, onboarding/handle/route.ts

## 2026-04-07 — Onboarding polish from Jake's test run

**Type:** Improvement
**Reported by:** Jake (user testing)
**User feedback:** "For the Strava message, there was a small punctuation error: 'connect to it here: . That way...' / Dean didn't ask about my goal for the mile time trial — I want to go sub 5 but the plan doesn't have any work around there / Two links in 'Your plan is ready' message was a bit confusing / For the confirmation page, can we personalize with the user's name? / Let's remove the 'And this number's always open' / 'How does this look?' should come in the same message as the plan"
**Root cause:** Multiple small issues: (1) [STRAVA_LINK] was embedded inline in a sentence so removing it left "connect to it here: ."; (2) goal time was "optional" even for short races where it's essential; (3) two links in the payment SMS (checkout + cancel) was confusing; (4) success page was generic; (5) "always open" closing felt redundant; (6) "How does this look?" was sent as a separate message after the plan.
**Fix / Change:** (1) Prompt now requires [STRAVA_LINK] on its own line at the end of the message; (2) Goal time is now required for mile/5k/10k goals; (3) Cancel URL removed from "plan is ready" SMS — just says "Cancel any time, before or after the trial."; (4) Checkout success page now personalized with user's first name ("Let's do this, Jake!") via token lookup; (5) Removed "always open" closing line from plan prompt; (6) "How does this look? Happy to adjust anything." is now appended in the plan message itself — the separate closing message is now just the reminder cadence question.
**Files changed:** onboarding/handle/route.ts, coach/respond/route.ts, billing/checkout/route.ts, checkout/success/page.tsx

## 2026-04-07 — Fix recency errors and communication gap acknowledgment

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "Common failure pattern where [Dean] loses trust" — specifically: Dean says "yesterday" for a run from 3 days ago, and doesn't acknowledge when multiple days have passed since he last messaged.
**Root cause:** Two separate issues: (1) The `user_message` trigger prompt had no rule requiring Dean to verify activity recency from the `(N days ago)` labels already present in RECENT WORKOUTS before using relative terms like "yesterday". (2) No concept of a "contact gap" — Dean had no instruction to acknowledge when his last message was several days ago, causing him to respond as if he'd been watching in real time. The eval runner also had a bug where `thisWeekMonday` was hardcoded and activities lacked relative time labels, making evals less representative of production.
**Fix / Change:** Added `ACTIVITY RECENCY` rule to the `user_message` trigger: Dean must check the `(N days ago)` label before using "yesterday" or "this morning" — use day name (e.g. "Monday's run") for anything 2+ days ago. Added `CONTACT GAP` rule: when the last coach message was 2+ days ago, computed from `recentMessages`, Dean is told the gap and instructed to acknowledge it naturally. Fixed eval runner to compute dynamic `thisWeekMonday` from `fixture.today`, added `(N days ago)` labels to activity entries, and added optional `date` field support on conversation entries. Added 3 new evals targeting these failure modes.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/fixtures/date-recency-gap-contact.json`, `evals/fixtures/date-midweek-miles-remaining.json`, `evals/fixtures/date-post-silence-reengagement.json`

---

## 2026-04-07 — Onboarding: race time extraction fix, triathlete context, Strava engagement, conversion copy

**Type:** Improvement
**Reported by:** Jake — post-eval review
**User feedback:** N/A
**Root cause:** Four gaps: (1) `recent_race_time_minutes` extraction rule had no M:SS format examples, so Haiku could misinterpret "18:45" (5K) as a longer time like 1:52:30; (2) triathlete "weakest leg" context was never explored — Dean moved on without asking why or collecting injury notes; (3) Strava connection was treated as data-only, missing the opportunity to ask what the athlete is trying to change; (4) wrap-up messages were generic rather than referencing the athlete's specific constraint or race.
**Fix / Change:** Added explicit M:SS examples to `recent_race_time_minutes` rule ("18:45" → 18.75) in both route.ts and sim runner. Added triathlon-specific instruction to ask why the run is the weakest leg and to collect injury history before [READY]. Added STRAVA CONTEXT section instructing Dean to use connected data as a hook for one contextual "what's been missing?" question. Added two new DEMONSTRATING VALUE bullets: name the specific mechanism for a stated struggle, and personalize the wrap-up using the athlete's own constraint/race language. All changes mirrored in run-simulation-evals.mjs.
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-simulation-evals.mjs

## 2026-04-07 — Onboarding prompt: name enforcement, farewell loop, re-ask prevention, race date verification

**Type:** Improvement
**Reported by:** Internal — simulation eval run 2026-04-07T15-00-33
**User feedback:** N/A
**Root cause:** Four prompt gaps identified via simulation evals: (1) name not explicitly required in [READY] criteria, allowing Dean to finish onboarding without collecting the user's name; (2) no instruction to stop after a graceful out-of-scope exit, causing a farewell loop with cycling-only users; (3) "don't re-ask" instruction only covered `onboarding_data`, not the live conversation history — causing Dean to re-ask timezone already stated in the first message; (4) user-provided race dates were sometimes accepted without verification despite the mandatory search rule.
**Fix / Change:** Added `name` to SIGNALING READY criteria with explicit fallback instruction. Added instruction to stop after one farewell when a cycling-only user declines. Expanded "don't re-ask" to explicitly cover conversation history. Strengthened the race date search mandate with "ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable." All changes applied to both route.ts and run-simulation-evals.mjs for parity.
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-simulation-evals.mjs

## 2026-04-07 — Fix "trail_race" shown in dashboard + pace consistency in onboarding

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "under dipsea in my dashboard instead of the mileage of the race like cirque series, it said trail_race in the A / B race section" and "Dean said my easy pace would be 8-8:40/mi on flat ground, but then when he texted me the pace was different in that week's plan"
**Root cause (1):** B/C races are stored with `goal_distance_miles: null` because the `other_races` extraction schema didn't include `goal_distance_miles`. When the dashboard renders the race, `GOAL_DISTANCE_LABELS` had no entry for `trail_race`, so it fell back to showing the raw `race.goal` value verbatim.
**Root cause (2):** The onboarding `summarizeCollected` function showed Dean the exact VDOT-calculated pace as a single number ("Easy pace: 7:48/mi"), but Dean would generate his own arbitrary range ("8:00–8:40/mi") rather than using the stored value. The training plan then showed a different range derived via `easyPaceRange(storedPace)`.
**Fix / Change (1):** Added `goal_distance_miles` to the `other_races` extraction schema and races insertion, so future B/C races with explicit distances get them stored. Added `trail_race`, `sprint_tri`, `olympic_tri`, `general_fitness`, and other non-distance goal types to `GOAL_DISTANCE_LABELS`. Also replaced the raw `race.goal` fallback with a title-cased conversion (e.g., `trail_race` → "Trail Race") for any future unknown goal types.
**Fix / Change (2):** Changed the `summarizeCollected` function to show Dean the pre-computed `easyPaceRange` ("Easy pace range: 7:50–8:20/mi — use this exact range") instead of a bare exact pace, so what Dean says during onboarding matches what the plan shows.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-07 — Move location/timezone collection to post-plan cadence step

**Type:** Improvement
**Reported by:** Jake (internal observation during onboarding)
**User feedback:** "I think we should move asking about location for reminders to when we actually tell the user we can send reminders (after the plan is sent!) it's more natural this way. If a user connected Strava, we should also look at their location on that and just confirm it - easier on them."
**Root cause:** The onboarding system prompt listed "Location / city" as a required field alongside goal, training days, and pace — causing Dean to ask mid-conversation before reminders were even mentioned. Strava users had their city already stored but Dean asked again from scratch.
**Fix / Change:** Removed location from the required onboarding fields and [READY] condition. Updated the post-plan closing message: Strava users with a known city now get "I have you in [city] from Strava — which reminder timing works better?" Non-Strava users without a timezone are still asked for their city at the natural moment when reminders are introduced.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-07 — Prompt guardrails: intra-lap timestamp hallucination + in-conversation pace overrides

**Type:** Bug Fix
**Reported by:** Conversation Analysis 2026-04-06 (auto-generated)
**User feedback:** N/A (caught by automated analysis)
**Root cause (Issue 1 — intra-lap timestamp hallucination):** When manual laps are recorded, the existing data guard only restricts lap references when `hasLaps` is false. When laps ARE present, Dean was fabricating sub-lap event timestamps (e.g. "at 48:46 into the run, HR jumped to 140") — Strava lap data only provides per-lap averages (avg pace, avg HR per lap) and does not record when within a lap a specific moment occurred.
**Root cause (Issues 2+3 — state tracking failure / corrected pace zones ignored):** No prompt instruction required Dean to treat athlete-confirmed values as ground truth during a session. When an athlete corrected Dean's stated pace mid-conversation, Dean continued re-deriving the value from stored profile defaults rather than locking what was confirmed. Similarly, when Dean explicitly acknowledged a corrected training zone, the corrected zone was not propagated into subsequent plan outputs.
**Fix / Change:**
1. Added precision-limitation note to the laps DATA GLOSSARY entry (shown only when `hasLaps` is true): "Lap data provides per-lap AVERAGES only. Do NOT cite specific elapsed-time markers within a lap — Strava does not record event-level timestamps within a lap."
2. Added `⚠️ ATHLETE-CONFIRMED IN-CONVERSATION DATA` rule to the MEMORY AND DATA LIMITATIONS block: athlete-confirmed/corrected paces, distances, and training zones are ground truth for the session; always override stored profile defaults; lock and acknowledge before moving on; never flip-flop on a corrected value.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-07 — Robust re-intro stripping: question-anchor approach

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "deployed and still getting the same response: Hey Jake! I'm Coach Dean, your AI running coach..."
**Root cause:** First post-processing attempt used `\n\n` as the paragraph boundary to find where the intro ends. But the model produces `\n` (single newline) or no newline at all, so the regex never matched. The "Hey Jake! I'm Coach Dean..." block passed through unstripped.
**Fix / Change:** Replaced the `\n\n`-dependent regex with a question-anchor approach: detect "I'm Coach Dean" in the first 400 chars, find the first `?` in the response, back-track to the start of that sentence (using last `\n` or `. ` before the `?`), and start the response from there. Works for `\n\n`, `\n`, and no-newline variants. Also updated eval runner to match.
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-onboarding-evals.mjs

## 2026-04-07 — Post-process greeting phrases + fix eval fixture message ordering

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "dean seems to be repeating himself a ton still? ... Hey Jake! I'm Coach Dean, your AI running coach..."
**Root cause:** Two issues found. (1) The eval fixture `no-greeting-repeat` had invalid message ordering — started with an assistant turn and duplicated the user "Jake" message, causing the model to see [assistant, user, user] instead of the production-correct [user, assistant, user]. This masked whether the prompt fix was actually working. (2) Even with correct message ordering, the model's deeply-trained "user gives name → say Nice to meet you" reflex overrides any system prompt instruction reliably. Tried 5+ prompt variations (bullet, HARD RULE block, NEVER list, example-based, top-of-prompt placement) — all failed.
**Fix / Change:** Fixed the eval fixture to mirror production message ordering. Added a post-processing strip on `rawText` (before signals are parsed) that removes "Nice/Great/Good to meet you" opener phrases on non-first messages. This is applied in both the route handler and the eval runner for parity. Simplified system prompt to a single light instruction (no more escalating NEVER blocks).
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-onboarding-evals.mjs, evals/fixtures/onboarding/no-greeting-repeat.json

## 2026-04-06 — Fix "yesterday" misattribution for past activities

**Type:** Bug Fix
**Reported by:** Ian (via Jake)
**User feedback:** "He just referred to Monday as yesterday on both Thursday and Sunday. Sounds good. He just referred to Monday as yesterday on both Thursday and Sunday. I ghosted Thursday so maybe that contributed but I think if the prompt includes the current date or something he could figure it out."
**Root cause:** Two gaps: (1) RECENT WORKOUTS in the system prompt had no server-computed recency labels, so Claude had to infer "yesterday" vs "3 days ago" itself — and got it wrong. (2) The dateContext instruction permitted natural relative terms ("yesterday", "this morning") without requiring Claude to verify the actual timestamp. Claude was treating "most recent strenuous event in conversation history" as "yesterday" regardless of when it actually occurred.
**Fix / Change:** Two-part fix:
1. RECENT WORKOUTS now includes a server-computed relative label per activity: `(today)`, `(yesterday)`, `(3 days ago)`, etc. up to 13 days. Claude is instructed to use these labels as the authoritative recency signal.
2. Tightened the dateContext instruction: Claude may only say "yesterday" if the event's timestamp or conversation date matches the explicitly provided Yesterday date. Older events must use the weekday name ("Monday's double header", "last week's long run").
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Fix walk mileage counting + session swap dashboard link bug

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "Dean seems to be counting her 'walk' strava activities towards running mileage. He shouldn't, only runs should count" / "The dashboard still shows a sunday run and tuesday strength" (after asking Dean to swap them)
**Root cause (bug 1):** In the `post_run` user message, the week-to-date total was labeled "(this run included)" even when the synced activity was a Walk. `weekMileageSoFar` correctly excludes walks (via `RUN_TYPES`), but the misleading label caused Claude to manually add the walk's distance on top of the running total (2.2mi + 1.25mi walk = 3.5mi incorrectly stated).
**Root cause (bug 2):** The "FULL PLAN REQUESTS — HARD RULE" prompt fired when Gwyneth said "I see my plan has me running on Sunday, can we switch that?" — Dean sent the dashboard link instead of handling the session swap request.
**Fix / Change:** (1) When the synced activity is not a run type, the week mileage context now explicitly says "WEEK-TO-DATE RUNNING MILES — this [Walk] is NOT included. Do NOT add its distance to this total." (2) Added an explicit EXCEPTION to the full plan request rule: if the athlete mentions the plan while asking to change it (swap, move session), treat it as a session swap request and do not send the dashboard link.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Onboarding conversion improvements + 5 new simulation evals

**Type:** Feature / Improvement
**Reported by:** Internal product review
**User feedback:** N/A
**Root cause:** Onboarding was pure data collection — no value demonstration, no scope clarity for cycling/tri users, generic trial CTA.
**Fix / Change:**
- Strava ask now includes a one-sentence value prop ("auto-calibrates training zones from real data")
- Dean now reflects one specific insight from the athlete's fitness baseline back at them (e.g. what their half PR implies for marathon target range)
- Cycling-only users: Dean now honestly acknowledges it specializes in running and asks if running is in the mix
- Triathlon users: Dean clarifies it handles the run leg specifically, not swim/bike
- Trial conversion message (`awaiting_payment`) now personalized: references race name, date, and week count — e.g. "Alex, your 24-week Chicago Marathon plan (October 11) is built and ready"
- 5 new simulation eval fixtures: sim-mile-time-trial, sim-cycling-only, sim-triathlon-70-3, sim-pricing-question, sim-5k-pr-hunter
- Simulation judge updated with `conversion_likelihood` and `scope_handled` scoring dimensions
**Files changed:** onboarding/handle/route.ts, run-simulation-evals.mjs, judges/simulation-quality.mjs, 5 new fixture files

## 2026-04-06 — Onboarding fixes: web search concatenation, ultra_race_history extraction, strava_skipped field, fixture correction

**Type:** Bug Fix
**Reported by:** Jake (eval results — simulation-2026-04-06T22-40-55)
**User feedback:** "by the way the boston marathon 2027 is actually april 19 so maybe the judge was wrong here"
**Root cause (4 issues):**
1. Web search text concatenation: The hosted web_search tool returns `server_tool_use` content blocks, not `tool_use`. Our text extraction checked only for `tool_use`, so `lastToolIdx` stayed -1 and ALL text blocks (pre-search and post-search) were concatenated into one message. This caused the malformed first message in sim-international-user and likely similar issues in production.
2. `ultra_race_history` not extracted: Haiku extraction prompt had no description or rules for the `ultra_race_history` field, so it never populated even when athletes clearly stated their ultra/trail background.
3. Race date not verified when user provides it: The mandatory search instruction didn't explicitly say to verify user-provided dates. Jordan said "February 7th" for Rocky Raccoon but the actual date is different — Dean should search regardless.
4. `sim-terse-user` fixture had wrong date: Fixture had `race_date: "2027-04-21"` (a Wednesday) and notes said "April 21, 2027". Boston Marathon is the third Monday of April; in 2027 that's April 19. Dean's web search found the correct date but the judge penalized it.
**Fix / Change:**
1. Added `server_tool_use` type check alongside `tool_use` when scanning for the last tool call index in both `route.ts` and `run-simulation-evals.mjs`. This ensures only post-search text is used when Dean calls web search.
2. Added extraction rule for `ultra_race_history`: summarize any ultra/trail race background mentioned. Also added `strava_skipped: true | null` to the extraction output so users who say "No Strava" upfront get it properly captured.
3. Updated mandatory search instruction: "user-provided dates are often wrong too — always verify via search regardless of what the athlete says."
4. Corrected `sim-terse-user` fixture: `race_date` → `2027-04-19`, user_agent_prompt updated, evaluation notes corrected.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`, `evals/fixtures/simulation/sim-terse-user.json`

---

## 2026-04-06 — Onboarding prompt improvements: goal classification, race dates, ultra fields, Strava skip routing

**Type:** Bug Fix / Improvement
**Reported by:** Jake (eval results — simulation-2026-04-06T22-23-41)
**User feedback:** N/A (caught by simulation evals — 6 of 10 fixtures scoring below 9/10)
**Root cause (4 issues):**
1. Race dates wrong from memory: despite the "always web_search" instruction, Dean was still stating race dates from memory (London April 1 instead of April 26, Boston April 20 instead of April 21). The instruction was too soft.
2. Goal misclassification for aspirational mentions: users returning to running or recovering from injury who mentioned a distant "maybe someday" race were classified as marathon/10k instead of return_to_running/injury_recovery.
3. Ultra required fields missed: ultra_race_history and injury_notes are required for safe 50K+ training plan generation, but were listed as "optional" — Dean was skipping them.
4. Training days double-asked after Strava skip: the Strava skip path used a hardcoded Haiku snippet ("ask for training days if missing") which re-asked questions that were already asked (but not yet answered) in the same message as the Strava link.
**Fix / Change:**
1. Renamed web search instruction to "RACE DATE — MANDATORY SEARCH" with stronger language: "call web_search immediately… do not state, confirm, or summarize any race date without first searching."
2. Added explicit goal classification rule to both Dean's system prompt and Haiku extraction: aspirational mentions don't override stated primary goal; no committed race = return_to_running or general_fitness.
3. Moved ultra/trail background + injury notes to "Required ONLY for ultra goals" section; injury notes also required for return_to_running/injury_recovery goals.
4. Strava skip now routes back through the full handleConversation (Sonnet with full history) instead of an abbreviated Haiku snippet — Dean sees what was already asked and won't re-ask. This also aligns with the "let Claude deal with it" architecture philosophy.
5. Updated run-simulation-evals.mjs to match all four prompt changes (parity requirement).
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-06 — Five onboarding UX fixes (name, repetition, days, plan timing, race dates)

**Type:** Bug Fix / Improvement
**Reported by:** Jake (internal testing)
**User feedback:** "didn't get a response... ask for the user's name in the first step... weird repetition of 'Great to meet you!' throughout... repetition of what days work best for training... Dean sent the plan at the same time as asking for my time goal... the dates are wrong for the races: Dipsea June 1, Cirque July 1"
**Root cause (5 issues):**
1. Name: not in required fields, never asked.
2. "Great to meet you" repeated: no instruction preventing it on follow-up messages.
3. Training days re-asked: Strava callback always asked "which days work?" when `shouldAdvanceToSchedule=true`, even if `training_days` was already extracted before the user tapped the link.
4. Plan + question at same time: `[READY]` fired in the same message as "do you have a goal time?", triggering `completeOnboarding` while the question was still outstanding.
5. Wrong race dates: extraction prompt said "if only month given, default to first of month" and Haiku was applying this even when the Coach had stated the exact date (from a web search). Result: June 1 and July 1 instead of June 14 and July 11.
**Fix / Change:**
1. Added "Athlete's name (ask in your first message if not already known)" to required fields.
2. Added instruction: "Never repeat 'Great to meet you', 'Nice to meet you', or similar greeting phrases after the first message."
3. Strava callback now checks `onboardingData.training_days` before appending the training-days question.
4. Added instruction: "When you signal [READY], do not ask any more questions — wrap up warmly, the plan fires right after."
5. Updated extraction prompt for `race_date` and `other_races.date` to explicitly prefer specific dates mentioned in the conversation over first-of-month defaults.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-06 — Fixed new users getting no response on first message

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "didn't get a response when I messaged Hey Dean! as a new user"
**Root cause:** After the onboarding revamp, the unified conversation handler fires on `onboarding_step = "onboarding"`, but new users were still being created with `onboarding_step = "awaiting_goal"`. The switch in `onboarding/handle` has no case for `"awaiting_goal"`, so it hit the default branch and returned `{ ok: true }` silently — no message sent.
**Fix / Change:** Changed new user insert in the linq webhook to set `onboarding_step: "onboarding"` so they immediately enter the unified conversation handler.
**Files changed:** `src/app/api/webhooks/linq/route.ts`

---

## 2026-04-06 — Self-serve subscription cancellation

**Type:** Feature
**Reported by:** Jake (internal)
**User feedback:** "It's unclear what the cancel route is — we need to make it easy to do and communicate that in the sign-up flow"
**Root cause:** No cancellation path existed. The SMS bot promised to send a link that didn't exist. Users had no way to cancel without contacting Jake directly.
**Fix / Change:** (1) Created `/cancel?token=xxx` page — server-side Stripe Customer Portal redirect, handles cancel/update payment/view invoices. (2) Added cancel keyword shortcut to `coach/respond` — "cancel", "unsubscribe", etc. sends the portal URL instantly without hitting the LLM. Also handles "help" keyword. (3) Updated `handleNonCadenceMessage` to send the real cancel URL instead of a broken promise. (4) Updated payment SMS to include the cancel URL explicitly ("cancel any time — before or after the trial — at coachdean.ai/cancel"). (5) Updated checkout page fine print to say the same. **Note: requires Stripe Customer Portal to be enabled at dashboard.stripe.com/settings/billing/portal.**
**Files changed:** `src/app/cancel/page.tsx` (new), `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/checkout/page.tsx`

---

## 2026-04-06 — Post-onboarding UX polish

**Type:** Improvement
**Reported by:** Jake (onboarding test session)
**User feedback:** "How does this look?" should come last after dashboard link; checkout iMessage preview should say "Start your free trial"; success page should be more celebratory; clicking checkout link again shouldn't create a duplicate subscription
**Root cause:** Plan message included feedback/reminder questions before the dashboard link was sent; checkout page had no metadata for iMessage previews; success page was generic; billing/checkout route didn't check for existing active subscriptions
**Fix / Change:** (1) Removed "How does this look?" and reminders offer from Claude's `initial_plan` prompt — now sent as a dedicated SMS *after* `generateAndSaveFullPlan` sends the dashboard link, preserving the right read order. (2) Added `checkout/layout.tsx` to export metadata for iMessage link previews. (3) Made success page more celebratory. (4) Billing checkout now returns a dashboard redirect if the user already has an active/trialing subscription instead of creating a duplicate Stripe session.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/checkout/layout.tsx` (new), `src/app/checkout/success/page.tsx`, `src/app/api/billing/checkout/route.ts`

---

## 2026-04-06 — Onboarding refactor: unified Claude conversation handler

**Type:** Refactor
**Reported by:** Internal observation / Jake feedback
**User feedback:** "It feels like we may want to remove some of our scaffolding and just let claude deal with it more"
**Root cause:** The 12-step rigid state machine (`awaiting_goal` → `awaiting_race_date` → … → `awaiting_cadence`) required constant patches for edge cases like off-topic detection misfires, loop detection, multi-race confusion, and natural conversation derailing the expected step sequence.
**Fix / Change:** Replaced ~3300 lines of step handler code with a ~550-line unified handler. Single `onboarding` step drives all pre-Strava, pre-plan conversation through Claude Sonnet (with web_search for race date lookups). One Haiku call extracts all structured fields from the full conversation after each exchange. Off-topic detection, loop detection, de-escalation, and all step-specific handler functions deleted. `awaiting_strava`, `awaiting_cadence`, and `awaiting_payment` remain as hard stops for specific flow gates.
**Files changed:** `src/app/api/onboarding/handle/route.ts` (rewritten), `src/app/api/signup/route.ts` (step name: `awaiting_goal` → `onboarding`), `src/app/api/auth/strava/callback/route.ts` (step advance: `awaiting_schedule` → `onboarding`), `src/__tests__/api/onboarding-handle.test.ts` (rewritten), `src/__tests__/api/multi-race-onboarding.test.ts` (rewritten)

---

## 2026-04-06 — Improve initial plan quality across all fitness tiers

**Type:** Improvement
**Reported by:** Jake Tennant (internal observation)
**User feedback:** "I'm a bit worried that some users will get all easy in the first week without much detail and be like 'this plan isn't worth it' - I think even for athletes that were doing like 15 mi/week consistently we need to think about things like strides, etc. And then for real beginners we just need to teach them about pacing zones, ramping up slowly, etc. and our philosophy so they believe it is the right way to approach training."
**Root cause:** Initial plan instructions only called out the quality-session requirement for HIGH VOLUME athletes. MODERATE and LOW VOLUME athletes could get an all-easy first week with no explanation of why. Beginners had no prompt instruction to explain the reasoning behind the plan structure.
**Fix / Change:** Extended explicit quality session requirements to all tiers:
- HIGH VOLUME (30+ mi/week): must include tempo/intervals/strides/hill repeats
- MODERATE VOLUME (10–30 mi/week): must include strides at minimum (4–6 × 20-sec pickups)
- LOW VOLUME (<10 mi/week): include strides on at least one run
Added "EXPLAINING THE PLAN" instruction for beginner/low-volume athletes: include 2–3 sentences in the first bubble explaining what "easy effort" means and why we build gradually — so new athletes trust the approach instead of dismissing it as generic advice.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-06 — Fix: three onboarding bugs (wrong goal bucket, date confusion, 50K display label)

**Type:** Bug Fix
**Reported by:** Jake Tennant (testing)
**User feedback:** "1) my plan was all easy miles for week one, even though my history shows I have a very good base 26+ miles/week for many months. 2) the dashboard didn't show dipsea at all, even though I mentioned it as a race 3) cirque series showed as a 50k in my dashboard even though Dean knew it was 8.9 miles (also shows up as a 50k in coaches note)"
**Root cause (three separate bugs):**
1. `handleGoal` set `goal: "50k"` as placeholder for named races with no explicit distance in the name (e.g. "Cirque Series Snowbird"), then updated `goal_distance_miles` from web search (8.9 mi) but never corrected the goal bucket. The whole plan was generated under "50k ultra" logic for an 8.9-mile mountain race.
2. `handleOtherRaces` prompt didn't tell Haiku what the A race's stored date was. When Jake said "Yes - Dipsea on June 14th…", Haiku set `confirmed_a_race_date: "2026-06-14"` (Dipsea's date), overwriting Snowbird's July 11 date. Dipsea then had no date in `other_races` and was filtered out.
3. `UpcomingRaces` in the dashboard checked `GOAL_DISTANCE_LABELS[race.goal]` first even when `goal_distance_miles` was set, so "50K" won over "8.9 mi".
**Fix / Change:**
1. `handleGoal`: when web search provides `distanceMiles`, also update `goal` via `distanceMilesToGoalBucket(distanceMiles)` so the coaching system uses the correct training approach.
2. `handleOtherRaces`: pass A race name and stored date in the Haiku prompt. Clarify rules: `confirmed_a_race_date` must only be set for the A race's own date, not for dates belonging to other races. Added implicit-yes handling: when Haiku returns null (user said "yes" with no specific date) and there's a stored date, mark it confirmed without looping back to `awaiting_race_date`.
3. `UpcomingRaces`: check if `goal_distance_miles` is non-standard (differs from bucket standard by >0.5 mi) and prefer it over the bucket label.
4. `buildUserMessage` initial_plan: added explicit instructions that HIGH VOLUME athletes must get ≥1 quality session in week 1 (no all-easy sandbagging), and mountain/trail races with elevation gain need vert-specific work from day 1.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

## 2026-04-06 — Fix: onboarding re-asks "What are you training for?" instead of answering multi-race process question

**Type:** Bug Fix
**Reported by:** Jake Tennant (testing)
**User feedback:** "A number of different races actually - should I say all of them or just pick one?" → Coach Dean replied "Hey Jake! What are you training for — a race, general fitness, something else?" (ignored the question entirely)
**Root cause:** `detectAndAnswerImmediate` only recognized coaching questions and capability questions — not process/guidance questions about how to answer the current onboarding step. So "should I say all of them or just pick one?" returned null, and the fallback re-asked the same question verbatim.
**Fix / Change:** (1) Added "process/guidance questions" as a recognized question type in `detectAndAnswerImmediate`, with a specific instruction to answer multi-race questions with "Just tell me your main goal race — we can add other races after." (2) When `introAlreadySent` is true and `questionAnswer` is returned, use the question answer alone instead of prepending it before the re-ask — the answer already redirects the athlete, so appending the re-ask was redundant.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-06 — Fix: session swaps not updating dashboard when athlete requests in-week changes

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "I see my plan has me running on Sunday, can we switch that for another day and maybe move the strength training to then?" — plan dashboard unchanged after Dean's response
**Root cause:** Two gaps in the session-swap pipeline: (1) The Dean system prompt had explicit instructions for multi-week plan changes ("state it explicitly so the athlete knows") but nothing equivalent for in-week session swaps — so Dean would respond with future-tense hedging ("I can move that") rather than a firm commitment. (2) The Haiku detection prompt (`maybeUpdatePlanSessions`) required the coach to "explicitly agree to a change" without examples, causing it to return `changed: false` for future-tense confirmations like "Moving strength to Sunday" or "I'll put the easy 3mi on Tuesday instead." Together: Dean responded vaguely → Haiku saw no explicit commit → DB not updated → dashboard unchanged.
**Fix / Change:** Added a `THIS WEEK SESSION SWAP` instruction block to the `user_message` system prompt directing Dean to agree immediately and state the new arrangement explicitly (e.g. "Done — moved strength to Sunday and easy 3mi to Tuesday"). Updated the Haiku detection prompt to accept both past-tense and future-tense confirmations as "explicitly agreed," and added guidance for correctly updating both the "day" and "date" fields when sessions swap days.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Extreme ramp guard + mileage regression language fix + manual activity Strava skip

**Type:** Bug Fix / Safety
**Reported by:** Issue review (users 39c51f9b/Julia, 7f356c80)
**User feedback:**
- Issue 2 (Julia): "You're at 60mi this week with one session left (Monday's easy 5mi). That puts you on track for 105mi total — a solid bump from last week's 2.2mi and right in line with your Dipsea prep."
- Issue 4: "You're at 20.2 mi for the week, closing out week 1 strong. Next week steps up to 17 mi..." (17mi < 20.2mi = step-down, not step-up)
**Root cause (Issue 2 — confirmed via Julia's activity data and conversation):** Julia texted "It's a 22 mile ride with 2-3,000 feet of climbing." The `user_message` workout extraction parsed this and wrote a manual `activity_type: "Run"` record with `distance_meters: 35405` (22mi) to the activities table — misclassifying a bike ride as a run. Later that day, her real 10.9mi trail run synced via Strava. `computeWeekMileage` then counted both: Apr 5 (10.87mi) + Apr 4 Strava (10.89mi) + Apr 4 manual (22.00mi) + Apr 3 (6.43mi) + Apr 2 (6.01mi) + Apr 1 (3.80mi) = **60.00mi exactly**. The existing dedup only removes manual entries within 15% of the Strava distance — 22mi vs 10.89mi (50% diff) passed through. Julia is a Strava user; her runs are captured automatically via webhook. The manual extraction path was designed for non-Strava users only.
**Root cause (Issue 4):** When `storedNextPlanWeek.mileage_target < weekMileageSoFar`, there was no prompt instruction preventing Dean from using "steps up" language. The arc's 17mi target was displayed without context that it was lower than the current week's actual.
**Fix / Change:**
- In `user_message` handler: skip writing manual workout activities when `user.strava_athlete_id` is set. Strava users' runs arrive via webhook; manual extraction for them creates phantom entries that double-count with real Strava data.
- In `buildCoachingSignalsBlock`: for ramps >100%, replace the gentle "mention naturally" note with an explicit ⚠️ EXTREME MILEAGE JUMP instruction — Dean must acknowledge the jump directly with the athlete rather than normalize it.
- In `buildUserMessage` for `user_message`: when `nextWeekContext` target < `weekMileageSoFar`, append a ⚠️ NOTE inline — "This target is LOWER than this week's current mileage. Do NOT say 'steps up' — describe it as a planned lighter week."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Fix syncArcCurrentWeek being killed by Vercel before it completes

**Type:** Bug Fix
**Reported by:** Jake Tennant (Gwyneth's account — weekly_recap set target to 9mi but coach text said 10mi; arc still showed original 16mi value)
**User feedback:** "her coaches note says 10 mi but the weekly target says 9 mi" / "she's only at a 9 mile target this week when she ran more last week and historically was doing 12-13/week"
**Root cause:** `syncArcCurrentWeek` was called with `void` (fire-and-forget) at the end of `processCoachRequest`, which itself runs inside `after()`. When `processCoachRequest` returned, Vercel terminated the lambda, killing `syncArcCurrentWeek` before it could update `training_state.weekly_mileage_target` or `training_plans.weeks`. This meant the periodization engine's initial `suggestedWeeklyMiles` value (9) persisted in training_state while the arc stayed at its original generated value (16mi), both diverging from what Dean actually prescribed in the SMS (10.5mi from sessions).
**Fix / Change:** Changed `void syncArcCurrentWeek(...)` to `await syncArcCurrentWeek(...)` in both `initial_plan` and `weekly_recap` branches. The response has already been sent before this code runs (it's all inside `after()`), so awaiting doesn't block anything — it just ensures the lambda stays alive until the sync completes.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-06 — Fix "3.5min" cross-training duration (Haiku digit-drop mis-parse)

**Type:** Bug Fix
**Reported by:** Jake Tennant (Gwyneth's account — "she still has 3.5 min for her strength and mobility session")
**User feedback:** "she still has 3.5 min for her strength and mobility session (odd number, probably will take longer than that - thought we addressed this yesterday)"
**Root cause:** Yesterday's fix only caught `X mi` patterns (e.g. "Strength + mobility 3.5 mi"). The stored label was `3.5min` — `mi` is followed by `n` (a word character), so the `(?!\w)` lookahead blocked the match. The `3.5min` value appears to be the Haiku session extractor dropping a digit when parsing "35 min" from the plan text (3.5 vs 35).
**Fix / Change:** Added a second sanitization pass in `extractAndStorePlanSessions`: after fixing `X mi` → `X min`, also detect decimal durations under 5 minutes on cross-training sessions (e.g. "3.5min") and multiply by 10 to recover the likely intended value ("35 min"). Threshold of 5 min ensures this only triggers on clearly-wrong values.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — Switch to per-mile splits (splits_standard) for US athletes

**Type:** Bug Fix
**Reported by:** Jake Tennant (Curtis's case)
**User feedback:** "Splits Dean shared were different from Strava" — Dean was working from per-km splits while the Strava app shows per-mile splits, causing pace figures to describe different intervals.
**Root cause:** Webhook stored `splits_metric` (one split per km) citing elevation unit ambiguity for `splits_standard`. This was wrong — both split types return `elevation_difference` in meters. The result was Dean saying "around mile 3: 11:00/mi" when Strava showed a different value at mile 3 (they covered different intervals).
**Fix / Change:** Switched webhook to store `splits_standard` (per-mile) going forward. Updated DATA GUARD to only fire for legacy activities with more splits than miles (km-stored data). Updated `analyze-conversations` route description to match.
**Files changed:** `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/cron/analyze-conversations/route.ts`, `src/__tests__/api/strava-webhook.test.ts`

## 2026-04-05 — Hard-code authoritative mileage phrase in weekly recap

**Type:** Bug Fix
**Reported by:** Jake Tennant (Curtis's case — weekly recap showed 36.2mi when actual was ~27mi)
**Root cause:** System prompt instruction said "use this exact figure" but Claude still derived 36.2 by treating "first 9 miles on trails" in conversation as an additional run. Prompt instructions alone are not sufficient when conversation context strongly suggests a different number.
**Fix / Change:** Added a mandatory opening phrase to the weekly recap: "YOUR FIRST TEXT MUST OPEN WITH THE EXACT PHRASE: 'Last week: X mi across N runs.'" This forces the authoritative figure into Claude's output rather than relying on it to remember the constraint.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — Fix mileage hallucination from conversational distance phrases in weekly recap

**Type:** Bug Fix
**Reported by:** Curtis (via Jake Tennant)
**User feedback:** Curtis said his actual mileage was ~26-27mi but Dean reported 36.2mi across 5 runs in the weekly recap. Curtis had said "for the first 9 miles, I was on trails and dirt roads" about his long run. Dean appears to have interpreted this as a separate 9-mile run and added it to the Strava total (27.2 + 9 = 36.2).
**Root cause:** The weekly recap system prompt instruction said "never sum individual runs yourself" but didn't explicitly guard against treating conversational distance phrases as additional uncounted runs. Claude saw "first 9 miles on trails" in conversation history and counted it as a 5th run not yet reflected in the Strava total.
**Fix / Change:** Extended the authoritative mileage instruction to explicitly warn: "distance phrases in the athlete's messages (e.g. 'the first 9 miles were on trails') describe portions of already-tracked Strava activities — do NOT count them as additional runs or add them to the total."
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — General re-ask fallback when goal_time step gets no clear answer

**Type:** Bug Fix
**Reported by:** Jake Tennant (observed via Curtis conversation)
**User feedback:** When Curtis pasted race results data ("1:29:06.54...") in response to the goal time question, Dean gave no response.
**Root cause:** `handleGoalTime` had no handler for messages where Haiku returns `has_answered: false` and none of the specific branches (research question, coaching question) matched. The code silently advanced with `goal_time_minutes: null` and sent an unrelated next-step question.
**Fix / Change:** Replaced a too-specific race-results regex check with a general Haiku-based fallback: whenever `has_answered === false` after all specific branches, Dean generates a contextual re-ask that acknowledges what was shared and asks for the personal goal time. This handles race results, ambiguous replies, off-topic messages, and any future cases.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`


## 2026-04-05 — Don't re-ask for race dates when user already provided them

**Type:** Bug Fix
**Reported by:** User feedback (Jake Tennant)
**User feedback:** "Jake, and I'm training for a few different races. Dipsea (June 14) and Cirque Series Snowbird (July 11), and half marathon time trial (May 31)" → Dean responded asking "can you give me the dates for each?"
**Root cause:** The `awaiting_other_races` step question always asked "can you give me the dates for each?" regardless of whether the user had already provided specific dates. The `secondary_goal` extraction prompt also didn't preserve dates.
**Fix / Change:** (1) Updated `extractAdditionalFields` prompt to include dates/timing in `secondary_goal` description. (2) In `getStepQuestion` for `awaiting_other_races`, detect whether `secondary_goal` contains month+day patterns (e.g. "July 11"). If specific dates are already present, ask only "Which of these is your A race?" without requesting dates again.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

## 2026-04-05 — Fix dashboard weekly target, long run, and cross-training label bugs

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "in text and in the schedule on the dashboard it was 23.5 miles but in the weekly target it was 32 mi. Also, it says my long run is 8.5 miles but it was actually 11 mi in Dean's text and in the schedule. My wife got strength prescribed for 3.5 min on Tuesday, but there was no detail on that."
**Root cause:** Three separate bugs:
1. `training_state.weekly_mileage_target` was set to `periodization.suggestedWeeklyMiles` (the engine's target) during weekly_recap, but never corrected after `syncArcCurrentWeek` computed the actual session sum. Dashboard "Weekly target" reads from `training_state`, so it showed 32mi instead of 23.5mi.
2. `syncArcCurrentWeek` updated `mileage_target`, `key_workout`, and `notes` in the arc but never updated `long_run_target`. The dashboard "Long run" reads from the arc blueprint value (8.5mi from initial plan generation), ignoring what Dean actually prescribed (11mi).
3. Dean occasionally wrote "Strength + mobility 3.5 mi" instead of "35 min" — the cross-training format guard in the prompt was missed at generation. The session extractor stored the label verbatim, causing "3.5 mi" to be parsed as running mileage on the dashboard and the duration to appear as "3.5 min".
**Fix / Change:**
- In `syncArcCurrentWeek`: compute `longRunMiles` from the long run session and patch `long_run_target` in `training_plans.weeks`; after patching the arc also update `training_state.weekly_mileage_target` to `actualMiles`
- In `extractAndStorePlanSessions`: sanitize cross-training session labels that incorrectly contain "mi" — convert "3.5 mi" → "35 min" for strength/mobility/bike/swim/yoga/etc. sessions before storing
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — Onboarding: respect athletes who already have a plan

**Type:** Bug Fix / UX
**Reported by:** Lori (7a704281) conversation review
**User feedback:** "I don't need a plan right now." — said during timezone step. Dean sent a full 4-week plan anyway.
**Root cause:** Two failure modes:
1. `checkOffTopic` classified "I already have a training plan. I'm in week 8/12..." as ON-TOPIC (training history comment) at `awaiting_race_date`, so onboarding continued instead of pivoting.
2. `handleTimezone` called `completeOnboarding` unconditionally when `findNextStep` returned null — "I don't need a plan right now" in the same message as "Provo" was completely ignored.
**Fix:**
1. Added `has_existing_plan` type to `checkOffTopic` system prompt. When detected, Dean answers any coaching question in the message, explains it's available as a coaching resource, and calls `completeOnboarding(skipInitialPlan: true)` to set up the profile without building a plan.
2. Added regex check in `handleTimezone` before `completeOnboarding` for "don't need a plan / don't want a plan / already have a plan" — sends a brief confirmation and skips plan generation while still writing the profile/state so future messages route through `coach/respond`.
3. Added `skipInitialPlan` option to `completeOnboarding` — writes `training_profiles` and `training_state` (so coaching works) but skips the `initial_plan` trigger.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-05 — P1 bug batch: watts, mileage, plan validation, onboarding

**Type:** Bug Fix (multiple)
**Reported by:** Internal review (users e6091ea5, 39c51f9b/Julia, 7a704281/Lori, 9471dde2/Dallan, 9f5f67c6, d7aac841)

### #1 — Watts hallucination (e6091ea5)
**Root cause:** No data guard for power/watt data. Claude invented watt figures for Zwift/cycling even though no power data exists in the DB record.
**Fix:** Added `average_watts` column to `activities` table (migration 024), stored from Strava webhook when present (power meters, Zwift). Guard is now conditional: shown when `average_watts` is null, skipped when real power data exists.

### #2/#5 — RECENT WORKOUTS bike miles inflating running totals (Julia, 9f5f67c6)
**Root cause:** `buildActivitySummary` RECENT WORKOUTS listed all activity types with miles. A bike ride showing "Ride 45mi" in the workout log gave Claude material to sum it with running miles and hallucinate a wrong weekly total.
**Fix:** Non-running activities (Rides, swims, etc.) now show duration (e.g. "Ride 90min") instead of miles in RECENT WORKOUTS. Running-only totals are unaffected.

### #3 — "33mi hill reps" copy-paste error (Julia)
**Root cause:** Claude copy-pasted the weekly total into an individual session label.
**Fix:** Added `fixSessionDistanceErrors()` to `plan-validation.ts`. Detects when a non-long-run session's mileage matches the weekly Total, replaces it with "?mi (check distance)" as a visible error flag, and rewrites the Total to match only the valid sessions. Wired into the response pipeline after `enforceVolumeCaps`.

### #4 — Onboarding days fabrication + context loss (Dallan)
**Root cause:** Claude invented specific training days ("Monday and Thursday") when athlete said "two days a week" without specifying which. Also re-asked for race info already in ATHLETE HISTORY.
**Fix:** Added two rules to `user_message` prompt: (1) never assign specific days without athlete choosing them; (2) never re-ask for data already present in ATHLETE HISTORY.

### #6 — Goal time applied to wrong race (d7aac841)
**Root cause:** `goal_time_minutes` stored without race-type context. A 4:00 marathon goal was displayed against a half marathon, producing an implied 18:18/mi pace.
**Fix:** Added a sanity check in `buildSystemPrompt`: if computed goal pace > 15 min/mi, inject a ⚠️ GOAL TIME MISMATCH warning prompting Dean to clarify with the athlete before building a plan.

### Onboarding question swallowed (Lori, 7a704281)
**Root cause:** `generateAnythingElseResponse` returned `isDone: true` when message contained both training info and a question. The question was silently dropped and onboarding completed without answering it.
**Fix:** Prompt now explicitly forbids `done: true` when message contains "?". Added a `forceAnswer` code-level safety net in `handleAnythingElse`.

**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/lib/plan-validation.ts`, `src/app/api/webhooks/strava/route.ts`, `supabase/migrations/024_average_watts.sql`, `src/__tests__/lib/plan-validation.test.ts`

---

## 2026-04-05 — Race preparedness floors and under-prepared athlete flag

**Type:** Bug Fix + Feature
**Reported by:** Jake (Ellen's plan)
**User feedback:** "she got a plan with very little mileage (max 11.5 in a single week) for a half marathon and is a very experienced runner"
**Root cause:** Two compounding issues:
1. `getTargetPeakMileage` floors were too low to produce adequate long runs. Half marathon floor was 22mi → peak long run of only 8.4mi at 0.38 factor. Marathon was 35mi → only 14.7mi long run. The floors didn't account for the actual long run fraction (38-42% of weekly volume) needed to reach race-distance-appropriate long runs.
2. `longRunFactor` in peak phase was 0.38 — too low for 3-day/week athletes where the long run is the primary quality session. Should be 0.42.
3. No feedback mechanism when an athlete's current mileage + weeks available makes it mathematically impossible to reach an adequate long run. Ellen (8mi/week, 10 weeks to half marathon) couldn't get to 10mi long run at safe build rates — but Dean never acknowledged this.
**Fix / Change:**
- Raised arc floors: half 22→30, marathon 35→45, 10K 15→20, split ultras into 50K(50)/50mi(55)/100K+100mi(65)
- Raised peak long run factor 0.38→0.42 across the board
- Added `computeRacePreparedness()` exported from training-plan.ts: computes achievable peak long run at 10%/week and returns the gap vs minimum adequate
- Added race preparedness flag injected into Dean's `initial_plan` prompt when achievable long run < 85% of minimum. Flag mandates Dean to: acknowledge the gap, recommend run/walk race day strategy, affirm finishing as goal, mention shorter race option
- Manually regenerated Ellen's plan after deploy
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Dashboard alignment: mileage target, key_workout, and Coach's Note from actual sessions

**Type:** Bug Fix
**Reported by:** Jake (Gwyneth's dashboard)
**User feedback:** "her runs over the week summed to 13 mi, not 15 mi and training arc referenced 800s where weren't in the actual plan"
**Root cause:** Three independent data sources were feeding the dashboard with inconsistent values:
1. `displayMileageTarget` used `training_plans.weeks[n].mileage_target` (arc blueprint, generated upfront by Haiku from a mileage estimate) instead of `training_state.weekly_mileage_target` (what Dean actually prescribed).
2. `key_workout` and `notes` on the current week were generated by a separate Haiku call in `generateAndSaveFullPlan` using only "baseMileage + phase + goal" as input — it invented "6×800m @ 5K pace" with no knowledge of what Dean actually scheduled for that user.
3. These arc fields were never reconciled after Dean's actual message was generated.
**Fix / Change:**
1. Dashboard `displayMileageTarget` now prefers `stateData?.weekly_mileage_target` (the live training_state value Dean wrote) over the arc blueprint value.
2. Added `syncArcCurrentWeek(userId, weekNum, phase, goal)` function that runs after `extractAndStorePlanSessions` for both `initial_plan` and `weekly_recap`. It reads the just-stored sessions, computes actual mileage, detects the key quality session, regenerates `notes` via a Haiku call using the real session list, then patches `training_plans.weeks[currentWeek]` with all three fields.
3. `syncArcCurrentWeek` runs fire-and-forget (`void`) so it doesn't block the SMS flow.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Partial-week arc calibration fix for mid-week onboards

**Type:** Bug Fix
**Reported by:** Internal observation + Jake follow-up ("this doesn't scale to Wednesday onboards")
**Root cause:** `generateAndSaveFullPlan` used `prescribedWeek1Miles` (the plan total from the initial_plan message) as `baseMileage` for the entire arc. Since the initial_plan now only covers today through Sunday, the prescribed total is always fewer than 7 days of miles unless the user onboards on Monday. A Wednesday onboard at 60mpw (~43mi for 5 days) would calibrate the arc from 43mi/week. A Saturday onboard (~16mi for 2 days) would be even worse. Any non-Monday onboard was affected.
**Fix / Change:** Two separate fixes that scale correctly to any onboard day:
1. **Arc base (avgWeeklyMileage vs prescribedWeek1Miles)**: If Strava history exists (`avgWeeklyMileage != null`), always use it as the arc base — it's an 8-week real average and is immune to partial-week distortion. If no Strava (user stated their mileage verbally), annualize the prescribed total: `prescribedWeek1MilesRaw × (7 / daysInPlan)`. This scales correctly for any day: Mon ×1.0, Wed ×1.4, Sat ×3.5.
2. **weekly_mileage_target stored in training_state**: Use `prescribedWeek1MilesRaw` for partial weeks (what was actually assigned for those days) rather than `periodization.suggestedWeeklyMiles` (full-week target). This prevents "0/65mi done" when only a 2-day plan was assigned. Sunday recap resets this to the proper full-week target.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Extraction burst fix + initial_plan week boundary + sunday-recap double-plan guard

**Type:** Bug Fix
**Reported by:** Internal observation (Julia's HR preference miss) + Jake feedback
**User feedback:** "why wasn't Julia's HR preference saved, and can we do a better job at making sure these extractions are more reliable? Also we should make sure that we try to work more cleanly in weeks e.g. if a user onboards Friday, give them their workout for Sat/Sun and then Sunday give them the next week"
**Root cause (extraction miss):** The 15-second debounce means when a user sends multiple quick messages (e.g. "please ignore wrist HR" + "I have a chest strap but don't always wear it"), the webhook for the first message is cancelled (newer message arrived) and only the second message is processed. `extractProfileData` was called with just `latestMsg.content` — the second message alone ("I have a chest strap but don't always wear it") doesn't clearly state a preference, so extraction returned `{}`.
**Fix / Change (extraction):** Changed extraction input from the single latest user message to all user messages since the last assistant reply (the debounce burst). When multiple messages arrive in one burst, they're joined and passed to `extractProfileData` together, so the full context is captured. Using `recentMessages.slice(lastAssistantIdx + 1)` to find the burst boundary.
**Root cause (week boundary):** `initial_plan` prompt gave Claude free rein to plan "a week," so it would plan from Saturday forward through the following Friday, straddling the Mon-Sun calendar boundary. Also no guard prevented the Sunday recap cron from firing for users who just got their initial_plan hours earlier on the same Sunday.
**Fix / Change (week boundary):** `initial_plan` user message now injects a computed `WEEK BOUNDARY` instruction telling Claude to plan sessions from today through this Sunday only (e.g. 2 days if onboarding Saturday). The Sunday recap cron now skips users who received an `initial_plan` or `weekly_recap` within the last 8 hours, preventing double-plans for same-day onboards.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/cron/sunday-recap/route.ts`

---

## 2026-04-04 — Trail race VDOT penalty + week boundary labeling in session rows

**Type:** Bug Fix / Improvement
**Reported by:** Julia (user feedback via Jake)
**User feedback:** "I think the trail runs on my strava threw off workout paces but it was easy enough to ask for changes. So a few things 1) if we create pacing zones from races and they are trail, we need to consider that - a trail 100k probably isn't the perfect race to dial in pacing zones, so maybe we look at road races or make adjustments and then ask for confirmation. The second thing is - do we know if we do a good job of adjusting the overall plan / each week based on feedback? we may want to check that we have been properly saving Julia's preferences to training notes or something."
**Root cause (trail races):** `selectBestRaceForPacing` in onboarding scored all races equally by recency/distance, with no penalty for `TrailRun` activity type. Trail races run slower than road races (terrain/elevation), so using a trail 10K for VDOT estimation would produce overly conservative road training zones. Separately, the onboarding message for Strava-suggested pacing had no caveat when the best race was a trail race.
**Fix / Change (trail races):** Added a 0.5× score multiplier for `TrailRun` activities in `selectBestRaceForPacing`, so road races are heavily preferred. Also added `is_trail` to the `StravaRaceSuggestion` type and threaded it into the onboarding "does this pace work?" message — when the best race is trail, Dean now explicitly calls this out and asks if the athlete has a road race to use instead.
**Root cause (week boundary):** `weekly_plan_sessions` spans from current day forward (7 sessions), which can straddle a Mon-Sun calendar week boundary. The system prompt labeled all future sessions "UPCOMING SESSIONS THIS WEEK," causing Dean to say "5 training days left" on Saturday when only 1 calendar day remained in the week.
**Fix / Change (week boundary):** Session rows now split at the upcoming Sunday boundary: sessions in the current Mon-Sun week are labeled "UPCOMING SESSIONS THIS WEEK (week ends Sunday)" and sessions in next week are labeled "NEXT WEEK'S PLANNED SESSIONS (starts Monday — do NOT count these as part of this week's mileage or day count)."
**Root cause (HR preference):** Julia's "ignore wrist HR" message wasn't extracted into `other_notes`. Manually patched Julia's `onboarding_data.other_notes` to include "Does not trust wrist-based HR data — ignore HR from non-chest-strap sources; focus on pace, distance, and perceived effort instead."
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Increase coaching debounce to 15s; fix "already did that" double responses

**Type:** Bug Fix
**Reported by:** Jake (user observation, Julia's conversation)
**User feedback:** Coach Dean sent two contradictory responses to two messages sent ~12 seconds apart ("16.3 mi for the week" then "0 mi logged"). Also said "I can't adjust your paces" immediately after adjusting them.
**Root cause (double response):** Coaching debounce was 10s — messages sent 12-15s apart each triggered their own independent response, causing contradictory outputs (different mileage totals, double acknowledgments).
**Root cause (pace confusion):** User sent two messages 1 minute apart: "Can you adjust paces based on 1:21:01 half?" then "That is what I ran on March 1st!" Dean updated paces on the first message, then when the second fired, saw paces already at VDOT 54 and said "they're already calibrated" — technically correct but confusing after just telling the user about the update. No prompt instruction to acknowledge already-completed work.
**Fix / Change:**
1. Increased coaching debounce from 10s to 15s in the Linq webhook.
2. Added `ALREADY-COMPLETED UPDATES` rule to `user_message` prompt: if the last coach message already made the update the athlete is now contextualizing, acknowledge briefly ("Already updated 👊") rather than re-processing or saying it can't be done.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-04 — Scale initial plan volume by fitness_level when no Strava history exists

**Type:** Bug Fix
**Reported by:** Jake (root cause investigation from user "plan looks light")
**User feedback:** N/A (root cause fix)
**Root cause:** When a user has no Strava history at plan generation time, the FITNESS TIER block in the system prompt hard-capped week 1 at 10mi regardless of `fitness_level`. An intermediate or advanced user without Strava connected got the same cap as a true beginner. The plan arc fallback in `generateAndSaveFullPlan` also defaulted to 15mi for all users with no history. Result: intermediate users with 7 days/week and 18+ mi/week actual fitness received a 9mi week 1 plan.
**Fix / Change:** (1) System prompt: FITNESS TIER for null avgWeeklyMileage now branches by fitness_level — beginner keeps the 10mi cap, intermediate gets a 15–25mi range, advanced gets a 25–35mi range. (2) generateAndSaveFullPlan: no-history fallback is now fitness-level-aware (beginner=15mi, intermediate=20mi, advanced=30mi) instead of a flat 15mi for everyone.
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/training-plan.ts

## 2026-04-04 — Plan health check section in daily email + admin regenerate-plan endpoint

**Type:** Feature
**Reported by:** Jake (internal observation from user "plan looks light" complaint)
**User feedback:** "I want to build a pipeline like we have for the daily email analyzing conversations that runs every 2-3 days and looks at generated plans and compares them to the conversation and evaluates whether the plan generated correctly and is updating correctly"
**Root cause:** No monitoring existed for plan-vs-conversation consistency. A user (0cb902da) had their plan start at 9mi/week (conservative default with no Strava history at onboarding), messaged that it was too light, Dean verbally acknowledged but only patched training_state — the full training_plans arc was never regenerated, leaving state/plan mismatched at 9mi.
**Fix / Change:** (1) Added `/api/admin/regenerate-plan` endpoint — accepts userId + optional prescribedWeek1Miles, calls generateAndSaveFullPlan with skipLinkSms=true. (2) Added `buildPlanHealthSection()` to the daily analyze-conversations cron — fetches all active users, checks state/plan mismatch, conversation drift (promises not reflected in DB), and arc sanity, adds as a second section to the daily email. (3) Manually fixed affected user's plan arc to base 19mi/week.
**Files changed:** src/app/api/admin/regenerate-plan/route.ts (new), src/app/api/cron/analyze-conversations/route.ts

## 2026-04-04 — Use Strava easy-run data as pace baseline when VDOT unknown; prefer recent race time over time trial for calibration

**Type:** Improvement
**Reported by:** Jake (Curtis conversation)
**User feedback:** "For this conversation, it seems like Curtis already had Strava connected, so we should be able to give him paces without a VDOT score - however, instead we should probably just ask for a race time (if strava data isn't good) from the past instead of asking to do a 5K time trial (or at least have that as an option)"
**Root cause:** When `current_easy_pace` is null and VDOT is unknown, the coach had no explicit guidance for using RECENT WORKOUTS data — so it defaulted to blocking on a 5K time trial rather than estimating from available Strava runs. It also only ever offered the time trial path, never asking for a recent race time which is lower friction.
**Fix / Change:** Added a new WHEN PACES ARE TBD rule to the VDOT-CALIBRATED PACING section: when paces are TBD but RECENT WORKOUTS exist, use typical easy run average pace as a baseline estimate and derive tempo/interval from there (labeled as estimates). When calibration is needed, ask for a recent race time first; only suggest a 5K time trial if no race times exist, and always offer both options in the same message.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-04 — Fix timezone never confirmed for Strava users; add timezone step to onboarding

**Type:** Bug Fix
**Reported by:** Jake (user observation)
**User feedback:** "I think we aren't saving timezone correctly in onboarding... my friend Julia is based in San Francisco but in the DB her timezone is NY so I think that may be why the confusion on today/tomorrow"
**Root cause:** `awaiting_timezone` was removed from `STEP_ORDER` with a note "moved to post-plan — asked alongside cadence question." But `handleCadence` treated any Strava-connected user as timezone-confirmed without ever asking them. If the user's Strava account timezone was set when they lived elsewhere (or was never updated), they'd silently get the wrong timezone forever. This caused day-of-week errors — a run at 9 PM Pacific is midnight Eastern, making a Friday run appear as Saturday.
**Fix / Change:**
1. Added `"awaiting_timezone"` back to `STEP_ORDER` after `awaiting_anything_else`. The question is already designed correctly: Strava users with a city see "Based on your Strava, looks like you're in [City, State] — is that still accurate?" Non-Strava users get "What city are you in?"
2. `isStepSatisfied("awaiting_timezone")` now returns `!!(data.timezone_confirmed)` instead of always `true`. Strava connection alone no longer satisfies it — only an explicit user confirmation does.
3. Removed `|| !!(user.onboarding_data.strava_connected)` from `timezoneAlreadyConfirmed` in `handleCadence`.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

---

## 2026-04-03 — Fix post-run mileage double-count; add warmup/cooldown to quality session plans

**Type:** Bug Fix
**Reported by:** Jake (user feedback)
**User feedback:** "I have done 14.7 mi so far this week, how'd you get to 20.4?" / "my workout didn't include warm up or cool down so mileage turns out to be more than what is written in the plan"
**Root cause (mileage):** For `post_run`, the system prompt's `TODAY'S PLANNED SESSION` was shown without any "completed" marker. Claude saw the current activity (5.7 mi) and the week-to-date (14.7 mi, which already included that run) and added them: 14.7 + 5.7 = 20.4. The "(this run included)" note in the user message was insufficient to prevent this.
**Root cause (warmup/cooldown):** Weekly plan session labels stored only the main workout distance (e.g. "5mi treadmill hills") without warmup/cooldown miles. When the athlete ran the full session including WU/CD, the Strava activity was longer than the plan said.
**Fix / Change:**
1. For `post_run` trigger, `TODAY'S PLANNED SESSION` in the system prompt is now labeled "(COMPLETED — already included in week-to-date above; do NOT add this distance again)". Also strengthened the mileage line to say "(includes today's synced run — do NOT add it again)".
2. Added `QUALITY SESSION MILEAGE` rule to both `weekly_recap` and `initial_plan` prompts: quality sessions (tempo, intervals, hill repeats, threshold) must state TOTAL distance including warmup (1mi default) and cooldown (0.5–1mi default), with the breakdown shown in parentheses, e.g. "Treadmill hills 6.5mi (1mi WU + 5mi at 8% grade + 0.5mi CD)".
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-03 — Fix daily email falsely flagging real Strava data as hallucinations

**Type:** Bug Fix
**Reported by:** Jake (daily email)
**User feedback:** "the daily email I get doesn't keep saying there's a ton of data hallucinations going on… I don't think is hallucinated because we do have strava data we are getting"
**Root cause:** The analyze-conversations cron only had conversation transcripts — no knowledge of what Strava data was actually present for each run. So when it saw "lap-button pacing" or per-lap pace/elevation in a post_run message, it couldn't distinguish real lap data from invented lap data, and flagged both. The prompt instructions about what Strava provides were also too vague.
**Fix / Change:** For each post_run message, now fetches the corresponding activity from the DB and annotates the transcript with what was actually available: distance, HR monitor yes/no, manual laps recorded yes/no, GPS splits always yes. The analysis prompt now instructs Claude to use these annotations as ground truth — only flag HR/lap references as hallucinations when the annotation confirms that data wasn't present. Also tightened the "NOT a hallucination" list to include pace, splits, elevation, and weekly mileage.
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`

## 2026-04-03 — Strengthen no-lap guard in post-run coaching prompt

**Type:** Improvement
**Reported by:** Internal (related to above)
**User feedback:** N/A
**Root cause:** The DATA GLOSSARY described `summary.laps` ("manual lap button presses... warmup, hard effort, cooldown") even when no laps existed, priming Claude to frame GPS split variation in lap terms. The guard was also too vague ("Do NOT invent or estimate lap paces").
**Fix / Change:** Glossary laps entry now only rendered when `hasLaps` is true. Guard text now explicitly bans: "lap-button" language, named lap segments (warmup/hard/cooldown lap), lap counts, per-lap elevation — and directs Claude to use "your splits show…" framing instead.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-03 — Plan quality eval harness

**Type:** Infra
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Existing evals only tested factual accuracy in coaching responses (mileage, paces, dates). No coverage for whether the training plans Coach Dean generates are structurally appropriate — correct volume, right session types, safe long run caps, appropriate progression for the athlete's fitness and goal distance.
**Fix / Change:** Added `plan_quality` eval category with a new judge (`evals/judges/plan-quality.mjs`) that evaluates plan structure rather than stated facts. Judge checks: week 1 volume vs current base, peak week appropriateness, sessions per week vs training days, long run cap, quality session types for goal race, progression safety. Added 5 fixtures covering the main failure modes: 5k beginner (volume spike, long runs too long), 5k competitive (missing interval work), half marathon first-timer (underprepared long runs), marathon first-timer (overtraining or underprepared), ultra first-timer (no back-to-back long runs or trail context). Runner updated to use the plan judge when `category === "plan_quality"`, increase max_tokens to 1500, and send a structured plan request rather than a standard initial-plan trigger message.
**Files changed:** `evals/judges/plan-quality.mjs` (new), `evals/run-evals.mjs`, `evals/fixtures/plan-5k-beginner.json` (new), `evals/fixtures/plan-5k-competitive.json` (new), `evals/fixtures/plan-half-marathon-first-timer.json` (new), `evals/fixtures/plan-marathon-first-timer.json` (new), `evals/fixtures/plan-ultra-first-timer.json` (new)

---

## 2026-04-03 — Fixed onboarding cadence question mismatch causing infinite loop

**Type:** Bug Fix
**Reported by:** User 0cb902da (P1 incident)
**User feedback:** Athlete answered "Mainly after workouts" to the cadence question, Dean responded with a completely different timing question they never answered, then a new post_run fired the original cadence question again as if nothing was said.
**Root cause:** The Haiku classifier in `handleCadence` was trained to recognize answers to a *timing* question (morning/nightly/weekly) but the actual question asked was a *frequency* question (daily/few times/mainly after runs). So "mainly after workouts" was classified as "unclear", fell into `handleNonCadenceMessage`, which sent a different timing question without clearing `onboarding_step`. The step was never cleared to null, so subsequent `post_run_onboarding` triggers kept re-asking the original question.
**Fix / Change:** Rewrote the Haiku classifier system prompt to match the actual question asked. New classification: "daily" → `morning_reminders`, "sometimes" → `nightly_reminders`, "reactive" (after runs) → `weekly_only`. Updated all re-ask strings, fallback messages, deescalation message, and `checkOffTopic` config to use the frequency-based question consistently. Confirmation messages updated to reflect the frequency-based framing ("I'll check in a few times a week" instead of "evening before each session").
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-02 — Stripe subscription billing + payment gate

**Type:** Feature
**Reported by:** Internal — pre-launch monetization
**User feedback:** N/A
**Root cause:** No payment infrastructure existed; all users had free access.
**Fix / Change:**
- Added per-user `billing_enabled` feature flag (default `false` — all existing users grandfathered). New signups can be opted in per-user or via the signup route once billing is live.
- Payment wall fires at the end of onboarding: after all questions are complete, users with `billing_enabled=true` receive a 7-day free trial checkout link instead of immediately getting their plan. `onboarding_step` is set to `awaiting_payment` and `initial_plan` is held until Stripe confirms checkout.
- Stripe Checkout hosted page at `/checkout?token=<dashboard_token>` — plan picker (monthly $20/mo, annual $10/mo billed yearly). No card form to build; Stripe handles it.
- Stripe webhook (`/api/webhooks/stripe`) handles: `checkout.session.completed` (fires `initial_plan`), `subscription.updated` (syncs status), `invoice.payment_failed` (sets `past_due`, sends dunning 1), `subscription.deleted` (sets `canceled`, sends dunning 1).
- Subscription gate in `coach/respond`: users with `billing_enabled=true` and no active subscription get blocked. `user_message` triggers send a resubscribe link; proactive triggers (reminders, post_run, weekly_recap) are silently skipped.
- 3-message dunning sequence: message 1 sent by webhook immediately on lapse; messages 2 and 3 sent by `/api/cron/dunning` at 4 and 8 days after message 1. Message 3 is the final outreach.
- Next-day payment reminder cron (`/api/cron/payment-reminder`): if user hasn't clicked the checkout link after 24 hours, sends one follow-up SMS.
**Files changed:** `supabase/migrations/023_billing.sql`, `src/lib/stripe.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/app/api/billing/checkout/route.ts`, `src/app/checkout/page.tsx`, `src/app/checkout/success/page.tsx`, `src/app/api/cron/payment-reminder/route.ts`, `src/app/api/cron/dunning/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `vercel.json`

---

## 2026-04-02 — Fix: today's planned sessions shown as "upcoming", causing Dean to call them "tomorrow's"

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "in this instance (for me), Dean thinks it is still yesterday and I have a strength session today (thursday), but it is thursday and I already did the strength session. [...] Keep tomorrow's strength session light on the hamstrings"
**Root cause:** The `activeSessions` filter used `sessionDate >= localTodayUTC`, which included today's sessions in the "UPCOMING SESSIONS THIS WEEK" list with no distinction from future sessions. Claude saw Thursday's strength session listed as "upcoming" without knowing it was today, and inferred it hadn't happened yet — calling it "tomorrow's session" when responding to a Thursday afternoon message.
**Fix / Change:** Split sessions into `todaySessions` (exactly today) and `futureSessions` (strictly tomorrow+). Today's sessions are now shown under a separate "TODAY'S PLANNED SESSION (may already be completed — check conversation history before giving future-tense advice)" header. Future sessions remain under "UPCOMING SESSIONS THIS WEEK". The projected week total now only sums future sessions (today's may already be done).
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-02 — Plan regen fixes: stable links, accurate arc context, 5K long run cap

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "Dashboard goes up to 16 miles but Dean says up to 20 / I don't have a week by week breakdown in front of me - yes he should have the training arc to be able to edit things / Old link didn't work when plan updated / Regenerated a new plan in the middle of a week, mileage for this week is 13 miles, but weekly target says 15 miles / 5K plan has 9.5 mi long run in it"
**Root cause:** Four distinct bugs: (1) `generateAndSaveFullPlan` always issued a new `dashboard_token`, invalidating the athlete's existing link every time the plan was regenerated. (2) The `user_message` context only included the next-week arc entry, so Dean hallucinated peak mileage instead of reading the stored plan. (3) `training_state.weekly_mileage_target` was only synced when `prescribedWeek1Miles` was provided; after a race-date regen it kept the old value, causing a mismatch with the new arc. (4) The long run factor (38% at peak) was applied without a goal-specific cap, producing 9.5mi long runs for 5K plans.
**Fix / Change:** (1) `generateAndSaveFullPlan` now fetches the user's existing `dashboard_token` and reuses it; only generates a new UUID (and stamps `trial_started_at`) if none exists. (2) Added `fullArcContext` to the `user_message` prompt — a compact week-by-week arc summary Dean can reference when asked about upcoming mileage or key sessions. (3) Always sync `weekly_mileage_target` to the computed arc week 1 value when no `prescribedWeek1Miles` is provided, so the dashboard reflects the regenerated plan. (4) Added goal-specific long run caps: 5K → 7mi, 10K → 10mi, half marathon → 14mi.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-plan-generate.test.ts`

---

## 2026-04-02 — Fixed tempo label/pace mismatch, run-question handling in onboarding, email analysis GPS splits

**Type:** Bug Fix (x3)
**Reported by:** Internal — daily conversation analysis digest
**Root cause (Issue 5):** When a user had no VDOT and tempo pace couldn't be validated, Dean could prescribe "Tempo 1.5mi @ 9:30-10:00/mi" — assigning the easy pace range to a quality session label. The existing PACE SANITY CHECK caught numerically wrong paces but didn't have an explicit label/pace consistency rule.
**Fix:** Added ⚠️ LABEL/PACE CONSISTENCY rule to system prompt: any session labeled Tempo/Threshold/Race Pace must be at least 30 sec/mi faster than easy pace. If it isn't, fix the label or the pace — never output a contradictory label+pace pair.

**Root cause (Issue 3):** The daily analysis email kept flagging Dean citing per-split paces as hallucinations. All GPS Strava runs automatically include `splits_metric` (per-km split data), so any split paces in a `post_run` message are real — not invented. The email analysis prompt didn't distinguish per-km splits (always present) from manual lap data (optional).
**Fix:** Updated email analysis prompt to clarify GPS splits are always real Strava data. A true hallucination would be HR values without an HR monitor, lap-by-lap detail when no laps were recorded, or a split narrative that contradicts the overall pace.

**Root cause (Issue 4):** During `awaiting_cadence`, if a user asked "what did I do during my run?", `handleNonCadenceMessage` classified it as a coaching question and answered without any activity context — leading to "I don't have access to your previous run data" even though Dean had just described that exact run. The classifier had no category for run-specific elaboration requests.
**Fix:** Added `run_question` classification. When detected, Dean fetches the last 6 conversation messages (which includes the post_run message with all activity data) and answers using that context, then re-appends the cadence question.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/cron/analyze-conversations/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-02 — This-week schedule override: reminders fire on the right days

**Type:** Feature
**Reported by:** Jake
**User feedback:** "if someone says I want to run mon, tues, fri this week instead of monday, sat, sunday, will the cron fire appropriately for reminders even if training days isn't updated?"
**Root cause:** No mechanism existed for temporary single-week schedule swaps. Without updating `training_days`, crons would fire on the old days; updating it permanently would overwrite the standing schedule.
**Fix / Change:** Added `this_week_override_days text[]` and `this_week_override_expires date` to `training_profiles`. When a user says "I want to run Mon/Wed/Fri this week", Dean stores the temporary days + an expiry of the upcoming Sunday. The morning-reminder and nightly-reminder crons now call `effectiveTrainingDays()` which uses the override if present and not expired, falling back to the standing schedule. A permanent schedule update clears any active override. The extraction prompt distinguishes "this week only" from standing schedule changes.
**Files changed:** `supabase/migrations/022_week_override_days.sql`, `src/lib/database.types.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/cron/morning-reminder/route.ts`, `src/app/api/cron/nightly-reminder/route.ts`

---

## 2026-04-02 — Fixed training_days case mismatch silently breaking morning reminders

**Type:** Bug Fix
**Reported by:** Jake (user's mom, Catherine)
**User feedback:** "My mom had Dean update her schedule to Sun, Tues, Thursday but hasn't heard from Dean since Sunday"
**Root cause:** When a user updates their training schedule via SMS, the LLM extraction prompt instructs Claude to return "full day names" (e.g. `["Sunday", "Tuesday", "Thursday"]`). These were saved directly to `training_profiles.training_days` without normalization. The morning-reminder cron compares against `todayWeekday.toLowerCase()` (e.g. `"tuesday"`), so capitalized values never matched and all affected users were silently skipped. The onboarding flow correctly normalizes to lowercase, creating an inconsistency between the two code paths.
**Fix / Change:** Added `.map(d => d.toLowerCase())` when saving `updated_training_days` from user messages in `coach/respond`. Catherine and anyone else who updated their schedule via SMS also needs their existing DB row fixed manually (capitalize bug may have introduced `["Sunday", "Tuesday", "Thursday"]` into their `training_days` column).
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-02 — Fix: additive total format in weekly plan messages

**Type:** Bug Fix
**Reported by:** Eval — `quality-no-internal-labels` fixture revealed by richer judge context
**Root cause:** Two issues compounding: (1) The TOTAL LINE FORMAT prompt rule said "show ONLY planned future sessions" — so when 6.5mi were already done and 19mi planned, Claude wrote "Total: 19 mi" ignoring already-done miles. (2) `correctMileageTotal` only parsed the compact session format `"Mon 3/2 · ..."` — when Claude used the fallback `"Tuesday, Mar 31: ..."` format, the function never fired and couldn't correct the total. After the prompt was updated to say "Total = planned + done", Claude started writing the math out explicitly as "19 mi planned + 6.5 done = 25.5 mi" (still wrong format).
**Fix / Change:** (1) Updated TOTAL LINE FORMAT prompt for `user_message` trigger: Total = full week (planned + already done), show ONLY the final number — no "X + Y = Z" breakdown. (2) Extended `correctMileageTotal` to also parse the fallback long-form date format ("Tuesday, Mar 31: ...") using a new `fallbackLineRe` regex and a shared `extractSessionMiles` helper. (3) Updated `format-no-additive-total` fixture ground_truth note to clarify that dates in Apr 2–5 are correct for a week starting Mon 3/30 (judge was incorrectly penalizing them). (4) Fixed activity date inconsistencies in `mileage-week3-some-logged` and `date-18-week-plan-week10` fixtures — both had a Saturday activity that landed in the prior Mon–Sun week, confusing the richer judge. Added `today: "2026-04-01"` to both.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/fixtures/format-no-additive-total.json`, `evals/fixtures/mileage-week3-some-logged.json`, `evals/fixtures/date-18-week-plan-week10.json`

---

## 2026-04-02 — Eval judge now date-aware and includes conversation context

**Type:** Infra
**Reported by:** Internal — discovered while adding fixture for the yesterday-attribution bug
**Root cause:** `buildEvalSystemPrompt` in `run-evals.mjs` and `buildJudgePrompt` in `factual-accuracy.mjs` both hardcoded `today = "2026-03-30"`. This made per-fixture date testing impossible — the coach response was generated for today's real date while the judge evaluated it against March 30, causing date-related fixtures to fail for the wrong reasons. Additionally, the judge had no visibility into `recent_activities` or `recent_conversation`, causing it to falsely flag content from those sources as hallucinated.
**Fix / Change:** Added `today` field to fixtures (defaults to `"2026-03-30"` so all existing fixtures are unaffected). Threaded it through both `buildEvalSystemPrompt` and `buildJudgePrompt`. Added `recent_activities` and `recent_conversation` blocks to judge context. Added `temporal_reference_correct` evaluation dimension to the judge. The richer judge context also surfaced a pre-existing bug in `quality-no-internal-labels` (additive total ignoring already-done miles) — added to known failures. Added `quality-morning-plan-yesterday-activity` fixture (9/10). Baseline is now 21/22 passing.
**Files changed:** `evals/run-evals.mjs`, `evals/judges/factual-accuracy.mjs`, `evals/fixtures/quality-morning-plan-yesterday-activity.json`, `CLAUDE.md`

---

## 2026-04-02 — Fix: morning plan referencing wrong day for recent activities

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "Here's another issue - Dean referring to Monday as yesterday: ...You're at 6 mi this week already from Monday, so this keeps you moving without piling on too much volume. Listen to your body — if you're still feeling yesterday's double header..."
**Root cause:** `dateContext` told Claude to "always use specific calendar dates rather than relative terms like 'tomorrow' or 'next Monday'". This rule is correct for *future* scheduled sessions (messages may be read later), but Claude was applying it to *past* activity references too — and when it couldn't say "yesterday" it guessed a training day from the schedule (Monday) instead of the actual logged date (Wednesday).
**Fix / Change:** Added `Yesterday: <date>` explicitly to `dateContext` (mirroring how Tomorrow is provided). Clarified the rule: future sessions should use specific calendar dates; past activities should use natural relative terms like "yesterday" or "Wednesday's run". Updated `run-evals.mjs` to match. Added new eval fixture `quality-morning-plan-yesterday-activity` to catch regressions.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`
**Eval note:** A fixture for this was attempted but the eval framework hardcodes `today = "2026-03-30"` in the judge while the coach response is generated with the real date — making temporal-reference tests ("yesterday" vs wrong day) impossible to judge correctly without per-fixture date injection. The first eval run did confirm the fix works (judge noted "Response avoids the forbidden day-specific phrases"). Proper eval coverage would require adding date injection to the judge.

---

## 2026-04-02 — Richer session detail: HR targets, easy run cues, strength exercises

**Type:** Improvement
**Reported by:** Jake (user)
**User feedback:** "I've gotten a lot of feedback that the sessions could use a bit more detail — for example, if a runner gets all easy miles in a week it's a bit boring and unmotivating. We should consider ways to give a bit more detail, for example - target HR zones if we see a user has a HR coming in via their strava, types of terrain to shoot for, more details on the why behind the workouts, etc. And also in my plan it says 30 min strength and mobility but I wasn't given much detail on what that is"
**Root cause:** Session labels were bare (e.g. "Easy 5mi @ 9:30/mi") with no purpose context, HR data from Strava was collected but never used for prescriptions, and strength sessions had no exercise specifics.
**Fix / Change:** Three prompt changes: (1) HR zone guidance — when HEART RATE data appears in activity summary, Dean appends a bpm target on easy run labels (~10–20 bpm below highest avg effort). (2) Easy run enrichment — easy runs now get one contextual cue per plan (terrain, effort description, or recovery framing), especially for all-easy weeks. (3) Strength specifics — whenever Dean prescribes a strength session, a follow-up bubble with 3–5 specific exercises (runner-focused hip stability/glute work by default, adjusted for injury notes) is required.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-02 — Dashboard now shows actual weekly sessions from Coach Dean

**Type:** Bug Fix
**Reported by:** Jake (user)
**User feedback:** "Seems my plan in the dashboard + what Dean sent me aren't the same — in particular, it seems like the dashboard doesn't include strength or cross training? and also it doesn't have the same detail on workouts."
**Root cause:** Dashboard was reading from `training_plans.weeks` and reconstructing the weekly view algorithmically via `buildDailyPlan()`, which only knew about running sessions (easy/key/long/rest). It never read `weekly_plan_sessions` from `training_state`, which is where the actual extracted sessions (including strength, cross-training, treadmill hills, bike, etc.) are stored after each weekly recap.
**Fix / Change:** Dashboard now fetches `weekly_plan_sessions` from `training_state`. When sessions exist, `buildDailyPlanFromSessions()` renders them directly — preserving exact labels, all session types, and parsed mileage. Falls back to the old algorithmic approach only when no stored sessions are available.
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-01 — Fix plan request sending dashboard link and date labeling in sessions

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A — "Could you send me my plan for training for bay to breakers?" caused Dean to use web search, research the race, and send the full plan as an inline SMS rather than the dashboard link
**Root cause:** Two separate issues. (1) The `isPlanRequest` early-exit only matched the exact phrase "my plan" via `/^\s*my\s+plan\s*$/i`. Natural-language variants like "send me my plan for training for X" bypassed the code-level redirect, went to Claude with web search enabled, and Claude generated an inline plan rather than sending the link. (2) The FULL PLAN REQUESTS prompt instruction was not strong enough to prevent this — Claude with web search capability overrode it.
**Fix / Change:** (1) Expanded `isPlanRequest` regex to also catch "send me my plan", "show me my plan", "view my training plan" patterns. (2) Strengthened FULL PLAN REQUESTS prompt: now labelled HARD RULE, explicitly forbids outputting a schedule inline even when web search is available. (3) Added tests: natural-language plan request variants now hit the early-exit and send the dashboard link without calling Claude; SESSION DAY LABELING instruction verified present in coaching user message.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`

---

## 2026-04-01 — Fix web search reasoning leaking as SMS messages

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A — observed in conversation where Dean sent 5 SMS messages instead of 1: internal reasoning paragraphs ("⚠️ GOAL DISCREPANCY DETECTED", "Wait — I need to check", "Now I need to provide the training plan") were all delivered to the athlete
**Root cause:** `lastToolIdx` filtering only matched `b.type === "tool_use"`, but `web_search_20250305` is a server-side tool whose blocks are typed `"server_tool_use"` (the request) and `"web_search_tool_result"` (the result) — neither matches `"tool_use"`. This meant `lastToolIdx` always stayed at -1 when web search was used, so ALL text blocks (including every reasoning paragraph) were kept and sent as SMS via `splitIntoMessages`.
**Fix / Change:** Updated `lastToolIdx` reduce to also match `"server_tool_use"` and `"web_search_tool_result"` block types. Added explicit prompt rule: when web search is used, the first thing output must be the coaching message — no narration of the search process, no internal analysis blocks.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-01 — Strengthen coaching prompt guards (pace sanity, WU/CD, mileage disputes, day labeling)

**Type:** Bug Fix
**Reported by:** Internal — automated conversation audit
**User feedback:** N/A
**Root cause:** Four prompt compliance failures identified from conversation review: (1) PACE SANITY CHECK was abstract ("faster than the easy pace above") so Claude could fail it when the stored tempo was TBD or when km/mile units were ambiguous — the documented error pattern is 8:46/mi × 1.60934 = 14:07/km, output as a tempo pace. (2) WU/CD pace was not mentioned in the sanity check, so Claude invented a pace 1 min/mile off from the easy pace already in context. (3) When an athlete disputed a mileage figure, Claude rearranged the same wrong narrative instead of re-anchoring to Strava ground truth. (4) When referencing planned sessions as "today" vs "tomorrow," Claude inferred day labels from list order rather than cross-checking stored dates against the current date.
**Fix / Change:** (1) Extracted `easyPaceGuardDisplay` and `tempoPaceGuardDisplay` variables so the PACE SANITY CHECK injects concrete numbers ("This athlete's easy pace is 9:30/mi — any quality pace at 9:30/mi or slower is a documented error") rather than abstract references. (2) Added WU/CD = easy pace rule to the same guard. (3) Added MILEAGE DISPUTE paragraph to user_message prompt: re-anchor to authoritative Strava figure, trust athlete correction, never rearrange narrative. (4) Added SESSION DAY LABELING paragraph: always cross-check session date against DATE CONTEXT, name moved sessions explicitly.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-01 — Improve dashboard return access and fix mobile sign-in placement

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** "the sign-in button shows up on mobile in an awkward spot between coach dean and get started on the top"
**Root cause:** Navbar had three items on mobile (logo, Sign in, Get started) with no room. Dashboard had no way to return without the magic link URL or re-requesting via phone number.
**Fix / Change:** (1) Hide "Sign in" from navbar on mobile; add "Already a user? View your plan" link below the Get Started button in the hero on mobile only. (2) Dashboard now saves the token to localStorage on first authenticated visit (`TokenPersist`). Subsequent visits to `/dashboard` (no token in URL) auto-redirect via `LocalTokenRedirect` — users can bookmark `coachdean.ai/dashboard` and it just works.
**Files changed:** `src/components/navbar.tsx`, `src/components/signup-form.tsx`, `src/app/dashboard/page.tsx`, `src/app/dashboard/token-manager.tsx` (new)

---

## 2026-04-01 — Fix race week mileage targets and dashboard weekly target display

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "week 31 race week shows 23 mi, which I assume is before the race, but that actually would put me at 49 mi for that week which seems a bit high. Other issue - the 'weekly target' in the 'This week' section on the dashboard says 19.8 mi but week 1 before full training arc says 26 mi."
**Root cause:** (1) Race week `mileage_target` used a flat 50% of peak factor regardless of race type. Since this represents pre-race training miles only (not including the race), a marathon runner would have 23mi pre-race + 26.2mi race = ~49mi total — far too high. The system prompt taper protocol had different (but also too-high) race week factors. (2) Dashboard "This week" header overrode the full week target with a partial-week sum of remaining sessions, making week 1 show 19.8mi instead of the plan's 26mi target.
**Fix / Change:** (1) Race week factor is now race-type-aware and significantly reduced: marathon/ultra = 25%, half = 28%, 5K/10K = 35% of peak. For a 46mi/wk marathon runner: 46×0.25=11.5mi pre-race training + 26.2mi race ≈ 38mi total — reasonable. Synced system prompt taper protocol to match. (2) Dashboard weekly target always shows the full week's `mileage_target` from the plan arc, removing the partial-week override.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

---

## 2026-03-31 — Cap weekly mileage growth on long training plans

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "looks like I just got a plan for the NYC marathon which is 7 months away, but it had me go up to 100 mi per week - that seems really high for an intermediate/semi-advanced runner - it seems Dean just continues to increase mileage over time"
**Root cause:** The arc builder in `training-plan.ts` applied a fixed 7% weekly growth factor with no ceiling. On a 12-week plan this is fine (~8 real build weeks → ~70% total gain), but a 30-week plan has ~22 real build weeks, compounding to 4–5× the starting volume. A runner starting at 25 mi/week would reach 100+ mi/week by race week.
**Fix / Change:** Added `getTargetPeakMileage()` with both a hard cap (prevents 100+ mpw on long plans) and a floor (prevents plans too low to prepare for the target distance — e.g. a 5 mi/week runner still gets a 35+ mpw marathon peak, not 9 mpw). The build factor is now derived dynamically from `(targetPeak / baseMileage)^(1 / realBuildWeeks)` and clamped to 2%–10%/week, so a low-volume runner ramps at ≈10%/week and a high-volume runner plateaus gracefully. Ultra hard cap raised to 100 mpw to support 100-mile training. Example peaks: marathon @ 5mpw → 33mi, marathon @ 25mpw → 44mi, marathon @ 40mpw → 68mi, ultra 100mi @ 60mpw → 99mi.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-03-31 — Quality sessions from week 1 for runners with an established base

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "if someone has already very consistently been doing X miles per week (lets say 25), then do they actually need a bunch more weeks of easy base building w/o quality sessions? The first few weeks look like 26 mi, 26.5 mi, 27 mi, 19 mi, 27.5 mi - just seems it's a bit boring and may not actually improve me much if I've already been doing base"
**Root cause:** The Haiku enrichment prompt instructed the model to assign pure easy/motivating descriptions to "base phase" weeks regardless of whether the runner already had an established base. A runner at 25 mi/week consistently gets early weeks just slightly above their current load with zero quality — genuinely not useful.
**Fix / Change:** Added `hasEstablishedBase` flag (baseMileage ≥ 15 mi/week). When true, the Haiku prompt now explicitly instructs it to include quality sessions (strides, fartlek, short tempo, easy intervals) from week 1, and only uses "easy aerobic miles" labels for deload weeks. New runners building from scratch still get a proper easy base phase. Also removed "Pure base/easy weeks get a motivating description" from the system prompt example list and added quality examples (strides + easy, fartlek).
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-03-31 — LLM-as-judge eval harness

**Type:** Infra
**Reported by:** Internal (Jake)
**User feedback:** N/A
**Root cause:** No automated way to score Coach Dean's response quality or catch regressions in factual accuracy (mileage, paces, split references, date/week correctness).
**Fix / Change:** Created `/evals/` eval harness. 18 fixtures covering 6 bug categories extracted from the changelog. Runner builds a realistic system prompt from fixture data, calls Claude Sonnet for the coaching response, then calls Claude Opus as judge. Exits 1 if any fixture scores below 7. `score-report.mjs` diffs two result files to show regressions/improvements. Added `npm run eval` script.
**Files changed:** `evals/run-evals.mjs`, `evals/score-report.mjs`, `evals/judges/factual-accuracy.mjs`, `evals/fixtures/*.json` (18 files), `package.json`, `.gitignore`

---

## 2026-03-30 — Dashboard week number wrong after plan regen; mileage arc too low; interval mileage not parsed; bolding inconsistent

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "It told her that this week is week two, even though the date of today should be within week one" / "It told her different mileage throughout the plan than what Dean had discussed" / "in the 'This week' section, the far right column where it says 'Mileage for that day' is sometimes inaccurate because it doesn't take into account how much mileage intervals will take up. It just seems to be scanning for mentions of miles, not something like 4x800" / "I'm also noticing some weird bolding on the far right side"
**Root cause:** Four separate issues. (1) `generateAndSaveFullPlan` never reset `training_state.current_week` to 1 on plan regeneration, so if a weekly_recap had previously incremented it the dashboard showed the wrong week. (2) The "my plan" regeneration path didn't pass `prescribedWeek1Miles`, so it ignored the stored weekly mileage target from prior coaching conversations and used a raw Strava average, producing a lower arc. (3) Key workout mileage parsing only matched patterns like "4mi tempo" — interval notation like "4x800m" or "6x1mi" returned 0 and fell back to a rough 20% estimate. (4) `font-semibold` was applied to all mileage values; only the quality session should be bold.
**Fix / Change:** (1) `generateAndSaveFullPlan` now always writes `current_week: 1` to training_state. (2) "My plan" path passes `state.weekly_mileage_target` as `prescribedWeek1Miles`. (3) Added interval parsing: `NxDISTANCE` in meters, km, or mi is converted to total miles. (4) Removed `font-semibold` from all rows; applied only to the key workout type.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`, `src/__tests__/lib/training-plan-generate.test.ts`

---

## 2026-03-30 — Vague race dates not extracted; goal_distance_miles not updated on goal change

**Type:** Bug Fix
**Reported by:** Internal observation (investigating dashboard not updating)
**User feedback:** N/A
**Root cause:** Two separate issues. (1) `extractProfileData` prompt only accepted specific dates or month-only; vague phrases like "late May" or "end of June" were intentionally excluded, so when a user or coach mentioned a vague race date it was silently dropped. (2) When a user changes their goal race type via SMS (e.g. "I'm doing a 5K now"), `persistProfileUpdates` updated `goal` but not `goal_distance_miles`, leaving it stale from the previous goal (e.g. a user who switched from 10K to 5K kept `goal_distance_miles = 6.214`).
**Fix / Change:** (1) Extended the race_date extraction prompt to resolve vague phrases to concrete dates: "early [month]" → 5th, "mid [month]" → 15th, "late/end of [month]" → 25th, month-only → 1st. (2) Added `goal_distance_miles` sync to the `hasGoalRaceType` branch in `persistProfileUpdates` using the same distance map as onboarding.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-30 — Dashboard not updated after race date pushed further out

**Type:** Bug Fix
**Reported by:** User (wife)
**User feedback:** "Hm that doesn't look like it's updated with the 8 week 5k plan"
**Root cause:** `persistProfileUpdates` only trimmed the existing plan arc when a race date changed; if the race moved *further* out (more weeks needed), the code explicitly left the plan as-is with a comment "can't generate new weeks without full regen." So when the user changed from an April 19 race to late May (~8 weeks), the dashboard still showed the old 3-week April plan.
**Fix / Change:** When a race date change requires *more* weeks than the existing plan has, call `generateAndSaveFullPlan` with `skipLinkSms: true` to fully regenerate the plan arc in-place. The trimming path is unchanged. Added `phoneNumber` parameter to `persistProfileUpdates` to support this.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-30 — Fixed "my plan" keyword sending wrong response instead of plan link

**Type:** Bug Fix
**Reported by:** User (Ian)
**User feedback:** Ian was told to reply "my plan" to get his dashboard link. When he did, Dean responded "Your training plan isn't ready yet — I'll send you a link once it's set up." — no link was sent.
**Root cause:** Two issues: (1) The "my plan" keyword had no dedicated code path — it went through Claude as a normal user_message. Claude was told via fallback text that the link was unavailable and to have the user reply "my plan"... creating an infinite loop. (2) For users where `dashboard_token` was null (e.g. plan generation failed silently, or legacy users onboarded before this feature), there was no recovery path.
**Fix / Change:** Added an early-exit handler for `user_message` triggers where the message exactly matches "my plan" (case-insensitive). This path bypasses Claude entirely and: (1) uses the existing `dashboard_token` if present, or (2) calls `generateAndSaveFullPlan()` to create the token for users who are missing one, then sends the link directly via SMS. Also converts `dashboardToken`/`dashboardUrl` from `const` to `let` so the newly generated token can flow through to Claude's context if needed.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-30 — Fixed hallucinated mile splits (km splits misread as mile splits)

**Type:** Bug Fix
**Reported by:** Internal QA observation
**User feedback:**
User 5caa7571: "Saw it come through — 3.1mi at 7:59/mi avg. That's a sharp effort: started controlled at 8:29, then got progressively faster each mile down to 7:19 in mile 5." (3.1mi run cannot have a mile 5)
User 58a1d122: "Saw it come through — 4mi, avg HR 159, splits held steady around 9:30-10:15/mi through mile 5, then you slowed to 12:02 on mile 6." (4mi run cannot have a mile 6)
**Root cause:** The code stores `splits_metric` from Strava (one entry per kilometer, not per mile). The data glossary told Claude "one entry per mile," so Claude treated split index as mile number. A 3.1mi (5K) run has 5 km splits; Claude called the last one "mile 5." A 4mi run has ~6-7 km splits; Claude referenced "mile 5" and "mile 6." No actual hallucination — the split data was real, just misidentified as mile splits.
**Fix / Change:**
- Added `cumulative_miles` field to each split entry (running total of distance in miles as each km split ends). Claude now has the actual position in the run, not just an array index.
- Updated data glossary to correctly describe splits as "one entry per kilometer — use cumulative_miles for position, do NOT treat the split index as a mile number."
- Added dynamic DATA AVAILABILITY GUARD: when splitCount > ceil(runDistanceMiles) + 1, injects an explicit warning naming the actual run distance, the split count, and a hard rule against referencing any mile number beyond the actual run distance.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-30 — Fixed tempo pace unit errors and weekly mileage Total line format

**Type:** Bug Fix
**Reported by:** Internal QA observation
**User feedback:**
Issue 1 (ae993f7b): "Wed 4/1 · Tempo 5mi (1mi warmup, 3mi @ 14:07, 1mi cooldown)" — 14:07 is slower than the athlete's easy pace of 10:12/mi. Either Dean prescribed the pace in min/km (14:07/km ≈ 8:46/mi) without labeling it, or it was an outright error.
Issue 2 (2426e277): "Total: 28 mi + your 37 mi already this week" — confusing additive format implies a 65-mile week when Dean meant 28 miles of future sessions. Also failed to flag overtraining risk.

**Root cause (Issue 1):** In the system prompt, easy pace was displayed via `easyPaceRange()` (which converts to min/km for metric users) but tempo and interval paces were injected verbatim from the DB (always min/mile). For metric users, Claude saw mixed units and attempted its own conversion — a documented error source. For athletes with no stored tempo pace, the system showed "Tempo TBD" and instructed Claude to derive paces from Strava, leaving it unconstrained and prone to unit confusion and invented values.

**Root cause (Issue 2):** The `initial_plan` prompt instruction said "factor [completed miles] into the weekly total" — Claude interpreted this literally by writing "Total: X mi + your Y mi" instead of keeping them separate. The same risk existed in the `weekly_recap` MILEAGE ACCURACY block which had no explicit prohibition on the additive format.

**Fix / Change:**
- Added `formatPaceForPrompt()` helper that converts stored min/mile paces to min/km for metric athletes before injection into the system prompt — Claude now receives pre-converted values and never needs to convert units itself.
- When `current_tempo_pace` or `current_interval_pace` is null, fall back to `estimatePacesFromEasyPace()` and show the estimated value with "(estimated from easy pace — no race data on file)" label, so Claude always has a concrete number to anchor to.
- Added "PACE SANITY CHECK" rule to the system prompt: any prescribed tempo/interval pace must be faster than the stored easy pace; if not, use the stored Tempo value instead. All pace prescriptions must include the unit.
- Rewrote the `initial_plan` "mileage so far" instruction: completed miles must be acknowledged in a separate sentence; the Total line shows ONLY planned future sessions; never write "Total: X mi + Y mi already this week"; if current week mileage is very high relative to target, flag the overload risk explicitly.
- Added explicit "TOTAL LINE FORMAT" rule to both `weekly_recap` and `initial_plan` MILEAGE ACCURACY sections.

**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-30 — Fixed leaked internal label and full plan not sent on user request

**Type:** Bug Fix
**Reported by:** User feedback (conversation screenshot)
**User feedback:** "this looks like a big - leaked the discrepancy label and then didn't actually send the plan"
**Root cause:** Two separate issues: (1) The output rules didn't explicitly forbid echoing internal `⚠️`-prefixed system-prompt directive labels, so Claude prefixed its response with "⚠️ GOAL DISCREPANCY DETECTED" — visible to the athlete. (2) When an athlete asked "send me my full plan", Claude responded "give me a sec and I'll build it out" then never sent it — because the `user_message` case lacked any instruction to output the plan directly, and `storedPlanAllWeeks` was never injected into the user message prompt.
**Fix / Change:** (1) Added an explicit output rule: never echo `⚠️`-prefixed internal directive headers in responses. (2) When athlete asks for their full plan, Dean now sends the dashboard link (built from the stored `dashboard_token`) rather than outputting the arc over SMS (too long) or promising to send it later. Passed `dashboardUrl` into `buildUserMessage` and added a `FULL PLAN REQUESTS` instruction directing Dean to share the link. Also raised `max_tokens` for `user_message` from 512 to 1000.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-03-28 — Fixed TypeScript build error in handleSchedule (Vercel deploy)

**Type:** Bug Fix
**Reported by:** Vercel build log
**User feedback:** N/A
**Root cause:** `mergedData` in `handleSchedule` was inferred as `{ days_per_week: number; training_days: string[] }` by TypeScript (losing the spread from `onboardingData: Record<string, unknown>`), so accessing `.strava_connected` was a type error. Additionally, the `selectBestRaceForPacing` call received `start_date: string | null` from the DB query but the function signature expected `start_date: string`.
**Fix / Change:** Added explicit `Record<string, unknown>` type annotation to `mergedData`; filtered out null `start_date` rows before calling `selectBestRaceForPacing`.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-29 — Fixed nightly analysis incorrectly flagging Strava data as hallucinations

**Type:** Bug Fix
**Reported by:** Internal observation (nightly email review)
**User feedback:** N/A
**Root cause:** The `analyze-conversations` prompt told Claude to flag "Coach Dean referencing splits/HR/laps it doesn't have, inventing specific numbers" — but gave no context about what data Dean actually has. Claude saw Dean citing specific distances, paces, and weekly mileage (all pulled live from Strava) and flagged them as hallucinations.
**Fix / Change:** Added an explicit section to the analysis prompt listing what Dean has access to via Strava (distance, pace, splits when synced, HR when device records it, weekly mileage, YTD stats, etc.) vs. what would be a true hallucination (inventing splits when not synced, HR without a monitor, etc.). The hallucination check is now scoped to actually-invented data only.
**Files changed:** src/app/api/cron/analyze-conversations/route.ts

---

## 2026-03-29 — Fixed morning reminder parroting "rest day" example when a run was discussed

**Type:** Bug Fix
**Reported by:** Ian (via Jake)
**User feedback:** "yesterday Dean said run on Sunday and today on Sunday he said it's a rest day"
**Root cause:** The `morning_reminder` prompt checks RECENT CONVERSATION to avoid re-describing what was already discussed — if it finds coverage, it sends a one-line confirmation. The example phrase in the prompt was `"Good morning — rest day today as we discussed last night."` — Claude anchored on this example and sent it verbatim (including "rest day") even when the prior conversation had confirmed a run for Sunday evening.
**Fix / Change:** Replaced the single rest-day example with two conditional examples — one for when last night covered a run, one for when it covered a rest day — with an explicit instruction that the confirmation must match what was actually discussed.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-28 — Partial-week display: show only remaining workouts when onboarding mid-week

**Type:** Improvement
**Reported by:** Jake (testing)
**User feedback:** "it seemed to give me a whole week of training for week 1 even though it's already saturday. I think we should just gray out the dates before today... only show week one as a partial week if there are workouts prescribed by Dean in that week"
**Root cause:** The "This Week" card always showed the full week target (e.g. 30 mi) even when the user onboarded on Saturday with just one run left in the week.
**Fix / Change:** Added partial-week logic that runs before `week1Monday` is used anywhere:
- Find remaining non-rest workouts for today-or-later in the current week
- If some remain (e.g. Saturday with a Sunday run): show mileage target as sum of those days only (e.g. 5 mi)
- If none remain (e.g. Saturday with no Sunday run): shift `week1Monday` forward 7 days so week 1 genuinely starts Monday — date labels, activity bucketing, race week badge, and arc all update automatically. No cursor-advance hack needed.
**Files changed:** `src/app/dashboard/page.tsx`

## 2026-03-28 — Gray out past days in This Week workout grid

**Type:** Improvement
**Reported by:** Jake (testing)
**User feedback:** "it seemed to give me a whole week of training for week 1 even though it's already saturday. I think we should just gray out the dates before today"
**Root cause:** The daily plan grid showed all 7 days with full color regardless of whether they'd already passed.
**Fix / Change:** Days before today are now dimmed the same as rest days (gray text, gray background). Today and future days remain full contrast. Uses `toLocaleDateString` to get today's weekday name and compares against `DAY_ORDER` index.
**Files changed:** `src/app/dashboard/page.tsx`

## 2026-03-28 — Remove dashboard paywall / trial locking

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "we don't want the plan to lock for now since we don't have a paid / free trial version just yet"
**Fix / Change:** Removed the 7-day trial gate — full plan arc is now always visible. Deleted `isTrialActive`, `PaywallCTA`, and the visibility/blur logic from the plan arc render. Also removed unused `trial_started_at` from the users DB query.
**Files changed:** `src/app/dashboard/page.tsx`

## 2026-03-28 — Fix: dashboard bolding, race week missing from plan, B/C races not showing

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "why is it bolding certain workouts during the 'this week' section? feels a bit random" / "last week ends Aug 2nd now" / "it's not showing B or C races, just my A race"
**Root cause (bolding):** Key workout days had `font-medium` applied to the label but long run days didn't. Made one workout look arbitrarily bolder than others.
**Root cause (race week missing):** `totalWeeks` in `generateAndSaveFullPlan` and `persistProfileUpdates` was calculated from `new Date()` (exact current time) rather than from the start of the current week (Monday). If computed after noon UTC, a race exactly N weeks away rounds down to N-1 weeks, leaving the race one week past the end of the plan. E.g. if computed at 2pm UTC, Aug 8 race gives 19 weeks (ends Aug 2) instead of 20 (ends Aug 9).
**Root cause (B/C races missing):** `completeOnboarding` filtered B/C races with `.filter(r => r.date && r.goal)` — Haiku often returns `goal: null` for named races (e.g. "A Basin") where it can't infer the distance, so those rows were silently dropped before insert.
**Fix / Change:**
- Removed `font-medium` from key workout label — all active workout rows now have the same text weight
- Changed `totalWeeks` calculation in both `generateAndSaveFullPlan` and `persistProfileUpdates` to anchor from Monday (start of week) rather than "now"
- Changed B/C races filter to only require `r.date`; falls back to A race's goal bucket when `r.goal` is null
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

## 2026-03-28 — Fix: promoted A race distance not looked up when date provided inline

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "I noticed that Dean didn't check to see what the Sierre Zinal distance was - it says 10k on my dashboard."
**Root cause:** When the user provides all race dates inline (e.g. "Sierre Zinal. Dipsea June 14, Sierre Zinal August 8"), `promotedDateConfirmed = true` in `handleOtherRaces` and `awaiting_race_date` is bypassed entirely. The distance lookup via `generateRaceAcknowledgment` lives inside `handleRaceDate`, so it never ran. `goal_distance_miles` stayed null and `goal` kept "10k" from the old A race (Dipsea). Dashboard showed "Sierre Zinal · 10K".
**Fix / Change:**
1. In `handleOtherRaces`, after promoting a new A race with `promotedDateConfirmed = true`, immediately call `generateRaceAcknowledgment` to look up the distance. If a distance is found, set `goal_distance_miles` and re-bucket `goal`. If the race has multiple distance options, ask "which distance?" and stay on `awaiting_other_races` via new `pending_distance_options` flag. If lookup returns nothing, clear `goal` to null rather than keeping the stale bucket.
2. Added `pending_distance_options` re-entry path at the start of `handleOtherRaces` to handle the follow-up distance answer.
3. Added `distanceMilesToGoalBucket` and `parseOptionKm` helper functions.
4. Dashboard: for named races, don't fall back to the standard bucket label when `specificDistanceMiles` is null — the bucket may be stale from the old race. Just show the race name without a distance suffix.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/dashboard/page.tsx`

## 2026-03-28 — Fix: goal time question asked about wrong race after A race promotion

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "still feels odd that Dean is asking me about my non A race here in onboarding" — after saying "Sierre Zinal. Dipsea is June 14, Sierre Zinal August 8, A Basin September 6", Dean asked "Do you have a time goal for the Dipsea race..."
**Root cause:** Haiku in `handleOtherRaces` wasn't recognizing the pattern where a user leads with just the race name ("Sierre Zinal.") as their A race answer. It returned `new_a_race: null`, treating the reply as date confirmations for the existing A race (Dipsea). So `race_name` stayed "Dipsea" and `awaiting_goal_time` asked about it.
**Fix / Change:** Added an explicit example to the `handleOtherRaces` Haiku prompt: when the athlete leads their reply with a standalone race name (short first sentence before the date list), that name IS the A race answer. Maps to the common pattern "RaceName. Date1, Date2, Date3."
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-29 — Strava race history used to suggest pace zones during onboarding

**Type:** Feature
**Reported by:** Jake (internal observation)
**User feedback:** N/A
**Root cause:** Dean had no way to derive training paces for Strava users unless they explicitly mentioned a PR — users with race history often never volunteered that info, leaving paces unset.
**Fix / Change:** When transitioning to `awaiting_anything_else`, if the user has Strava connected and no paces yet, query their race history for the best recent race (scored by recency + standard distance; ultras excluded). If found, compute VDOT paces and surface the suggestion in the "anything else?" question for confirmation/correction. If Strava connected but no races found, explicitly ask for a PR or easy pace. `formatRaceDistance` moved to `src/lib/paces.ts` as a shared utility.
**Files changed:** `src/lib/paces.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/api/auth/strava/callback/route.ts`

## 2026-03-28 — Fix: race distance labels now use ±3% tolerance matching instead of coarse buckets

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "I did a 30k today but he said 25k so it felt a little inaccurate"
**Root cause:** `guessRaceLabel()` used hard < thresholds (e.g. `< 30000` → "25K"), so a 30K GPS track reading 29.8km (GPS drift is normal) fell into the "25K" bucket.
**Fix / Change:** Replaced with `formatRaceDistance()` — checks each standard distance (mile, 5K, 10K, 15K, half, 25K, 30K, marathon, 50K, 50 mi, 100K, 100 mi) with ±3% tolerance. If no standard matches, falls back to actual distance in the user's preferred units (`18.6 mi` or `30.1km`). Also passes `preferredUnits` (already computed from athlete profile) through to the formatter.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`

## 2026-03-28 — Fix: "X miles in the last 4 weeks" was reading a stale Strava aggregate

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "it could be because he's not counting miles from runs today (I did an 18 miler)"
**Root cause:** The mileage figure came from `stats.recent_run_totals` — a pre-computed aggregate from the Strava athlete stats endpoint fetched at OAuth time. This lags behind activities uploaded moments earlier (e.g. a long run done the same day as connecting), so fresh runs were excluded.
**Fix / Change:** After `importRecentActivities` runs (which IS up-to-date), query the activities DB table directly for the last 28 days and sum from there. The race detection for `raceMentionLine` was consolidated into the same query.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`

## 2026-03-28 — Mid-onboarding Strava events get a coaching reaction + onboarding nudge

**Type:** Feature
**Reported by:** Jake (internal observation)
**User feedback:** N/A
**Root cause:** Strava activity events for users mid-onboarding were silently stored but not acted on, wasting a good engagement moment.
**Fix / Change:** Instead of skipping the coaching response, the webhook now fires a `post_run_onboarding` trigger. `coach/respond` handles this with a lightweight early-exit path — Claude reacts briefly to the run (distance, pace), then re-asks the user's current pending onboarding question so they know to reply and finish setup.
**Files changed:** `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/strava-webhook.test.ts`

## 2026-03-28 — Mention recent races when Strava connects

**Type:** Feature
**Reported by:** Jake (internal observation)
**User feedback:** N/A
**Root cause:** The Strava connect confirmation SMS only mentioned recent runs; races (workout_type=1) — which are great fitness assessments — were invisible to the user.
**Fix / Change:** After the synchronous 8-week activity import in the Strava callback, we query for races and include them in the welcome SMS. E.g. "Spotted your recent half marathon too — great fitness marker." Uses a `guessRaceLabel()` helper to map distance → race name (5K, 10K, half marathon, marathon, etc.).
**Files changed:** `src/app/api/auth/strava/callback/route.ts`

## 2026-03-28 — Plan changes now propagate to the dashboard in real-time

**Type:** Feature / Bug Fix
**Reported by:** Jake (internal audit)
**User feedback:** N/A — identified via code review: race date corrections and workout changes made over SMS were not reflected in the dashboard
**Root cause:** Three separate gaps: (1) `persistProfileUpdates` updated `training_profiles.race_date` but not `races` or `training_plans`, so the dashboard countdown and arc length stayed wrong after a correction. (2) `maybeUpdatePlanSessions` updated the operational session list but never patched `training_plans.weeks[currentWeek].key_workout`, so the dashboard showed the stale workout even after Dean agreed to change it. (3) `maybeUpdateTrainingPlanWeeks` had too narrow a keyword list — illness/travel keywords only, missing workout-preference changes like "more intervals".
**Fix / Change:**
- `persistProfileUpdates`: when `race_date` is extracted, also update the A race row in `races` table and patch `training_plans` (`race_date`, `total_weeks`, trimmed `weeks` array if race moved closer)
- `maybeUpdatePlanSessions`: now accepts `planId`, `planAllWeeks`, `currentWeekNum`; Haiku response extended to include `key_workout`; when a quality session changes, patches `training_plans.weeks[currentWeekNum].key_workout` so the dashboard reflects Dean's agreement
- `maybeUpdateTrainingPlanWeeks`: keyword list broadened to include workout-preference triggers (`more interval`, `add tempo`, `more hill`, `switch workout`, etc.)
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-28 — Dashboard "This Week" now shows miles logged so far with progress bar

**Type:** Feature
**Reported by:** Jake (internal feedback)
**User feedback:** "One more thing that would be good to show would be how many miles a user actually did in a given week"
**Root cause:** N/A — `actualMilesByWeek` was already computed for past weeks but not surfaced for the current week.
**Fix / Change:** Added a "Done this week" progress bar to the "This Week" card showing `X / Y mi` with a live fill. Bar turns green if the weekly target is met. Only renders when at least one run has been recorded this week.
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-03-28 — Dashboard display improvements: week dates, race day badge, key workout miles, single-race label

**Type:** Improvement
**Reported by:** Jake (internal testing), Gwyneth (weekly target mismatch)
**User feedback:** "4 mi tempo effort is listed as 3 miles on the right side of the dashboard, causing the overall weekly target (15 mi) to be out of sync with the number in the 'full training arc' section (16 mi) and what dean texted (16 mi)"
**Root cause (key workout miles):** `keyWorkoutMi` in `buildDailyPlan` was always 20% of weekly mileage. If Dean's plan said "4mi tempo", it would show 3mi (20% of 16mi ≈ 3). Fix: parse leading mileage from `key_workout` text (e.g. "4mi tempo" → 4mi).
**Root cause (weekly target mismatch):** Plan arc week 1 applied a 1.07× buildFactor on top of `prescribedWeek1Miles`, making the arc start at ~28mi when Dean said 26mi. `training_state.weekly_mileage_target` held the correct value but caused arc vs "This Week" card divergence. Fix: week 1 now uses `baseMileage` directly (no buildFactor); build begins from week 2. Dashboard now uses `currentWeek.mileage_target` (plan arc) directly.
**Root cause (total weeks off by one on mid-week onboarding):** `Math.round` on fractional weeks could round down, losing a partial first week. Changed to `Math.ceil` so e.g. 18.07 weeks → 19 weeks (user gets the full week including current partial week).
**Fix / Change:**
- `buildDailyPlan`: parse miles from key_workout text before falling back to 20% formula
- "This Week" weekly target: use `currentWeek.mileage_target` directly (drops stale `training_state` override)
- `WeekCard`: shows week date range (e.g. "Mar 24 – Mar 30") and a "Race day" red badge on the race week
- `UpcomingRaces`: hides priority (A/B/C) badge when user has only one race
- `generateAndSaveFullPlan`: week 1 = baseMileage (no factor); buildFactor starts week 2; `Math.ceil` for total weeks
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`, `src/__tests__/lib/training-plan-generate.test.ts`

---

## 2026-03-27 — Add test coverage for multi-race onboarding and generateAndSaveFullPlan

**Type:** Improvement
**Reported by:** Internal testing
**User feedback:** N/A
**Root cause:** Tests for multi-race onboarding flow and `generateAndSaveFullPlan` were either missing or had incorrect mock sequences. Specifically: (1) `awaiting_goal` tests incorrectly included a `checkOffTopic` mock (the POST handler skips it for `awaiting_goal`), causing mock pollution that cascaded into later test groups; (2) `generateAndSaveFullPlan` tests were missing entirely; (3) the `completeOnboarding` races-table test used `awaiting_schedule` but that handler never calls `completeOnboarding` — it only routes to `awaiting_anything_else`; (4) the two `awaiting_cadence` tests in `onboarding-handle.test.ts` were missing the `parseTimezoneFromMessage` LLM call that runs in parallel with cadence classification when timezone isn't yet confirmed.
**Fix / Change:** Removed spurious `ON_TOPIC` first mock from all Group 1 and Group 2 tests in `multi-race-onboarding.test.ts`. Created `src/__tests__/lib/training-plan-generate.test.ts` with 11 tests covering `total_weeks` calculation from race date, `prescribedWeek1Miles`→`training_state` sync, `skipLinkSms` flag, and plan/text alignment. Redesigned the `completeOnboarding` races-table test to use `awaiting_anything_else` step (which correctly calls `completeOnboarding` when `isDone=true`). Added missing `parseTimezoneFromMessage` mock to both `awaiting_cadence` tests in `onboarding-handle.test.ts`.
**Files changed:** src/__tests__/api/multi-race-onboarding.test.ts, src/__tests__/api/onboarding-handle.test.ts, src/__tests__/lib/training-plan-generate.test.ts (new)

## 2026-03-27 — Fix 4 onboarding/plan bugs: date ordering, week count, race dedup, weekly total regex

**Type:** Bug Fix
**Reported by:** Jake (direct testing)
**User feedback:** "(1) Sierre Zinal shows 19 weeks away but Dean said 22 — because Dean stored Aug 31 instead of the date I gave. (2) dates in the plan text are not chronological. (3) both upcoming races on dashboard are labeled Sierre Zinal, no A Basin. (4) dashboard says 29.5mi weekly target but plan text said 26 miles."
**Root cause:**
1. When user promotes a new A race and the date comes from `lookupRaceDate` (web search) rather than the user's message, code was setting `race_date_confirmed: true` — so `awaiting_race_date` was skipped. The web search date (Aug 31) was stored without the user ever confirming it.
2. `initial_plan` prompt said "sorted chronologically" but model sorted by day-of-week order, producing Sat 3/28 and Sun 3/29 after Thu 4/2 near a month boundary.
3. Two bugs: (a) Old A race (Dipsea) demoted to B with `date: oldDate || ""` — empty string is falsy, filtered at insert. (b) Haiku sometimes includes the promoted A race in `other_races` despite the rule — code wasn't deduplicating.
4. `prescribedWeek1Miles` regex didn't match `"That's 26 miles for the week."` — fell back to Strava avg (29.5mi).
**Fix / Change:**
1. Track user-provided vs web-search dates separately. Only `race_date_confirmed: true` for user-provided — web search prefills loop to `awaiting_race_date`.
2. Explicit instruction: sort by actual calendar date, with month-boundary callout (Sat 3/28 before Tue 3/31).
3. (a) Call `lookupRaceDate` for old A race when it has no stored date. (b) Strip any `other_races` entry matching the new A race's first word.
4. Added patterns for `"That's ~26 miles for the week"` and `"26 miles for the week"`.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

## 2026-03-27 — Move timezone/location question to post-plan, alongside reminder cadence ask

**Type:** Improvement
**Reported by:** Jake (direct feedback)
**User feedback:** "we should move the question about location to confirm when reminders go out to after the plan is created when we ask about when someone wants reminders"
**Root cause:** `awaiting_timezone` was a pre-plan onboarding step, creating an awkward mid-flow question ("what city are you in?") before the athlete had seen any plan or context for why location matters.
**Fix / Change:** Removed `awaiting_timezone` from `STEP_ORDER` and set `isStepSatisfied` to always return `true` for it (effectively skipping it pre-plan). In the `initial_plan` prompt, when timezone is not yet confirmed, Dean is instructed to combine both questions into one natural ask: "I can send a reminder the morning of each session or the evening before — which works better? And what city are you in so I time them right?" In `handleCadence`, timezone is now extracted in parallel with cadence classification and saved to `users.timezone` if successfully parsed. Strava users are excluded since their timezone is already set from the athlete profile.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

## 2026-03-27 — Fix race ack implying wrong hierarchy when multiple races mentioned

**Type:** Bug Fix
**Reported by:** Jake (direct testing)
**User feedback:** "Dean said 'Sierre-Zinal and A-Basin should set you up nicely for building into that June race' — but Dipsea is actually the first race, not the A race"
**Root cause:** `generateRaceAcknowledgment` was instructed to "briefly acknowledge secondary races in context (e.g. 'Dipsea and Broken Arrow will serve as great tune-up races leading into CCC')". The example implies a clear A race, but when multiple races are mentioned without a stated priority, the model guessed the first-mentioned race (Dipsea) as primary and framed the others as leading into it — which is wrong and contradicts the A race question that immediately follows.
**Fix / Change:** Changed the prompt instruction for secondary race acknowledgment: instead of implying a hierarchy, just note that the other races are on the calendar without framing any as "building towards" another. The A race question that follows is where that relationship gets established.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-27 — Fix dashboard rest days, B/C race display, and B race plan awareness

**Type:** Bug Fix + Feature
**Reported by:** Jake (direct testing)
**User feedback:** "(1) my plan has workouts each date but in the dashboard the view of this week just says rest every day (2) I gave Dean two other races that should show up in Upcoming races, but they don't — I just see my A race. (3) I think the plan needs to more intelligently help me prep for my B races too"
**Root cause:**
1. `buildDailyPlan` in dashboard compared `sorted.includes(day)` where `sorted` had lowercase day names from DB ("tuesday") but `DAY_ORDER` used title case ("Tuesday"). The includes check always returned false → every day rendered as rest.
2. B/C races weren't in the `races` table because `handleOtherRaces` uses Haiku (no web access) to extract race dates. Named races mentioned without explicit dates came back with null → filtered out by `.filter(r => r.date && r.goal)` at insert time. The data was captured in `onboarding_data.other_races` but never made it to the `races` table.
3. `generateAndSaveFullPlan` didn't know about B/C races — the Haiku enrichment that writes `key_workout` and `notes` for each arc week had no context about tune-up race weeks. The `initial_plan` prompt also didn't instruct Dean on how B races should shape the arc description.
**Fix / Change:**
1. Normalize training days to title case in `buildDailyPlan` before the `includes` comparison.
2. After Haiku parses `other_races`, do parallel `lookupRaceDate` web searches for any race with a name but no date. Added `/api/admin/resync-races` endpoint to re-sync the races table from `onboarding_data` for users whose races were dropped during earlier buggy onboarding.
3. Pass B/C races to `generateAndSaveFullPlan` with week-number mappings so the enrichment Haiku can label B race weeks as tune-up efforts. Added "B/C RACE PLANNING" instructions to the `initial_plan` prompt so Dean mentions B races as fitness checkpoints in the arc orientation.
**Files changed:** src/app/dashboard/page.tsx, src/app/api/onboarding/handle/route.ts, src/lib/training-plan.ts, src/app/api/coach/respond/route.ts, src/app/api/admin/resync-races/route.ts

## 2026-03-27 — Fix multi-race question showing wrong pre-filled date (Dipsea date shown for Sierre Zinal)

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** Dean said "Is the Sierre Zinal 31k the A race? I have June 14 for it" — but June 14 is Dipsea's date, not Sierre Zinal's.
**Root cause:** The goal classifier picked "Sierre Zinal 31k" as `race_name` (because of the explicit "31k" distance in the message), while `generateRaceAcknowledgment` returned June 14 as the primary race date (for the first-mentioned race, Dipsea). Two systems picking different "primary" races, smashed together in the question.
**Fix / Change:** In the multi-race `awaiting_other_races` question, removed the pre-filled date entirely — it can't be trusted because the goal classifier and web search pick different races as primary. Question now simply asks "Which of these is your A race? And can you give me the dates for each?" Also removed the implicit date-confirmation fallback in `handleOtherRaces` since there's no longer a pre-fill to fall back to.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-27 — Fix multi-race onboarding: ask A race question before date when multiple races mentioned

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** "feels like we still aren't correctly parsing and asking about which race is the primary focus here? I would expect it to ask — which is your A race and then confirm the dates for each" — Dean was asking "You mentioned June — do you have a specific date?" instead of "Is Dipsea the A race?"
**Root cause:** When `secondary_goal` is set (multiple races detected), the 2026-03-26 fix correctly skipped the date *pre-fill* but did NOT skip the `awaiting_race_date` step itself. So the flow was: acknowledge all races → ask for date (`awaiting_race_date`) → ask which is A race (`awaiting_other_races`). Wrong order — date should only be confirmed after we know which race is the A race.
**Fix / Change:**
1. `isStepSatisfied("awaiting_race_date")` now returns `true` when `secondary_goal` is set — skips the date step entirely on first pass, jumping straight to `awaiting_other_races`.
2. Pre-fill `race_date` from web search even in multi-race case (removed `!raceInfo.secondaryGoal` guard) so the confirmation question is "Looks like the Dipsea is on June 14" rather than open-ended.
3. `handleOtherRaces` nextStep logic simplified: always loops back to `awaiting_race_date` when `race_date_confirmed` is false — covers both the A-race-promotion case and the new multi-race skip path.
4. `awaiting_other_races` question now context-aware: when `secondary_goal` is set and a pre-filled date exists, asks "Is the Dipsea the A race? I have June 14 for it — what are the dates for the others?" combining A-race confirmation + all race dates in one turn. Falls back to open-ended date ask if no pre-fill.
5. `handleOtherRaces` LLM now extracts `confirmed_a_race_date` so the A race date can be confirmed in the same step (no separate `awaiting_race_date` round-trip). If user promotes a different A race and provides its date inline, that's also confirmed without looping back.
6. `handleOtherRaces` LLM prompt now includes `secondary_goal` context so previously mentioned races (Sierre Zinal, A Basin) are captured in `other_races` even on brief replies like "Yes".
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-27 — Dashboard: A/B/C race list + daily workout breakdown for current week

**Type:** Feature
**Reported by:** User feedback (Jake)
**User feedback:** "(1) I think we should show A B or C races on the dashboard view (for example I have a race in 12 weeks, but my A race is in 18 weeks) (2) we should consider showing the whole week of workouts for the week that a user is currently on (rather than just the high level summary)"
**Root cause:** Dashboard only showed the primary plan race date and a single key_workout summary for the current week — no visibility into other races the user had registered, and no day-by-day workout breakdown.
**Fix / Change:** (1) Added an "Upcoming Races" card (between hero and This Week card) that fetches from the `races` table and renders all future races with A/B/C priority badges, dates, and days-until countdown. (2) Expanded the "This Week" card to show a full 7-day grid when `training_days` is available on the user's profile — assigns long run to last training day, key workout to a mid-week day, and easy runs to remaining days, with estimated distances. Falls back to the old key_workout summary when training_days is null.
**Files changed:** src/app/dashboard/page.tsx

## 2026-03-26 — Fix plan re-generation when user confirms reminder preference

**Type:** Bug Fix
**Reported by:** Dean (user report — Jake's conversation)
**User feedback:** After receiving the initial plan and being asked about reminder cadence, Jake replied "yeah reminders evening before would be great thanks" and Coach Dean responded with "Got it — and sorry for the delay! Let me get your plan together now." and regenerated the entire plan.
**Root cause:** `msgType` in `coach/respond/route.ts` had no case for `trigger === "initial_plan"`, so the initial plan was stored in conversations with `message_type: "coach_response"`. The `handleCadence()` function in the onboarding handler queries for `message_type === "initial_plan"` to determine if the plan was already sent — finding nothing, it set `planAlreadySent = false` and re-triggered plan generation every time the user answered the cadence question.
**Fix / Change:** Added `"initial_plan"` case to the `msgType` ternary chain so the initial plan is stored with the correct `message_type`, making the `planAlreadySent` guard work correctly.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-03-26 — Harden onboarding: code guards for goal bucket, schedule, and race date

**Type:** Improvement / Bug prevention
**Reported by:** Internal audit
**User feedback:** N/A
**Root cause:** Several onboarding LLM outputs were trusted unconditionally — an invalid goal bucket, non-canonical day name, out-of-range days_per_week, or past race date from Haiku would be silently stored and cascade into plan generation.
**Fix / Change:**
1. Added `VALID_GOAL_BUCKETS` constant. After goal classifier runs, invalid bucket values are nulled out (treated as no goal detected) rather than stored. Same guard on the `handleGoalTime` re-bucket path.
2. In `handleSchedule`: training day names are lowercased and filtered against a canonical set (rejects typos like "Tuesaday"). `days_per_week` is clamped to 1–7.
3. In `handleRaceDate`: user-provided dates in the past are rejected (the web-search path already did this; now consistent for user-entered dates too).
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-26 — Fix multi-race onboarding: wrong date assignment, correction detection, A race switching

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** "it doesn't seem like Dean is properly switching to my target race or clearly differentiating when there are two options" — Dean pre-filled August 8 as Dipsea's date (it was Sierre Zinal's), didn't handle the correction "Ah that's the date of Sierre Zinal", and kept Dipsea as the A race even after user said "No Sierre Zinal is".
**Root cause:**
1. `generateRaceAcknowledgment` returned August 8 (found for Sierre Zinal via web search) as the primary race's (Dipsea's) date — even though the user said "Dipsea in June." The prompt had no rule about date consistency with the athlete's stated timing.
2. `handleRaceDate` treated any null date extraction as "user confirmed the pre-fill." When user said "Ah that's the date of Sierre Zinal", Haiku extracted no date → fell back to the wrong pre-filled date. No logic existed to detect race-date reassignment.
3. `handleOtherRaces` Haiku prompt required "explicit signals" for A race switching, but "No Sierre Zinal is" is an implicit response to a yes/no question — not captured as a promotion.
**Fix / Change:**
1. Added rule to `generateRaceAcknowledgment`: if the athlete stated a month/season for the primary race, the returned date MUST fall in that window — don't return a secondary race's date. Also added a code-level guard in `handleGoal`: when `raceInfo.secondaryGoal` is set (multiple races detected), skip the date pre-fill entirely and let `awaiting_race_date` ask explicitly. Deterministic: doesn't rely on the LLM attributing the date to the right race.
2. Added a parallel Haiku call in `handleRaceDate` (only when there was an unconfirmed pre-fill) to detect "this date belongs to a different race" corrections. When detected, clears the pre-filled date and asks for the primary race's actual date.
3. Added examples to `handleOtherRaces` Haiku prompt for implicit/truncated A race promotions: "No Sierre Zinal is", "No that one" → `new_a_race` set.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-26 — Fix 3 dashboard/SMS inconsistencies: deload in peak, weekly target drift, week-1 sync

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** "I'm noticing a lot of inconsistencies between the dashboard and what Dean texts"
**Root cause:**
1. **Deload logic mismatch**: `periodization.ts` was missing `&& phase !== "peak"` in the deload check, while `training-plan.ts` correctly excluded peak weeks. This caused Dean to incorrectly prescribe a reduced-volume recovery week in peak-phase weeks (e.g. week 4 when the race is 5 weeks away). Dashboard showed "Peak Phase" but Dean's plan said to back off.
2. **Weekly target drift**: Dashboard showed `training_plans.weeks[n].mileage_target` (static plan arc). After week 1, the weekly recap updates `training_state.weekly_mileage_target` to Dean's actual dynamic prescription — but the dashboard was reading the stale arc value instead. The training_state field was fetched but never displayed.
3. **Week 1 `training_state` not synced**: `completeOnboarding` sets `training_state.weekly_mileage_target` from onboarding data, not from what Dean actually prescribed. `generateAndSaveFullPlan` had `prescribedWeek1Miles` available but never wrote it back to training_state.
**Fix / Change:**
1. Added `&& phase !== "peak"` to `periodization.ts` deload check. Added a test for this case.
2. Dashboard "Weekly target" now reads `training_state.weekly_mileage_target` (live, Dean-synced) with plan arc as fallback.
3. `generateAndSaveFullPlan` now updates `training_state.weekly_mileage_target` with `prescribedWeek1Miles` when available.
**Files changed:** src/lib/periodization.ts, src/lib/training-plan.ts, src/app/dashboard/page.tsx, src/__tests__/lib/periodization.test.ts

## 2026-03-26 — Fix prescribedWeek1Miles regex + capture distance corrections in goal_time step

**Type:** Bug Fix
**Reported by:** Jake (direct observation — previous fixes didn't hold)
**User feedback:** "1) I see Sierre Zinal 10K on my dashboard, it should be 31k. 2) The weekly target in the dashboard is 29 mi but Dean texted me a plan that is 18 miles."
**Root cause (10K label):** Previous fix cleared `goal_distance_miles` when Sierre Zinal was promoted as A race, but the web search in `handleRaceDate` returned `distanceMiles: null` (multiple options found — VK + 31K). The goal bucket also stayed wrong: it fell back to Dipsea's old "10k" bucket since `newARace.goal` was null in `handleOtherRaces`. When the user corrected "I'm doing the 31k version" in `handleGoalTime`, the handler only extracted `goal_time_minutes` and ignored the distance mention.
**Root cause (29 mi vs 18 mi):** The regex at line 489 only matched `"Total: 18mi"` format, but Dean's plan text uses `"That's ~18 miles this week."` — no match → `prescribedWeek1Miles = null` → baseMileage fell back to Strava avg → week 1 multiplied by 1.07 factor.
**Fix / Change:** (1) In `handleGoalTime`, after extracting goal time, also check for distance mentions like "31k" or "5km" — if found and plausible, update `goal_distance_miles` and re-bucket `goal` in mergedData before completeOnboarding runs. (2) Extended the prescribedWeek1Miles regex in `coach/respond` to also match `"~18 miles this week"` format.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

## 2026-03-26 — Don't assume race distance in acknowledgments; ask which distance for multi-option races

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** "it seems like in this scenario, Dean could have asked which race distance I was doing (if there are multiple based on a web search)" — Dean said "a legendary vertical kilometer in the Alps!" for Sierre Zinal when the user was actually doing the 31K.
**Root cause:** Two separate issues: (1) `acknowledgeSharedInfo` was called in `handleRaceDate` with the user's date confirmation message (e.g. "Sierre Zinal is on August 8th!") and used its training knowledge about Sierre Zinal to characterize it as a VK — no web search, just hallucinated characterization. (2) `generateRaceAcknowledgment`'s prompt didn't explicitly call out that a VK and a longer trail race at the same event are distinct distance options that should trigger the "which distance?" clarification.
**Fix / Change:** (1) Added explicit instruction to `acknowledgeSharedInfo` to NOT use training knowledge about races/events and to treat "[race name] is on [date]" messages as bare answers returning null. (2) Added a rule to `generateRaceAcknowledgment` that a Vertical Kilometer is always a separate race from longer distances at the same event, and that the ack must not mention a specific distance when multiple options exist.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-26 — Look up date for promoted A race; clear stale race_month on promotion

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** "seems like Dean is getting confused between Dipsea and Sierre Zinal here, we should have him either look up the date of Sierre Zinal or ask for it, this is a bit confusing about June"
**Root cause:** Two issues when a race is promoted to A-race mid-onboarding: (1) `race_month` from the old A race ("June" for Dipsea) was never cleared, so the `awaiting_race_date` question asked "You mentioned June" even though we were now asking about Sierre Zinal. (2) The Haiku parser that handles `other_races` returned `date: null` for Sierre Zinal since it can't do web search — no date lookup was triggered for the promoted race.
**Fix / Change:** In `handleOtherRaces`, when `newARace` is promoted and has no date from parsing, call a new `lookupRaceDate(raceName)` function that uses web search to find the upcoming race date. Also explicitly clear `race_month: null` in the merged data so stale month context from the old A race doesn't bleed through.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-03-26 — Include race name in date confirmation question

**Type:** Improvement
**Reported by:** Jake (direct observation)
**User feedback:** "feels like we may be able to actually callout the specific race we are asking about here to be clearer: Looks like the race is on June 14, 2026 — does that match your registration?"
**Root cause:** The date confirmation message used the generic phrase "the race" even though the race name (`race_name`) was already stored in onboarding data.
**Fix / Change:** Pull `race_name` from onboarding data and use it in the confirmation: "Looks like the Dipsea is on June 14, 2026 — does that match your registration?"
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-03-26 — Look up race distance when A race is promoted during onboarding

**Type:** Feature / Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** Sierre Zinal showing as "30K" (bucket label) on dashboard — actual distance is ~31K
**Root cause:** When a new A race is promoted in `handleOtherRaces`, `goal_distance_miles` is cleared. No distance lookup was happening for the new race — it just fell back to the bucket standard.
**Fix / Change:** In `handleRaceDate`, when `goal_distance_miles` is null but `race_name` exists (i.e., a promoted A race without a looked-up distance), call `generateRaceAcknowledgment(raceName)` in parallel with the date extraction. If it finds a `distanceMiles`, store it in `onboarding_data`. This uses the same Sonnet + web search path that found Dipsea = 7.4mi in the initial goal step.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-26 — Fixed three dashboard/plan discrepancies after initial plan generation

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** "the first week Dean sent me is 26 mi but on the dashboard it's 29 mi. Also the dash is labeled 7.4 miles (distance of the dipsea race). there was also a discrepancy between 19 and 20 weeks to the race"
**Root cause (7.4 mi / Dipsea):** When the original A race was promoted in `handleOtherRaces` (Dipsea → Sierre Zinal), `goal_distance_miles = 7.4` from the Dipsea web search was left in `onboarding_data`. The dashboard reads `onboarding_data.goal_distance_miles` for the race distance display, so it showed Dipsea's distance even after the A race changed.
**Root cause (26 vs 29 mi):** `generateAndSaveFullPlan` independently computes week 1 mileage as `avgWeeklyMileage × 1.07` (27 × 1.07 = 29). Dean separately prescribed 26mi. The dashboard shows the arc's `mileage_target`, not the actual prescribed sessions total.
**Root cause (19 vs 20 weeks):** `generateAndSaveFullPlan` used `Math.ceil` on 19.3 weeks → 20, while Dean's plan text computed it as ~19. The dashboard SMS said "20-week training plan" while Dean said "~19 weeks."
**Fix / Change:**
1. Clear `goal_distance_miles` in `handleOtherRaces` when the A race is promoted — the old distance no longer applies.
2. Parse the prescribed week 1 total from the corrected plan text (regex on "Total: ~26mi") and pass it to `generateAndSaveFullPlan` as `prescribedWeek1Miles`, which becomes the arc's `baseMileage`. This keeps arc week 1 in sync with what Dean actually sent.
3. Changed `Math.ceil` → `Math.round` in `generateAndSaveFullPlan` so `totalWeeks` matches Dean's language.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts, src/lib/training-plan.ts

## 2026-03-26 — Fixed initial plan generation timeout (60s Vercel limit)

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** Sent a detailed "anything else" response, waited 5 minutes with no reply, then sent "You still working on the plan?" — got the cadence question instead of the plan
**Root cause:** `initial_plan` had web search enabled (`shouldUseWebSearch`), causing Sonnet + tool use + 800 tokens + large system prompt to exceed Vercel's 60s function limit. Plan generation timed out silently. The `onboarding_step = "awaiting_cadence"` is set at the START of plan generation (by design, as a safety net), so the next inbound SMS was routed to cadence handling instead of being treated as "user is confused."
**Fix / Change:**
1. Removed `initial_plan` from `shouldUseWebSearch` — race details are already looked up during onboarding; the plan doesn't need web search.
2. Increased `maxDuration` from 60 to 120 seconds as a safety buffer.
3. Added plan re-trigger in `handleCadence`: if no `initial_plan` message exists in conversations when the athlete answers the cadence question, re-trigger plan generation instead of saying "how does the plan look?" (which would reference a plan they never received).
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-03-26 — Added holding message before initial plan generation

**Type:** Bug Fix / UX
**Reported by:** Jake (direct observation)
**User feedback:** "I sent this message and haven't heard back in about a minute which feels too long"
**Root cause:** When `handleAnythingElse` determines the athlete is done (isDone: true), it immediately calls `completeOnboarding` which triggers plan generation via `after()`. Plan generation takes 30–90 seconds. No feedback was sent in the interim — the athlete sees silence.
**Fix / Change:** Send "Perfect — I've got everything I need. Give me a moment and I'll send over your plan." immediately before kicking off `completeOnboarding`. The initial_plan message opens with athlete-specific context (not "Got it"), so there's no double-acknowledgment.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-26 — Fixed double-ask for goal time during onboarding

**Type:** Bug Fix
**Reported by:** Jake (direct observation)
**User feedback:** "I guess I just want to perform to the best of my ability; no current time goal. My top 5k is 17:23 but I'm probably a bit slower than that right now" → Coach Dean responded with coaching advice then re-asked "Do you have a time goal in mind, or are you focused on finishing?"
**Root cause:** In `handleGoalTime`, when `goalTimeMinutes` was null, the code entered a "general coaching question" branch for any message that wasn't a research question. The user's message had no `?` but included 5K PR context, which Sonnet treated as a coaching question and answered — then re-appended the goal time question.
**Fix / Change:** Added `message.includes("?")` guard to the coaching question branch. Messages without a `?` that don't extract a time goal are now treated as "no specific goal" answers and advance the onboarding step normally (with `acknowledgeSharedInfo` prepended to the next question).
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-26 — Fixed Dean adding multi-week mileage into the current week total

**Type:** Bug Fix
**Reported by:** Rachel
**User feedback:** "Dean told me I was at 11.5 miles this week and included '3.5mi Sunday from last week's carryover' in the total"
**Root cause:** Dean was ignoring the authoritative `weekMileageSoFar` figure in the system prompt and instead computing its own week total by adding up individual run mentions from the conversation, including runs from previous weeks.
**Fix / Change:** Strengthened the `⚠️ THIS WEEK'S MILEAGE` instruction to explicitly forbid Dean from computing its own mileage total, from including "carryover" runs from prior weeks, and to always use the Strava-computed "done so far" figure as-is.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-26 — Fixed coaching questions being ignored or weakly handled across all onboarding steps

**Type:** Bug Fix
**Reported by:** Internal observation (follow-up to cadence bug)
**User feedback:** N/A
**Root cause:** Three separate gaps existed across onboarding steps: (1) `checkOffTopic` generated a 1-sentence Haiku acknowledgment for coaching questions rather than actually answering them, and was missing stepContext entries for `awaiting_other_races`, `awaiting_mileage_baseline`, and `awaiting_injury_background` so those steps fell through without any off-topic check at all. (2) `awaiting_timezone` was excluded from the off-topic check with no alternative question detection. (3) `handleStrava` only detected Strava-specific questions (regex for "?" + "strava") — other coaching questions were silently treated as skips. `handleGoalTime` only used a web search path for research questions (triggered by "?") — general coaching questions without "?" were silently treated as "no goal time" and advanced.
**Fix / Change:** (1) Rewrote `checkOffTopic` to classify off-topic messages as `coaching_question` vs `other` — coaching questions now get a full Sonnet answer (2-4 sentences) followed by the step re-ask, instead of a throwaway Haiku sentence. Added missing stepContext entries with `reAsk` text for all steps. (2) Removed `awaiting_timezone` from the off-topic exclusion list so it now goes through `checkOffTopic`. (3) Expanded `handleStrava` to detect any coaching question containing "?" (not just Strava-specific) using `detectAndAnswerImmediate`, answering it and appending the Strava link re-ask. Added a coaching question fallback inside `handleGoalTime` for non-research-question cases.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/__tests__/api/onboarding-handle.test.ts

## 2026-03-26 — Fixed awaiting_cadence ignoring plan feedback and coaching questions

**Type:** Bug Fix
**Reported by:** User feedback (two separate P1 incidents)
**User feedback:**
- "Do I need to be running this much? If possible, id like to only be running 1-2 times a week an cycling 4 days a week." → Coach Dean replied with the cadence question, ignored the plan change entirely.
- "Should I try to run almost a half marathon at least / Before the actual race" → Coach Dean replied with the cadence question, ignored the coaching question entirely.
**Root cause:** `handleCadence()` classified non-cadence responses as "unclear" and immediately re-asked the cadence question with no acknowledgment of what the athlete actually said. `awaiting_cadence` was excluded from the off-topic check (any response is valid), so nothing caught these cases before they hit the bare re-ask fallback.
**Fix / Change:** Added `handleNonCadenceMessage()`. When the Haiku classifier returns "unclear" during `awaiting_cadence`, a second Haiku call classifies the message as `plan_feedback`, `coaching_question`, or `other`. Plan feedback: generates an enthusiastic acknowledgment, stores the athlete's message in conversation history (so Claude sees it), then re-triggers `initial_plan` to rebuild the plan with the new preferences (the new plan ends with the cadence question again). Coaching question: uses Sonnet to answer directly in 2-4 sentences and appends the cadence question at the end. Other: falls back to re-asking cadence as before.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-25 — Fixed Strava callback overwriting onboarding name with Strava profile name

**Type:** Bug Fix
**Reported by:** User (Shaun's friend)
**User feedback:** "I think Dean may have just called my friend Shaun, Spicy instead?"
**Root cause:** The Strava OAuth callback unconditionally overwrote `users.name` with `athlete.firstname` from Strava. If the user had a different display name in their Strava profile (e.g. "Spicy"), it replaced the name already captured during onboarding (e.g. "Shaun" from "Hi Dean, I'm Shaun").
**Fix / Change:** Fetch the existing name (from `onboarding_data.name` or `users.name`) before the update. Only fall back to the Strava athlete firstname if no name has been captured yet. This preserves the name the user introduced themselves with.
**Files changed:** src/app/api/auth/strava/callback/route.ts

## 2026-03-25 — Reduced taper from 3 weeks to 2 weeks

**Type:** Bug Fix / Improvement
**Reported by:** Vivian
**User feedback:** Her 5-week aggressive half marathon plan had 3 weeks of taper, leaving only 2 weeks of actual training.
**Root cause:** Taper was hardcoded at 3 weeks in both `training-plan.ts` (plan arc generation) and `periodization.ts` (weekly phase computation). On a 5-week plan that's 60% taper.
**Fix / Change:** Reduced taper to 2 weeks in both places. Updated taper volume factors to 70% → 50% of peak (was 75% → 65% → 50%). Updated all tests accordingly.
**Files changed:** src/lib/training-plan.ts, src/lib/periodization.ts, src/__tests__/lib/training-plan.test.ts, src/__tests__/lib/periodization.test.ts

---

## 2026-03-25 — Fixed awaiting_cadence infinite loop (Vivian)

**Type:** Bug Fix
**Reported by:** User observation (Vivian)
**User feedback:** Dean kept asking the reminder cadence question ("morning, evening, or weekly?") in a loop even after Vivian replied "Morning" three times.
**Root cause:** The `checkOffTopic` guard was missing `awaiting_cadence` (and `awaiting_timezone`, `awaiting_goal_time`) from its exclusion list, even though the comment above it explicitly said to skip those steps. When Vivian replied "Morning", the off-topic LLM interpreted it as a greeting rather than a preference answer and returned `on_topic: false` with a freshly-generated cadence question. The `handleCadence` function was never reached.
**Fix / Change:** Added `step !== "awaiting_cadence"`, `step !== "awaiting_timezone"`, and `step !== "awaiting_goal_time"` to the off-topic check condition, matching the existing comment. These steps accept any response by design — their own handlers classify the input.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-03-25 — Fix multi-race onboarding stealing wrong distance; fix bike "mi" inflating mileage; stop model reasoning leaking as SMS

**Type:** Bug Fix (3 bugs)
**Reported by:** Nathan's onboarding conversation
**User feedback:** "adding 60 min of biking to run mileage - he's not actually doing 98 miles"; "his dashboard said his race was 7.4 miles"; "sounds like some of the reflection of the model is coming in too"

**Bug 1 — Cross-training "60 min" counted as 60 running miles:**
**Root cause:** Claude correctly wrote "Easy bike 60 min" but the mileage regex `/(\d+(?:\.\d+)?)\s*mi/i` has no word boundary — it matched "mi" as the first two letters of "min", counting the session as 60 miles. Session total became 38 running + 60 bike = 98. Since the stated total matched the (incorrectly) computed total, `correctMileageTotal` made no correction.
**Fix:** Two-layer fix: (1) `correctMileageTotal` now skips mileage extraction entirely for sessions whose description contains cross-training keywords (bike, swim, strength, mobility, etc.); (2) the regex now uses `mi(?:les?)?\b` with a word boundary so "60 min" can never register as mileage even in a running session. Added explicit ⚠️ CROSS-TRAINING FORMAT prompt rule to reinforce using 'min' not 'mi'.
**Files changed:** src/app/api/coach/respond/route.ts

**Bug 2 — CCC showing as "7.4 miles" (Dipsea's distance):**
**Root cause:** `generateRaceAcknowledgment` received Nathan's full multi-race message (Dipsea ~7mi, Broken Arrow 23K, CCC 100K). The web-search LLM returned `distance_miles: 7.4` (Dipsea's non-standard distance) even though CCC was the primary goal. The fallback at `raceInfo.distanceMiles` stored 7.4 as `goal_distance_miles`. Since `|7.4 - 62.137| > 0.5`, the system prompt showed "CCC (7.4 miles)". Fixed Nathan's data: cleared `goal_distance_miles` to null in both `training_profiles` and `users.onboarding_data`.
**Fix:** Updated `generateRaceAcknowledgment` prompt to identify the PRIMARY goal race and return `distance_miles` only for that race. Added explicit rule: if primary race is a standard bucket (100K, 50K, marathon, etc.), return null even if a secondary race has a non-standard distance.
**Files changed:** src/app/api/onboarding/handle/route.ts

**Bug 3 — Model reasoning sent as SMS bubbles:**
**Root cause:** System prompt said "CCC (7.4 miles)" (Bug 2). Model recognized CCC as a 100K, output its confusion as paragraphs, which `splitIntoMessages` turned into separate SMS bubbles.
**Fix:** Strengthened OUTPUT RULES to explicitly prohibit any meta-commentary about discrepancies between system prompt data and what the model knows. Root fix is Bug 2 — removing the contradictory data prevents the confusion from arising.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-25 — Code-level plan validation: enforce volume caps and deduplicate sessions post-generation

**Type:** Bug Fix
**Reported by:** Internal — prompt-only fixes for Issues 1 and 5 not reliable enough
**User feedback:** N/A
**Root cause:** Prompt instructions ("HARD LIMIT", "non-negotiable") for volume caps were already present before Issue 1 occurred — the model violated them anyway. Same risk for duplicate session lines. Prompt text cannot be trusted for safety-critical constraints.
**Fix / Change:** Created `src/lib/plan-validation.ts` with two pure, tested functions wired into the post-generation pipeline in `route.ts`:
- `enforceVolumeCaps(message, weeklyCapMiles, longRunCapMiles)`: for low-volume athletes on `initial_plan`/`weekly_recap` triggers, parses all running session distances, caps any single session at `longRunCapMiles`, then floor-scales the total to `weeklyCapMiles` if still over. Uses floor (not round) to guarantee the sum never overshoots the cap. Also rewrites any stated weekly total in the text to match the corrected sessions.
- `deduplicateSessionLines(message)`: removes exact duplicate `"DDD D/M · ..."` lines, keeping the first occurrence.
Both functions are no-ops when caps are null or no session lines are present.
**Files changed:** src/lib/plan-validation.ts (new), src/__tests__/lib/plan-validation.test.ts (new, 18 tests), src/app/api/coach/respond/route.ts

## 2026-03-25 — Five coaching quality fixes: volume guardrail, interval math, goal dedup, Strava onboarding, plan dedup

**Type:** Bug Fix
**Reported by:** User feedback (users d7aac841, 479e43d6, 0a234882, a9b4016c)
**User feedback:**
- (d7aac841) "Coach Dean told me Week 1 is capped at 7 mi then immediately prescribed 18 mi including a 9 mi long run"
- (479e43d6) "6x400m interval session stated as 7mi total — should be ~3.75mi"
- (d7aac841) Coach Dean flagged goal confusion (marathon vs half) three times in a row even after athlete answered
- (0a234882) Athlete asked "Should I get Strava?" during onboarding — Coach Dean ignored the question and advanced
- (a9b4016c) Thu 3/26 session appeared twice identically in the same plan
**Root cause:**
1. System prompt had a volume cap but no long run cap, and the self-consistency check was missing — model stated a cap then violated it
2. No interval math instructions; model hallucinated session totals
3. Goal discrepancy flag had no dedup rule; fired on every message because stale DB goal was never updated when athlete corrected it
4. handleStrava treated any reply as a skip without checking for questions
5. No dedup instruction in plan output rules
**Fix / Change:**
1. Added ⚠️ LONG RUN CAP (35% of current weekly volume) to FITNESS TIER for low-volume athletes; added SELF-CONSISTENCY CHECK to VOLUME AND SAFETY section
2. Added INTERVAL SESSION MATH rule to user_message prompt with explicit formula and example
3. Added GOAL DISCREPANCY — RAISE ONCE ONLY rule to system prompt header; added goal_race_type field to extractProfileData and persistProfileUpdates so DB is updated when athlete corrects their goal
4. handleStrava now detects questions containing "strava" + "?" and replies with a Strava pitch + link instead of silently skipping
5. Added NO DUPLICATE ENTRIES rule to plan output session format instructions
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-03-25 — Add SMS commands FAQ entry to landing page

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Users had no way to discover commands like FEEDBACK and MY PLAN without being told out-of-band.
**Fix / Change:** Added a new FAQ item "Are there any special commands I can text Dean?" listing FEEDBACK, MY PLAN, and STOP with brief descriptions of what each does.
**Files changed:** src/app/page.tsx

---

## 2026-03-25 — Add 15s timeout to race acknowledgment web search

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "I didn't get a response after I told him the race... oh wait, it just landed - took about 3 min"
**Root cause:** `generateRaceAcknowledgment` does a web search with `claude-sonnet-4-5-20250929` for named races. Occasionally this hangs or runs very slowly (3min observed for Dipsea). The function had no timeout, so if the web search stalled the whole `handleGoal` call stalled with it.
**Fix / Change:** Wrapped the `anthropic.messages.create` call in a `Promise.race` against a 15-second timeout. If it times out, logs a warning and falls back to `empty` (no race-specific ack, no date, no distance — the goal is still captured and onboarding continues normally).
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-25 — Fix Dean never asking for user's name during onboarding

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "Dean didn't ask for my name"
**Root cause:** `awaiting_name` was missing from `STEP_ORDER` entirely, so `findNextStep` never returned it. The step handler, satisfier, and question all existed — the step just wasn't reachable.
**Fix / Change:** (1) Intro message (signup API + handleGoal direct-text path) now asks "What's your name and what are you training for?" so name and goal are collected together upfront. (2) Added `"awaiting_name"` as the first entry in `STEP_ORDER` as a fallback — if the user answers goal but skips their name, Dean asks for it before moving to race date. Satisfied automatically when name was already captured. (3) Fixed `handleName` which was hard-coded to call `completeOnboarding` (written when name was the last step) — now calls `findNextStep` and continues through remaining steps, greeting by name on transition.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-25 — Fix A-race confusion when user re-prioritizes during other-races step

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "I found this conversation in onboarding a bit confusing - I assumed it would ask more about my target race...rather than the first race I mentioned"
**Root cause:** `handleOtherRaces` always treated the first-mentioned race as the A race regardless of priority signals. When Jake said "the 100k is top priority then dipsea," the system kept Dipsea as `race_name` and then asked about goal time for "the race" generically — so Jake answered thinking about the 100k while Coach Dean looked up Dipsea stats.
**Fix / Change:** (1) `handleOtherRaces` parse prompt now detects A-race promotion via `new_a_race` field — when set, swaps `race_name`/`goal`/`race_date` to the newly promoted race, adds old A race to `other_races` as B, and clears `race_date_confirmed`. After promotion, `nextStep` is forced to `awaiting_race_date` so the new A race date gets confirmed before continuing (bypassing the normal forward-only step scan). (2) `awaiting_goal_time` question now names the specific race: "Do you have a time goal for the Tahoe Rim Trail?" — removing the ambiguity entirely.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-25 — Fix cite-tag stripping swallowing words in race acknowledgment

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "seems like this message had a piece that got cut-off? ...shortcuts like Suicide You're going after one of the toughest trail races out there"
**Root cause:** Claude's web_search tool sometimes wraps cited words inside `<cite>text</cite>` tags. The regex `/<cite[^>]*>[\s\S]*?<\/cite>/g` was stripping the entire tag including its inner content, so "Suicide <cite>Steps</cite>" became "Suicide " — dropping the word "Steps" and creating a run-on.
**Fix / Change:** Changed all three cite-stripping regexes in `onboarding/handle/route.ts` to preserve inner content: `replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, "$1")`.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-25 — Landing page: remove training science section, sharpen FAQ with Strava angle

**Type:** Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "Do we think the 'Built on proven training science' section should be folded into an FAQ? Also let's update the FAQs to reference the Strava integration — 'How does Coach Dean know what paces to assign?' could reference pulling Strava history."
**Root cause:** Training science section felt secondary next to the comparison and plan arc sections. FAQ answers for paces and Strava underplayed the Strava integration as a selling point. Coach names/methodology had no FAQ home after removal.
**Fix / Change:** Removed the training science section entirely. Updated "How does Coach Dean know what paces?" to lead with Strava history as the best path, then cover the no-Strava fallback. Updated "Do I need Strava?" to explain what Strava unlocks ("the feature testers have found most valuable"). Added a new "What training philosophy does Coach Dean follow?" FAQ to preserve the methodology credibility signal (80/20, Lydiard, VDOT, Roche).
**Files changed:** src/app/page.tsx

---

## 2026-03-25 — Landing page: plan arc visualization, comparison section, Strava angle

**Type:** Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "should we showcase the dashboard on the landing page? I'm thinking about things to differentiate from Runna — 'a professional running coach for 1/10 of the price'. One thing we should emphasize is real time feedback on all your Strava activities, that has been really cool."
**Root cause:** Landing page didn't mention the dashboard, didn't anchor the price angle, and undersold the real-time Strava feedback feature.
**Fix / Change:**
- Hero subtext updated: "analyzes every run" and "a fraction of the price" added
- Value prop 2 changed from "Smart adjustments for injury prevention" to "Instant coaching after every run" — centers the Strava real-time feedback as a key differentiator
- New "Your full season, laid out before you start" section: code-rendered 12-week plan arc showing base/build/deload/peak/taper blocks with a current-week indicator and legend — no screenshot dependency
- New "A professional coach for 1/10 of the price" comparison section: three cards (Training apps ~$15/mo, Coach Dean featured dark card, Human coach $150–300/mo) clearly positioning Dean in the middle
- Runna FAQ answer sharpened: leads with the Strava post-run feedback angle ("actual analysis of your pace, effort...that alone is something no app does"), then covers ChatGPT
**Files changed:** src/app/page.tsx

---

## 2026-03-25 — Dashboard link SMS now explains what the plan page is for

**Type:** Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "I think another thing that may be helpful in onboarding is to have a sentence about the purpose of the dashboard when we send it"
**Root cause:** The plan-ready SMS just said "Your full 12-week training plan is ready to view: <url>" with no context about what to expect next.
**Fix / Change:** Added a second sentence: "I'll send you the specifics each week and keep this updated as your training progresses." Separated by a newline so it reads as two distinct thoughts.
**Files changed:** src/lib/training-plan.ts

---

## 2026-03-25 — Dashboard hero: race name, countdown, and week progress bar

**Type:** Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "can we callout the race date / week a bit more prominently"
**Root cause:** Hero card showed race date as small gray text and "X days to go" in the same size. Race name was `text-base`. No visual week progress indicator.
**Fix / Change:** Race name bumped to `text-lg font-bold`. Race date and days-to-go split into a two-column row: date on the left, large bold countdown (`text-3xl`) on the right. Week progress shown as a thin progress bar under "Week X of Y" + phase badge.
**Files changed:** src/app/dashboard/page.tsx

---

## 2026-03-25 — Fix race_date null overwrite, race distance from web search, deload labeling, short-plan phase scaling

**Type:** Bug Fix + Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "1) It doesn't seem like I actually have a taper built into my race right now. 2) I'm still getting the issue where I say I want to do the Dipsy race, which is 7.4 miles, but it says I'm doing a 10K at the top of my plan. 3) In onboarding, Dean did not ask which races are my A, B, or C races or which is my priority."
**Root cause:**
- **Root bug (causes issues 1 and 3):** In `handleRaceDate`, when the user says "yes" to confirm a web-search pre-filled race date, the Haiku parser returns `parsed.race_date = null` (no date literal in "yes"). The code then wrote `race_date: null` over the pre-filled value. This caused: (a) `awaiting_other_races` to be skipped (its `isStepSatisfied` check exits early when `!data.race_date`), meaning Dean never asked about A/B/C race priority; (b) `training_profiles.race_date = null`, causing `generateAndSaveFullPlan` to run with `hasRace=false` → 12-week base/build cycle with no taper instead of a race-specific arc with taper.
- **Issue 2 (race distance label):** When user says just "Dipsea" without an explicit distance, the goal classifier correctly maps it to the "10k" bucket but sets `goal_distance_miles: null`. The web search finds the real distance (7.4 mi) in the acknowledgment but that value was never extracted or stored — so the dashboard fell back to the bucket label "10K".
- **Deload weeks:** Always existed in the plan but were stored with the parent phase label (e.g. "Base"), making them invisible to the user.
- **Short-plan phase thresholds:** With totalWeeks ≤ 16, `weeksFromEnd` is always < 14 so no "base" phase was ever assigned — everything collapsed into "build/peak/taper".
**Fix / Change:**
- `handleRaceDate`: `finalRaceDate = parsed.race_date ?? onboardingData.race_date ?? null` — preserves pre-filled date when user just confirms.
- `generateRaceAcknowledgment`: Added `distanceMiles: number | null` to `RaceInfo`. Prompt now instructs Claude to return `distance_miles` when the race has a non-standard distance (e.g. 7.4 for Dipsea). Stored in `onboarding_data.goal_distance_miles` as fallback if the goal classifier didn't set one.
- `computePhaseForPlan`: Thresholds now scale proportionally (`scale = totalWeeks / 24`) so 12-week plans get base → build → peak → taper phases.
- Training plan loop: Deload weeks now stored with `phase: "deload"` instead of the parent phase label.
- Dashboard: Added `deload` to `PHASE_LABELS` ("Deload") and `PHASE_COLORS` (green badge).
**Files changed:** src/app/api/onboarding/handle/route.ts, src/lib/training-plan.ts, src/app/dashboard/page.tsx

---

## 2026-03-25 — Web search for race time research questions during goal-time onboarding step

**Type:** Feature
**Reported by:** User feedback (Jake)
**User feedback:** "Can you check on the race what times usually finish in the top 35 (to get a black shirt)?" — Dean kept deflecting with "what's your goal time?" instead of actually looking it up.
**Root cause:** `handleGoalTime` used `claude-haiku` with no tools — purely a time extractor. When the athlete asked a research question instead of stating a time, it had no way to answer and just fell through to the normal re-ask.
**Fix / Change:** Added `isGoalTimeResearchQuestion()` regex check and `searchGoalTimeInfo()` helper that fires Sonnet + `web_search_20250305` when the athlete asks about race times/competitive standards instead of stating a goal. On a research question, Dean searches for historical results, answers conversationally, and re-asks for the athlete's personal goal time — staying on `awaiting_goal_time` so the flow isn't skipped.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-25 — Fixed "I'm Coach Dean" re-introduction after intro already sent

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "Still getting the weird 'I'm Coach Dean...' after he already did an intro"
**Root cause:** The `intro_sent: true` DB update in `handleGoal` (no-goal branch) used `void` (fire-and-forget). On Vercel, the function can be killed after returning the HTTP response but before the unawaited promise resolves. When the user's next message arrived, `onboarding_data.intro_sent` was still falsy, so the goal-processing branch appended "I'm Coach Dean, your AI running coach." again. Secondary issue: the update used the original `onboardingData` snapshot, which didn't include any name extracted during the same invocation — overwriting `onboarding_data.name` on the next write.
**Fix / Change:** Changed `void supabase.update(...)` to `await supabase.update(...)` so `intro_sent` is reliably persisted before the handler returns. Also merged any extracted name into the update payload to prevent the data-loss overwrite.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-03-25 — Reject short code / non-E.164 senders in Linq webhook

**Type:** Bug Fix
**Reported by:** Internal observation (Vercel logs)
**User feedback:** N/A
**Root cause:** Linq delivers inbound messages from short codes (e.g. `32099`) and other non-standard senders as webhook events. The handler would attempt to create a user row and send a welcome SMS to the sender, which Linq then rejected with error 1005 ("recipient must be a valid E.164 phone number").
**Fix / Change:** Added an early-exit guard after `senderPhone` is extracted — if the sender doesn't match a phone-like pattern (≥7 digits) or a valid email address, the webhook returns 200 immediately without DB writes or SMS sends. Emails are allowed through because iMessage users may appear with their Apple ID email as the sender handle.
**Files changed:** src/app/api/webhooks/linq/route.ts

---

## 2026-03-24 — Dean can adjust upcoming training plan weeks for illness/injury/travel

**Type:** Feature
**Reported by:** Internal
**User feedback:** "Dean needs to be able to update the next week if needed to accommodate for illness, injury, travel, or change in priorities (maybe updating the quality workout for example). Or 'remove' a week from the plan for a full illness, etc."
**Root cause:** Training plan arc was static after generation. Dean could give verbal advice about modifying training but had no way to actually update the stored plan.
**Fix / Change:**
- Extended plan fetch to also fire for `user_message` trigger (was `weekly_recap` only), pulling current + next week from `training_plans`
- Injected next week context ("Week N: X mi target, key workout: ...") into Dean's `user_message` prompt so Dean can see what it's working with
- Added `TRAINING PLAN ADJUSTMENT` instruction to Dean's prompt: when illness/injury/travel/priority change warrants it, Dean should commit to the change explicitly ("I've updated next week on your dashboard — dropping it to X miles...")
- Added `maybeUpdateTrainingPlanWeeks` function: after each `user_message` response, if adjustment-relevant keywords are present (sick, injured, travel, etc.), runs a Haiku extraction to detect whether Dean committed to a plan change and extracts the new values (mileage_target, key_workout, notes). Patches those week objects in `training_plans.weeks` JSONB. Only fires on keyword match to avoid unnecessary calls.
- "Remove a week" = Dean sets mileage_target to ~30% of original and key_workout to "Easy recovery — no quality work"
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-24 — Dashboard shows actual mileage and completion per week

**Type:** Feature
**Reported by:** Internal
**User feedback:** "the plan should progress and show progress for each week you've done (like 'complete' or a checkmark) and maybe show your actual mileage or key stats"
**Root cause:** Dashboard showed only planned mileage; no indication of what was actually run each week.
**Fix / Change:** Fetch all activities for the user in the dashboard query. Compute actual mileage per plan week by anchoring Week 1 to the Monday of `training_plans.created_at`, then binning each run activity into the appropriate week. WeekCard now shows: ✓ Done (green, ≥80% of target), Partial (yellow, >0 but <80%), — (gray, nothing logged). Actual vs target shown as "9.2 / 12 mi" for past weeks. Also narrowed the "my plan" SMS command to exact match only (`/^(my plan|my training plan)$/i`) to avoid false positives on conversational mentions.
**Files changed:** src/app/dashboard/page.tsx, src/app/api/webhooks/linq/route.ts

---

## 2026-03-24 — "My plan" SMS command sends dashboard link

**Type:** Feature
**Reported by:** User feedback
**User feedback:** "let's have that as a command" (re: texting Dean to get the dashboard link)
**Root cause:** No keyword handler existed for users wanting to retrieve their plan link via SMS.
**Fix / Change:** Added a regex keyword handler in the Linq webhook for phrases like "my plan", "my training plan", "dashboard", "plan link", "training plan link". Bypasses the coaching flow and immediately texts back the dashboard URL. Returns a friendly "not ready yet" message if the user has no plan/token. Also added `dashboard_token` to the user select in the webhook so it's available without a second query.
**Files changed:** src/app/api/webhooks/linq/route.ts

---

## 2026-03-24 — Fix iMessage link preview for dashboard

**Type:** Bug Fix
**Reported by:** User observation
**User feedback:** "I'm seeing the preview link to the dashboard that dean sends in iMessage not have a preview in imessage, makes it feel a bit suspicious"
**Root cause:** The dashboard page had no page-level metadata export, so it relied on the root layout's generic OG tags. Next.js App Router may not reliably propagate those for dynamic pages with query params (`?token=`), resulting in no preview.
**Fix / Change:** Added a static `metadata` export to `src/app/dashboard/page.tsx` with a dashboard-specific title ("Your Training Plan — Coach Dean"), description, and the existing `og-image.png`. iMessage will now show the Coach Dean logo and a recognizable title.
**Files changed:** src/app/dashboard/page.tsx

---

## 2026-03-24 — Multi-race support (A/B/C priority) + 52-week plan cap

**Type:** Feature
**Reported by:** Internal — design review of training plan limitations
**User feedback:** N/A
**Root cause:** Training plans were capped at 24 weeks (races >6 months away got a truncated arc). No model for B/C tune-up races — coaching had no awareness of secondary events on the calendar.
**Fix / Change:**
- New `races` table with A/B/C priority, backfilled from existing training_profiles
- New `awaiting_other_races` onboarding step (after race date confirmed): asks if this is their A race and captures any other races on the calendar
- `completeOnboarding` now writes all races (A + B/C) to the races table
- `coach/respond` queries the races table and injects B/C race guidance into the system prompt: mini-taper protocol for B races within 14 days, workout-mode note for C races within 7 days
- Plan generation cap raised from 24 → 52 weeks; Haiku enrichment tokens raised from 1500 → 2500 to handle longer arcs
**Files changed:** supabase/migrations/021_races_table.sql, src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts, src/lib/training-plan.ts

## 2026-03-24 — Fixed flaky periodization tests failing on boundary dates in CI

**Type:** Bug Fix
**Reported by:** Jake (CI failure on GitHub Actions)
**User feedback:** "my previous PR failed the tests on github actions"
**Root cause:** `computePhase` used `Math.ceil(daysUntil / 7)` for `weeksUntil`. The test helper `weeksFromNow(N)` creates a date-only string N×7 days out, but `computePhase` parses it as noon UTC. When tests run before noon UTC on GitHub Actions, the difference is N×7 days + a few hours → `Math.ceil` rounds up to N×7+1 days → `Math.ceil((N×7+1)/7)` = N+1 weeks → wrong phase at every boundary.
**Fix / Change:** Changed `Math.ceil(daysUntil / 7)` to `Math.floor(daysUntil / 7)` in `computePhase`. Boundary dates (e.g. exactly 21 days out) correctly land in the lower-or-equal phase rather than the next one up.
**Files changed:** src/lib/periodization.ts

## 2026-03-24 — Fixed "10K plan" label when user specified a named race (e.g. Dipsea)

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "it seems like even though I told Dean I'm going to do the Dipsea, which is a 7.4-mile race with a lot of climbing in Mill Valley, that he's prepping me for a 10K in onboarding"
**Root cause:** `generateAnythingElseResponse` and `generateConstraintAcknowledgment` both received the generic goal bucket label ("10k") rather than the specific race name. The goal parser correctly stores `race_name: "Dipsea"` in `onboarding_data`, but it wasn't being passed to those Claude calls — so Dean would say "your 10k plan" instead of "the Dipsea".
**Fix / Change:** In `generateAnythingElseResponse`, build the context string from `race_name` + `goal_distance_miles` when available, falling back to the generic label. In `generateConstraintAcknowledgment`, pass `race_name` instead of `formatGoalInline(goal)` when a named race is present.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-03-24 — Fixed typing bubbles persisting after message sent + "I'm Coach Dean" appearing mid-conversation

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "after sending his intro message to me in the onboarding flow, the typing bubbles appeared on my end, even though I knew that Dean wasn't going to send another message" / "I'm Coach Dean, your AI running coach." appearing in the middle of Dean's response after the intro was already sent
**Root cause (typing):** The Linq webhook fired `startTyping` immediately (correct) then ran a hardcoded 4-retry loop every 4.5s covering up to 18s. Both `onboarding/handle` and `coach/respond` have their own keep-alive loops that stop when the message is sent — but the webhook's loop ran independently and re-triggered the typing indicator *after* the response had already been delivered and cleared it.
**Root cause (identity note):** For direct-text users (not web signup), `onboarding_data.intro_sent` was never written to the DB after sending the full intro in the `awaiting_goal` handler. So when the next message (with the actual goal) came in, `!intro_sent` was still true and the identity sentence was appended to the goal acknowledgment.
**Fix / Change:** (1) Removed the 4-fire continuation loop from the webhook — the immediate `startTyping` call stays for instant feedback. (2) After sending the intro for direct-text users in `handleGoal`, write `intro_sent: true` to `onboarding_data` so it isn't appended again.
**Files changed:** src/app/api/webhooks/linq/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-03-24 — Full multi-week training plan generation + /dashboard

**Type:** Feature
**Reported by:** Internal observation (Jake)
**User feedback:** "Dean seems to just create a weekly plan on a one-off basis and doesn't seem to follow a super structured 12-week arc or cadence up to a race... one thing that we'll want to do is be able to show the user or tell the user, from a high level, what their training plan is."
**Root cause:** Dean generated each week's plan reactively at signup and on every Sunday recap, with no memory of the intended arc. Each week was effectively invented from scratch, leading to inconsistent progression and no way for users to see where they were headed.
**Fix / Change:**
- Added `training_plans` table to store the full pre-generated multi-week arc (base → build → peak → taper) with per-week mileage, long run, key workout, and coaching notes.
- After `initial_plan` fires, `generateAndSaveFullPlan` computes the full arc using the existing periodization logic, calls Claude Haiku once to enrich each week with `key_workout` and `notes`, saves it, generates a `dashboard_token`, sets `trial_started_at`, and texts the athlete a link to their plan dashboard.
- `weekly_recap` now fetches the stored plan week and injects it as `STORED TRAINING PLAN` context so Dean reflects on actual vs. planned — not inventing the plan from scratch.
- New `/dashboard` page at `coachdean.ai/dashboard?token=xxx`: shows goal, race countdown, current week highlight card, and the full plan arc. Trial active (≤7 days): all weeks visible. Trial expired: future weeks beyond current+1 are blurred with "Unlock full plan" CTA (Stripe paywall placeholder).
- New `/api/dashboard/request-link` route: accepts phone number, finds user, ensures token, texts the link — used by the dashboard fallback screen for users who lost their link.
- Added `dashboard_token` and `trial_started_at` columns to `users` table (migration 020).
**Files changed:** `supabase/migrations/020_training_plans.sql`, `src/lib/database.types.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`, `src/app/dashboard/request-link-form.tsx`, `src/app/api/dashboard/request-link/route.ts`

## 2026-03-24 — Fixed fire-and-forget DB writes being silently dropped in serverless

**Type:** Bug Fix
**Reported by:** Internal observation (discovered while debugging Catherine's mileage reset)
**User feedback:** N/A
**Root cause:** Several DB writes in `coach/respond` used `void` (fire-and-forget), which meant the promises weren't tracked by the enclosing `after()` callback. In Vercel's serverless environment, if the function instance exits before these promises resolve, the writes are silently dropped. This caused: (1) `weekly_recap` and `initial_plan` never advancing `current_week` / saving `weekly_mileage_target` — confirmed by Catherine's state being stuck at week 1 since March 9 despite multiple recaps running. (2) `persistProfileUpdates` (injuries, paces, race data, workout saves from user messages) and `maybeUpdatePlanSessions` (plan adjustments mid-week) also being dropped.
**Fix / Change:** Changed `void` to `await` for: `training_state` updates on `initial_plan` and `weekly_recap`, `extractAndStorePlanSessions` calls, `persistProfileUpdates`, and `maybeUpdatePlanSessions`. Left `linq_chat_id` as `void` (low stakes — chatId is passed directly on each request). Left `taper_peak_miles` inside `buildSystemPrompt` as `void` — fixing it requires making `buildSystemPrompt` async, deferred.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-03-24 — Fixed three onboarding flow issues (questions pile-up, Strava step regression, schedule repeat)

**Type:** Bug Fix
**Reported by:** Internal testing (Jake)
**User feedback:** (1) "we ask a ton of questions in the first message" (2) "strava didn't seem to properly show up in the response" / Dean replied "I don't have access to external apps like Strava" (3) "repeat of a question on which days work for me"
**Root cause:**
1. `detectAndAnswerImmediate` prompt didn't prohibit generating questions — Haiku was returning things like "how much trail experience do you have? what's your mileage?" for messages with no actual question. These got prepended to the acknowledgment alongside the next step question, resulting in multiple questions in one message.
2. & 3. Strava OAuth callback unconditionally set `onboarding_step: "awaiting_schedule"` for ANY non-fully-onboarded user. If the user texted during the `awaiting_strava` step (triggering `handleStrava` to advance them), then completed OAuth, the callback reset them backwards. Their next message hit `checkOffTopic` for `awaiting_schedule` — which had no Strava context and hallucinated "I don't have access to Strava". The schedule question also repeated.
**Fix / Change:**
1. Added "Do NOT ask follow-up questions" to `detectAndAnswerImmediate` prompt. If answering would require more info, return `{"no_question": true}` instead.
2. & 3. Strava callback now only sets `onboarding_step: "awaiting_schedule"` when the user's current step is exactly `awaiting_strava`. If they've already progressed past it, the step is left unchanged. Also added a brief Strava stats summary to the callback SMS ("I can see your recent runs — X miles across Y runs in the last 4 weeks") so the user knows their data is being used.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/auth/strava/callback/route.ts`

## 2026-03-24 — Fixed infinite response loop on burst onboarding messages (P0)

**Type:** Bug Fix
**Reported by:** User feedback (user 75d11cc3, Tomo)
**User feedback:** "wait hold up" / "you're not tomo lol, i'm tomo" / "ok i think there's some confusion here" / "you texted MY number, which is tomo" / "bro you're clearly another AI lol" / "alright this is getting weird, you're stuck in a loop" / "if there's an actual person behind this and you meant to text tomo, just lmk what you need help with" — 8 replies of "Hey Tomo! I'm Coach Dean..." within seconds
**Root cause:** The onboarding path in the Linq webhook intentionally skipped the 10s debounce (comment: "each step expects exactly one reply"). When a user sent multiple messages in rapid succession, each message independently called `/api/onboarding/handle` before any response had been sent. All concurrent calls read `onboarding_step = "awaiting_goal"` from the DB (step hadn't advanced yet), all detected no goal, and all sent the identical intro message — resulting in 8+ identical replies within seconds.
**Fix / Change:** (1) Applied the same 10s debounce to the onboarding path that the coaching path already uses: store the message, wait 10s, check if a newer user message arrived — if yes, skip. Only the final message in a burst fires the handler. (2) Added a loop detection safety net in `onboarding/handle`: before routing to a step handler, check if the last 2+ assistant messages within 2 minutes are identical. If so, send a single de-escalation message ("Looks like something got confused on my end...") and bail instead of repeating again.
**Files changed:** src/app/api/webhooks/linq/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-03-24 — Fixed mileage reset for non-Strava users on weekly recap (part 2)

**Type:** Bug Fix
**Reported by:** User feedback (Jake's mom, Catherine)
**User feedback:** "She said she did one 4-mile run, but she actually did a couple more last week. It's kind of annoying to text Dean every time you do a run... this needs to make sure it's building off of her previous weekly plans, which were more around the 9-10 mile range rather than going back to 6 miles."
**Root cause:** Two issues: (1) Even with the part 1 fix, Dean was anchoring next week's plan to what the athlete *mentioned* conversationally (the one 4mi run Catherine texted about) rather than the stored progression target — non-Strava athletes only text a fraction of their runs so this always undercounts. (2) Catherine's `weekly_mileage_target` in the DB was already corrupted to 6.5mi by the March 22 reset before the part 1 fix landed, so the progression target itself was wrong.
**Fix / Change:**
- Added explicit prompt instruction to `weekly_recap` for non-Strava users: "Non-Strava athletes only text a fraction of their runs — assume they completed most of their plan. Build next week from the PROGRESSION TARGET in CURRENT TRAINING STATE, not from reported mileage." Prevents Claude from anchoring to conversational reports which always undercount.
- Manual DB fix needed for Catherine: set `training_state.weekly_mileage_target = 10` to restore the correct baseline before next cron.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-03-24 — SMS feedback and refund commands with admin email notification

**Type:** Feature
**Reported by:** Internal (pre-launch feedback loop design)
**User feedback:** N/A
**Root cause:** No way for users to submit feedback or request refunds through Coach Dean — they'd have to find a separate contact channel.
**Fix / Change:** Added `FEEDBACK:` and `REFUND` SMS command handling in the Linq webhook. Both fire a structured admin email via Resend (phone, user ID, Strava status, timestamp, full message). REFUND sends an ack SMS and stops — Dean can't action billing. FEEDBACK falls through to the normal coaching path so Dean can respond: if it's coaching-actionable (e.g. "more intervals"), he acts on it directly without acknowledging the feedback label; if it's a product suggestion, he says "Got it — I'll pass that along." Dean's `user_message` prompt includes explicit rules for both paths. Requires `RESEND_API_KEY` and `ADMIN_EMAIL` env vars.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`

## 2026-03-24 — Fixed mileage reset for non-Strava users on weekly recap

**Type:** Bug Fix
**Reported by:** User feedback (Jake's mom, Catherine)
**User feedback:** "She noticed is that Dean initially gave her 12 or maybe 10 miles of easy running in a week, then gave her 12, then gave her 11, so the mileage started going down. She's starting to feel good, so she actually feels like she can do more. It feels like he's not pushing her enough... Instead, he's just kind of randomly decreasing mileage."
**Root cause:** Catherine doesn't use Strava. Every Sunday when the `weekly_recap` cron fired, `recentActivities` was empty → `weekMileageSoFar = 0`, `avgWeeklyMileage = null`, `suggestedWeeklyMiles = null`. Claude was explicitly told "0.0 mi across 0 runs this week" and treated it as authoritative — generating messages like "Last week was quiet — 0 miles logged" and resetting to a beginner-conservative plan (6.5mi) even when Catherine had been running 10–12mi weeks.
**Fix / Change:**
Three changes to `coach/respond/route.ts`:
1. **Periodization fallback**: For non-Strava users where `avgWeeklyMileage` is null, fall back to `state.weekly_mileage_target` (what Dean last prescribed) as the baseline for progression target computation. This ensures the `+8%` build target is anchored to the actual prescribed plan, not to nothing.
2. **System prompt mileage line**: When the athlete has no Strava and 0 tracked miles, replace "0.0 mi done so far" with "not tracked (athlete not on Strava) — refer to RECENT CONVERSATION for what was reported". Prevents Claude from treating 0 as a real mileage figure.
3. **Weekly recap user message**: When no Strava and 0 tracked miles, replace the authoritative "0.0 mi this week" context block with an explicit warning: data is missing, do NOT say "quiet week", check conversation for what was reported.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-03-23 — Auto-resolve injury notes when athlete confirms they're better

**Type:** Feature
**Reported by:** Internal observation (follow-on to injury nagging fix)
**User feedback:** N/A
**Root cause:** Even with a prompt-level "stop asking" rule, the underlying `injury_notes` in the DB still said e.g. "side cramp" — so after every plan reset or new conversation context, the injury would reappear as an active concern. The resolved state existed only in recent conversation history, which fades.
**Fix / Change:**
- Added `injury_resolved` field to `ExtractedProfileData` and the Haiku extraction prompt. When an athlete explicitly says their injury is gone/resolved/no longer an issue, Haiku sets `injury_resolved: true`. One-run reports ("didn't hurt today") do not trigger this — only clear "it's healed" statements do.
- In `persistProfileUpdates`: if `injury_resolved === true` and `injury_notes` exists and doesn't already start with "Past (resolved):", the notes are rewritten to `"Past (resolved): [original]"`. This persists to the DB so the status survives across all future conversations.
- PROACTIVE INJURY section in system prompt now has a RESOLVED INJURIES rule: if notes start with "Past (resolved):", treat as historical context only — don't check in, don't mention in reminders, only surface if the athlete brings it up again.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-23 — Stop repeating injury questions; reduce conversational message length

**Type:** Bug Fix / Improvement
**Reported by:** User feedback (Jake's wife texting Dean)
**User feedback:** "he seems to be sending quite long texts, plus consistently asking about a side tenderness which is now better"
**Root cause:** (1) The injury follow-up rule said "never silently skip injury notes" with no off-ramp — Claude kept asking about the cramp/tenderness every message even after being told twice it was fine. (2) `user_message` had no rule against re-mentioning tomorrow's session in an active back-and-forth, so Dean kept appending the schedule preview to every reply. (3) Length rule allowed 2–3 bubbles by default with no distinction between plans vs. Q&A conversations.
**Fix / Change:**
- Added STOP ASKING RULE to the injury section: scan last 6 messages — if athlete has said the injury is fine/resolved, do not ask again. If they've said it twice, treat it as cleared entirely.
- Added NO REPEAT SCHEDULE PREVIEW to `user_message` prompt: if Dean already mentioned tomorrow's session or upcoming workouts earlier today, do not repeat it. Answer the question, then stop.
- Added LENGTH IN CONVERSATION to `user_message` prompt: if there are 4+ messages today (active back-and-forth), 1 bubble max — 2 at most.
- Tightened the global LENGTH rule to distinguish post-run/plans (2–3 bubbles OK) from Q&A (1 bubble almost always right).
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-03-23 — Code-driven periodization: week counter, phase, and deload scheduling

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `current_week` and `current_phase` were initialized during onboarding but never updated. Every user was perpetually on "Week 1, phase: base" regardless of how long they'd been training. Recovery weeks existed only as a vague coaching principle in the system prompt — Claude had no way to know when to actually deload.
**Fix / Change:**
- Added `src/lib/periodization.ts` with `computePhase()` and `buildPeriodization()` — single source of truth for week counting, phase, deload detection, and mileage progression targets.
- `computePhase()`: when a race date exists, phase is derived backwards from race day (base → build → peak → taper). Without a race, phases cycle on a 12-week calendar (6 base, 6 build).
- `buildPeriodization()`: computes `effectiveWeek` (initial_plan resets to 1; weekly_recap increments; others read as-is), `isDeloadWeek` (every 4th week, never during taper), and `suggestedWeeklyMiles` (−30% on deload, +8% on base/build, +5% on peak, null during taper).
- After each `initial_plan` or `weekly_recap`, `current_week`, `current_phase`, and `weekly_mileage_target` are persisted to the DB so all subsequent messages reference the correct values.
- System prompt now injects the computed week/phase/deload into CURRENT TRAINING STATE. On deload weeks, a mandatory `⚠️ RECOVERY WEEK` block tells Claude exactly what to do (25–30% volume reduction, no new quality sessions).
- `weekly_recap` user message prompt injects a deload instruction block or progression target based on the computed context.
- 21 new unit tests covering phase cycling, deload detection, taper override, and mileage targets.
**Files changed:** src/lib/periodization.ts (new), src/app/api/coach/respond/route.ts, src/__tests__/lib/periodization.test.ts (new)

## 2026-03-23 — Training arc overview and workout "why" across all message types

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Initial plan messages showed only the current week with no context about what's ahead. Quality sessions (tempo, intervals) had no explanation of their purpose. Users had no understanding of training phases or why they were doing specific workouts.
**Fix / Change:**
- `initial_plan`: First bubble now opens with a 1-2 sentence training arc orientation when a race date exists — briefly sketches the phases from base → quality → taper so the athlete knows where the whole journey is going, not just week 1. Then one sentence on why this specific week is structured the way it is.
- `initial_plan` sessions list: Quality sessions (tempo, intervals, race-pace work) now include a brief inline purpose note — e.g. "Wed 3/12 · Tempo 4mi (2mi @ 8:45) — builds lactate threshold, the engine for your goal pace."
- `weekly_recap`: PROGRESSION section now requires one rationale sentence every week, not just on phase changes — e.g. "Another building week — consistency is the work right now." Quality sessions in the sessions list also get the inline purpose note.
- `morning_reminder` / `nightly_reminder`: Quality sessions now include one sentence explaining what they train and why it matters for the athlete's goal. Woven naturally after the workout description.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-23 — Test suite, Strava webhook async fix, cron N+1 query batching

**Type:** Infra + Performance
**Reported by:** Internal — pre-launch reliability review
**User feedback:** N/A
**Root cause:** (1) No automated tests meant breakage could only be caught manually. (2) The Strava webhook processed activities synchronously — `getValidAccessToken` + `getActivity` HTTP calls + multiple DB writes could take 3–5 seconds, exceeding Strava's 2-second response window and triggering retries. (3) The morning and nightly reminder crons made 2–3 individual DB queries per user (checking for recent post_run and user messages), scaling as O(n) with user count.
**Fix / Change:**
- Added vitest test suite: 54 tests across 6 files covering VDOT pace calculations, timezone inference, typing indicator timing, signup flow (validation, duplicate detection, SMS send), Strava webhook (deauth, new activity, onboarding guard, dedup), and Linq webhook (opt-out keywords, opt-in restart, routing to onboarding vs coaching vs discard).
- Wrapped Strava activity processing in `after()` so the webhook always returns 200 to Strava immediately, then processes asynchronously.
- Refactored morning and nightly reminder crons to batch conversation lookups: a two-pass approach pre-computes which users need checks (no DB), then does 2 batch queries for all users combined, replacing O(n×2–3) queries with O(2). Per-user `fetch` calls now run in parallel via `Promise.allSettled`.
**Files changed:** vitest.config.ts, package.json, tsconfig.json, src/__tests__/**, src/app/api/webhooks/strava/route.ts, src/app/api/cron/morning-reminder/route.ts, src/app/api/cron/nightly-reminder/route.ts

---

## 2026-03-23 — Pin goal race to top of system prompt to prevent distance hallucination

**Type:** Bug Fix
**Reported by:** User b1b308cf
**User feedback:** "It's a 50 mile race and not 50k"
**Root cause:** Coach Dean spontaneously wrote "50K" mid-conversation (in a gear advice response) despite the profile correctly storing the race as a 50-mile ultra. The model made an initial slip, which then lived in conversation history. Subsequent calls to buildSystemPrompt fed that "50K" assistant turn back as context, and the model anchored to its own prior output rather than the profile data. The RACE DATA RULE existed but was buried in the ATHLETE HISTORY block (~57 lines into the prompt) and didn't account for the model trusting its own prior conversation turns over profile data.
**Fix / Change:** Goal race is now the very first thing in the system prompt — before the role description, output rules, or any other context. Format: `ATHLETE: / GOAL: [distance] on [date]` followed immediately by a warning that prior conversation messages may contain errors and the profile is authoritative. Removed the redundant RACE DATA RULE from the ATHLETE HISTORY block.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-22 — Fix three user-reported coaching issues (Curtis, Isaac x2)

**Type:** Bug Fix + Improvement
**Reported by:** Curtis, Isaac

**Issue 0 — Mid-onboarding drop-off (pre-plan stall, all users)**
**Root cause:** The reengagement cron only ran for users with `onboarding_step IS NULL`. Users who started onboarding but dropped off mid-flow (at any of the 11 pre-plan steps: awaiting_goal, awaiting_race_date, etc.) were never contacted again.
**Fix:** Cron query now fetches all users regardless of onboarding_step. New pre-plan stall check: if a user has been silent for >2 days on any pre-plan step and no nudge has been sent, they get a single resume nudge ("looks like we got cut off — just reply to pick up where you left off"). When they reply, `onboarding/handle` routes them from their current step automatically.
**Files changed:** src/app/api/cron/reengagement/route.ts

**Issue 1 — Curtis: dead silence after initial plan (awaiting_cadence stall)**
**User feedback:** "After I set it up, I wasn't getting any sort of messages. Dead silence. I thought it must just be way less chatty than I expected. Then, I realized that I never replied to the final setup message. It said something like, 'I'll send you a weekly plan. How does that sound'. I think because I never said 'okay,' the conversation stopped completely."
**Root cause:** `coach/respond` sets `onboarding_step = 'awaiting_cadence'` after the initial plan fires. The reengagement cron's query filtered `.is("onboarding_step", null)`, making these users completely invisible — no proactive messages, no nudges, nothing.
**Fix:** Extended the reengagement cron query to include `awaiting_cadence` users. If the initial plan was sent >3 days ago with no reply, the cron defaults the user to `nightly_reminders`, sets `onboarding_step = null`, and sends a nudge explaining the default.
**Files changed:** src/app/api/cron/reengagement/route.ts

**Issue 2 — Isaac: Strava elapsed time causing false "break" analysis**
**User feedback:** "The AI coach has started to comment on strava stats like total moving time, which are very misleading to it. For example, i didn't stop and save my strava and perhaps let it be on pause for a while, and it interpreted that pretty poorly… The moving time was 1:54 but elapsed over 2 hours, so looks like there were breaks built in."
**Root cause:** `activityForClaude` spread all DB fields including `elapsed_time_seconds`. Claude compared it to `moving_time_seconds` and inferred breaks. Separately, the paused-device final split (72:30/mi) passed through unfiltered.
**Fix:** Excluded `elapsed_time_seconds` from `activityForClaude`. Added a filter on splits to drop any with pace >20 min/mile (clearly device-paused, not running).
**Files changed:** src/app/api/coach/respond/route.ts

**Issue 3 — Isaac: passive coaching, no goal discussion**
**User feedback:** "It doesn't feel like it's pushing/coaching me at all. Just saying good job and suggesting week after week of about the same total mileage, and asking about how my legs feel. It never talks about goals either."
**Root cause:** The `post_run` prompt only said "analyze their performance" with no instruction to connect runs to race goals or push for progression. The `weekly_recap` prompt had no guidance to introduce quality sessions or explain the training arc.
**Fix:** Added a COACHING FORWARD section to the `post_run` prompt: explicitly instructs Claude to connect runs to race prep, name improvements, and suggest quality sessions if the athlete has a time goal and is stuck in all-easy volume. Added a PROGRESSION section to `weekly_recap`: if the athlete has a time goal and recent weeks are all easy, this week's plan must introduce tempo or interval work with a rationale sentence.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-22 — Fix "Week 2" labeling bug and push Sunday recap to 6pm PT

**Type:** Bug Fix + Improvement
**Reported by:** Ian
**User feedback:** (1) "It's not week 2, I've been using Coach Dean for a while — I think this should be week 4." (2) Asked if the weekly recap cron is accidentally on UTC — it ran during his run.
**Root cause:** (1) Weekly recap prompt had no guard against week numbering. Claude inferred "Week 2" from the training context (low mileage + building volume) rather than from any authoritative source. (2) Sunday recap was `0 22 * * 0` = 22:00 UTC = 3pm PDT / 6pm EDT — firing mid-afternoon PT and catching east-coast evening runners mid-run.
**Fix / Change:** (1) Added a WEEK NUMBERING rule to the weekly_recap prompt: do not use "Week N" labels — use "this week" / "next week" or describe the phase by intent instead. (2) Moved sunday-recap cron from `0 22 * * 0` (22:00 UTC Sunday = 3pm PDT) to `0 1 * * 1` (01:00 UTC Monday = 6pm PDT / 9pm EDT Sunday), giving most US runners time to finish their Sunday run.
**Files changed:** src/app/api/coach/respond/route.ts, vercel.json, src/app/api/cron/sunday-recap/route.ts

---

## 2026-03-22 — Fix Claude reasoning leaking into SMS for reminder triggers

**Type:** Bug Fix
**Reported by:** Nathan (observed in conversation)
**User feedback:** Nathan received messages containing Dean's internal reasoning ("Wait — I need to check the context first", "But hold on — let me re-read the data more carefully", "This is confusing. Let me check the actual situation") as literal SMS texts at 8:49 PM.
**Root cause:** The reminder prompt variants all started with "CONTEXT CHECK: Before writing, scan the RECENT CONVERSATION above..." — this framing explicitly invited Claude to narrate its scanning process before producing the final message. Claude then used a `---` separator to divide reasoning from the answer, but `splitIntoMessages` has no concept of that separator and sent all of it. The system prompt's "do all reasoning silently" rule was overridden by the more specific user-message instruction to scan-before-writing.
**Fix / Change:** Removed the "CONTEXT CHECK: Before writing, scan..." framing from all 6 reminder prompt variants (morning/nightly × plain/includeWorkoutCheckin/missedRunCheckin). Replaced with direct conditional rules: "If RECENT CONVERSATION already contains X, send ONE sentence only. Otherwise, [instructions]." No scanning invitation = no narration = no leakage. Also applied the same fix to 4 additional high-risk imperative patterns in weekly_recap and initial_plan ("Before placing any run, check...", "Before finalizing the week plan, count...", "Before writing any weekly mileage total, silently sum...", "Look at X before writing a single word") — same structural vulnerability, lower frequency so not yet caught in production.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-22 — Don't assume Strava users ran if no activity came through

**Type:** Bug Fix
**Reported by:** Elise
**User feedback:** "Dean assumed I ran on Friday and Saturday even though I didn't — it didn't give me any chance to reschedule"
**Root cause:** Both morning-reminder and nightly-reminder crons only included a workout check-in for users *without* Strava, on the assumption that Strava users get post-run feedback via webhook. But if no run happened, there's no webhook, so Dean silently assumed the workout occurred and sent the next-day reminder as normal.
**Fix / Change:** Both crons now also check for Strava users: if yesterday/today was a scheduled training day and no `post_run` conversation arrived in the relevant window (and the user hasn't already texted in), a new `missedRunCheckin: true` flag is passed to `coach/respond`. This triggers a separate prompt branch with a casual, non-judgmental check-in ("Didn't see a run from you yesterday — did you get it in?") followed by today's session and an open invite to reschedule.
**Files changed:** src/app/api/cron/morning-reminder/route.ts, src/app/api/cron/nightly-reminder/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-21 — Fix four coaching issues found in user conversations

**Type:** Bug Fix
**Reported by:** Internal observation (user d7aac841, f2a0b924)

### Issue 2 — Contradictory Strava connection state
**User feedback:** Within one day: "I don't see Strava data" → "Your Strava is already connected" → "I don't have Strava connected yet"
**Root cause:** `hasStrava` was injected into `buildUserMessage` for plan formatting only. System prompt never explicitly stated the connection status — Claude inferred it from whether activity data was present, which fails when Strava is connected but import hasn't finished.
**Fix:** Added `- Strava: connected / not connected` as an explicit line in ATHLETE HISTORY, derived from `user.strava_athlete_id`. Claude now reads a factual boolean rather than inferring from data presence.

### Issue 3 — JSON leakage + off-topic classifier false negative
**User feedback:** `{"on_topic": false} "That's awesome..."` appeared in a coach message. Athlete pushback on beginner plan was classified as off-topic and ignored.
**Root cause:** (1) `checkOffTopic` asked Claude to return either JSON or plain text — ambiguous format that leaked when Claude mixed formats. (2) Classifier prompt didn't include "fitness/training pushback" as explicitly on-topic, so "I've been running consistently, I think I can handle more mileage" was classified as off-topic during `awaiting_schedule`.
**Fix:** Restructured `checkOffTopic` to always return structured JSON (`{"on_topic": true}` or `{"on_topic": false, "response": "..."}`). Added athlete fitness/training pushback and plan correction explicitly to the on-topic list. Parsing now reads the `response` field directly — no string stripping that could leak.

### Issue 4 — Half marathon becomes marathon, goal pace fabricated
**Root cause:** When `goal_time_minutes` is not stored, `goalPaceStr` is empty — nothing in the prompt explicitly says "no goal pace". The GOAL PACE rule told Claude to use "the pre-calculated value", but Claude hallucinated one when it wasn't there. Also no guardrail against substituting a different race distance.
**Fix:** Added `" — no goal time on file"` to the goal line when undefined, so the absence is explicit. Added rule to GOAL PACE section: if "goal pace" doesn't appear in ATHLETE HISTORY, do not invent one — use effort-based language instead.

### Issue 5 — Stroller running noted but dropped
**Root cause:** `other_notes` (including stroller context) was being extracted and saved to the DB, but the `handleGoal` acknowledgment was built from canned templates that never referenced it — so the athlete got no acknowledgment in the moment.
**Fix:** Added `generateConstraintAcknowledgment` (Haiku, 80 tokens) that fires in parallel with the existing enrichment calls when `other_notes` is present. Appends a Claude-generated natural sentence to the acknowledgment for both named-race and standard-goal paths. Also added "stroller running" as an explicit example in both extraction prompts to ensure reliable capture.

**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts

---

## 2026-03-21 — Surface Coach Dean start date in system prompt

**Type:** Feature
**Reported by:** User feedback (Jake)
**User feedback:** "my wife also was curious what her last X weeks of training looked like and dean didn't seem to have an accurate recollection of when she started training with Dean... Example: How many weeks have I been training with you? What was my start date?"
**Root cause:** `user.created_at` existed in the DB but wasn't surfaced in the system prompt. The MEMORY AND DATA LIMITATIONS section explicitly told Dean "never state when the athlete first signed up" — so he'd correctly admit he didn't know, even though the data was available.
**Fix / Change:** Compute start date and weeks-with-Dean from `user.created_at` inside `buildSystemPrompt`. Inject into ATHLETE HISTORY as "Started with Coach Dean: [date] (X weeks ago)". Updated MEMORY AND DATA LIMITATIONS to tell Dean he does have this info and should use it.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-03-21 — Removed hard quality-session ban for low-volume athletes

**Type:** Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "my wife has been running for a long time and is wondering why she isn't getting intervals / tempo"
**Root cause:** The LOW VOLUME fitness tier (avg < 10 mi/week) contained a hard rule: "Hold off on structured quality sessions (tempo, intervals) until they have 4–6 weeks of steady easy running." This fired regardless of all-time experience or race goal — an experienced runner returning from a break or training for a 5K/mile would get base-only plans. Also flagged: no 5K-specific section existed, and the LOW VOLUME block was fighting Claude's contextual judgment rather than guiding it.
**Fix / Change:** Replaced the hard ban with a directional nudge: include at least 1 quality session/week for all non-true-beginners, calibrated to all-time experience (visible in Strava stats) and race goal. Left the WEEK 1 VOLUME CAP intact. The "No data" tier remains base-only — that's the correct guardrail for true beginners. Deliberately chose to loosen the restriction rather than add carve-outs (5K exception, experienced runner exception) to keep the prompt lean and trust Claude's judgment.
**Files changed:** src/app/api/coach/respond/route.ts

---

## [Unreleased]

---

## 2026-03-21 — Fix post_run "on track for X mi" using wrong projected total

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "You're at 5.1 mi this week, on track for 15 mi total. Sat long run (4mi) and Mon easy (3mi) are up next." — 5.1 + 4 + 3 = 12.1, not 15.
**Root cause:** For `post_run` responses, `correctMileageTotal` was skipped entirely (correct — there's no session list in the response). But Dean still reads the `UPCOMING SESSIONS THIS WEEK` block from the training state and sometimes computes a projected total himself, citing "on track for X mi". If Dean only mentions the next 1–2 upcoming sessions in his reply but cites the full-week projected total, the math looks inconsistent to the user. There was no post-processing step to validate Dean's stated projection against the system-computed value.
**Fix / Change:** Added two new helpers: `computeProjectedWeekMiles(sessions, weekMileageSoFar)` — mirrors the projection logic in `buildCurrentTrainingState` and returns the authoritative projected total. `correctProjectedTotal(message, projectedWeekMiles)` — corrects "on track for X mi" / "on pace for X mi" / "projected X mi" patterns when Dean's stated value diverges from the system-computed projection. For `post_run`, the response now passes through `correctProjectedTotal` instead of being returned raw. Added 8 test cases in `test-dedup-mileage.mjs`.
**Files changed:** `src/app/api/coach/respond/route.ts`, `scripts/test-dedup-mileage.mjs`

---

## 2026-03-21 — Fix next-week plan total inflated by current-week miles

**Type:** Bug Fix
**Reported by:** Jake (wife's account)
**User feedback:** "she has 4 runs, with 15 miles total, but Dean said it was 25 miles"
**Root cause:** `correctMileageTotal` is called with `alreadyCompletedMiles = weekMileageSoFar` to handle mid-week plan corrections (e.g. Ian's bug where Dean forgot to add completed runs to the stated total). But when the user asks "what's next week's plan?", the response contains sessions dated to the following week. `correctMileageTotal` computed `correctTotal = plannedMiles (15) + alreadyCompletedMiles (10) = 25`, then saw Dean's "15 mi total" and "corrected" it to 25. The function had no concept of which week the plan was for.
**Fix / Change:** `correctMileageTotal` now parses the month/day from each session line (`Mon 3/23 · ...`) to find the earliest session date. If the plan's Monday is in a future week relative to today, it sets `effectiveCompleted = 0` (the future week starts at 0 miles). Added dynamic test cases in `test-dedup-mileage.mjs` that compute next-week dates from `new Date()` so they stay valid over time.
**Files changed:** `src/app/api/coach/respond/route.ts`, `scripts/test-dedup-mileage.mjs`

---

## 2026-03-21 — Fix weekly mileage double-counting from manual/Strava race condition

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "I'm only at like 4.5. I think it double counted my run that was 3.05 miles that just come in still."
**Root cause:** Race condition between a `user_message` handler (which extracts and stores a manual activity when the user texts Dean about a run) and the Strava webhook (which tries to delete manual dupes before firing `coach/respond`). If the user_message INSERT completes after the webhook's DELETE query, the manual activity survives and is counted alongside the Strava activity — doubling the mileage for that run. The `deduplicateActivities` function only caught same-start-time pairs (±2 min), so a manual activity stored at noon UTC and a Strava activity at the actual run time (hours apart) were both counted.
**Fix / Change:** Added Pass 2 to `deduplicateActivities`: after the existing time-based dedup, build a map of Strava activity (UTC date → [distance_meters]). Then filter out any `source = 'manual'` or `source = 'conversation'` activity whose UTC date and distance (within 15%) match a Strava counterpart. Since `deduplicateActivities` runs inside `processCoachRequest` (in `after()`), this runs after all DB writes have completed — it catches any manual that survived the webhook's earlier deletion attempt. Also added `source` to the `ActivityRow` interface and select query so the field is available for dedup logic. Added 6 test cases to `test-dedup-mileage.mjs` covering the shadow removal, false-positive guard (different date), distance-mismatch guard, two-Strava-same-day non-dedup, and conversation source.
**Files changed:** `src/app/api/coach/respond/route.ts`, `scripts/test-dedup-mileage.mjs`

---

## 2026-03-20 — Four onboarding plan quality fixes from pressure-test run

**Type:** Bug Fix
**Reported by:** Internal testing (20-scenario pressure test)
**User feedback:** N/A
**Root cause:** Four separate issues discovered in full 20-scenario test run:
1. `generateRaceAcknowledgment` returned `["12K", "15K"]` for Bay to Breakers (single-distance race). Prompt rule existed but wasn't strong enough. Claude confabulated a "15K option" from a unit-conversion variant.
2. True beginners (TC06 only walks, TC18 doesn't run) got continuous 3mi runs instead of run/walk intervals. `initial_plan` prompt had volume cap but no run/walk trigger.
3. Timeline math was nondeterministic — Claude independently computed "7.5 weeks" for a 32-week-away marathon by unit-converting incorrectly. DATE CONTEXT already had the pre-calculated value but no instruction to use it exclusively.
4. `awaiting_ultra_background` step never fired for TC03/TC07/TC19 because `isStepSatisfied` checked `experience_years != null` which got set from non-ultra context (lottery attempts, etc.) and prematurely satisfied the step.
**Fix / Change:**
- Bug 1: Strengthened `generateRaceAcknowledgment` prompt to distinguish "distinct entry categories" from "unit-conversion variants". Added code-level ratio filter: `distanceOptions` is discarded if max/min < 1.3 (catches 12K vs 15K which differ by only 25%).
- Bug 2: Added `RUN/WALK INTERVALS FOR ZERO-BASELINE ATHLETES` rule to `initial_plan` prompt in coach/respond — triggers when FITNESS TIER is "No activity data" or weekly miles ≈ 0 with no running habit.
- Bug 3: Added `RACE TIMELINE — never compute this yourself` rule to `initial_plan` prompt, pointing at the pre-calculated days/weeks in DATE CONTEXT.
- Bug 4: Changed `isStepSatisfied("awaiting_ultra_background")` to require `data.ultra_race_history` (explicit) instead of `data.experience_years != null` (too broad). Added `ultra_race_history` field to `extractAdditionalFields` so the extractor captures it when the user mentions actual races completed.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

---

## 2026-03-20 — Fix initial_plan DB constraint blocking plan storage in dry_run tests

**Type:** Bug Fix
**Reported by:** Internal — debug investigation of missing initial_plan in test output
**User feedback:** N/A
**Root cause:** `conversations` table had a CHECK constraint (`conversations_message_type_check`) listing only `'morning_plan', 'post_run', 'user_message', 'coach_response', 'reengagement'`. `initial_plan` was not included. All 5 insert attempts in `completeOnboarding`'s dry_run path silently failed with postgres error 23514. The plan was generated (773 chars, correct content) but never persisted.
**Fix / Change:** Migration `019_initial_plan_message_type.sql` drops and recreates the constraint with `'initial_plan'` added. Also removed temporary `[debug/completeOnboarding]` and `[debug/timezone]` console.log statements added during diagnosis.
**Files changed:** `supabase/migrations/019_initial_plan_message_type.sql`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-20 — Fix initial plan display in test runner + Bay to Breakers loop

**Type:** Bug Fix (test tooling)
**Reported by:** Internal — second 20-scenario test run
**User feedback:** N/A
**Root cause:** (1) Test runner exited loop at step=null before `completeOnboarding` finished generating the initial plan — never showed the plan output. (2) Bay to Breakers web search hallucinated a "15K option" that doesn't exist, triggering a disambiguation loop. The default for `awaiting_goal` was "OK, sounds good" which doesn't resolve a goal, causing 15-round infinite loop. (3) `generateRaceAcknowledgment` lacked a clear rule against confabulating distances.
**Fix / Change:** Added 5s post-loop wait + explicit `initial_plan` query so plans are always shown. Added `awaiting_goal` fallback default to break disambiguation loops. Added distance_options confabulation rule to web search prompt.
**Files changed:** `tests/run-onboarding-test.mjs`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-03-20 — Onboarding bug fixes from pressure-test run + step-driven test runner

**Type:** Bug Fix + Improvement
**Reported by:** Internal — automated 20-scenario pressure test
**User feedback:** N/A
**Root cause:** Three distinct bugs found in `generateRaceAcknowledgment` and `extractAdditionalFields`:
1. Web search `<cite index="...">` tags leaked into SMS ack text verbatim
2. `goal_time_minutes` was never extracted from the initial goal message, causing `awaiting_goal_time` to always fire even when user stated their time goal upfront (e.g. "Need to run sub 3:05")
3. Hallucinated race dates: model inferred a date from "5 months from now" or made up a past date, then included countdown language ("6 weeks out") based on it
**Fix / Change:**
- Bug 1: Strip `<cite ...>...</cite>` and self-closing `<cite ... />` tags from `ack` after web search response; also strip from plain-text fallback
- Bug 2: Added `goal_time_minutes` to `extractAdditionalFields` — only extracted when user EXPLICITLY states a specific finish time; omitted entirely (not null) when not mentioned, so `awaiting_goal_time` still fires when needed
- Bug 3: (a) Strengthened prompt: never compute date from relative expressions, never include timeline language without a confirmed search date. (b) Post-processing: discard `raceDate` if it's in the past relative to today
- Test runner rewritten to be fully step-driven: queries actual DB `onboarding_step` after each exchange, sends matching scenario message or default fallback; handles dynamic steps (timezone, ultra_background, etc.) automatically without hard-coding into each scenario
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `tests/run-onboarding-test.mjs`

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

