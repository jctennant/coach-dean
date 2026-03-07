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