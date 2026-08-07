# Known issues — found, reproduced, not yet fixed

Bugs that have been **observed and traced** but deliberately left unfixed, so they don't get
rediscovered from scratch. Same reasoning as `docs/crons.md`: a problem with no repo trace
gets found again the expensive way.

Each entry records how to reproduce it, what it costs, and — where it's known — what the
fix probably is. Delete an entry when it's fixed, and add a changelog line.

**Rule:** if you're about to "discover" one of these, read the entry first. If you fix one,
delete it here in the same commit.

---

## 1. Race-date verification overrides correct athlete-stated dates

**Severity:** High — a wrong race date miscalibrates the entire arc (weeks, phases, taper).
**Found:** 2026-08-04, `sim-runna-user-uploads-plan`, reproduced on two separate runs.

**What happens:** the athlete states a specific, correct race date and Dean "corrects" it to a
different one from search, or burns 2–3 turns arguing about it.

- Run A (baseline `ee720b84`): *"Dean spent 2 full turns questioning Chris's race date
  (October 19) despite Chris's confidence, creating unnecessary friction."*
- Run B (branch, after fixture update): Dean changed Oct 19 → **Oct 4**, Chris confirmed the
  wrong date, and the turn-6 "19 weeks to race day" math was then computed off it. Judge:
  *"a hallucinated 'fact check' that poisoned the collected data."*

**Why it isn't a missing rule:** the prompt already forbids exactly this, in two places — the
NAME COLLISION GUARD ("do not 'correct' the athlete's date — ask them to confirm which race
they mean instead") and "Never silently override a specific athlete-provided date with a
search result that differs by just 1–2 days." Both were added for prior instances. This is a
compliance failure, so per CLAUDE.md's decision order a third prompt sentence is the wrong
move.

**Likely fix (structural):** the override is a comparison between two dates — do it in code,
not in the model. When the athlete has stated a specific day+month and search returns
something else, either keep the athlete's date or ask; never let the model silently write the
searched one into `mergedData.race_date`. The `race_date_verified` / `race_date_verified_for`
machinery in `handleConversation` is already the right place to hang this.

**Related history:** 2026-07-25 changelog, "Dean confidently 'corrected' a race date to a
different, similarly-named race" — same class, fixed with prompt text, now recurring.

---

## 2. Haiku extraction misses explicitly stated fields

**Severity:** Medium — produces redundant questions, which is the single most common
onboarding complaint ("he already asked me that").
**Found:** 2026-08-04, `sim-runna-user-uploads-plan`. Present in baseline `ee720b84` too, so
it is **not** a regression from the reliability pass.

**What happens:** `extractFields` fails to capture fields the athlete stated outright.

- `training_days`: Chris says "I run Tuesday, Thursday, Saturday, Sunday". Not extracted →
  `maybeEnterScheduleConfirm` sees an empty list and asks "What days of the week do you want
  to run?" — a question he had already answered.
- `has_existing_plan`: Chris opens with "I'm already on a Runna plan". Not set to `true`.

**Why it matters more than it looks:** `has_existing_plan` is now unreliable in *both*
directions. The false-*positive* is what put an athlete who never uploaded anything into
complement mode and stalled plan generation permanently (2026-08-04). That path is closed —
the field no longer drives `coaching_mode` — but an extractor that both invents and drops the
same field is worth distrusting wherever else it's read.

**Note before fixing:** `handleScheduleConfirm` and `handleInjuryIntake` call `extractFields`
on the **single inbound message**, while `handleConversation` passes the **full history**.
Check which path dropped the value before touching the extraction prompt — a one-message
window that can't see an earlier statement is a different bug from a model miss.

---

## 3. Strava is asked several turns later than the prompt requires

**Severity:** Medium — Strava is mandatory and the core of the product; every turn before it
is churn exposure.
**Found:** 2026-08-04, `sim-runna-user-uploads-plan`. Baseline turn 5, branch turn 6.

**What happens:** the prompt says "Ask about Strava after goal is established — BEFORE
anything else", and the judge's target is turn 2–3. Observed at turns 5–6.

**Probable cause:** RACE DATE CONFIRMATION COMES FIRST explicitly outranks everything ("your
VERY NEXT message MUST address those race dates before anything else — before Strava"), so
every turn spent on issue #1 above pushes Strava back. Fixing #1 may fix this for free —
check before treating it as separate.

**Counter-evidence that it isn't universal:** `sim-pricing-question` asked Strava at turn 2
and scored 9/10. This shows up on personas whose race date takes several turns to settle.

---

## Reproducing

```bash
export ANTHROPIC_API_KEY=$(grep "^ANTHROPIC_API_KEY" .env.local | cut -d= -f2- | tr -d '"' | tr -d "'")
node evals/run-simulation-evals.mjs --fixture sim-runna-user-uploads-plan --verbose
```

The judge is an LLM and single runs vary by ±1; the same fixture scored 9/10 and 6/10 on
consecutive runs of identical code, differing only in whether #1 fired. Run a fixture more
than once before concluding a change helped or hurt, and A/B against a base commit in a
`git worktree` rather than against memory of a previous score.
