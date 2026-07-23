# Coach Dean — Codebase Reference

## Stack
Next.js 14 App Router · Supabase (PostgreSQL) · Anthropic Claude · Linq SMS (iMessage-like) · Strava OAuth · Vercel

## Prompt Engineering Philosophy

**Don't fix behavioral problems by adding more rules to the prompt.**

The system prompt in `coach/respond/route.ts` is already large. Every time something goes wrong, the temptation is to bolt on another rule. Resist this — a longer prompt means more for the model to juggle, more potential for conflicts, and a codebase that gets harder to reason about over time.

### When to add a rule (rare)
Only when the behavior is fundamental and applies universally across all triggers — e.g. "never echo internal plan state to athletes." Even then, prefer one concise sentence over a multi-line block.

### When NOT to add a rule
- One-off response quality issues (tone, word choice, phrasing) — these are noise, not signal
- Things that can be fixed in code (post-processing, output validation)
- Things that a separate focused agent handles better

### Preferred alternative: multi-agent decomposition (Poke pattern)
[Poke](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/) (an SMS AI agent that scaled to 400k users) solves this with two-layer architecture:

- **Interaction agent** — handles personality, tone, and user-facing conversation. Focused system prompt.
- **Execution agents** — spawned on-demand with their own isolated prompts for specific tasks (extraction, validation, plan generation). Pure task machines, zero personality.

This is already partially the pattern here (Haiku for extraction, Sonnet for coaching). When a new concern surfaces, ask: *should this be a separate focused agent call, not a new rule in the monolith?*

Examples of where this applies to Coach Dean:
- Response quality checks (name repetition, week number leaks, length) → a lightweight post-processing pass or validator call, not prompt rules
- Structured data extraction → already delegated to Haiku correctly
- Plan generation → already a separate lib function correctly

**Default question before adding any prompt text:** "Is there a code-level or architectural fix that keeps the prompt smaller?"

### Before you patch a *recurring* behavioral bug — check the fix mechanism, not just the fix

Three bug classes have each recurred multiple times across the changelog: Claude's internal
reasoning leaking into an athlete's SMS, Claude repeating the same coaching angle/phrase
across consecutive messages, and Claude hallucinating a fact. Each individual fix was
reasonable, but the *pattern* — "add a phrase to a list", "add a pattern to a regex", "add
another `<rule>` block" — is exactly what this file warns against, because it's chasing
phrasing variety with a classifier that can never be complete. If you're about to fix a bug
in one of these three families, use the decision order below instead of reaching straight
for another regex/phrase/`<rule>` addition:

1. **Can the channel itself make the bug structurally impossible?** This is the strongest
   fix and should be tried first. Example already in the codebase: `coach/respond/route.ts`
   forces every coaching turn through a `deliver_message` tool call (`tool_choice: {type:
   "any"}` on every request to `anthropic.messages.create`) — Claude's reasoning has no
   free-text channel to leak through anymore, because the only text read out of the response
   is the `message` argument of that specific tool call. `stripReasoningPreamble()` still
   exists as a defense-in-depth safety net (and as the extraction path for the rare turn
   where no tool gets called at all), but it is no longer the primary defense, and it should
   not be extended with new regex patterns as the main way to fix a new leak — if a new leak
   shape appears, first ask whether the structural constraint itself needs strengthening.
2. **If the channel can't be constrained, can a separate, focused validator judge *meaning*
   instead of *phrasing*?** This is the Poke-pattern execution agent, applied as a checker
   rather than a generator. Example already in the codebase: `src/lib/repetition-check.ts`
   — a one-purpose Haiku call that judges whether a new message repeats the same coaching
   angle as a recent one, semantically, so it doesn't need a maintained regex/phrase list at
   all (contrast with the `recentPostRunInsights` lens-pattern array and the `weekly_recap`
   `FORBIDDEN PHRASES` block in `route.ts`, both of which need a new entry every time Dean
   invents new wording for an old idea). New instances of this pattern don't have to be
   advisory-only forever — `repetition-check.ts` ships v1 as log-only specifically because it
   touches the live SMS send path; if you're adding a validator somewhere with more room for
   a blocking check (e.g. before a batch/cron send, or with a retry budget), it's fine to
   have it gate the response.
3. **Only if neither of the above applies** — i.e., the behavior is fundamental and
   universal, not phrasing-shaped — add the one-sentence prompt rule, per the "when to add a
   rule" section above.

