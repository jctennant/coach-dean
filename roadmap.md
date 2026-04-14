# Coach Dean — Roadmap & Improvement Log

---

## Runna Gap Analysis — 2026-04-13

Runna is the closest competitor worth benchmarking against. It was acquired by Strava in April 2025 and has ~4.9/5 stars. Key strengths: coach-designed plans, calendar sync, drag-and-drop rescheduling, race time prediction, PB tracking, and a clean daily training view. Its biggest weakness is AI — it uses algorithmic adaptation, not conversational AI. The user's take: if Runna shipped strong AI (comparable to Dean), the only remaining reason to use Dean would be on-the-fly modifications.

**Dean's moat:** conversational AI is genuinely better — injury management, progress sounding board, nuanced plan adjustments mid-cycle. This is hard for Runna to replicate. But Dean is missing nearly all of Runna's UI/visibility layer, which creates daily friction for power users.

**Strategy:** Close the visibility and convenience gaps (calendar, metrics, plan view) so Dean isn't losing users to Runna for non-AI reasons, while doubling down on the conversational AI that Runna can't match.

---

### Gap 1 — iCal / Calendar Feed
**Effort:** Low (1–2 days) | **Impact:** High

Runna generates a live iCal feed that syncs training sessions to Google Calendar, Apple Calendar, or any calendar app. Sessions appear alongside your life so you can plan around them. Changes in Runna auto-update the feed.

**What Dean has:** Nothing. The plan lives in `training_plans.weeks` JSON and users have no way to see upcoming sessions outside of asking Dean.

**What to build:**
- `GET /api/calendar/feed?userId=<id>&token=<secret>` returns a valid `.ics` feed
- Each session in `weekly_plan_sessions` (the current week) + upcoming weeks from `training_plans.weeks` becomes a VEVENT with title (e.g. "Easy Run — 6 miles"), description (target pace, notes), and date
- Token is a stable per-user secret stored in `users` table (prevents enumeration)
- Regenerated each request from live plan data — always current
- Include a `/calendar` page that shows the user their personal feed URL + one-click "Add to Google Calendar" and "Add to Apple Calendar" links

**Why low effort:** No new data model — the plan already exists. This is pure formatting + one new route + one static page.

---

### Gap 2 — Race Time Prediction & "Am I On Pace?"
**Effort:** Low (1 day) | **Impact:** High

Runna shows a running estimated finish time for your goal race based on current fitness, and gives "Pace on point / Ahead of the Pack / Let's Review" status updates.

**What Dean has:** VDOT calculations exist in `src/lib/paces.ts`. Dean knows `current_easy_pace`, `current_tempo_pace`, `current_interval_pace`. The weekly recap already references progress loosely. But there's no persistent estimated finish time surfaced consistently, and no "am I on pace for my goal?" structured feedback.

**What to build:**
- Compute estimated finish time from current VDOT and surface it in:
  - Weekly recap ("Your current fitness puts you at ~3:52 marathon. Goal is 3:45. You're 7 minutes off — here's the plan.")
  - Morning plan messages when race is <8 weeks out
- Store `estimated_finish_time_minutes` on `training_profiles` (updated after each VDOT recalculation) so it's queryable
- Add a structured "on pace?" judgment block to the weekly recap prompt: compare estimated finish time to `races.goal_time_minutes` and instruct Claude to name the gap explicitly

**Why low effort:** VDOT math is already there. This is mostly a prompt + one new column.

---

### Gap 3 — PB Tracking
**Effort:** Low–Medium (2–3 days) | **Impact:** Medium

Runna tracks personal bests across distances and automatically updates estimated race times when a new PB is set. Users can see their progression.

**What Dean has:** Activities are stored in `activities` with `distance_meters` and `average_pace`. There's no PB detection or storage.

**What to build:**
- `personal_bests` table: `(user_id, distance_label, finish_time_seconds, activity_id, set_at)`
- Standard distances: 1mi, 5K, 10K, half, full, 50K, 50mi, 100K, 100mi
- After each `post_run`, check if the completed activity is a race (`workout_type = 1`) or a time trial and compare against stored PBs — if better, insert new row and include a PB callout in the post-run message
- Surface PBs in weekly recap and on the metrics page (Gap 5)
- When a PB is set, trigger a VDOT recalculation and update paces

**Why medium:** Needs a new table + migration + PB detection logic + VDOT recalculation hookup.

---

### Gap 4 — "Not Feeling 100%" / Adaptive Week
**Effort:** Low–Medium (2–3 days) | **Impact:** High

Runna's "Not Feeling 100%" feature (launched 2026) lets users drop into reduced-load modes: Easy & Long Runs Only, Short Easy Runs Only, or No Running. It ramps back up after the adjustment period.

**What Dean has:** Users can message Dean and ask to modify their week — Dean does this conversationally. But there's no structured command, no persistent "reduced load week" state, and no automatic return-to-normal ramp.

**What to build:**
- SMS commands: "easy week", "rest week", "I'm sick", "I'm busy" → detected by user_message handler
- When triggered, set a `week_mode` flag on `training_state`: `normal | easy | minimal | rest`
- `weekly_recap` and `morning_plan` check `week_mode` and adjust targets accordingly
- Auto-reset to `normal` the following Monday, with a check-in message ("Back to full training this week — how are you feeling?")
- This is mostly formalizing what Dean already does conversationally into a persistent state machine

**Why worth doing:** Runna charges for this as a premium feature and users love it. For Dean it's mostly a state flag + prompt changes.

---

### Gap 5 — Training Dashboard (Web View)
**Effort:** Medium (3–5 days) | **Impact:** High

