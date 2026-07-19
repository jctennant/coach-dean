# Cron schedules — source of truth

All recurring jobs run on **cron-job.org** (not Vercel Crons — the `vercel.json` crons
block was removed 2026-04-09, commit `010c2a41`, when schedules moved to the dashboard).
The dashboard is the *live* config; **this file is the declared record of what should be
scheduled**. The morning-reminder cron once sat disabled with no repo trace — this file
exists so that can't happen silently again.

**Rule: any change on cron-job.org (add / remove / pause / retime a job) must be
reflected here in the same sitting, and vice versa.** A PR that adds a cron endpoint
isn't done until its row is added below and the job is created on the dashboard.

## Shared contract

- All endpoints are `GET` and require the header `Authorization: Bearer $CRON_SECRET`.
- cron-job.org kills requests at **30 seconds** — handlers must return 200 fast and do
  real work in `after()` (see the 2026-03 sunday-recap timeout incident).
- All schedules below are **UTC** cron expressions.
- `RESTRICT_TO_PHONES` (temporary kill-switch, 2026-07-12) gates the LLM-calling crons
  marked ⛔ below. If it's still set in Vercel prod, those crons silently skip every
  other user.

## Jobs

| Endpoint | Schedule (UTC) | What it does |
|---|---|---|
| `/api/cron/sunday-recap` ⛔ | `0 1 * * 1` (Mon 01:00 UTC = Sun evening US) | Weekly recap + next-week plan for **all** onboarded users. Replaces the nightly reminder on Sundays. |
| `/api/cron/nightly-reminder` | `0 */2 * * *` (every 2 h sweep) | Sends tomorrow's-workout reminder when the user's **local** hour is 20:00–21:59. Skips Sundays (recap covers it). Dedup: `last_nightly_reminder_date`. |
| `/api/cron/morning-reminder` | `0 */2 * * *` (every 2 h sweep) | Sends today's-workout reminder when local hour is 06:00–09:59. Dedup: `last_morning_reminder_date`. |
| `/api/cron/missed-messages` ⛔ | `*/30 * * * *` (every 30 min) | Re-fires `coach/respond` for inbound user messages 3–90 min old with no assistant reply. |
| `/api/cron/analyze-conversations` ⛔ | `0 9 * * *` | Opus digest of yesterday's conversations, emailed via Resend. |
| `/api/cron/dunning` | `0 12 * * *` | Dunning messages 2 and 3 (4 / 8 days after payment lapse). |
| `/api/cron/welcome-tips` | `0 15 * * *` | One-time tips SMS to users whose `initial_plan` landed 20–48 h ago. |
| `/api/cron/payment-reminder` | `0 15 * * *` | Follow-up SMS if checkout link unclicked after 24 h. |
| `/api/cron/reengagement` | `0 16 * * *` | Nudges/downgrades silent users; silently graduates legacy `awaiting_cadence` rows. |
| `/api/cron/trial-expiry` | daily — **time unverified** | Closes the 7-day reverse trial: sends "trial's up" SMS, flips user to `awaiting_payment`. |

### Deliberately NOT scheduled

- `/api/cron/morning-workout` — legacy Phase 2 stub. It was accidentally live in early
  2026 (no cadence check, no dedup, no timezone logic) and removed from schedules on
  2026-03-08. **Do not re-add it.**

## Provenance / verification status

Schedules for the first 9 rows come from the last `vercel.json` crons block before the
2026-04-09 move (assumed migrated as-is) plus code comments (`missed-messages` documents
its own 30-min cadence). `trial-expiry` was added directly on cron-job.org
(changelog 2026-06) and its time was never recorded in the repo.

**TODO (Jake):** open the cron-job.org dashboard once and confirm each row — exact
expressions, enabled/paused state, and the `trial-expiry` time — then delete this
paragraph and the "time unverified" marker.
