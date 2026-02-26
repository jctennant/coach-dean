# Coach Dean — Changelog

All notable changes to Coach Dean are tracked here. Each entry includes the user feedback or motivation that drove the change, so we have full context over time.

---

## [Unreleased]

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

