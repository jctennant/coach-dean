# Coach Dean — Roadmap & Improvement Log


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