### `route.ts` size

`coach/respond/route.ts` is large (thousands of lines, hundreds of functions) because the
default move for years was "add to the file that's already there." Don't make it worse by
default:
- New pure logic (parsing, scoring, validation, correction) belongs in `src/lib/*.ts`, not
  as another function in `route.ts` — `plan-validation.ts`, `load-score.ts`, and
  `repetition-check.ts` are the pattern to follow, not the exception.
- New Claude/Haiku calls that do one narrow job (extraction, validation, classification)
  belong in their own `src/lib/*.ts` file with their own prompt, not inline in the coaching
  system prompt.
- If you find yourself about to add a fourth or fifth variant of "scan recent messages for
  pattern X" directly in `route.ts`, that's a signal to extract a shared helper (or a
  validator agent) rather than writing another bespoke loop in place.
- A full decomposition of `route.ts` along interaction-agent / execution-agent lines is worth
  doing eventually, but it's a planned refactor with its own test/eval pass, not something to
  attempt piecemeal inside an unrelated bug fix.

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
| `training_profiles` | `race_date`, `goal`, `current_easy_pace`, `current_tempo_pace`, `current_interval_pace`, `preferred_units`, `injury_notes`, `proactive_cadence`, `training_days`, `crosstraining_tools`, `crosstraining_days` (optional CT day preference, distinct from `training_days`) |
| `training_state` | `current_week`, `current_phase`, `weekly_mileage_target`, `weekly_plan_sessions` (JSON), `last_activity_date`, `taper_peak_miles` |
| `training_plans` | `weeks` (JSON array of week objects), `total_weeks` — the full multi-week arc |
| `activities` | `strava_activity_id`, `activity_type`, `distance_meters`, `average_pace`, `average_heartrate`, `workout_type` (1=race), `start_date`, `summary` (splits/laps JSON) |
| `races` | `race_date`, `race_name`, `goal`, `priority` (A/B/C), `goal_time_minutes`, `goal_distance_miles` |
| `conversations` | `role`, `content`, `message_type`, `strava_activity_id`, `created_at` |

### conversations.message_type allowlist

The DB has a `CHECK` constraint (`conversations_message_type_check`) enforcing valid values. **Whenever you add a new message_type, you must also add it to this constraint via a migration**, otherwise inserts will fail silently (the error is swallowed unless logged).

Current valid values:
`post_run`, `initial_plan`, `initial_plan_link`, `morning_plan`, `nightly_reminder`, `morning_reminder`, `weekly_recap`, `user_message`, `coach_response`, `onboarding`, `awaiting_strava`, `reengagement`, `plan_import_week_ask`, `plan_upload`, `changelog`, `dashboard_announcement`, `welcome_tips`, `workout_image`, `symptom_checkin`, `injury_checkin`

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
| `null` | Onboarding complete |

(The legacy discrete-step states — `awaiting_cadence`, `awaiting_schedule`, `awaiting_goal_time`, etc. — were fully removed 2026-07-18 after a DB check confirmed no users held them.)

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

**73 fixtures across 9 categories:**

| Category | What it catches | Fixture count |
|---|---|---|
| `mileage_accuracy` | Wrong weekly total, hallucinated mileage, deload week target errors | 6 |
| `pace_accuracy` | Wrong VDOT-derived pace, unit errors (min/km vs min/mile), tempo slower than easy | 6 |
| `split_distance_accuracy` | Coach says "mile 5" on a 3.1mi run — km splits misread as mile splits | 3 |
| `date_week_correctness` | Wrong week number after plan regen, wrong phase name, race-week messaging missed | 8 |
| `mileage_format` | Additive total format ("Total: 25mi + your 15mi already") | 2 |
| `response_quality` | Internal labels echoed verbatim, injury handling (hold/clear/threshold), reminder correctness, post-run opener praise, numbers without interpretation, strength-block firing rules | 28 |
| `plan_quality` | Plan structure: volume ramp, long run, quality sessions, safe progression, metric units, cross-training integration | 12 |
| `plan_update` | Plan-change requests: lighter week, quality work, day-structure changes, long-run reschedules | 5 |
| `uploaded_plan_accuracy` | User-uploaded plan: range sessions, week sync, recap math | 3 |

