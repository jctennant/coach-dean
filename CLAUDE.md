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
| `src/app/api/onboarding/handle/route.ts` | Unified onboarding conversation — Sonnet drives dialogue, Haiku extracts fields, [READY] completes |
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

### conversations.message_type allowlist

The DB has a `CHECK` constraint (`conversations_message_type_check`) enforcing valid values. **Whenever you add a new message_type, you must also add it to this constraint via a migration**, otherwise inserts will fail silently (the error is swallowed unless logged).

Current valid values:
`post_run`, `initial_plan`, `initial_plan_link`, `morning_plan`, `nightly_reminder`, `morning_reminder`, `weekly_recap`, `user_message`, `coach_response`, `onboarding`, `awaiting_strava`, `reengagement`, `plan_import_week_ask`, `plan_upload`, `changelog`, `dashboard_announcement`, `welcome_tips`, `workout_image`

Migration pattern to add a new type:
```sql
ALTER TABLE conversations DROP CONSTRAINT conversations_message_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_message_type_check
  CHECK (message_type IN ('post_run', 'initial_plan', ... , 'your_new_type'));
```

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

## Onboarding states (onboarding_step column)

The old discrete step flow is gone. Onboarding is now a **unified conversation** driven by a single Claude (Sonnet) call per message.

| State | What it does |
|---|---|
| `"onboarding"` | Main state — Claude conversation collects everything naturally, signals [READY] when done |
| `"awaiting_strava"` | Pause state — conversation halts while user connects Strava or replies "skip" |
| `"awaiting_timezone"` | Post-plan — non-Strava users asked for city/state so reminders fire at correct local time |
| `"awaiting_payment"` | Billing gate — user receives trial checkout link; plan accessible after signup |
| `"awaiting_cadence"` | **Legacy** — immediately graduates user to `null` with `nightly_reminders` default |
| `null` | Onboarding complete |

**What Dean collects in the unified conversation (rough order):**
1. Name + goal (combined in first message)
2. Training context: "Are you working from a plan already, or starting fresh?" (just context — no routing decision)
3. Strava (mandatory — write-access link used for coaching note annotation)
4. Injury history (required for all athletes, asked after Strava connects)
5. Race date (web_search required for any named race — never state from memory)
6. *(Trail/mountain races)* Race goal (finish vs. competitive placement) + prior race experience
7. *(Ultra goals 30k+)* Ultra/trail race background
8. *(return_to_running / injury_recovery)* Injury details + current status
9. *(Short races: mile / 5k / 10k)* Goal finish time
10. Training days per week (if Strava has no data)

**Required for [READY]:** Name + goal + Strava connected + injury history answered. No mode question.

When all required fields are collected, Claude appends `[READY]` to its final message. The system strips the tag, stores the data, and fires the `initial_plan` trigger for ALL users. `coaching_mode = 'adaptive'` for all new users — one mode, responsive coaching toward the race.

## Patterns to know

- **All proactive triggers** use `after()` to return 200 immediately, then process async — Vercel keeps the process alive after response
- **`dry_run` mode** available on both coach/respond and onboarding/handle — skips SMS, still writes conversations, returns the message in the response body
- **`rebuild_plan` trigger** — silent plan regeneration: `{"userId":"<id>","trigger":"rebuild_plan","silent":true}` rebuilds the arc without sending the "plan ready" SMS. Note: `userId` is camelCase in the request body.
- **Activity dedup**: by `strava_activity_id` (upsert), plus near-dupe detection (±2 min start time, ±15% distance) and manual-dupe cleanup
- **Typing indicators**: `startTyping()` called before each Claude call; a background loop refreshes every 4.5s for long generations
- **Message splitting**: `splitIntoMessages()` breaks long coach responses into multiple SMS bubbles, each sent with a compose delay
- **Tests**: vitest, all in `src/__tests__/`. Supabase and Anthropic are always mocked. Run with `npm test`.

## Admin curl commands

Always write curl commands as a single line — multi-line commands cause copy/paste issues. Example:

```bash
curl -X POST https://coachdean.ai/api/coach/respond -H "Content-Type: application/json" -d '{"userId":"<id>","trigger":"rebuild_plan","silent":true}'
```

**Request body field names** use camelCase (`userId`, not `user_id`).

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

## Eval Harness (`/evals/`)

`npm run eval` — run LLM-as-judge quality checks on Coach Dean's responses. Not part of CI (expensive); run manually before significant prompt changes.

### What the evals test

Each fixture in `evals/fixtures/*.json` represents a frozen user state + inbound SMS. The runner (`evals/run-evals.mjs`) builds a realistic coaching system prompt from the fixture data, calls Claude Sonnet for the response, then calls Claude Opus as the judge. Results go to `evals/results/` (gitignored).

**23 fixtures across 7 categories:**

| Category | What it catches | Fixture count |
|---|---|---|
| `mileage_accuracy` | Wrong weekly total, hallucinated mileage, deload week target errors | 4 |
| `pace_accuracy` | Wrong VDOT-derived pace, unit errors (min/km vs min/mile), tempo slower than easy | 4 |
| `split_distance_accuracy` | Coach says "mile 5" on a 3.1mi run — km splits misread as mile splits | 3 |
| `date_week_correctness` | Wrong week number after plan regen, wrong phase name, race-week messaging missed | 3 |
| `mileage_format` | Additive total format ("Total: 25mi + your 15mi already") | 2 |
| `response_quality` | ⚠️ internal labels echoed verbatim, morning reminder says rest day when run was confirmed, morning plan attributes activity to wrong day; post-run opener praise; numbers cited without interpretation; strength block fires when it shouldn't; strength block absent when injury is active | 7 |
| `plan_quality` | Plan structure: volume ramp, long run, quality sessions, safe progression — and for metric users, correct km units throughout | 1 |

