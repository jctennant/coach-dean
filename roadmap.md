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

## Post-onboarding B/C race extraction
**Priority:** P1
**Context:** When a user mentions a new B/C race in a post-onboarding SMS, `persistProfileUpdates` has no field for it — `ExtractedProfileData` only captures A-race date, goal type, paces, injuries, etc. The race gets mentioned in `other_notes` as freeform text (if at all), but never makes it to the `races` table. Only races in the `races` table are passed to `generateAndSaveFullPlan` as `bRaces`, so the plan won't extend to cover the new race until an admin manually adds it.

**Partial mitigation already in place (2026-04-13):** `handleRebuildPlan` now syncs `onboarding_data.other_races` → `races` table before each rebuild, which catches races captured during onboarding but never inserted. Doesn't help for races mentioned post-onboarding.

**What the fix looks like:**
1. Add `new_b_races?: Array<{ date: string; name: string | null; priority: "B"|"C"; goal_distance_miles?: number | null }> | null` to `ExtractedProfileData`
2. Update the Haiku extraction prompt in `extractProfileData` to capture B/C races from phrases like "I also signed up for X race on Y date"
3. In `persistProfileUpdates`, upsert extracted B/C races into the `races` table (insert if `race_date` not already present for this user)
4. Trigger a silent rebuild after the upsert so the arc extends to cover the new race immediately

**Files:** `src/app/api/coach/respond/route.ts`

---

## ~~Plan integrity check in weekly_recap~~ ✓ Shipped 2026-04-13
Every Sunday `weekly_recap` now syncs `onboarding_data.other_races` → `races` table and triggers a silent `rebuild_plan` if any were missing. Arc self-heals weekly for all users.