**Last full run (2026-07-19, before the fact-gate wiring below):** 65/73 passing, avg 8.9/10 (up from 62/73 @ 8.4 on 2026-07-18 — several commits landed between the two runs and fixed things incidentally). `quality-morning-reminder-run` and `injury-shin-splints-mileage-spike` (both 0/10 on 2026-07-18) no longer reproduced. `plan-100k-crosstraining` (4/10) was root-caused to an eval-harness gap, not a Dean bug — see the fact-gate section below — and now scores 10/10. Of the remaining 8 failures from that run, 4 were individually confirmed fixed after wiring in the Phase B fact gate (`date-race-week`, `date-taper-messaging`, `pace-vdot52-post-run-easy`, `uploaded-plan-week-sync`) plus one fixture data bug fix (`post-run-stat-interpretation`) — **not yet re-run as a full 73-fixture suite** (that run is the expensive step; only run it before a significant prompt change or when you need a fresh aggregate number). Two failures are still open: `plan-masters-first-marathon` and `plan-shin-splints-10k` (`plan_quality` — not covered by the fact gate; likely the same free-hand-prompt gap as the crosstraining bug, see below). New finding, not yet resolved: `injury-shin-return-to-run-plan-question` fails 0/10 (missing literal `[INJURY_HOLD]` tag) even though Dean's content is correct — production's prompt never asks Dean to restate the tag on hold-continuation turns (only `[INJURY_CLEAR]` is asked for again), so this may be an overly strict fixture rather than a real bug; needs a product call before changing either side.

### When to update evals

**Update a fixture's `ground_truth`** when you change intentional behavior — e.g. if the mileage format changes deliberately, update what "correct" means.

**Add a new fixture** when a user reports a factual error in a response: extract the user's context (week, VDOT, miles), recreate it as a fixture, and add it to catch regressions of that specific bug.

**Do NOT update a fixture to make a failing test pass** by loosening the criteria — that defeats the purpose. If Dean's response is wrong, fix the prompt in `coach/respond/route.ts`, then re-run evals to confirm improvement.

### How the runner works (architecture note)

The runner builds the system prompt directly from fixture JSON — it does **not** call the live Next.js route or Supabase. This makes it a standalone tool with no running-server dependency.

Since 2026-07-18 the runner executes via `tsx` and **imports the extracted `src/lib` coach-context modules directly** instead of mirroring them: `coach-date-context` (DATE CONTEXT header + gap alert), `coach-race-context` (race countdown/taper/secondary races/post-race), `coach-fitness-tier`, `coach-pace-context`, `paces`, `session-mileage`, `injury-return`, and `exercise-library` (injury exercises + recovery timelines). **Every future Phase A slice extracted from `buildSystemPrompt` should be imported into the runner the same way — each extraction shrinks the parity list below instead of growing it.** Fixture notes: in-taper fixtures must set `user.taper_peak_miles` (mirrors the locked-in peak production persists at taper entry).

**Phase B fact gate is now wired into the runner too (2026-07-19)** — this was a real gap, not just a parity nit: for `post_run`/`user_message`/`morning_plan`/`weekly_recap`/`initial_plan` triggers (excluding the free-hand `plan_quality` overview prompt), the runner now calls `deliver_message` with a `stated_facts` echo and runs it through the real `checkStatedFacts`/`buildFactCorrection` from `src/lib/fact-check.ts` (imported, not mirrored), retrying once on mismatch exactly like `route.ts`. Before this, the runner called Claude with plain text completion and no tools at all, so mileage/date fixture failures never told you whether production's fact-check retry would have caught and corrected them — the eval was silently testing a weaker path than what an athlete actually receives. Confirmed fixing several fixtures once wired in (`date-race-week`, `date-taper-messaging`, `pace-vdot52-post-run-easy`, `uploaded-plan-week-sync`). One fixture, `post-run-stat-interpretation`, turned out to have a **fixture data bug** unrelated to the gate: `miles_logged_this_week` was 11.5 (only the day's run) while `recent_activities` showed two more runs earlier in the same Mon–Sun week, for a true total of 23mi — the fixture's own "authoritative" week-to-date number was wrong, so Dean was correctly repeating bad input. Fixed the fixture data directly (not the criteria).

