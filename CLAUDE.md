# Coach Dean — Codebase Reference

## Stack
Next.js 14 App Router · Supabase (PostgreSQL) · Anthropic Claude · Linq SMS (iMessage-like) · Strava OAuth · Vercel

## Core data flow

```
Web signup → POST /api/signup → SMS onboarding (multi-step via /api/onboarding/handle)
                                      ↓ onboarding_step = null → initial_plan fires
Strava OAuth → /api/auth/strava/callback → imports activities → sends SMS
Strava webhook → /api/webhooks/strava → POST /api/coach/respond (trigger: post_run)
Inbound SMS → /api/webhooks/linq → onboarding/handle (if onboarding_step set) or coach/respond
Crons → POST /api/coach/respond (various triggers)
```

## Key files

| File | Purpose |
|---|---|
| `src/app/api/coach/respond/route.ts` | Core coaching engine — all triggers, Claude calls, SMS send |
| `src/app/api/onboarding/handle/route.ts` | Multi-step onboarding flow with Claude extractions |
| `src/app/api/webhooks/strava/route.ts` | Strava activity events → stores activity → fires coach/respond |
| `src/app/api/webhooks/linq/route.ts` | Inbound SMS routing |
| `src/app/api/auth/strava/callback/route.ts` | Strava OAuth, activity import, welcome SMS |
| `src/lib/strava.ts` | Strava API helpers (token refresh, activities, stats) |
| `src/lib/linq.ts` | SMS send/receive, typing indicator |
| `src/lib/paces.ts` | VDOT pace calculations |
| `src/lib/periodization.ts` | Training week/phase/deload logic |
| `src/lib/training-plan.ts` | Full multi-week plan generation |
| `src/lib/plan-validation.ts` | Volume cap enforcement, session dedup |

## DB tables

| Table | Key columns |
|---|---|
| `users` | `phone_number`, `name`, `strava_athlete_id`, `strava_*_token`, `onboarding_step`, `onboarding_data` (JSON), `timezone`, `linq_chat_id` |
| `training_profiles` | `race_date`, `goal`, `current_easy_pace`, `current_tempo_pace`, `current_interval_pace`, `preferred_units`, `injury_notes`, `proactive_cadence`, `training_days` |
| `training_state` | `current_week`, `current_phase`, `weekly_mileage_target`, `weekly_plan_sessions` (JSON), `last_activity_date`, `taper_peak_miles` |
| `training_plans` | `weeks` (JSON array of week objects), `total_weeks` — the full multi-week arc |
| `activities` | `strava_activity_id`, `activity_type`, `distance_meters`, `average_pace`, `average_heartrate`, `workout_type` (1=race), `start_date`, `summary` (splits/laps JSON) |
| `races` | `race_date`, `race_name`, `goal`, `priority` (A/B/C), `goal_time_minutes`, `goal_distance_miles` |
| `conversations` | `role`, `content`, `message_type`, `strava_activity_id`, `created_at` |

## Coach triggers (coach/respond)

| Trigger | When |
|---|---|
| `post_run` | Strava activity webhook (fully onboarded user) |
| `post_run_onboarding` | Strava activity webhook (user mid-onboarding) — lightweight early-exit path |
| `initial_plan` | End of onboarding — sets `onboarding_step: awaiting_cadence` before calling Claude |
| `weekly_recap` | Sunday cron — recaps week + builds next week plan |
| `morning_plan` | Morning cron — today's workout |
| `morning_reminder` | Morning cron for non-Strava or non-responding users |
| `nightly_reminder` | Nightly cron |
| `user_message` | Inbound SMS from onboarded user |
| `workout_image` | Image upload path |

## Onboarding steps (onboarding_step column)

`awaiting_goal` → `awaiting_race_date` → `awaiting_schedule` → [`awaiting_ultra_background`] → [`awaiting_injury_background`] → `awaiting_anything_else` → `awaiting_cadence` → `null` (complete)

`awaiting_strava` is a separate step handled by the Strava connect button, not by onboarding/handle. The OAuth callback advances the user from `awaiting_strava` → `awaiting_schedule`.

## Patterns to know

