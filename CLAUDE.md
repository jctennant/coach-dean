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