Remaining hand-mirrored parity points between `route.ts` and `run-evals.mjs` (still inline in route.ts — extract, then import):
- The km-split DATA GUARD injection (`splitCount > ceil(miles) + 1`)
- RECOVERY WEEK block (injected when `current_week % 4 === 0 && phase !== taper/peak`)
- Mileage accuracy rules block (no additive totals)
- The `plan.weekly_total` cap/clamp check (`computeWeekOneVolumeCap`/`periodization.suggestedWeeklyMiles`) that production runs on `initial_plan`/`weekly_recap` deliveries — not wired into the runner's `plan_quality` path, which is a fully separate free-hand prompt not connected to `training-plan.ts` or `plan-validation.ts` at all. This is the likely root cause of most other `plan_quality` failures (peak-week volume, session-count-vs-training-days mismatches, wrong day-of-week) — they're testing a hand-written prompt that reinvents plan generation, not the deterministic generator + validator athletes actually get. Worth a larger follow-up: either give the runner's `plan_quality` path the same caps/rules `training-plan.ts` has, or find a dry-run way to call the real generator.

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

`npm run eval:simulation` — end-to-end multi-turn onboarding simulations. A user agent (Haiku) plays each persona across multiple turns; Dean (Sonnet) responds; Haiku extracts fields after each exchange; Sonnet judges the full transcript (switched from Opus 2026-07-22 — no measurable quality difference on this rubric-style scoring, at meaningfully lower cost per run).

### What the simulations test

| Persona | What it catches |
|---|---|
| `sim-trail-multi-race` | Multi-race handling, Strava mid-flow, correct A/B race split, trail_race goal type |
| `sim-marathon-first-timer` | Standard happy path, PR as fitness baseline, race date extraction |
| `sim-general-fitness` | No race → general_fitness goal, [READY] without race_date |
| `sim-injury-runner` | Injury collected before [READY], return_to_running goal, supportive tone |
| `sim-terse-user` | Minimal answers, follow-up questioning, higher turn budget |
| `sim-shin-splint-trail-race` | Strava scope honesty, race-countdown consistency across messages, injury red-flag screen (diffuse vs. localized/rest shin pain) before completion, no cross-message re-summarization of the same mileage-drop story |

### How it works

Each simulation turn:
1. Dean (Sonnet) generates a response given current `collected` + conversation history
2. [STRAVA_LINK] is intercepted — if persona has Strava, OAuth is simulated
3. Once connected, a real Strava-analysis message is generated (mirrors `handleDataAnalysis`'s system prompt — not a static placeholder), then an injury-intake follow-up loop runs (mirrors `handleInjuryIntake`'s gate/questions, capped at 2 follow-ups), then a completion message is generated (mirrors `buildDeterministicCompletion`) — this ends the simulation the same way production ends onboarding from this stage, without further [READY]-seeking turns
4. If Strava is skipped, or before Strava connects, a normal user-agent reply follows instead
5. Haiku extraction runs on full history → merges into `collected`
6. Repeat until [READY]/completion or max_turns

### Key parity points to maintain with `onboarding/handle/route.ts`

- `buildDeanSystemPrompt` → mirrors `handleConversation` system prompt exactly
- `summarizeCollected` → mirrors same function in route.ts, including the deterministic race-countdown line (`(N days / M weeks away — always use this exact figure...)`) added 2026-07-22 — this is the fix for cross-message countdown drift; if it's ever removed from the runner's mirror without removing it from route.ts, the countdown-consistency check on `sim-shin-splint-trail-race` will pass for the wrong reason (an LLM getting lucky) rather than the actual reason (a shared computed value).
- `extractFields` + `mergeCollected` → mirrors Haiku extraction and merge logic (now includes the injury-detail fields: `active_injury`, `injury_severity`, `injury_body_part_current`, `reported_during`, `injury_management`, `injury_pain_character`)
- VALID_GOAL_BUCKETS set
- `buildStravaAnalysisPrompt` → mirrors `handleDataAnalysis`'s system prompt (added 2026-07-22)
- `injuryShouldComplete` / `injuryMissingFields` / `getInjuryFollowUp` → mirrors `handleInjuryIntake`'s gate (including the `injury_severity`-required fix and the shin/tibia red-flag question), added 2026-07-22
- `buildCompletionMessage` → mirrors `buildDeterministicCompletion`'s active-injury path (added 2026-07-22; does not cover the Sonnet-synthesis uploaded-plan branch, since no simulation fixture has an uploaded plan)

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
5. Never delete old entries. Closed quarters are archived verbatim into `CHANGELOG-<year>Q<n>.md` files (linked from the top of `CHANGELOG.md`) so the working file stays scannable — archive the previous quarter when a new one starts.

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