- **All proactive triggers** use `after()` to return 200 immediately, then process async — Vercel keeps the process alive after response
- **`dry_run` mode** available on both coach/respond and onboarding/handle — skips SMS, still writes conversations, returns the message in the response body
- **Activity dedup**: by `strava_activity_id` (upsert), plus near-dupe detection (±2 min start time, ±15% distance) and manual-dupe cleanup
- **Typing indicators**: `startTyping()` called before each Claude call; a background loop refreshes every 4.5s for long generations
- **Message splitting**: `splitIntoMessages()` breaks long coach responses into multiple SMS bubbles, each sent with a compose delay
- **Tests**: vitest, all in `src/__tests__/`. Supabase and Anthropic are always mocked. Run with `npm test`.

---

# Claude Code Instructions — Changelog Maintenance
## Changelog Rule

After completing **any meaningful change** to the codebase, always append a new entry to `CHANGELOG.md` at the root of the project.

### What counts as a meaningful change:
- Bug fixes (especially ones reported by users)
- New features or functionality
- Changes to how messages are sent or timed
- Updates to prompts or Coach Dean's behavior
- Infrastructure or config changes
- Dependency updates that affect behavior

### What to include in each entry:

```markdown
## YYYY-MM-DD — Short description of change

**Type:** Bug Fix | Feature | Improvement | Refactor | Infra
**Reported by:** User feedback / Internal observation / Testing
**User feedback:** (paste verbatim if this was user-reported, otherwise "N/A")
**Root cause:** (what was actually wrong or missing)
**Fix / Change:** (what changed and why — be specific)
**Files changed:** (list the key files modified)
```

## Test Rule

**Always run `npm test` before committing any code change** — including route handlers, lib files, cron jobs, and prompts. If tests fail after a code change, fix or update the tests before committing.

### When tests need to be updated (not just the code):
- Adding a new LLM call to an existing handler changes the mock call sequence — update the corresponding test to add the extra mock
- Changing what a function returns or which DB tables it touches may require updating assertions
- Changing intentional behavior (e.g. "web-search dates no longer auto-confirm") means updating the test's expected values and description to match the new contract

The GH Actions workflow runs `npm test` on every push. A commit that breaks tests will block every PR until fixed.

---

## Database Schema Rule

Whenever a DB migration is needed (new column, table, index, etc.):
1. Run `npm run gen:types` to regenerate `src/lib/database.types.ts` from the live schema
2. Run `npm run typecheck` to catch any code that references missing or renamed columns

This prevents runtime failures from schema/code drift. The `reengagement_sent_at` incident (all inbound messages silently failing) was caused by code referencing a column that hadn't been added to the DB yet — types would have caught it at build time.

### Backfill Rule for Behavioral Columns

Any time a new column uses `NULL` to mean "this has never happened" (e.g. `last_nightly_reminder_date`, `last_morning_reminder_date`), the migration **must** include a backfill `UPDATE` for existing rows — otherwise every existing user will incorrectly appear as a "first timer."

Example: adding `last_nightly_reminder_date`:
```sql
ALTER TABLE training_profiles ADD COLUMN IF NOT EXISTS last_nightly_reminder_date date;

-- Backfill: existing nightly_reminders users have clearly already been set up
UPDATE training_profiles SET last_nightly_reminder_date = CURRENT_DATE WHERE proactive_cadence = 'nightly_reminders';
```

### Existing Users Checklist for Proactive Features

Before shipping anything that fires automatically at users (crons, triggers, new message types), ask:
- What happens to users **already in the system** when this runs for the first time?
- Does any `NULL` check treat existing users as new users?
- Would a backfill be needed to set the correct initial state for existing rows?

---

### Rules:
1. Always add new entries at the **top** of the changelog, below the `[Unreleased]` header
2. Use today's date in `YYYY-MM-DD` format
3. If the change was driven by user feedback, **always paste it verbatim** — this is the most valuable part
4. Be specific in Root Cause and Fix — future you will thank present you
5. Never delete old entries

### Example entry:

```markdown
## 2025-02-25 — Fixed date off-by-one for evening runs

**Type:** Bug Fix
**Reported by:** Gwyneth 
**User feedback:** "Coach Dean told me my Tuesday run was on Wednesday, really annoying"
**Root cause:** Server was using UTC timestamps from Strava without converting to user's local timezone. A 9pm MT run was being read as the next day in UTC.
**Fix / Change:** Pull timezone from Strava athlete endpoint on account connect, store as IANA string (e.g. America/Denver), apply to all date formatting and reasoning logic.
**Files changed:** strava.ts, scheduler.ts, messageFormatter.ts
```