**Current baseline (2026-04-02):** 22/22 passing, avg 9.5/10. No known failures. (Baseline pre-dates `plan-half-marathon-metric` and 4 post-run quality fixtures added 2026-05-24 — run evals to establish new baseline.)

### When to update evals

**Update a fixture's `ground_truth`** when you change intentional behavior — e.g. if the mileage format changes deliberately, update what "correct" means.

**Add a new fixture** when a user reports a factual error in a response: extract the user's context (week, VDOT, miles), recreate it as a fixture, and add it to catch regressions of that specific bug.

**Do NOT update a fixture to make a failing test pass** by loosening the criteria — that defeats the purpose. If Dean's response is wrong, fix the prompt in `coach/respond/route.ts`, then re-run evals to confirm improvement.

### How the runner works (architecture note)

The runner builds the system prompt directly from fixture JSON — it does **not** call the live Next.js route or Supabase. This makes it a standalone tool with no running-server dependency. The tradeoff: it mirrors the prompt-building logic in `route.ts` rather than importing it. If you add a major new section to `buildSystemPrompt` (e.g. a new guard block that changes model behavior for a category), add the equivalent injection to `buildEvalSystemPrompt` in `evals/run-evals.mjs` so the evals stay realistic.

Key parity points to maintain between `route.ts` and `run-evals.mjs`:
- VDOT pace formula and easy-pace display range (`paceAtVDOTPct`, `easyPaceRange`)
- Next-7-days date mapping (weekday ↔ calendar date)
- The km-split DATA GUARD injection (`splitCount > ceil(miles) + 1`)
- ⚠️ RECOVERY WEEK block (injected when `current_week % 4 === 0 && phase !== taper/peak`)
- Mileage accuracy rules block (no additive totals)

### Score report / diff

```bash
node evals/score-report.mjs                              # compare two most recent runs
node evals/score-report.mjs results/run-A.json results/run-B.json
```

Exits 1 if regressions detected, so this can gate a deploy if needed.

---

## Onboarding Evals (`/evals/fixtures/onboarding/`)

`npm run eval:onboarding` — behavioral correctness checks for the onboarding conversation flow.

### What the onboarding evals test

| Category | What it catches | Fixtures |
|---|---|---|
| `first_message` | Dean must intro himself + ask for name on message 1 | 1 |
| `no_repetition` | No "Great to meet you" / re-intro on message 2+ | 1 |
| `conversation_flow` | No re-asking for already-collected fields; trail race handled correctly | 2 |
| `ready_signal` | [READY] must not appear in same message as an open question | 1 |

### Key parity points to maintain between `onboarding/handle/route.ts` and `run-onboarding-evals.mjs`

- `summarizeCollected` function (what Dean sees under "WHAT YOU ALREADY KNOW")
- `isFirstResponse` instruction branch (intro vs no-repeat)
- SIGNALING READY instructions (no question with [READY])
- STRAVA context format

### When to add a new onboarding fixture

Add a fixture whenever a conversation bug is reported (repetition, re-asking, wrong intro behavior). The fixture should freeze the conversation state and inbound message at the point of the failure.

---

## Simulation Evals (`/evals/fixtures/simulation/`)

`npm run eval:simulation` — end-to-end multi-turn onboarding simulations. A user agent (Haiku) plays each persona across multiple turns; Dean (Sonnet) responds; Haiku extracts fields after each exchange; Opus judges the full transcript.

### What the simulations test

| Persona | What it catches |
|---|---|
| `sim-trail-multi-race` | Multi-race handling, Strava mid-flow, correct A/B race split, trail_race goal type |
| `sim-marathon-first-timer` | Standard happy path, PR as fitness baseline, race date extraction |
| `sim-general-fitness` | No race → general_fitness goal, [READY] without race_date |
| `sim-injury-runner` | Injury collected before [READY], return_to_running goal, supportive tone |
| `sim-terse-user` | Minimal answers, follow-up questioning, higher turn budget |

### How it works

Each simulation turn:
1. Dean (Sonnet) generates a response given current `collected` + conversation history
2. [STRAVA_LINK] is intercepted — if persona has Strava, OAuth is simulated and Strava connected message injected
3. User agent (Haiku) replies as the persona
4. Haiku extraction runs on full history → merges into `collected`
5. Repeat until [READY] or max_turns

### Key parity points to maintain with `onboarding/handle/route.ts`

- `buildDeanSystemPrompt` → mirrors `handleConversation` system prompt exactly
- `summarizeCollected` → mirrors same function in route.ts
- `extractFields` + `mergeCollected` → mirrors Haiku extraction and merge logic
- VALID_GOAL_BUCKETS set

Use `--verbose` to print the full simulated conversation as it runs:
```bash
node evals/run-simulation-evals.mjs --fixture sim-trail-multi-race --verbose
```

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