Runna's core product is a visual training calendar. You see your full plan, completed runs, upcoming sessions, weekly mileage, and race countdown — all in one screen.

**What Dean has:** The landing page at coachdean.ai. No authenticated user area. All training visibility is via SMS.

**What to build (MVP — read-only):**
- Auth: magic link via Supabase Auth or a simple `/dashboard?token=<user_token>` for MVP
- `/dashboard` page showing:
  - Race countdown ("14 weeks to [Race Name]")
  - Current week overview: sessions, targets, completed runs checked off
  - Estimated finish time vs goal (feeds from Gap 2)
  - PBs (feeds from Gap 3)
  - Weekly mileage chart (last 8 weeks) — query `activities`
  - Upcoming 4-week plan view (read-only)
- Mobile-first layout since most users are on phone

**Why medium:** Requires auth flow, data fetching from multiple tables, and a new set of UI components. But this is standard Next.js App Router territory — no new backend logic, just new pages.

**Phase 2 (after MVP):** Add run rescheduling — drag a session to a different day triggers a `rebuild_plan` with constraint overrides. This is the hardest Runna feature to replicate and should come after the read-only view ships.

---

### Gap 6 — Tips & Coaching Content in Daily Messages
**Effort:** Very Low (half a day) | **Impact:** Medium

Runna delivers personalized workout briefings before each session — race prep tips, pacing strategy, fueling guidance, form cues. No two briefings are identical.

**What Dean has:** Morning plan messages focus on the workout itself. Tips are ad hoc based on what Claude decides to include.

**What to build:**
- Add a "coaching tip of the day" injection to the `morning_plan` prompt
- Rotate through tip categories: pacing strategy, fueling, recovery, mental, form, race prep
- Make category context-aware: fueling tips in the final 6 weeks, mental tips in taper, race day tips the week before
- One small prompt addition, no new infrastructure

---

### Runna Feature Gaps NOT Worth Chasing (for now)

| Feature | Why not |
|---|---|
| **Social / community ("Spaces")** | Runna's community is private and small — users already have Strava for social. Building this from scratch has high effort and network-effect problem. |
| **Blog / supplemental content** | Dean's value is conversational, not editorial. A blog competes with Running with Remy, PodiumRunner, etc. Not differentiated. |
| **Strength & mobility routines** | Runna partners with strength coaches. Dean could mention this but building a library of routines is content work, not engineering. |
| **Device-guided workouts (Garmin/Apple Watch)** | Requires hardware SDK integration. Strava already syncs pace targets — Runna's edge here is deep device integration that's out of scope. |
| **Gamification** | User explicitly called this out as low priority. |

---

### Recommended Build Order (effort vs impact)

1. **iCal Feed** — fastest win, users ask "can I see my plan in my calendar?" constantly
2. **Race Time Prediction + "Am I on Pace?"** — adds structured goal-tracking to every recap
3. **"Not Feeling 100%" week modes** — formalizes what Dean does conversationally, adds persistence
4. **PB Tracking** — unlocks better post-run messages + feeds the dashboard
5. **Dashboard (read-only)** — biggest lift but highest perceived value for power users
6. **Tips injection** — tiny, do it alongside anything else

---

Issues discovered via conversation analysis on 3/15

P1 — fix before next growth push
P2 — before any marketing push
Issues discovered through onboarding simulation (10 athletes, 2026-03-12). See `test-cases.md` for full transcripts and test methodology.

---

---

## Positive findings (keep as-is)
- Ultra path (`awaiting_ultra_background`) correctly auto-skips "anything else" when background data captures what's needed
- `no_event: true` and `injury_recovery` paths route correctly
- Multi-distance race detection (Behind the Rocks) worked perfectly

---

## ~~Post-onboarding B/C race extraction~~ ✓ Shipped 2026-04-13
Added `new_b_races` to `ExtractedProfileData` and the Haiku extraction prompt. `persistProfileUpdates` now deduplicates against existing `races` rows and inserts new ones, then triggers a silent `rebuild_plan` so the arc extends immediately. 4 tests added to `coach-respond-field-sync.test.ts`.

---

## ~~Plan integrity check in weekly_recap~~ ✓ Shipped 2026-04-13
Every Sunday `weekly_recap` now syncs `onboarding_data.other_races` → `races` table and triggers a silent `rebuild_plan` if any were missing. Arc self-heals weekly for all users.

---

## Make `races` the single source of truth for the A race (eliminate dual state)
**Priority:** P1 — before next growth push
**Context:** The A race date and goal type currently live in two places: `training_profiles.race_date` / `training_profiles.goal` (what `generateAndSaveFullPlan` uses) and `races` (priority=A) (what the dashboard and rebuild flow use). `persistProfileUpdates` tries to keep them in sync after every change, but any gap in coverage (a new update path, a failed DB write, an admin operation that touches one table) creates drift that causes plan bugs. Today's session was partly caused by this — the plan generation ignored the `races` table and computed length from `training_profiles.race_date` alone.

**What the fix looks like:**
1. `generateAndSaveFullPlan` fetches `raceDate` from `races` (priority=A) instead of accepting it from `profile.race_date`
2. All plan-affecting mutations (race date change, goal type change) write to `races` as the primary write, and `training_profiles` becomes a denormalized cache updated secondarily
3. Long-term: drop `training_profiles.race_date` and `training_profiles.goal` in favour of always joining `races`
4. Migration: backfill `races` for any user who has `training_profiles.race_date` set but no A-race row

**Why not done yet:** Touches `generateAndSaveFullPlan`, `persistProfileUpdates`, `buildSystemPrompt`, and all call sites — high blast radius. Needs a dedicated session with full test coverage.
