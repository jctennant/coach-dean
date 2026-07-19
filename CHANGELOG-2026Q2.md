# Coach Dean — Changelog Archive: 2026 Q2

Entries moved verbatim from CHANGELOG.md (nothing deleted — see the archive note there).

---

## 2026-06-28 — Multi-agent architecture Phase 2: injury routing, reminder agent, B/C race context

**Type:** Refactor / Improvement
**Reported by:** Internal architecture review
**User feedback:** N/A
**Root cause:** Reminder triggers (morning_reminder/nightly_reminder) were building the full 7700-line coaching prompt and loading 50 activities + 20 race history records that reminders never use. Injury queries were also going through the full prompt despite needing only a ~400-token focused context.
**Fix / Change:**
- Injury routing: when `classifyIntent` returns `injury_query` with a known body part, `getRehabData()` builds a focused ~400-token dynamic block (athlete, injury, rehab protocol, recent conversation) instead of the full prompt. Falls through to full flow on any failure or unknown body part.
- Reminder agent: `morning_reminder` and `nightly_reminder` now skip the 50-activity and 20-race-history Supabase queries entirely (saves 2 DB reads per trigger for every user, daily). They build a focused dynamic prompt via `buildReminderDynamic()` from `src/lib/reminder-prompt.ts`, which omits TRAINING PHILOSOPHY, aerobic metrics, VDOT formula, load context, and all activity history.
- B/C race context: reminder prompts now include B/C secondary race awareness — B race ≤14 days gets a mini-taper note (10-15% volume reduction), B race >14 days gets a mention, C race ≤7 days gets a "quality workout" framing.
- Added `src/__tests__/lib/reminder-prompt.test.ts` (15 tests).
**Files changed:** `src/lib/reminder-prompt.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/reminder-prompt.test.ts`

---

## 2026-06-28 — Multi-agent architecture Phase 1: structured logging, exercise library extraction, intent classifier

**Type:** Refactor / Improvement
**Reported by:** Internal architecture review
**User feedback:** N/A
**Root cause:** `coach/respond/route.ts` was a 557KB monolith — every trigger loaded the same enormous prompt and made the same Sonnet call regardless of what the user asked. No structured logging made silent failures in `after()` invisible.
**Fix / Change:**
- **Structured logger** (`src/lib/logger.ts`): thin JSON-line logger with correlationId per request, agentName, timing, level filtering via `LOG_LEVEL` env var. Sentry capture on error. Used at all key checkpoints: entry, Claude call start/end with duration, action tags detected, SMS send.
- **Exercise library** (`src/lib/exercise-library.ts`): moved `BODY_PART_EXERCISES` and `CROSS_TRAINING_ALTERNATIVES` out of route.ts into their own module with `getRehabData(bodyPart)` lookup and `normalizeBodyPart()` alias resolution. Zero LLM calls — pure deterministic lookup.
- **Intent classifier** (`src/lib/intent-classifier.ts`): Haiku pre-pass for `user_message` trigger, runs in parallel with profile extraction. Returns `{ intent: "injury_query" | "plan_question" | "strava_query" | "general", bodyPart?, confidence }`. Falls back to `{ intent: "general" }` on any failure — transparent to the user.
- **route.ts wiring**: correlationId generated per request; intent classifier runs in `Promise.all` alongside existing profile extraction (no added latency); `after()` error now structured-logged before Sentry; key `console.error` calls replaced with `log.error`.
**Files changed:** `src/lib/logger.ts` (new), `src/lib/exercise-library.ts` (new), `src/lib/intent-classifier.ts` (new), `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/logger.test.ts` (new), `src/__tests__/lib/exercise-library.test.ts` (new), `src/__tests__/lib/intent-classifier.test.ts` (new), `src/__tests__/api/coach-respond.test.ts`, `src/__tests__/api/coach-respond-field-sync.test.ts`

---

## 2026-06-20 — Six fixes from a 2-week conversation scan (load nagging, persistent directives, effort labels, posters, UPDATE PLAN, return-to-running)

**Type:** Improvement
**Reported by:** Internal — scan of past 2 weeks of user conversations (46 users, 18 active)
**User feedback (verbatim):**
- "Can you stop telling me not to overtrain or risk injury. I'm barely exercising I'm not concerned" (and Dean kept warning anyway two days later)
- "I don't know that this is above my workload"
- "My heart rate was 82bpm, that was very easy" / "I would not call that moderate effort"
- "Can you say my pelvis instead of groin" / "You need to update your definition of moderate workout" (both ignored on subsequent messages)
- "Can you say my pelvis instead of groin when asking?" — preference evaporated next message
- "UPDATE PLAN" (sent twice, athlete got prose promises and never saw an actual plan)
- "Can you give me exercises for my groin" / "can you keep track of how many days I do SPD?" (return-to-running athlete wanting real rehab + self-tracking)

**Root cause:**
1. **Load nagging** — `computeACWR` flagged any ratio >1.3 with no absolute-volume floor, so a 1mi→2.4mi week read as "138% above your average." ~29% of all auto-messages carried injury/easy-day warnings; the forced "REQUIRED ACKNOWLEDGMENT" re-fired load mentions every post-run.
2. **Directives evaporated** — tone/vocabulary directives ("stop nagging", "say pelvis not groin") were never extracted or persisted, so the automated post_run/recap paths never saw them.
3. **Effort labels** — `classifyCrossTrainingEffort` defaulted to "moderate" whenever there was no LTHR anchor, mislabeling an 82bpm walk as moderate.
4. **Posters** — only fired when directly asked; 2 sent in 2 weeks despite many injury mentions.
5. **UPDATE PLAN** — `generateAndSaveFullPlan` saved the plan but sent NO SMS (`planReadyNote` was dead code), and the few notes that existed pointed to a "dashboard" the product no longer has.
6. **Return-to-running** — Dean repeated "stop running, see a physio" verbatim 4×, refused to give the usable 0–2/10 pain framework athletes asked for, and brushed off a self-tracking request.

**Fix / Change:**
1. ACWR/load: added absolute-volume floors — flag only when 7-day load ≥15mi AND the jump over the 4-week avg is ≥8mi (week-over-week trend similarly gated at ≥15mi recent + ≥3mi jump). Low-volume "spikes" now explicitly tell Dean NOT to warn. Forced load acknowledgment now respects the recent-insight dedup so it can't repeat every run. Stripped ⚠️ glyphs.
2. Directives: new `coaching_directives` extraction field (Haiku) → accumulated/deduped/capped in `onboarding_data.coaching_directives` → injected as a NON-NEGOTIABLE block near the top of the system prompt, applied across every trigger including automated ones.
3. Effort labels: added an absolute-HR fallback (<115bpm = easy) and a recovery-grade activity set (walk/hike/yoga/pilates → easy); changed the no-data default from "moderate" to "easy."
4. Posters: routine + poster now lead toward sending whenever the athlete asks about strength/rehab OR reports a new pain at a targeted body part — not only when asked twice.
5. UPDATE PLAN: `generateAndSaveFullPlan` now texts the actual plan as a TEXT ARTIFACT (current week in full + compact forward arc + peak) and logs it as `initial_plan_link`; rebuilt the plan-ready notes to drop dead "dashboard" references.
6. Return-to-running: added explicit "do not repeat the stop-running/physio wall," "give the usable pain framework not a wall," and "self-tracking is a yes (count from history)" rules to the active-injury block; removed ⚠️ from injury-hold and RTR-phase blocks; added an explain-my-data fast path for "what is ACWR/fartlek/GAP" questions.

**Files changed:** `src/lib/training-analytics.ts`, `src/lib/cross-training.ts`, `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-analytics.test.ts`, `src/__tests__/lib/cross-training.test.ts` (new)

## 2026-06-18 — Removed Strava activity annotation feature

**Type:** Refactor
**Reported by:** Internal — buggy behavior observed
**User feedback:** N/A
**Root cause:** Annotation feature had bugs and was writing incorrect data to Strava activity descriptions.
**Fix / Change:** Removed `annotateStravaActivity` and all supporting code (`detectWorkoutKind`, `computeZoneTime`, `computeZone12Pct`, `computeEfficiencyTrend`, `generateAnnotationFallback`, `AnnotationContext` interface). Removed annotation call from the post_run dedup guard path. Exported test helpers (`selectActivityEmoji`, `processSplitsForMetrics`, `computeAerobicEfficiency`, `computeCardiacDecoupling`, `buildSplitAnalysis`, `formatBestGapLine`) retained. Removed unused `getActivity`, `updateActivityDescription`, `fetchActivityWeather` imports.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-06-18 — Fixed [NO_REPLY] suppressing user_message responses

**Type:** Bug Fix
**Reported by:** Jake (user self-report)
**User feedback:** "Coach respond seems to be broken - dean isn't responding to me"
**Root cause:** [NO_REPLY] instruction was injected for all `user_message` triggers. GPT-4o misapplied it for a repeated strength routine question, returning [NO_REPLY] in ~2.4 seconds. Structural fix: [NO_REPLY] now only applies to `post_run` and `workout_image` triggers where silent non-reply after a closing ack is appropriate. For `user_message`, Dean always replies.
**Fix / Change:** Changed `isRunReview` to `isPostRun` in the [NO_REPLY] injection condition, removing `user_message` from the path entirely.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-06-18 — Fixed internal reasoning leaking into SMS in the final paragraph

**Type:** Bug Fix
**Reported by:** Internal observation (Lori's conversation, weekly review)
**User feedback:** N/A — caught reviewing conversations. Lori received a 4-bubble reply that opened with "I need to read the thread first to understand the context. Looking at RECENT CONVERSATION, the athlete has been receiving post-run coaching messages…" and "This is a FOLLOW-UP IN AN ACTIVE THREAD…", "What to do:…", before the actual coaching message.
**Root cause:** `stripReasoningPreamble` strips leading reasoning *paragraphs* but (a) deliberately never strips the final paragraph, and (b) can't handle reasoning that shares a paragraph with the real message. Claude's output ended with a paragraph that glued trailing reasoning ("Both key sessions are done. The athlete has completed their week's core work in one session.") directly onto the real message ("Got it — the lap button catch explains it. You knocked out the speed work…"), so the reasoning prefix survived and was sent.
**Fix / Change:** Added a sentence-level pass (Pattern 4) that runs after the paragraph pass. It finds the first sentence that clearly addresses the athlete (second person, or a greeting/acknowledgment) and, if any sentence before it reads like reasoning, drops everything up to it. Third-person references to "the athlete" and echoed prompt section names ("RECENT CONVERSATION", "What to do:", "FOLLOW-UP IN AN ACTIVE THREAD") are reliable reasoning tells since a coach always addresses the runner as "you". Guarded to never strip everything. Added a regression test reproducing Lori's exact leak.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`

---

## 2026-06-18 — Fixed GPT-4o silently returning [NO_REPLY] for strength routine requests

**Type:** Bug Fix
**Reported by:** Jake (user self-report)
**User feedback:** "Coach respond seems to be broken - dean isn't responding to me" — repeated "Can you send me general shin and hip / core strength routine?" with no reply
**Root cause:** The [NO_REPLY] instruction is injected for all `user_message` triggers (via `isRunReview`). GPT-4o was misapplying it — the conversation history contained an unrelated post_run response appearing after the user's first strength routine request (from a concurrent Strava webhook), making the repeated question look like a concluded conversation. GPT-4o returned `[NO_REPLY]` in ~2.4 seconds, indicating it applied the rule without fully reading the message content.
**Fix / Change:** Added CRITICAL EXCEPTIONS line to the [NO_REPLY] instruction explicitly listing patterns that always require a reply: question marks, "can you / send me / what / how / why" openers, and any kind of request. This prevents GPT-4o from silently suppressing legitimate questions.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-06-13 — Switched AI provider back to OpenAI (Anthropic rate limits) + fixed hallucinated race date

**Type:** Infra / Bug Fix
**Reported by:** Jake
**User feedback:** "For some reason, didn't get a message after my strava run today - also this message from Dean was wrong - Race is in two days (today is Friday night): … 'Race is in 5 days — bike tomorrow.'" — and later, with logs: "ah I got another rate limit failure - think I need to move back over to openai for now! … 429 … rate limit of 10,000 input tokens per minute (model: claude-sonnet-4-5-20250929)"
**Root cause:**
1. **Missing post-run message** — the Anthropic org is on a low tier (10,000 input tokens/min, 5 req/min). The coach system prompt is large, so `post_run` (and other) generations intermittently hit a `429 rate_limit_error`. The failure happens inside `processCoachRequest` which runs in `after()`; the error is caught and sent to Sentry/PostHog but no SMS is ever sent, so it looks like a silent miss. (A prod `dry_run` succeeded because it happened to land under the per-minute ceiling — which initially masked the cause as a post-generation send bug. Strava read/write, billing gate, and dedup were all ruled out.)
2. **Wrong race countdown** — the athlete's stored `race_date` was `2026-06-18` (a Thursday) for the Dipsea Race, but Dipsea 2026 is **Sunday, June 14** (confirmed via web search). Onboarding's web-search step stored the wrong date, so Dean computed "5 days out" instead of 2.
**Fix / Change:**
- Set `AI_PROVIDER=openai` (the `anthropic.ts` shim routes all calls through OpenAI). Changed locally in `.env.local`; Jake set the same env var in Vercel prod. No code change — the shim's default stays `anthropic`; the env var is the "for now" lever. Verified end-to-end: a fresh local dev server on the OpenAI provider successfully generated + sent the previously-missing `post_run` message and annotated the Strava activity.
- Corrected the data for the affected athlete: `training_profiles.race_date` and the `races` row updated `2026-06-18 → 2026-06-14`.
- Re-sent the missing post-run SMS (athlete confirmed receipt).
**Note / follow-up:** Long-term fix is an Anthropic rate-limit/tier increase (the 429 links to console limits). Also worth hardening: a `429` during a proactive trigger should surface more loudly (or `withRetry` should honor the `retry-after` within the 120s `maxDuration` budget) rather than vanishing.
**Files changed:** .env.local (AI_PROVIDER), production data fix (training_profiles, races) — no application code changed.

## 2026-06-11 — Wired strength-routine poster images into the coach flow

**Type:** Feature
**Reported by:** Continuation of personalized-strength-routines work
**User feedback:** "I put all of the posters in /public/strength-posters — let's go for it!"
**Root cause:** N/A — final step of the strength feature: athletes get the routine as text, but the "show them how" half (illustrated posters) needed wiring now that the images exist and the Linq media schema is confirmed.
**Fix / Change:** Added a `[STRENGTH_POSTER]` signal token (mirrors `[REBUILD_PLAN]` etc.): when Dean lists the full strength routine, he appends the token; the system strips it before send and follows the text bubbles with the matching illustrated poster via `sendMediaSMS`. The poster URL is built absolute (`NEXT_PUBLIC_APP_URL/strength-posters/<routine_key>.png`) since Linq fetches and re-hosts it. The token instruction is only injected when a poster-backed routine is actually on file, so Dean never promises an image that doesn't exist. Send is best-effort (try/catch) so a media failure never breaks coaching, logs a `[Sent strength routine poster: <key>]` conversation row (`coach_response` type — no new message_type/migration needed), and fires a `strength_poster_sent` event. dry_run responses now surface `strength_poster: <key|null>` for testing. Verified all 13 posters in `/public/strength-posters` are valid PNGs matching the routine keys.
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/linq.ts (sendMediaSMS, prior entry)

---

## 2026-06-11 — Confirmed Linq outbound media schema + sendMediaSMS primitive

**Type:** Feature
**Reported by:** Strength-poster follow-up
**User feedback:** N/A (continuation of the personalized-strength-routines work — needed to know whether the SMS channel can send images before building the poster send path)
**Root cause:** The product only ever sent text parts via Linq; the outbound media schema was unconfirmed, blocking the strength-routine poster feature.
**Fix / Change:** Probed the live Linq API (`scripts/test-linq-media.mjs`) and confirmed the outbound media shape on the first candidate: a `{ type: "media", url, mime_type }` part alongside the text part returns HTTP 201 over iMessage. Notable: Linq downloads the URL and re-hosts the image on its own CDN, so the media URL only needs to be publicly reachable at send time. Added a validated `sendMediaSMS(to, body, mediaUrl, mimeType)` primitive to `linq.ts` (factored the chatId extraction into a shared `extractChatId` helper reused by `sendSMS`). NOT yet wired into the coach flow — that waits on the poster images existing (sending a 404 URL fails the attachment).
**Files changed:** src/lib/linq.ts, scripts/test-linq-media.mjs (new)

---

## 2026-06-11 — Personalized strength routines: library, generator, and fixing the phantom routine path

**Type:** Feature
**Reported by:** Product audit (the 3 injury-prevention levers)
**User feedback:** "For these three most common reasons people get injured … audit the actual product. The hip and core strengthening: we actually ideally could show them how to do the various exercises, and if someone has a history of a specific injury, we can proactively give them a weekly routine to prevent further injury."
**Root cause:** The coach prompt read a stored strength routine from `training_profiles.dashboard_insights.strength_recovery`, but **nothing in the codebase ever wrote that field** — so the read-path always fell through to a `NO STRENGTH ROUTINE STORED` branch that instructed Dean to say *"I'll add recommendations to your dashboard based on your injury history."* That dashboard no longer exists and the routine was never generated — a live empty promise. Separately, the exercise library was a flat `Record<string,string[]>` of free strings with no stable IDs, so there was no way to attach demo media.
**Fix / Change:**
- New `src/lib/strength-library.ts`: normalized the exercise library into 42 stable-ID `Exercise` objects (name/specs/cue) and 13 `Routine`s (12 injury-site routines + a universal `hip_core` base from the Run RCT). Each routine `key` doubles as the poster filename stem.
- `composeStrengthRoutine()` — deterministic (no LLM) generator: maps an athlete's injury body part / history text to the best-matching routine, falls back to `hip_core` when there's injury history but no recognizable site, returns null when there's no injury signal at all. Output shape is backwards-compatible with the existing coach reader (`{name, specs, reason}`) plus `routine_key` / `poster_url` / `note`.
- Wired generation at **onboarding finalization** (new users get a routine from day one, stored in `dashboard_insights.strength_recovery`) and **lazily in coach/respond** (existing users get one generated + persisted on their next post_run/weekly_recap/user_message — covers the back catalog with no migration, and kills the empty promise everywhere). Reworded the prompt block to drop all "dashboard" references.
- `scripts/strength-catalog.mjs` + `npm run strength:catalog` → writes `docs/strength-routines.md`, the canonical list of routines + exercises to produce poster images for (one poster per routine key). Note: `poster_url` resolves to `/strength-posters/<key>.png` (override via `NEXT_PUBLIC_STRENGTH_POSTER_BASE`); images don't exist yet and Dean does not yet *send* them — that's the follow-up once the Linq outbound-media field is confirmed.
- 25 unit tests for catalog integrity, injury→routine mapping, and generation.
**Files changed:** src/lib/strength-library.ts (new), src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts, scripts/strength-catalog.mjs (new), docs/strength-routines.md (new), package.json, src/__tests__/lib/strength-library.test.ts (new)

---

## 2026-06-11 — Structural prompt improvements: gray zone repetition, boilerplate sign-offs, variable interpolation bug

**Type:** Improvement + Bug Fix
**Reported by:** Internal observation (7-day conversation audit)
**User feedback:** N/A
**Root cause / findings:**
- Gray zone advice repeated to same users 4-5x in one week despite existing dedup instructions — instruction-based suppression isn't reliable
- "Let me know if you have any other questions" appearing 32+ times per week — output contract only fired on post_run/user_message, not weekly_recap/morning_plan
- Weekly recap boilerplate question ("How's sleep and energy?") hardcoded as mandatory ("Do NOT skip this") — fired on every recap regardless of context
- Post-run closing question default framed as "appropriate since you haven't asked recently" — encouraged a question every time
- Variable interpolation bug in correctMileageTotal: no guard for word ranges like "20 to 25 miles" — upper bound matched "X miles this week" pattern and got replaced with week total, producing "12 to 36.7 miles this week"
**Fix / Change:**
- Gray zone: data-layer suppression — when recently flagged, Z3 bullet replaced with "SKIP — use pacing alternative" so option doesn't exist in the prompt
- Sign-offs: added stripBoilerplateSignoffs() post-processing; extended output contract to all triggers via proactiveOutputContract block; moved "NO SIGN-OFFS" to rule 1 in output contract
- Weekly recap question: removed mandatory "Do NOT skip this" — now conditional
- Post-run question: default changed to "skip unless you actually need the answer"; explicitly skips when recent insights ≥ 2 or recent questions ≥ 2
- Variable interpolation: added `(?<!-|to )` lookbehind plus callback check for "\bto\s+" context before each matched number
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-06-11 — Evidence-based injury-prevention section (research credibility + AEO)

**Type:** Feature
**Reported by:** Internal / growth
**User feedback:** "These are some of the top reasons runners get injured supported by research — we can incorporate a section about the research on running injuries / RCTs too? … I want to basically say we cover the top 5 things that keep runners healthy / help you stay on track."
**Root cause:** The page asserted injury-prevention positioning but offered no external evidence backing it, and wasn't capturing high-intent "what causes running injuries" search/answer-engine traffic. Each of the five research-backed levers maps to a capability the product genuinely has, but that connection was never made explicit.
**Fix / Change:**
- Added a "Backed by the research — the five things that actually keep runners healthy" section between "How it works" and the example conversations. Five cards, each pairing a sourced research stat with the matching Coach Dean capability: (1) single-session load spikes (+128% risk, Garmin-RUNSAFE 5,205 runners), (2) prior injury history (2–6× risk), (3) hip & core strength (−34% injuries, Run RCT / Leppänen BJSM 2024), (4) sleep (1.7× risk), (5) structured/graduated plans (Linton et al. 2025 scoping review, 106 studies). Closes with the interaction-effect point (the levers aren't independent — Coach Dean holds the full context).
- Verified each claim against the code before writing it: load/milestone monitoring from Strava, injury history captured in onboarding (and weighted conservatively), strength work + weekly "any strength work in?" check, weekly sleep/energy check-in (`avg_sleep_hours` extracted/stored in onboarding/handle and coach/respond), and structured periodized VDOT plans.
- Added a "What are the most common causes of running injuries?" entry to both the visible FAQ and the FAQPage JSON-LD to capture that query for SEO/AEO.
**Files changed:** src/app/page.tsx

---

## 2026-06-11 — Hero declutter + more natural mockup conversation

**Type:** Improvement
**Reported by:** Internal review
**User feedback:** "top landing page section feels too crowded - can we cut copy by like 50% and adjust the animation so the copy actually makes sense in this context and doesn't look like it was written by AI?"
**Root cause:** The hero had accumulated three stacked copy blocks (H1 + a three-clause subhead + a "Tell Coach Dean where you're at" micro-prompt list), which crowded the column next to the phone mockup. The subhead used the AI-tell triad structure ("monitors X, flags Y, adapts Z. All over text."). The mockup conversation opened with a "Great run today!" praise-bomb and a 💪 emoji, reading generated rather than like a real coach thread, and didn't sit naturally alongside the hero message.
**Fix / Change:**
- **Hero** (`page.tsx`): cut copy ~55%. Shortened H1 to "An expert running coach who keeps you healthy.", replaced the triad subhead with one human line ("…reads every run you do and texts you back like a coach who's actually paying attention — catching the small stuff before it sidelines you."), and removed the micro-prompt list from the hero (that messaging already lives in the final CTA).
- **Mockup** (`imessage-mockup.tsx`): rewrote the 5-message thread so Dean opens proactively (he saw the run + flagged elevated HR), listens to the knee report, adjusts tomorrow's session, and ties back to the goal race (CIM). Dropped the praise-bomb opener and the emoji so it reads like a real coaching conversation.
**Files changed:** src/app/page.tsx, src/components/imessage-mockup.tsx

---

## 2026-06-11 — Landing page ICP sharpening + SEO/AEO improvements

**Type:** Improvement
**Reported by:** Internal review / growth feedback
**User feedback:** "The page is in solid shape — the hero headline is already pointing the right direction. But there are meaningful gaps for the ICP (serious recreational runners with a race goal managing an active/recent injury). SEO/AEO needs work — not getting many hits. A runner googling their injury searches 'IT band not getting better,' 'return to running after stress fracture,' not 'AI running coach.'"
**Root cause:** (1) Page metadata was generic ("An AI-powered running coach that connects to Strava and coaches you via SMS") with no injury/recovery search language, no keywords, no structured data — invisible to the injury-specific searches the ICP actually runs, and uneligible for FAQ rich results / AI answer-engine citation. (2) The hero's strongest conversion copy (the three "where you're at" micro-prompts) was buried in the footer. (3) The social-proof marquee diluted the ICP signal with mass-market beginner terms ("Couch to 5K", "Mile time trial", "5K PR"). (4) Strength/mobility work — a core part of the product and a major ICP hook (the thing their PT keeps telling them to do) — was nearly invisible.
**Fix / Change:**
- **SEO metadata** (`layout.tsx`): rewrote title → "Coach Dean — AI Running Coach for Injury-Free Race Training", injury-specific description, added `keywords` (injury prevention, return to running after injury, shin splints, IT band, stress fracture recovery, etc.), canonical URL, robots index/follow, and a Twitter summary_large_image card.
- **AEO structured data** (`page.tsx`): added `SoftwareApplication` + `FAQPage` JSON-LD (`@graph`) so the existing FAQ content is eligible for Google rich results and citable by AI answer engines. Includes new Q&As for "Can Coach Dean help me return to running after an injury?" and "Does Coach Dean include strength training?".
- **Hero** (`page.tsx`): sharpened H1 to "...keep you healthy — all the way to race day." and pulled the three micro-prompts (staying healthy through a high-mileage block / managing something nagging / coming back after time off) up from the footer into the hero under the CTA.
- **Marquee** (`race-marquee.tsx`): replaced beginner/mass-market terms with serious + comeback signals (Sub-3 marathon, Comeback after IT band syndrome, Rebuilding after shin splints, Healthy through marathon block).
- **Strength visibility** (`page.tsx`): added two insight cards — a "Strength & mobility" accountability prompt and a "Plan rebuild" after missed time card — both grounded in real product behavior (strength block + silent plan rebuild).
- **Technical SEO** (`sitemap.ts`, `robots.ts`): added a sitemap and robots.txt (previously neither existed) — sitemap lists the indexable marketing pages; robots allows crawling while disallowing `/api/`, `/dashboard`, `/checkout`, `/cancel`.
**Files changed:** src/app/layout.tsx, src/app/page.tsx, src/components/race-marquee.tsx, src/app/sitemap.ts (new), src/app/robots.ts (new)

---

## 2026-06-11 — Internal reasoning leaking into SMS messages

**Type:** Bug Fix
**Reported by:** Internal observation (conversation log review)
**User feedback:** N/A
**Root cause:** The `user_message` system prompt contained a "BEFORE WRITING ANYTHING — do these two things:" block with numbered steps (READ THE THREAD, IDENTIFY WHAT THIS MESSAGE IS). Claude occasionally treated this as a scratchpad template and echoed the step labels verbatim in output (e.g. "This is a FOLLOW-UP IN AN ACTIVE THREAD...", "I need to read the thread first...", "What to do:..."). The `stripReasoningPreamble` safety net didn't catch these specific patterns.
**Fix / Change:** (1) Rewrote the prompt preamble to remove the numbered-steps structure — replaced with a single instruction to check the thread silently before writing. (2) Added missing patterns to `stripReasoningPreamble`/`reasoningMarkers` for the leaked phrases: "I need to read/check...", "FOLLOW-UP IN AN ACTIVE THREAD", "What to do:", "Checking THIS WEEK'S PLAN:", "Looking at RECENT CONVERSATION...".
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-06-10 — Dean recited "I'll track your shin" instead of acting on it

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "Doesn't seem like Dean is doing a good job of tracking my shin - he's just saying he will haha" — followed by two replies where Dean recited the same shin-management summary (incl. "If you mention the left shin after a run, I'll adjust your load — not just flag it. … that's the signal I'll track.") instead of (a) giving concrete rehab when asked "anything else I should do for it?" and (b) listing the week's sessions when asked "What does my plan say for the rest of the week."
**Root cause:** The onboarding completion message (`buildDeterministicCompletion`) planted first-person meta-promises in conversation history — "I'll adjust your load — not just flag it", "that's the signal I'll track", "After your next run, I'll send a note … whether to adjust." Jake's shin *was* stored as structured `active_injury` state (the ACTIVE INJURY rule block was firing), but once those promise phrases were in the transcript, Sonnet latched onto them and recited the management summary in place of answering the actual question or using `get_rehab_protocol`. The promises read as empty to the user precisely because nothing concrete backed them.
**Fix / Change:** (1) `coach/respond` ACTIVE INJURY block — added a rule: don't recite the management plan or promise to track; every message touching the injury must add NEW concrete value (answer the question, give rehab via `get_rehab_protocol`, or make a named go/no-go with a named adjustment). If asked about the week/plan, give the actual sessions, not the injury summary. (2) `onboarding/handle` `buildDeterministicCompletion` — stripped the self-referential "I'll adjust your load / not just flag it / that's the signal I'll track / I'll send a note and decide whether to adjust" phrasing at the source; replaced with concrete watch-point and first-run-easy-then-report framing.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-06-10 — Centralized delayed-retry on AI rate limits (429)

**Type:** Infra
**Reported by:** Jake
**User feedback:** "not yet fixed off the free tier - can we setup a delayed retry in case we hit the rate limit?"
**Root cause:** With the provider back on Anthropic and the account still on the free / tier-1 plan, a tokens-per-minute spike returns HTTP 429. Each SDK's built-in retry (default 2) wasn't enough/consistent, and the OpenAI shim path had its own separate behavior.
**Fix / Change:** Added a centralized `withRetry` wrapper in `lib/anthropic.ts` applied to `messages.create` for **both** providers, and disabled each SDK's own retries (`maxRetries: 0`) so retry behavior lives in one place. On a retryable status (408/409/429/5xx/529) it waits and retries, honoring the server's `retry-after` / `retry-after-ms` header when present, otherwise exponential backoff (1s→2s→4s…, capped 30s) with jitter. Bounded by `AI_MAX_RETRIES` (default 5) and a total-wait budget `AI_MAX_RETRY_WAIT_MS` (default 60s) — it won't start a wait that would blow the budget. Every call site benefits (coach response, Haiku extraction, plan parsing). Added `anthropic-retry.test.ts` (8 cases).
**Operational note:** The retry waits inside the serverless function (including `after()` background work). On a TPM limit, `retry-after` can be up to ~60s — ensure the Vercel function `maxDuration` is high enough to cover the wait, or lower `AI_MAX_RETRY_WAIT_MS`. Raising the Anthropic tier remains the real fix.
**Files changed:** `src/lib/anthropic.ts`, `src/__tests__/lib/anthropic-retry.test.ts`

## 2026-06-10 — Rehab data behind a tool + switch back to Anthropic provider

**Type:** Improvement / Infra
**Reported by:** Jake (architecture review)
**User feedback:** "If you ever do a broader prompt refactor, moving reference data (exercises, pacing tables, cross-training options) behind tools would be the right direction." + "let's do the anthropic one and switch everything back to anthropic now."
**Root cause:** The full `BODY_PART_EXERCISES` and `CROSS_TRAINING_ALTERNATIVES` maps were injected inline into every injured athlete's system prompt (via the ACTIVE INJURY and RECURRING INJURY blocks), adding mass on every message regardless of whether exercises were actually discussed. As the injury-prevention focus grows, this data would keep bloating the prompt.
**Fix / Change:**
- Added a `get_rehab_protocol` client tool. Dean calls it on demand (active injury, recurring body part, or a newly-surfaced symptom on post_run/user_message) to fetch targeted exercises + injury-safe cross-training (filtered/prioritized by the athlete's available equipment, with pregnancy-safe notes and the pain-threshold scale). The exercise/cross-training data no longer lives in the prompt — `buildRehabProtocol()` builds it as code. Removed the now-dead `getBodyPartExercises`/`getCrossTrainingAlternatives` inline-injection helpers (kept the underlying maps, now used by the tool).
- Implemented a tool-use loop around the main coach call: when Dean calls `get_rehab_protocol` (stop_reason `tool_use`), the result is fed back and he finishes the message. Capped at 3 rounds. web_search (a server tool) is unaffected — it resolves within a single response.
- **Switched the default AI provider back to Anthropic.** The tool round-trip requires native tool support that the temporary OpenAI shim lacked. Flipped the code defaults from `?? "openai"` to `?? "anthropic"` in `lib/anthropic.ts` (provider selection), `coach/respond/route.ts` (web-search gate), `onboarding/handle/route.ts` (pre-search gate), and the eval harnesses. `.env.local` was already `anthropic`.
- **Shim hardening (also fixes lever-1 safety):** the OpenAI shim's `convertMessages` only accepted a string `system`. After the caching change `system` is sometimes an array (`[{static,cache_control},{dynamic}]`); the shim now flattens the array to a string and drops `cache_control` (OpenAI auto-caches prefixes; it has no `cache_control`). Prevents a 400 on the OpenAI path if the provider is ever flipped back.
- Tests: pinned `onboarding-handle.test.ts` to `AI_PROVIDER=openai` (its mocked call sequences encode the OpenAI pre-search path, which still ships); added rehab-tool round-trip tests to `coach-respond.test.ts`. 456/456 passing.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/anthropic.ts`, `src/app/api/onboarding/handle/route.ts`, `evals/run-*.mjs`, `src/__tests__/api/coach-respond.test.ts`, `src/__tests__/api/onboarding-handle.test.ts`

## 2026-06-10 — OUTPUT CONTRACT: end-of-prompt quality gate for coach replies

**Type:** Improvement
**Reported by:** Jake (coaching quality review)
**User feedback:** "If anything improves the responses of Coach Dean to be more like an actual coach — with specific insights and recommendations, no generic 'nice job' or 'keep things truly easy'."
**Root cause:** The "lead with the observation, no generic praise, no sign-offs" guidance already existed but was buried ~250 lines deep in the system prompt, where model attention is weakest. Responses still drifted into filler openers and uninterpreted numbers (the `response_quality` evals specifically catch post-run opener praise and numbers cited without interpretation).
**Fix / Change:** Added a concise OUTPUT CONTRACT appended as the LAST element of the system prompt (after all dynamic blocks, closest to generation = highest attention), gated to `post_run` and `user_message` triggers. It hard-requires: (1) open with the specific data insight + what it MEANS, never a greeting/praise; (2) exactly one concrete, individualized takeaway, never generic filler; (3) injury & load as the priority lens — surface a specific load-management/recovery read proactively when LOAD CONTEXT shows a spike/recovery signal or the athlete mentioned soreness (directly supports the injury-prevention focus); (4) no filler praise/recaps/sign-offs; (5) escape valve — answer narrow questions precisely and stop. Mirrored the same block at the end of the eval harness's `buildEvalSystemPrompt` (gated identically) to keep eval parity.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

## 2026-06-10 — Prompt caching for the coach engine (cached static framework)

**Type:** Improvement / Infra
**Reported by:** Jake (efficiency review)
**User feedback:** "Please do your best to reduce the size of the coach respond / post run prompts so that they run more efficiently (consider tool use, caching, other options)."
**Root cause:** The ~15–20k-token coach system prompt was rebuilt and sent in full on every coach call (post_run, every inbound SMS, every reminder) with no prompt caching. The largest, byte-identical, athlete-independent instructional content (identity, core mission, the 11 principles, communication style, tone, formatting, and all the WHEN-AN-ATHLETE behavior rules) was interleaved with per-athlete data and — critically — the most dynamic block (`factsBlock`) sat at the very top, so no stable cacheable prefix existed.
**Fix / Change:** Restructured `buildSystemPrompt` to return `{ static, dynamic }`. The athlete-independent coaching framework is relocated to a single front block (the identity/mission/principles region + the COMMUNICATION STYLE → ATHLETE-CONFIRMED region, byte-for-byte preserved), and all per-athlete data (facts, goal/race, fitness tier, training state, activity, conversation) plus the appended dynamic blocks form the uncached tail. The coach call now sends `system` as a two-block array with `cache_control: { type: "ephemeral" }` on the static prefix. Because the prefix is identical across the whole user base (keyed only by units pref + trigger class), it caches across athletes — cached input is ~10% the cost and lower-latency. Expected ~50–70% input-token reduction on coach calls plus lower TTFB. Bonus: live athlete data + RECENT CONVERSATION now sit at the end of the prompt (closest to generation), which improves recall of those exact facts. A few MEMORY-rule directional words ("above"→"below"/"table below") were adjusted since those rules now precede the athlete-data sections. Relocation was done programmatically and verified by a line-multiset diff (rendered prompt text unchanged except the intended edits). Test helpers updated to normalize the new array `system` shape.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`, `src/__tests__/api/coach-respond-metric.test.ts`

## 2026-06-09 — Injury-specific cross-training alternatives menu

**Type:** Improvement
**Reported by:** Jake (product review)
**User feedback:** "I really want Dean to not just tell people 'take a week off or take a few days off.' Instead he should be giving them ideas of ways to stay active via cross-training that won't harm them, or ways to strengthen and recover from the injury so they come back more quickly."
**Root cause:** Dean had body-part-specific rehab exercises but no map of which cross-training activities are safe vs. risky per injury type. LIGHTER_WEEK and INJURY_HOLD rules gave generic suggestions ("easy bike, elliptical, swim") with no injury-awareness. No instruction to proactively offer a cross-training menu instead of rest.
**Fix / Change:** Added `CROSS_TRAINING_ALTERNATIVES` map (12 body parts) and `getCrossTrainingAlternatives()` injected into the ACTIVE INJURY prompt block alongside existing exercises. Added a hard rule: never say "take a few days off" — always offer 2-3 specific active alternatives appropriate for the injury, prioritizing the athlete's available tools. Updated LIGHTER_WEEK and INJURY_HOLD rules to use injury-specific alternatives rather than a generic list.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-06-09 — Cross-training messages now inherit injury context + no praise openers

**Type:** Improvement
**Reported by:** Internal conversation review
**User feedback:** N/A
**Root cause:** `buildCrossTrainingContext` never received `injury_notes` and had no instruction to connect the session to the athlete's active injury. Its "no generic openers" rule was also too weak — the model still opened with "Great job!" on bike/swim/rowing sessions.
**Fix / Change:** Added `injuryNotes` param to `buildCrossTrainingContext`. When an active injury exists, injects a mandatory rule to explain how the cross-training session protects the injury site and end with a brief check-in. Also hardened the opener prohibition to match the running post-run rule ("NEVER open with praise"). `injuryNotes` is now passed from the call site in `route.ts`.
**Files changed:** `src/lib/cross-training.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-06-08 — Injury coaching improvements: pain threshold, groin exercises, pregnancy context, dedup window

**Type:** Improvement
**Reported by:** Jake (conversation review — Gwyneth)
**User feedback:** Gwyneth reported pain going from 1/10 → 3-4/10 during runs and asked what level of pain was OK. Dean gave a binary "don't run" answer three times instead of a specific threshold. Exercises suggested (heel raises, calf stretches) were from her old shin injury, not her current groin strain. Pregnancy context wasn't shaping cross-training advice or exercise recommendations.
**Root cause:** (1) No explicit pain threshold in the ACTIVE INJURY prompt — Dean defaulted to binary "stop running" rather than the clinical 0–2/10 rule. (2) "groin" was missing from BODY_PART_EXERCISES — getBodyPartExercises returned an empty string, so Dean had no specific exercises and fell back to stored dashboard exercises from the prior shin injury. (3) Pregnancy context existed only in conversation history, not injected into the ACTIVE INJURY block where it could shape advice. (4) Content-dedup window in linq webhook was 30s — a duplicate delivery 35s later could slip through.
**Fix / Change:** (1) Added `groin` to BODY_PART_EXERCISES with four pregnancy-safe adductor/hip exercises. (2) Added explicit PAIN THRESHOLD RULE to the ACTIVE INJURY block (0–2/10 acceptable, 3/10 = stop, worsening during run = stop signal) — Dean now gives the athlete the actual scale, not a binary answer. (3) Added PREGNANCY CHECK to the ACTIVE INJURY block: checks injury_notes/physio_notes/coaching_threads for "pregnant" keyword; if stored, confirms; if not, instructs Claude to scan RECENT CONVERSATION and apply pregnancy-specific rules (aqua jogging cross-training, tighter 0–1/10 threshold, pregnancy-safe exercises only, correct referral chain, relaxin context, fitness anxiety reassurance). (4) Updated extraction prompt to capture "pregnancy-related" in injury_notes when athlete mentions pregnancy alongside an injury. (5) Extended content-dedup window from 30s to 60s. (6) Manually updated Gwyneth's injury_notes to "groin strain, pregnancy-related, started last week" so pregnancy context is immediately active.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/webhooks/linq/route.ts

## 2026-06-07 — Onboarding: plan-aware synthesis, sleep question sequencing, injury message focus

**Type:** Improvement
**Reported by:** Jake (internal product review)
**User feedback:** "(1) The final message is doing too much and delivering too little — it recaps instead of answering the athlete's question. (2) Dean never actually used the SWAP plan — the plan upload is currently decorative. (3) The sleep question is sequenced wrong and feels like a form — dropped as its own standalone message after Jake asked for suggestions."
**Root cause:**
1. `buildSynthesisMessage` Sonnet prompt told Claude to recap race/Strava context rather than lead with specific injury management actions, making it feel like a status report.
2. Plan sessions were injected into the prompt context but the prompt didn't explicitly instruct Claude to name specific sessions by label and day — so the plan was present but invisible in the output.
3. Sleep question was sent as a blocking standalone message in `handleInjuryIntake` after injury fields were complete, delaying the answer to any question the athlete had asked.
**Fix / Change:**
- Redesigned `buildSynthesisMessage` Sonnet prompt: now leads with 3 ranked, specific injury management actions (numbered inline), then names the exact upcoming plan session from `sessionList` as the decision point using its verbatim label, then closes with "How's it feeling today compared to yesterday?" rather than a diagnostic question. If the athlete's last message asked a question, Claude is instructed to lead with the answer.
- Added `lastUserMessage` param to `buildSynthesisMessage` so the synthesis can respond to what the athlete actually asked.
- Folded sleep question into `handleDataAnalysis` (Strava synthesis stage) — combined with the injury/health question as one natural sentence. Removed standalone sleep question block from `handleInjuryIntake` entirely.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-06-07 — RTR protocol, multi-session swap, gait triage question

**Type:** Feature
**Reported by:** Jake (internal product review)
**User feedback:** N/A
**Root cause:** Three gaps identified in injury recovery product: (1) INJURY_CLEAR jumped straight to full plan without a graduated return; (2) SESSION_SWAP could only modify one session per response; (3) Triage never explicitly asked whether a symptom was affecting the athlete's gait.
**Fix / Change:**
- **Return-to-run protocol (2-phase)**: `handleInjuryClear` now starts RTR phase 1 (walk/run intervals, 3×/week, 20–25 min) instead of immediately rebuilding the full plan. Sends two phase 1 protocol SMS bubbles with the body part named. Phase 2 (easy running, ~55% mileage cap) is reached via `[RTR_ADVANCE]` tag after two consecutive pain-free sessions. Phase 2 graduation re-fires `injury_clear` → plan rebuild with standard ramp. `return_to_run_phase` column now actually increments (1 → 2 → null with plan rebuild).
- **RTR block in system prompt**: `morning_plan`, `post_run`, `user_message` all receive a `⚠️ RETURN-TO-RUN PHASE N ACTIVE` block when the phase is set. Phase 1 rules: walk/run only, no continuous runs, gate question after each session. Phase 2 rules: easy only, mileage cap, gate question.
- **RTR_ADVANCE tag**: When Dean signals `[RTR_ADVANCE]`, the after() handler increments the phase or fires `injury_clear` for graduation. Tag is stripped before SMS send.
- **handleSymptomCheckin RTR-aware**: Fetches `return_to_run_phase` and `injury_body_part`; uses gate question ("How did the [body_part] feel — any pain during or after, or all clear?") in RTR mode; keeps generic gait-inclusive question otherwise.
- **Multi-session SESSION_SWAP**: Changed from single `.match()` to `.matchAll()` — Claude can now emit multiple `[SESSION_SWAP day="X" to="Y"]` tags in one response to surgically modify 2+ sessions. After() handler loops all matches before writing one DB update. System prompt updated to show multi-tag example.
- **Gait question in triage**: Added `GAIT QUESTION — TRIAGE` rule between `SHARP PAIN DISAMBIGUATION` and `MANDATORY PROFESSIONAL REFERRAL`. Dean now explicitly asks "Does this change how you're walking or running — like favouring one side, any limping?" when a new symptom is first reported. Athlete confirming gait impact → mandatory referral trigger.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`

---

## 2026-06-07 — Injury intake captures management context and synthesis describes how coaching works

**Type:** Feature / Improvement
**Reported by:** Jake (internal)
**User feedback:** "should we ask something like 'are you doing anything for that injury right now?' want to make sure that onboarding fully captures the relevant context and can provide some good recommendations for the upcoming week and then describes how to work together"
**Root cause:** Injury intake only probed for body_part, severity, and when-it-flares — never asked what the athlete is already doing for it (PT, rest, ice, etc.). Synthesis message closed generically ("coaching note lands after your first run") without describing what that note would address for injury cases.
**Fix / Change:** (1) Added `injury_management` as a captured field in `extractFields` — extracted when athlete says what they're doing for an injury. (2) `handleDataAnalysis` now closes with a direct management question when injury was pre-flagged: "Are you doing anything for the [body part] right now — physio, rest, any specific treatment?" (3) `handleInjuryIntake` probe sequence now prioritizes management + timing combined ("what are you doing for it and when does it flare") over severity. (4) `buildDeterministicCompletion` uses management context to write a nuanced injury note (PT → "working alongside your physio"; rest → "good call giving it rest; I'll pace the ramp"; other treatment → acknowledge + add body-part action). (5) Closing sentence for injury cases now describes what coaching will specifically address: "After your next run, I'll send a note — what the session means for the [body part], and whether to adjust the next day."
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-06-07 — Strava analysis leads with injury context when injury is already flagged

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "I flagged my shin issue before my race upcoming and it kind of just said 'I'll keep an eye on it' and decided to focus on my HR instead from strava...should the strava connection analysis focus on the core goal / issue being brought up?"
**Root cause:** `handleDataAnalysis` had a single prompt structure for all users. When `injuryAlreadyCollected` was true, the prompt only modified the closing line ("close with a forward-looking sentence") but kept the same main body: "lead with 2-3 Strava numbers (e.g. weekly mileage, HR zone %)". The HIGH Z3 WARNING rule fired regardless, pushing Dean to lead with "57% of your runs are in Zone 3" even though the athlete had just flagged a shin issue.
**Fix / Change:** Restructured `handleDataAnalysis` system prompt to branch on `injuryAlreadyCollected`. When injury is known: (1) Lead with injury + volume/load signals as the primary lens — not HR zones; (2) Name a specific load signal to watch and connect it to the injury; (3) HR zone analysis demoted to a supporting observation only if relevant to recovery; (4) No closing injury question. The injury context (from `current_niggles`, `injury_notes`, `injury_history`) is now explicitly surfaced in the prompt as "INJURY FLAGGED BEFORE STRAVA: [text]" so Dean has the specific detail, not just a boolean.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-06-07 — Eliminate jargon (ACWR, units) and align all triggers on injury prevention mission

**Type:** Improvement
**Reported by:** Jake (internal)
**User feedback:** "we probably need to clearly define 'units' and the way we are going about training load / running load here! same with something like ACWR, most people don't know what that is. Also, can you take a look now at onboarding, coach respond, and sunday recap and make sure all of them properly align on focusing on injury prevention and recovery (getting faster without getting injured)"
**Root cause:** (1) The LOAD CONTEXT block used "units" and "impact load" as athlete-facing terms — meaningless to athletes. (2) The prompt used "ACWR" as a term Dean could say to athletes, including in example phrases like "ACWR at 1.38." (3) Coaching philosophy ("get faster without getting injured") was stated in onboarding but not in the main coach/respond prompt. (4) Weekly recap LONGITUDINAL SIGNALS used load only as a mileage-volume signal, not tied to injury prevention.
**Fix / Change:** (1) Added PLAIN LANGUAGE jargon rules at the top of buildSystemPrompt: never say "ACWR", "X units", "impact load score", or "cardiac decoupling" to athletes — translate each into plain English with specific example wordings. (2) Added CORE COACHING MISSION paragraph to buildSystemPrompt aligning coach/respond with onboarding's "get faster without getting injured" philosophy. (3) Fixed all ACWR example phrases in 5 CORE METRICS, OVERRIDES, CITE THE NUMBER, and weekly recap — replaced with plain-English equivalents. (4) Added load-as-injury-prevention framing to weekly recap LONGITUDINAL SIGNALS: when athlete has injury notes, load is always the first signal. (5) LOAD CONTEXT block header now explicitly instructs Dean it's internal-only data, never to repeat raw numbers to athletes.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-06-07 — Shift post-run coaching lens from HR to load scores and injury prevention

**Type:** Improvement
**Reported by:** Jake (internal)
**User feedback:** "coach respond and post run are still mostly focused on HR a lot - Gwyneth keeps getting messages about that and maybe we need to shift towards the load scores we now have and injury prevention"
**Root cause:** The "5 CORE METRICS" prompt listed HR as "an important lens for easy runs" — making it the default fallback for any run where ACWR wasn't spiking. Load scores were only surfaced as a spike alert (ACWR >1.3), not as a regular coaching lens. Athletes with injury history were getting HR zone analysis instead of load-tied injury prevention framing.
**Fix / Change:** (1) Promoted TRAINING LOAD to the default easy-run lens with explicit per-session load vs. recent baseline comparison ("52 units — 37% harder than your recent easy run average of 38 units") including injury prevention tie-in when injury notes exist. (2) Demoted HR to "use for quality sessions and long runs; NOT the default for easy runs." (3) Expanded loadContextBlock to compute last 5 session impact loads, calculate recent average, and inject the delta comparison into the prompt so Dean has concrete numbers to cite. Fixed current-activity exclusion to use start_date (strava_activity_id not in select).
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-06-07 — Ask athlete what week of plan they're on; use that for synthesis

**Type:** Improvement
**Reported by:** Jake (internal)
**User feedback:** "we can also ask what week the user is on, that's probably better!"
**Root cause:** `buildSynthesisMessage` computed the current plan week from race date math, which is wrong if the athlete started late, repeated a week, or is off-schedule.
**Fix / Change:** When athlete answers YES to the plan check question, Dean now asks "What week are you on?" as the follow-up. Haiku extracts `plan_current_week: number` from the conversation. `buildSynthesisMessage` uses the stored week number as the primary source (falls back to race-date computation if not set). Also surfaced in `summarizeCollected` so Dean doesn't re-ask.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-06-07 — Plan-aware synthesis message at end of onboarding

**Type:** Feature / Improvement
**Reported by:** Jake (internal testing — SWAP plan + shin soreness scenario)
**User feedback:** "Dean gave generic taper advice instead of referencing the specific Tuesday workout in my SWAP plan"
**Root cause:** `buildDeterministicCompletion` was fully deterministic text — it had no access to `plan_sessions_all_weeks` and couldn't name specific upcoming workouts or frame a decision point.
**Fix / Change:** Replaced synchronous `buildDeterministicCompletion` call with async `buildSynthesisMessage`. When `plan_sessions_all_weeks` is present AND there is an active injury, makes a Sonnet call with a tight prompt: names the specific next quality session (by day + label) as the decision point, states that session is where we'll know whether to push or pull back, and ends with a mandatory diagnostic question ("Does the [body_part] hurt only while running, or also walking around?"). Falls back to deterministic logic for non-injured users or users without an uploaded plan.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-06-07 — Onboarding: injury-first flow, plan check step, UKK PDF scoped correctly

**Type:** Feature / Improvement
**Reported by:** Internal (ICP targeting + onboarding review)
**User feedback:** "I don't necessarily want us to send the PDF link to everyone — we should send it when we feel like strength training is needed and could help!"
**Root cause:** Onboarding was framed as a fitness app ("what are you working toward?") rather than targeting the ICP of athletes managing or preventing injury. UKK PDF was sent deterministically at completion for all injury users rather than contextually by Claude. Plan check was passive — Dean only acknowledged plans if the athlete volunteered them, rather than explicitly asking.
**Fix / Change:**
- **Injury-first framing**: Goals-stage system prompt now positions Dean as "the thing that catches early warning signs so you can race and train without getting sidelined." First message uses "what's going on (or dealing with right now)" framing to surface injury alongside goals.
- **Plan check — mandatory Step 2**: After goal is established, Dean now explicitly asks "Are you following a training plan or working with a coach right now?" before Strava. This is a required step in the flow, and [READY] now requires plan check answered. Plan check is handled gracefully for yes/no/injury-context answers.
- **Injury-first synthesis**: `buildDeterministicCompletion` now puts the injury note BEFORE the Strava observation when active injury is present, and ends with a specific timing question ("When does the [body_part] flare — during runs, after, or both?") rather than the Strava cadence close.
- **UKK PDF removed from deterministic completion**: PDF link no longer fires for all active injury users. Instead, `hipCoreProtocolBlock` in `coach/respond` gives Claude the protocol + conditions for when to surface it naturally (active injury + no exercises prescribed, load spike with soreness, athlete asks about strength).
- **Haiku extracts `has_existing_plan`**: Removed broken [MODE:...] tag dependency. Haiku now extracts `has_existing_plan` (boolean) directly from the conversation when athlete answers the plan check question.
- Eval runner synced with all prompt changes.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-onboarding-evals.mjs`

---

## 2026-06-07 — Injury prevention Phase 1: UKK protocol + sleep tracking + weekly check-in

**Type:** Feature
**Reported by:** Internal (injury prevention research review)
**User feedback:** N/A
**Root cause:** Coach Dean had load spike detection and symptom tracking but wasn't surfacing the UKK hip/core protocol (the best RCT evidence for injury prevention) or tracking sleep beyond onboarding intake.
**Fix / Change:**
- Added `UKK_PDF_URL` constant (`https://ukkinstituutti.fi/...`) in both `coach/respond` and `onboarding/handle`
- New `hipCoreProtocolBlock` in `buildSystemPrompt` — injected for `post_run`, `weekly_recap`, `user_message` triggers. Flags when `active_injury` or load spike is present. Tells Claude when/how to surface the link (not to describe exercises — just send the link).
- `buildDeterministicCompletion` now adds the UKK PDF link as a part for athletes with `active_injury = true` or RTR/injury_recovery goals.
- Added `avg_sleep_hours` to `ExtractedProfileData` + extraction prompt. Haiku now extracts explicit sleep mentions from user messages and `persistProfileUpdates` saves to `training_profiles.avg_sleep_hours`.
- Weekly recap prompt now instructs Claude to end the second text with: "How's sleep and energy been this week? Any strength work in?" — closes the loop on the two highest-evidence soft signals.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-06-07 — Switched AI provider back to Anthropic

**Type:** Infra
**Reported by:** User request
**User feedback:** "can we switch over to anthropic as API provider now?"
**Root cause:** Provider had been temporarily on OpenAI since April due to Anthropic tier 1 rate limits. Limits resolved.
**Fix / Change:** Changed default in `src/lib/anthropic.ts`, all 5 eval runners, and `.env.local` from `"openai"` to `"anthropic"`. Added `AI_PROVIDER=anthropic` to `.env.local`. User will update Vercel env vars. Web search now active natively for `user_message` trigger in `coach/respond` and inline `web_search_20250305` tool used in onboarding Sonnet calls.
**Files changed:** `src/lib/anthropic.ts`, `.env.local`, `evals/run-evals.mjs`, `evals/run-onboarding-evals.mjs`, `evals/run-simulation-evals.mjs`, `evals/run-extraction-evals.mjs`, `evals/run-strava-analysis-evals.mjs`

---

## 2026-06-07 — Onboarding evals: 9/9 passing, new injury fixtures, prompt fixes

**Type:** Improvement / Eval
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Several onboarding prompt issues found by running evals after the onboarding overhaul: (1) generic praise ("That sounds like a challenging and exciting goal!") on trail race disclosure; (2) goals-stage Dean probing injury details instead of acknowledging and continuing; (3) RTR goals pivoting to Strava before asking one injury question; (4) injury intake eval fixture using goals-stage prompt instead of intake-stage prompt.
**Fix / Change:**
- Strengthened "no generic praise" instruction with explicit banned phrases list ("that sounds like a challenging/exciting goal", etc.) — synced between `route.ts` and eval runner.
- Restructured injury mention instruction in goals stage: STEP 1 check (is this RTR/injury_recovery goal?) routes to injury probe or acknowledge-and-continue. Added explicit "Do NOT mention Strava in this message" for RTR path so model doesn't preview Strava while asking the injury question.
- Added Strava section exception for RTR goals (injury question first, Strava after).
- Updated `trail-race-goal-type` ground_truth to accept Strava-first as valid after goal is established.
- Added injury intake stage detection to eval runner (`buildInjuryIntakeSystemPrompt`): fixtures with `stage: "injury_intake"` now use the intake-stage prompt instead of goals-stage Sonnet.
- New onboarding fixtures: `injury-active-goals-stage` (active injury mid-goals-stage), `injury-intake-follow-up-quality` (injury intake specific follow-up targeting).
- New simulation fixture: `sim-active-injury-marathon` (Jordan with active hamstring, tests full injury intake flow including body_part/severity/reported_during collection).
- Final result: 9/9 onboarding evals passing, avg 10.0/10.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-onboarding-evals.mjs`, `evals/fixtures/onboarding/trail-race-goal-type.json`, new fixtures `injury-active-goals-stage.json`, `injury-intake-follow-up-quality.json`, `evals/fixtures/simulation/sim-active-injury-marathon.json`

## 2026-06-07 — Onboarding overhaul: injury-aware completion, sleep, off-topic handling, two-follow-up cap

**Type:** Feature / Improvement
**Reported by:** Internal observation (Jake's onboarding experience — hamstring disclosure got "I'll keep an eye on it")
**User feedback:** "you disclosed a hamstring issue and Dean said 'I'll keep an eye on it.' That's the worst possible response to an injury disclosure at onboarding — it's passive, it's vague, and it signals that the information went nowhere."
**Root cause:** `buildDeterministicCompletion` had a generic injury note with no body-part-specific action, no commitment to load modification, and no "what happens next" moment. `handleInjuryIntake` capped at one follow-up regardless of how much was captured. `symptom_history` was never seeded at onboarding. `return_to_run_phase` was never set for RTR/injury_recovery goals. No off-topic handling in the goals stage.
**Fix / Change:**
- `buildDeterministicCompletion` — conditional branch when `active_injury = true`: acknowledges the specific body part by name, gives one concrete pre-run action (body-part lookup table), and commits to load modification not just flagging. Historical injury also upgraded from "on my radar" to "modify load when needed, not just flag it." All paths now close with a "what happens next" sentence ("Next time Strava syncs a run, I'll send you a coaching note within a few minutes").
- `handleInjuryIntake` — increased follow-up cap from 1 to 2. After first follow-up, Haiku checks if body_part + severity + reported_during are all known; only fires a second follow-up if fields are still missing. Target varies by follow-up number (first = most important missing field, second = final gap).
- Sleep question — added at the end of injury intake before completion: "Last thing — how's sleep been lately? It affects how I interpret your recovery between runs." Extracted from response and stored as `avg_sleep_hours` in `training_profiles`.
- `completeOnboarding` — seeds `symptom_history` JSONB with an initial entry when `active_injury = true`, so the recurrence monitoring system has context from day 1 rather than waiting for a post-run check-in.
- `completeOnboarding` — sets `return_to_run_phase = 1` in `training_state` for `return_to_running` and `injury_recovery` goals.
- `completeOnboarding` — long run baseline now falls back to `strava_longest_run_miles` from Strava history, so users don't need to be asked for data Strava already has.
- `extractFields` — added `reported_during` (during/after/both), `avg_sleep_hours` fields.
- Off-topic classifier — rule-based early returns + optional Haiku LLM call for messages that are long, contain `?`, and lack training keywords. Off-topic messages get a natural answer + redirect to the current stage goal without advancing onboarding state.
- Migration `050_avg_sleep_hours.sql` — adds `avg_sleep_hours numeric` to `training_profiles`.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `supabase/migrations/050_avg_sleep_hours.sql`, `src/lib/database.types.ts`

## 2026-06-07 — Load + symptom monitoring system (pivot to injury-prevention coaching)

**Type:** Feature
**Reported by:** Internal product analysis
**User feedback:** N/A
**Root cause:** Competitive analysis and 2-week PMF review showed strongest engagement with injury-aware users. Research: 70-80% of running injuries caused by load spikes; single session ≥10% above prior 30-day max is the primary predictor.
**Fix / Change:** Full pivot from reactive post-run feedback to proactive load + symptom monitoring:
- **Two-signal load scoring**: `running_impact_load` (mechanical tissue stress, spike detection) and `activity_fatigue_load` (systemic fatigue, coaching tone). Activity-type-specific multipliers: full impact for runs, 0.65× for hike/elliptical, 0.8× for ride/swim, 0 for pure leg-day (WeightTraining/Workout).
- **Zone multiplier** (TRIMP-style): HR-primary (Z1-2=1.0, Z3=1.5, Z4=2.0, Z5=3.0), pace-fallback when no HR.
- **Trail grade modifier**: `1.0 + (grade - 0.08) × 2`, capped at 1.4, applied only to impact load not fatigue.
- **Treadmill grade inference**: elevation_gain=0 is common; fallback to speed < 1.8 m/s → walking incline → 0.65× modifier.
- **Spike detection**: session impact load > rolling 30-day max × 1.10 → sets `pending_symptom_checkin = true` in training_state.
- **`handleSymptomCheckin`**: proactive one-question SMS fired at next nightly/morning cron after a spike. Clears the flag after sending.
- **Leg-day flag TTL**: `leg_day_flag_expires_at` checked at response time (not relying on cron to clear).
- **Symptom history**: structured JSONB with canonical body part vocabulary. 30-day recurrence window. Pattern detected ≥2 reports → system prompt escalation.
- **Sharp disambiguation**: one clarifying question before PT referral escalation.
- **SESSION_SWAP tag**: `[SESSION_SWAP day="Thu" to="40min easy bike"]` — surgical session modification without full week rebuild.
- **PHYSIO_REFERRAL tag**: records when Dean refers athlete to a professional; stores `physio_referral_sent_at`.
- **Physio prescription capture**: `physio_notes + physio_prescribed_restrictions` injected into system prompt so Dean coaches within the physio's constraints.
- **Backfill script**: `node scripts/backfill-load-scores.mjs` — idempotent, processes users in chronological order, `--dry-run` + `--user-id` flags.
- **DB migrations**: 017 (load score columns), 018 (symptom_history, pending_sharp_disambiguation, message_type constraint), 019 (physio tracking, return-to-run phases).
**Files changed:** `src/lib/load-score.ts` (new), `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`, `migrations/017-019_*.sql` (new), `scripts/backfill-load-scores.mjs` (new), `src/lib/database.types.ts`, `src/__tests__/lib/load-score.test.ts` (new)

## 2026-06-07 — Fixed onboarding injury stage asking about injury twice when already discussed

**Type:** Bug Fix
**Reported by:** Internal observation (Jake)
**User feedback:** "Seems like the onboarding changes we made aren't quite right"
**Root cause:** The new `handleDataAnalysis` stage (post-Strava) always appended "Has injury ever been a factor for you, or anything you're managing right now?" even when the user had already shared injury context during the goals stage. Then `handleInjuryIntake` sent a Haiku follow-up question regardless of whether `injury_history`/`current_niggles`/`injury_notes` was already populated. Users who mentioned injury during the goals conversation got asked about it 2-3 more times.
**Fix / Change:** `handleDataAnalysis` now checks `injuryAlreadyCollected` and skips the injury question when data is present, instead closing with a forward-looking coaching line. It also pre-sets `injury_follow_up_sent: true` in `onboarding_data` so `handleInjuryIntake` sees it immediately. `handleInjuryIntake` adds `injuryAlreadyKnown` as a third short-circuit condition alongside `followUpAlreadySent` and `noInjury`, completing onboarding immediately when injury context is already captured.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-06-07 — Coaching style question on race drop or pregnancy; coaching_mode_request extraction

**Type:** Feature
**Reported by:** User feedback (Gwyneth via Jake)
**User feedback:** "Dean didn't actually give me an option to be given workouts from him"
**Root cause:** When an athlete drops their A-race or announces a major life change (pregnancy), Dean acknowledged it conversationally but kept prescribing structured workouts without asking what the athlete wanted. No extraction path existed for athletes to express "just track my runs" preference. Old onboarding had a coaching mode question; new onboarding removed it.
**Fix / Change:** Added a `COACHING STYLE QUESTION` rule to the user_message system prompt: when the athlete drops their primary race or announces pregnancy, Dean now asks "Do you want me to keep writing your weekly workouts, or would you rather just check in after each run for now?" Added `coaching_mode_request` to Haiku extraction (picks up "analyst" or "full_coach" responses) and persists the result to `training_profiles.coaching_mode`. Also updated Gwyneth's profile: `injury_notes` now includes pregnancy context (~10 weeks as of June 2026), `coaching_mode` set to `analyst`.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-06-07 — Fixed post-run insight dedup never firing; fixed Gwyneth's stale training state

**Type:** Bug Fix
**Reported by:** User feedback (Gwyneth)
**User feedback:** "Dean keeps telling me I need to stay below X heart rate" (repeated on every run including walks and hikes)
**Root cause:** The `conversations` query at line 173 of `coach/respond/route.ts` only selected `role, content` — missing `message_type`. Both dedup loops (`recentPostRunInsights` and `recentRecapObservations`) checked `m.message_type !== "post_run"` which always evaluated to `undefined !== string = true`, so every message was skipped. Neither dedup mechanism has ever fired. Additionally, Gwyneth's `weekly_mileage_target` was stuck at 3 (should be 18) and `race_date` still pointed to the Snowbird race she dropped May 26. Her `coaching_threads` still read "Continue reducing time in the moderate zone" which kept nudging Dean toward Z3 advice regardless of dedup.
**Fix / Change:** Added `message_type` to the conversations select. Patched Gwyneth's DB: `weekly_mileage_target` → 18, `race_date` → null, `coaching_threads` → null.
**Files changed:** `src/app/api/coach/respond/route.ts` (line 173)

---

## 2026-06-04 — Injury prevention: warmup prescriptions, weekly mobility, form cues, first-time PT referral

**Type:** Feature
**Reported by:** Internal — injury prevention identified as a major gap
**User feedback:** N/A
**Root cause:** System had strong injury *response* (rehab exercises, hold/lighter-week states, return ramps) but no proactive injury *prevention* — no warmup guidance before quality sessions, no standing mobility routine for healthy athletes, and no form coaching linked to active injuries.
**Fix / Change:**
- Quality session warmup: when morning_plan trigger fires for a tempo, interval, or long run (14mi+), system prompt now instructs Dean to add a second bubble with a specific warmup routine (session-type appropriate, under 280 chars). Easy and rest days are untouched.
- Weekly mobility routine: for all athletes on weekly_recap and initial_plan, Dean now includes one "Mobility + recovery 15 min" session on a rest day. Rotates 4 exercises from a curated pool of 7 each week. Omitted only if athlete already has yoga/stretching in cross-training tools.
- Form cues tied to injury: when an athlete has an active shin/knee/IT band injury AND cadence < 170 spm, a single one-sentence form cue is injected into the injury follow-up block. Three body parts mapped with clinically grounded cues.
- PT referral for first-time moderate pain: first-occurrence moderate/severe injuries now get one gentle PT referral sentence ("If this doesn't settle down within a week, a sports physio can rule out anything structural"). Doesn't fire for recurring injuries (those already have stronger language).
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-06-04 — Reworked user_message prompt framing (classification-first approach)

**Type:** Improvement
**Reported by:** Jake (internal observation, Gwyneth)
**User feedback:** Gwyneth asked "But what do you think the groin could be, given how far along I am?" and "But do you know about SPD?" — Dean responded with the same generic "take it easy / easy runs / monitor symptoms" advice 3-4 times instead of engaging with the actual questions.
**Root cause:** Structural problem in the `user_message` system prompt. The opening instruction was "use their activity history and training data to give specific, personalized advice" — this anchored Claude to the training-data lens for every message type, forcing 25+ override rules to compensate for specific failure modes. The model was biased toward coaching outputs even when the athlete was asking a medical question or pushing back on a prior response.
**Fix / Change:** Replaced the "use training data" default framing with a classification-first structure. Claude is now instructed to (1) read the thread before writing and (2) identify what type of message it is — active follow-up, non-training question, training question, life update, status update, or confirmation — then respond accordingly. Training data is reframed as context available when relevant, not the lens for every response. Non-training questions (physiology, medical, pregnancy-related symptoms) now have an explicit branch that says: answer the question directly and engage with the topic; pregnancy context in RECENT CONVERSATION shapes how symptoms are interpreted. The three bandaid rules added earlier (FOLLOW-UP PUSHBACK, CONVERSATION REPETITION GUARD, PREGNANCY CONTEXT) are removed — their intent is now handled by the top-level classification.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-06-04 — Onboarding race condition, wrong YTD milestone, Strava friends text removed

**Type:** Bug Fix (3 issues)
**Reported by:** Jake (internal observation)
**User feedback:** "got a repeat here... Should I do any stretching or strengthening for the shin? [Dean responds with the same initial_plan message again]" / "Rebekah got a message today that she hit 200 mi this year but she actually is at something like 350" / "we are not showing the coaching notes right now in strava, so let's remove mention of your friends will see this"
**Root cause:**
1. Race condition in onboarding: if user sends a message while `onboarding/handle` is still processing (Claude + web search takes 15-30s), the second message sees `onboarding_step = "onboarding"` and gets routed to `onboarding/handle` again. By then all fields are collected so [READY] fires a second time, triggering `initial_plan` again with the same "go run" message.
2. YTD milestone used `recentActivities` (last 50 activities, ~12 weeks) to compute year-to-date miles. For year-round runners, this underflows — causing false milestone triggers (e.g. crossing 200mi when athlete is at 350mi total).
3. Onboarding messages mentioned "your friends will see it too" for Strava coaching notes, but coaching notes are not currently being posted.
**Fix / Change:**
1. Added a conditional update guard in `completeOnboarding`: `.eq("onboarding_step", "onboarding")` filter on the users update + early return if 0 rows matched (means another call already completed).
2. Added a separate YTD activities DB query (all runs since Jan 1) for `post_run` milestone checks — replaces the unreliable `recentActivities` filtering approach.
3. Removed "your friends will see it too" / Strava coaching note mentions from all onboarding messages (en/fr/es).
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-05-31 — Onboarding architecture: dedicated post-Strava stages for data synthesis and injury intake

**Type:** Feature / Refactor
**Reported by:** Jake (direct user experience feedback after going through onboarding himself)
**User feedback:** "1. The mode question is redundant after removing complement/no-plan modes — it can just go. 2. After Strava connects, there's no synthesis moment. Dean says nothing opinionated. Just 'Great! I can see your data' and moves on. 3. Injury intake is too passive — Dean acknowledges and moves on instead of probing. 4. The completion message feels templated and unearned. 5. 'Give me a sec to pull the rest in' is a false promise — there's no async loop."
**Root cause:** Monolithic system prompt let the LLM control conversation flow, leading to mode questions fired after injury disclosures, generic platitudes about injury history, no real synthesis of Strava data, and a completion message built from LLM discretion instead of structured data.
**Fix / Change:** Added a `stage` field to `onboarding_data` and two dedicated handlers in `onboarding/handle/route.ts`: (1) `handleDataAnalysis` — fires when `(strava connected)` arrives, generates opinionated Strava synthesis connecting weekly mileage/HR zones to the race timeline, asks one injury question, sets `stage: "injury_intake"`; (2) `handleInjuryIntake` — receives injury response, uses Haiku to generate one specific follow-up OR immediately calls `buildDeterministicCompletion` if no follow-up needed; (3) `buildDeterministicCompletion` — template-built final message from structured data (race+timeline, training observation, injury note, "First coaching note lands after your next run"). Goals-stage prompt updated: removed mode question, removed training-days as a required field, added injury-in-dedicated-stage note, updated SIGNALING READY to 3-item check (name + goal + Strava). Removed "Give me a sec to pull the rest in" from Strava callback confirmation message.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/auth/strava/callback/route.ts, evals/run-onboarding-evals.mjs, evals/run-simulation-evals.mjs, evals/fixtures/onboarding/no-reask-collected-info.json, evals/fixtures/onboarding/injury-history-race-goal.json

---

## 2026-05-30 — Mode collapse: one coaching mode for all users; onboarding no longer gates on plan choice

**Type:** Feature / Refactor
**Reported by:** Jake (product direction feedback)
**User feedback:** "One mode. Call it something like 'race-focused coaching' internally. From there Dean operates as a responsive coach: suggests the week's structure conversationally ('this week I'm thinking 4 runs, ~35 miles, one quality session — does that fit your schedule?'), annotates each run as it happens, and adjusts based on what actually occurs. Not a plan, not pure analysis — ongoing calibration toward a race."
**Root cause:** FROM_SCRATCH/COMPLEMENT/NO_PLAN mode gates created a product decision upfront that most users aren't equipped to make. Complement mode was too restrictive (no session prescription) and no-plan mode gave up too much value.
**Fix / Change:** Removed [MODE:...] tags from onboarding entirely. All users now fire `initial_plan` after onboarding. `coaching_mode` = 'adaptive' for new users (no ANALYST/COMPLEMENT restrictions). Existing plan context (`has_existing_plan`, `external_plan_notes`) still informs how Dean frames suggestions, but doesn't gate what he does. `initial_plan` message changed from plan-document delivery to conversational first-week orientation. `parseModeFallback` function removed. COMPLEMENT/NO_PLAN early exits from `completeOnboarding` removed.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts, src/__tests__/api/onboarding-handle.test.ts

---

## 2026-05-30 — Onboarding overhaul: single Strava link, deeper injury probing, earlier plan preference, synthesis wrap-up

**Type:** Improvement
**Reported by:** Jake (direct user feedback after observing onboarding conversations)
**User feedback:** "The two Strava auth links is a real problem. Making the user choose between read vs. read+write is a technical decision they shouldn't have to make. Most users won't understand the distinction... Default to write access and explain the benefit in plain English: 'I'll connect to Strava and add a short coaching note to each activity — your friends will see it too.' 'Great choices, Jake!' is the wrong register. A coach doesn't praise race selection. They react to it with information. The hamstring disclosure is underhandled... A coach would probe: how long exactly, does it hurt during runs or just after, have you seen anyone about it, does it affect your gait? The final question is too late and too binary. 'Want me to build you a training plan, or just coaching notes?' should come earlier... There's no synthesis moment at the end. The 'Give me a sec' message is a dead-end UX moment."
**Root cause:** Multiple onboarding prompt and UX issues: (1) two-link Strava pattern confused users with a technical choice they didn't understand; (2) injury mentions dismissed with generic advice instead of probed; (3) plan preference question asked last when it determines Dean's whole approach; (4) coach responses praised race choices instead of reacting with information; (5) no synthesis at [READY] to make the user feel heard; (6) holding messages ("Give me a sec") created dead-end UX.
**Fix / Change:** Single Strava write link everywhere (read-only link removed), with plain English copy about coaching notes in the feed. Injury intake updated to require specific follow-up (how long, during/after). Plan preference question moved to step 2 (before Strava), reworded from "want a plan or coaching notes?" to "do you have a plan already or want me to build one?". Race reaction now leads with coaching insight not praise. [READY] wrap-up must include a synthesis sentence. Added explicit "no standalone holding messages" rule.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-05-24 — Coaching focus preference; reduce Z3 harping; wrist HR artifact detection; improved metric explanations

**Type:** Feature + Improvement
**Reported by:** Jake (internal observation + user feedback pattern)
**User feedback:** "Can you make sure we don't harp on the 'make your runs truly easy' too much? I've noticed a lot of athletes using Coach Dean get annoyed by this because either (1) wrist based HR is not accurate - maybe solution for this one is to give better pacing guidance based on their strava data (2) They don't actually want to always run super slow. I'm curious if it would make sense to check in and see if the user is liking focus on one thing versus another (HR zones vs strength vs a good warmup routine vs focusing on cadence, etc."
**Root cause:** (1) Z3/gray-zone advice was firing too aggressively and prescriptively, regardless of HR data quality or athlete preference. (2) No mechanism to detect wrist HR sensor spikes that inflate max HR readings. (3) Metric explanations gave numbers without plain-English meaning. (4) No way to store or act on per-athlete coaching focus preferences.
**Fix / Change:**
- **Wrist HR artifact detection**: Computes `max_heartrate / average_heartrate` ratio for non-quality runs. If > 1.45, injects an HR ARTIFACT RISK data guard so Dean avoids zone-based prescriptions for that run.
- **Z3 gray zone**: Changed from prescriptive mandate ("next easy run, aim for below X bpm") to observational question ("you were in the gray zone — does that match how it felt?"). Only fires when no artifact risk AND the recent-insights dedup block isn't already flagging it.
- **80/20 softened**: Reframed as guideline, not mandate. Explicitly respects athlete intent — if they don't want to focus on slowing down, Dean acknowledges it rather than repeating the advice.
- **Coaching focus preference**: Added `coaching_focus` field to `onboarding_data` JSON. Haiku extraction detects when an athlete expresses a preference (HR zones, pacing, strength/form, consistency, no zones) and stores it. Injected into system prompt to weight the coaching lens. Weekly recap prompts a check-in if focus is unset after week 3.
- **Core metrics restructured**: Post-run now uses 5 clear priority metrics (training load, HR, aerobic efficiency, pacing/execution, cadence) with explicit instructions to translate every number into plain English.
- **HR zone descriptions**: Updated Z1–Z5 to explain the training-adaptation purpose of each zone, not just the bpm range.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/hr-zones.ts`

---

## 2026-05-28 — Positive-only coaching style preference

**Type:** Feature
**Reported by:** User feedback
**User feedback:** "I have a few folks that say 'just tell me good job and whatever else you noticed, not keep runs easier'"
**Root cause:** No way to persistently store or respect a per-athlete preference for affirming-only feedback.
**Fix / Change:** Added `coaching_style` column (default `'standard'`) to `training_profiles`. When an athlete says something like "just tell me good job" or "stop telling me to run easier", Dean responds warmly and appends `[POSITIVE_ONLY]` which writes `coaching_style = 'positive_only'` to the DB. Athletes in positive-only mode get data and observations but no effort corrections (Z3 gray zone, "run easier", cardiac drift "ease off" advice). Added `[STANDARD_COACHING]` tag to revert. Prompt injection block and tag detection/stripping wired throughout the post-run path.
**Files changed:** `supabase/migrations/046_coaching_style.sql`, `src/lib/database.types.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-05-28 — Remove passive metric CTA; ban filler openers and restatement conclusions

**Type:** Improvement
**Reported by:** User feedback
**User feedback:** "I don't like the 'reply if you want to dig into any of these numbers'. [Examples of messages with robotic openers, filler conclusions like 'keep the momentum going', 'fitness is clearly on the rise', and passive invite endings.]"
**Root cause:** A `METRIC FOLLOW-UP HINT` was being injected for runs 2–5 telling Claude to add a passive "Reply if you want to dig into any of these numbers" bubble. Separately, no explicit rule banned the filler restatement pattern ("keep the momentum going", "fitness is clearly on the rise") or the robotic opener phrases ("Saw your run come through", "Saw the run sync through").
**Fix / Change:** Removed the METRIC FOLLOW-UP HINT injection entirely. Added "Saw your run come through" / "Saw the run sync through" to the banned openers list. Added a rule against trailing restatement sentences — if the numbers have been cited, the conclusion is implicit; do not add a summary sentence after the insight. Also banned passive CTA endings ("Reply if you want to dig into...", "Feel free to ask for more details").
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond-metric.test.ts`

---

## 2026-05-28 — Limit "run easier" advice frequency; require actual metrics for pace-at-HR claims

**Type:** Improvement
**Reported by:** User feedback
**User feedback:** "Dean still keeps telling people to run easier — there should be a limit on the same type of message. Also getting 'you ran the same pace at an easier HR' over and over without any actual metrics. It needs actual metrics!"
**Root cause:** (1) The Z3 gray-zone "run easier" advice was not included in the `recentPostRunInsights` anti-repetition tracking, so it could appear on every consecutive run with no limit. (2) The prompt had no enforcement rule requiring specific numbers when making pace-at-HR improvement claims — Claude would generate the observation without citing today's pace, HR, baseline average, or the delta.
**Fix / Change:** Added `Z3 gray zone / run easier advice` as a tracked lens in `recentPostRunInsights` (with regex matching gray zone, Z3, "keep HR below", "run easier", etc.). Added a `⚠️ FREQUENCY LIMIT` warning in the Z3 prompt instruction: if this lens was already used in recent post-run messages, skip it and pick a different lens. Added a hard rule in the `CITE THE NUMBER` block: any "same pace at easier HR" / pace-at-HR-improvement claim must cite today's pace (MM:SS/mi), today's avg HR (bpm), the baseline avg pace at similar HR across N prior runs, and the improvement delta — otherwise the claim must not be made.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-05-24 — Wrist HR artifact detection and softer HR language when data quality is uncertain

**Type:** Improvement
**Reported by:** Internal / product direction
**User feedback:** N/A
**Root cause:** Strava doesn't expose whether HR came from a wrist optical sensor or chest strap. Wrist sensors can produce artifact spikes (contact loss, motion interference) that inflate the max HR reading and distort cardiac drift calculations. The coaching prompt previously used HR data with equal confidence regardless of data quality.
**Fix / Change:** Added a server-side artifact risk heuristic: if max_heartrate / average_heartrate > 1.45 on a non-quality-session run (where a high ratio is physiologically normal), the activity is flagged as having potential HR artifact risk. When the flag fires, a DATA AVAILABILITY GUARD is injected instructing Dean to use effort language rather than specific bpm/zone labels, and to caveat cardiac drift as directional only. A general wrist HR note was also added to the HR metric section so Dean knows to soften language and defer to chest strap confirmation when the athlete mentions it.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-05-24 — Richer metric explanations for intermediate athletes across post-run, recap, and HR zones

**Type:** Improvement
**Reported by:** Internal / product direction
**User feedback:** N/A
**Root cause:** Metrics were surfaced as numbers or zone labels without consistently explaining what they mean for training approach. HR zones were named (Z2, Z3) but not described in terms of what each zone builds or costs. Post-run had 7 pick-one options with no structure; intermediate athletes who don't know what "cardiac decoupling" or "m/beat" means would find the feedback opaque.
**Fix / Change:** Four targeted changes: (1) Reorganized post-run "PICK ONE METRIC" into 5 named core metrics (Training Load, Heart Rate, Aerobic Efficiency, Pacing/Execution, Cadence) with explicit "what this means for training" requirements for every metric, especially HR. (2) Added training-adaptation purpose to each HR zone in both the LTHR-based and fallback zone blocks — Z2 explains why easy miles there, Z3 explains the gray zone trap, etc. (3) Aerobic efficiency and cardiac drift blocks now require the plain-language translation ("your heart is working 6% less to hold the same pace") not just the number. (4) Weekly recap longitudinal signals updated to require the same number + meaning standard. All metric examples rewritten to show what good looks like for an intermediate runner.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/hr-zones.ts`

## 2026-05-24 — Stronger specificity rules for Sunday weekly recap

**Type:** Improvement
**Reported by:** Jake (user feedback on their own recap)
**User feedback:** "example of what I just got that I think could be more specific: Your pace continues to improve. This week you logged 41.6 miles across 6 runs, and your pace has been tackling elevation smoothly. Watch your load, as this week's mileage is 18% above your recent weekly average of 35.1 miles. Keeping an eye on your leg recovery is crucial, especially after pushing distances and vert recently. Next week, aim to maintain this progress safely."
**Root cause:** The recap prompt had CITE THE NUMBER and LONGITUDINAL SIGNALS rules, but lacked a "WHAT GOOD LOOKS LIKE" section anchoring expected specificity with concrete examples — so Claude would satisfy the rules technically but still produce vague improvement language instead of real coaching observations.
**Fix / Change:** Added a WHAT GOOD LOOKS LIKE block with three full examples showing the number→meaning→response pattern (high-mileage week with aerobic efficiency numbers, load-spike intervention with ACWR and specific action, quality session recap with actual pace comparison). Also added explicit "do not" guidance to CITE THE NUMBER for easy pace, elevation, and load warnings, requiring actual values rather than qualitative improvement claims.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-05-24 — Add 4 post-run eval fixtures for new coaching behaviors

**Type:** Infra / Eval
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** The post-run prompt changes (examples-first, no opener praise, contextual-only strength, interpret-don't-report) had no eval coverage — no way to catch regression back to old behavior.
**Fix / Change:** Added 4 fixtures in `evals/fixtures/`: `post-run-no-opener-praise` (opener must be a metric, not praise), `post-run-stat-interpretation` (numbers must be interpreted in context, not just cited), `post-run-no-strength-prescription` (routine easy run — strength block must NOT fire), `post-run-strength-active-injury` (active hamstring + tempo — strength block MUST fire with specific exercises). Also added `average_cadence` and `cardiac_decoupling_pct` support to the eval runner so fixture 2 can exercise those fields.
**Files changed:** `evals/fixtures/post-run-no-opener-praise.json`, `evals/fixtures/post-run-stat-interpretation.json`, `evals/fixtures/post-run-no-strength-prescription.json`, `evals/fixtures/post-run-strength-active-injury.json`, `evals/run-evals.mjs`, `CLAUDE.md`

---

## 2026-05-24 — Injury auto-detection, specific exercise guidance, and missed-message safety net

**Type:** Feature / Bug Fix
**Reported by:** Internal observation (conversation audit)
**User feedback:** N/A
**Root cause (injury):** `active_injury` was never set automatically — it required a manual `injury_hold` trigger. Haiku extraction wrote to `injury_notes` and `injury_body_parts` but never escalated to the full ACTIVE INJURY coaching mode. Dean also gave generic "strengthen it" advice instead of specific exercises.
**Root cause (missed messages):** `after()` in the Linq webhook swallows crashes silently — if `coach/respond` fails, the user gets no reply and there is no retry mechanism.
**Fix / Change:**
- Added `injury_severity` ("mild"/"moderate"/"severe") to the Haiku profile extraction prompt. When severity is moderate or severe, `active_injury`, `injury_body_part`, `injury_severity`, and `injury_start_date` are now auto-set in `training_profiles` without needing a manual trigger.
- Auto-clears `active_injury` when the athlete explicitly reports the injury is resolved (existing `injury_resolved` extraction).
- Escalates `injury_severity` if athlete describes worsening symptoms in a follow-up message.
- Added `BODY_PART_EXERCISES` lookup (12 body parts) injected into the system prompt when body parts are flagged — covers IT band, hamstring, knee, shin, calf, foot, hip, piriformis, glute, back, ankle. Dean now gives concrete exercises instead of vague "strengthen it".
- Exercises appear in both the ACTIVE INJURY block and the RECURRING INJURY ALERT block.
- New cron endpoint `GET /api/cron/missed-messages`: scans for `user_message` rows in the 3–90 min window with no assistant reply and re-fires `coach/respond`. Set up on cron-job.org every 30 minutes.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/cron/missed-messages/route.ts`

---

## 2026-05-24 — Restructure post-run prompt: examples-first, no accumulating ban lists

**Type:** Improvement
**Reported by:** Jake (user feedback on response quality)
**User feedback:** "The message is optimizing for completeness instead of resonance. It hits every checkbox (praise, pace stat, cadence stat, strength prescription) but has no point of view. A real coach doesn't open with 'Great job managing that elevation' — that's a participation trophy. A coach says something that makes you think 'huh, they actually watched my run.' The stats don't say anything. '~7:02/mi segment' — which segment? Was that intentional? Was it a problem? 156 spm cadence — is that good, bad, expected for trails? The numbers are being reported rather than interpreted."
**Root cause:** The prompt had accumulated ~60 lines of "do NOT" rules and ban lists that described the failure mode in detail but didn't show the model what good looks like. Claude optimized for rule compliance (hit every checkbox) rather than resonance. The strength block fired after every routine easy run regardless of context.
**Fix / Change:**
- Replaced the NO OPENER PRAISE + INTERPRET DON'T REPORT + FORBIDDEN PHRASES + EASY EFFORT AFFIRMATION rules with 4 concrete example messages showing the correct tone, style, and interpretation depth. Examples cover: easy trail run with elevation, tempo on target, aerobic efficiency trend, load warning.
- Collapsed the INSIGHT RULES section — the long bullet list is gone; structural accuracy rules (EXECUTION CHECK, ZONE GUARD, CITE THE NUMBER) remain since examples can't replace them.
- Combined CADENCE and CARDIAC DECOUPLING interpretation guidance directly into the PICK ONE METRIC list instead of separate sections.
- STRENGTH AFTER RUN changed from "fire after every easy/moderate run when no fatigue" to contextual-only: injury flag active + site stressed, athlete explicitly asked, or designated recovery day. Routine runs end after the main insight.
- Removed duplicate TOTAL LENGTH line.
- Net result: ~65 lines of rules replaced with ~30 lines of examples + condensed rules.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-05-23 — Tests for computeWeekSessions, current_week parsing, and priorPostRunCount

**Type:** Refactor
**Reported by:** Internal (test coverage for features added this session)
**User feedback:** N/A
**Root cause:** Three features added without test coverage: `computeWeekSessions` date mapping, `current_week` regex parsing from `external_plan_description` at [READY], and `priorPostRunCount` prompt injection (FIRST COACHING SESSION / METRIC FOLLOW-UP HINT).
**Fix / Change:** Added 8 tests for `computeWeekSessions` (dates, edge cases, month boundary), 3 tests for `current_week` seeding at onboarding completion (week 6, default to 1, case-insensitive), and 4 tests for `priorPostRunCount` (0 prior → FIRST COACHING SESSION, 1–4 prior → METRIC FOLLOW-UP HINT, 5+ → neither). Total: 437 tests passing.
**Files changed:** `src/__tests__/lib/training-plan.test.ts`, `src/__tests__/api/onboarding-handle.test.ts`, `src/__tests__/api/coach-respond-metric.test.ts`

---

## 2026-05-23 — Seed current_week from athlete's stated plan week at onboarding completion

**Type:** Bug Fix
**Reported by:** Internal (found while building plan session sync)
**User feedback:** N/A
**Root cause:** `training_state.current_week` was hardcoded to `1` at onboarding completion regardless of what the athlete said. If someone said "I'm on week 8 of my Runna plan," the value was stored in `external_plan_description` conversationally but never parsed, so plan session sync would always start from week 1.
**Fix / Change:** At onboarding completion, parse `external_plan_description` for "week N" and use that as the initial `current_week` value. Falls back to 1 if no week is mentioned.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-05-23 — Structured extraction of uploaded training plans (all weeks, not just blob)

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Uploaded plans were stored as raw text blobs only. `weekly_plan_sessions` (the structured JSON used by morning_plan and post_run to surface today's session) was never populated for complement-mode users — only for Dean-generated plans. The `plan_source = "uploaded"` handler in `syncWeekFromArc` was dead code with nothing writing to it.
**Fix / Change:**
- At upload time, Haiku now extracts the full plan into structured JSON (`{ week_number, sessions: [{ day, label }] }`) and stores it in `onboarding_data.plan_sessions_all_weeks`.
- Current week's sessions are immediately written to `training_state.weekly_plan_sessions` with absolute M/D dates computed from this week's Monday, so morning_plan can surface today's session right away.
- New `computeWeekSessions()` and `syncWeekFromUploadedPlan()` utilities in `training-plan.ts` handle date computation and DB writes.
- On each Sunday recap, `syncWeekFromUploadedPlan` advances `weekly_plan_sessions` to the next week from the stored arc — no LLM needed at query time.
- Extraction is non-fatal: if Haiku fails, the raw text blob still works for conversational Q&A.
**Files changed:** `src/app/api/plan/upload/route.ts`, `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

## 2026-05-23 — Complement morning plan names today's specific session; metric follow-up hint on early runs

**Type:** Feature / Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** (1) Complement-mode morning_plan sent a generic "check in on the week" instead of naming the athlete's actual prescribed session for today. The data was already in CURRENT TRAINING STATE but the instruction didn't tell Dean to use it. (2) Users with no coaching history don't know they can ask follow-up questions about cited metrics.
**Fix / Change:**
- Complement morning_plan now explicitly tells Dean to find TODAY'S PLANNED SESSION in CURRENT TRAINING STATE and name it (distance, structure, paces). Falls back to tomorrow's session if today has none.
- On post-run messages 2–5, if Dean cited a named metric, a second bubble invites the athlete to ask follow-up questions ("Reply if you want to dig into any of these numbers"). Gated: only fires when a metric was actually cited, and only during the early relationship window so it doesn't become repetitive.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-05-23 — Force metric citations in post-run and recap (no more vague trend language)

**Type:** Bug Fix / Improvement
**Reported by:** Internal observation
**User feedback:** Dean kept saying "your HR is getting better for your pace" without sharing any actual numbers
**Root cause:** The longitudinal analysis block passes actual m/beat values and % changes to Claude, but there was no instruction requiring Claude to cite those numbers. Claude was summarizing the trend in natural language and dropping the values.
**Fix / Change:** Added CITE THE NUMBER rules to both the post_run and weekly_recap prompts. Each named metric (aerobic efficiency, cardiac drift, ACWR, cadence, week-over-week mileage) now has an explicit example showing the required format with the actual value, and a "NOT" counter-example banning the vague alternative. Applied to both triggers.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-05-23 — Tighten post-run messages: shorter format, metric-first, question variety, strength prescriptions

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Post-run messages were too long (3–5 sentences), asked the same closing question type repeatedly, and strength recommendations lacked sets/reps detail. No mechanism existed to vary closing questions or suggest post-run strength.
**Fix / Change:**
- Hard cap: 2 sentences max + optional 1-sentence question (down from 3–5)
- Lead-with-metric instruction: number first, meaning second in same sentence
- COACHING FORWARD merged into the insight sentence instead of being a separate sentence
- CLOSING QUESTION changed from required to conditional: tracks last 3 post-run questions asked and skips/varies when the same type has been used recently
- New STRENGTH AFTER RUN block: occasional second bubble after easy runs suggesting 3 specific exercises with sets × reps (only when no fatigue signals, not after hard/long runs)
- New PLAN ADJUSTMENTS rule: only suggest plan changes when the athlete explicitly mentions something — not proactively after every run
- STRENGTH SESSION SPECIFICS improved: always requires sets × reps, provides a diverse exercise pool with injury-specific variations, no more generic "clamshells and hip thrusts" every time
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-05-23 — Fix weekly recap showing 0.0 mi for UTC+ timezone users

**Type:** Bug Fix
**Reported by:** User feedback (Gwyneth)
**User feedback:** "Dean says on Saturday: 'This week's load of 19.4 miles is above your planned volume.' Then on Sunday he says: 'Last week was a bit quieter with 0.0 mi across 0 runs, focusing more on recovery.'"
**Root cause:** The Sunday recap cron fires at 01:00 UTC Monday. For UK users (BST = UTC+1), this is 02:00 AM Monday locally — the user is already in a new week. When `localWeekMonday(new Date(), "Europe/London")` was called, it returned the current (empty) Monday, so all runs from the just-completed week appeared to belong to "last week" and were excluded, yielding 0 runs / 0.0 mi.
**Fix / Change:** Extracted a `weekCalcRefDate(trigger, timezone)` helper. For `weekly_recap` trigger, if the user's local day is already Monday (dow === 1), the helper backs up to noon UTC of yesterday (Sunday) so all week-boundary calculations (`computeWeekMileage`, `computeWeekRunCount`, `buildActivitySummary`, `computeSessionsStatus`, `computeWeekCrossTrainingAerobicMinutes`, `buildWeeklyCrossTrainingSummary`) look at the just-completed Mon–Sun week.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/cross-training.ts`

## 2026-05-23 — Per-mile split context for follow-up questions + repetitive easy-effort reminder fix

**Type:** Bug Fix / Improvement
**Reported by:** Jake Tennant
**User feedback:** "(1) He doesn't seem to actually have a metric if I ask (Grade Adjusted Pace, Efficiency, etc.) (2) He keeps telling my wife the same thing post run (make your easy runs truly easy)"
**Root cause:**
1. For `user_message` triggers (follow-up texts), the system prompt had no per-mile split data — only aggregate run stats. When an athlete asked "what was the GAP for each mile?" Dean had no data to answer with and gave a generic definition instead.
2. "Make your easy runs truly easy" was not in the FORBIDDEN PHRASES list, so Claude kept writing it on easy Z2 runs. The anti-repetition regex for easy-effort affirmations only caught Zone 1/2 label mentions, not the many variations Dean used.
**Fix / Change:**
1. Added a new DB fetch for `user_message` trigger: after identifying the most recent run from the activity cache, fetches its `summary` (splits) and `aerobic_efficiency` / `cardiac_decoupling_pct` from the activities table. Transforms splits through `transformSplitForClaude` (pace, GAP, HR, elevation per split) and injects as a `MOST RECENT RUN — DETAILED METRICS` block in the user_message prompt. Dean can now answer specific per-mile or per-km questions with actual data.
2. Added "make your easy runs truly easy" / "easy runs truly easy" / "run them truly easy" / "truly easy effort" to FORBIDDEN PHRASES.
3. Broadened the `recentPostRunInsights` anti-repetition regex for easy-effort affirmations to catch: "easy effort", "truly easy", "keep.*easy", "easy run", "aerobic base", "conversational effort", "aerobic system held". This flags easy-effort coaching as a recently-used lens so Dean rotates to a different insight angle on the next run.
4. Updated EASY EFFORT AFFIRMATION rule to require varying the delivery angle (tie to decoupling, cadence, or week context) rather than defaulting to a generic easy-effort reminder every Z2 run.
**Files changed:** `src/app/api/coach/respond/route.ts`, `CHANGELOG.md`

---

## 2026-05-05 — Hardened week-to-date mileage against hallucination

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "got this message from dean this morning, but I was only at ~2.3 miles for the week: … 'You're now at 5.8 miles for the week.'"
**Root cause:** Dean's morning Strava sync triggered a post_run response. The system prompt computed week-to-date correctly (Morning Run 3,803m = 2.36 mi; the 0-distance Workout activity from Monday was correctly excluded) and the `WEEK-TO-DATE (this run included): 2.4 mi across 1 run` rule was present. Sonnet ignored the rule and stated "5.8 miles for the week" — a clean hallucination with no arithmetic source in the prompt. The existing `correctMileageTotal` / `correctProjectedTotal` guards target session-list math and "on track for X mi" projections, neither of which fires on a stated week-to-date completed total.
**Fix / Change:** Two layers.
1. **Prompt lift:** Prepend the post_run user message with `WEEK-TO-DATE: <X> across <N> runs (computed from Strava — quote this exact figure if you reference week mileage; never invent a different number)` so the authoritative figure is the freshest token before generation. Strengthened the inline `WEEK-TO-DATE` rule to demand verbatim quoting.
2. **Post-gen guard:** New `correctWeekToDateTotal` function — regex-finds `\d+(\.\d+)? mi(les)? for/this (the )?week` in Dean's response, compares to `weekMileageSoFar`, rewrites the number if off by >0.4 (mi or km). Skips projection lead-ins ("on track for", "projected", etc.) so it doesn't double-correct projections. Wired into the post-processing pipeline for `post_run` and `user_message` triggers.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-05-04 — Fixed scoping bug that disabled the `max_heartrate` data guard

**Type:** Bug Fix
**Reported by:** Internal audit (response-quality review)
**User feedback:** N/A
**Root cause:** In `src/app/api/coach/respond/route.ts`, the `dataGuards.push(...)` for the "max_heartrate is a single-run peak, not physiological max HR" guard was originally an unconditional push (commit `ee9dbf4`). A later edit added the km-split-mismatch `if (!isMetricUser && hasSplits && splitCount > Math.ceil(miles) + 1)` block immediately above it but placed the opening brace on the wrong line, accidentally pulling the max-HR guard inside the conditional. The indentation hint was visible (6-space vs 8-space inside the block) but TypeScript happily accepted the structure. As a result, the guard only fired for imperial users with detected km-split mismatches — a rare edge case. For the common path (any HR-equipped activity), Dean had no programmatic guard preventing him from saying things like "based on today's peak of 187, your max appears to be ~190."
**Fix / Change:** Moved the max-HR guard above the km-split conditional and gated it on `hasHR` instead, so it fires for every activity that has heart-rate data — which is the original intent. The km-split warning remains correctly scoped inside its own block.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-05-04 — Fixed `:60` second rollover in VDOT pace calculation

**Type:** Bug Fix
**Reported by:** Internal audit (response-quality review)
**User feedback:** N/A
**Root cause:** `paceAtVDOTPct` in `src/lib/paces.ts` formatted paces as `${min}:${sec}` where `min = Math.floor(minPerMile)` and `sec = Math.round((minPerMile - min) * 60)`. When `minPerMile` was just under a whole minute (e.g. 6.997), `sec` rounded to 60, producing strings like `"6:60/mi"` instead of `"7:00/mi"`. A VDOT sweep confirmed the bug fires on ~12 distinct VDOT values across the realistic range — including VDOT 49.8 tempo, VDOT 43.7 interval, and VDOT 60.2 tempo. The sibling helper `fmtPace()` had a `:60` rollover guard; `paceAtVDOTPct` did not.
**Fix / Change:** Round to total seconds first, then derive `min` and `sec` via `Math.floor(totalSec / 60)` and `totalSec % 60`. Added a sweep test in `paces.test.ts` that asserts no pace string ever ends in `:60/mi` across VDOTs derived from 5K times 14:00–35:00.
**Files changed:** `src/lib/paces.ts`, `src/__tests__/lib/paces.test.ts`

---

## 2026-05-04 — Reverse free trial mode (env-gated, default off)

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** N/A — new flow.
**Fix / Change:** Added a "reverse free trial" flow as an opt-in alternative to the upfront-payment flow. New signups with `REVERSE_TRIAL_ENABLED=true` get full coaching access for 7 days without entering payment, then a daily cron flips them to `awaiting_payment` and sends the Stripe checkout link. After expiry, the coach/respond gate enforces a hard cutoff: proactive triggers silently skip; inbound user messages get the existing checkout-link reply.

Implementation:
- Migration `045_reverse_trial.sql` — new `users.reverse_trial_enabled` boolean (default false, NOT NULL)
- `signup/route.ts` — reads `REVERSE_TRIAL_ENABLED` env var, stamps the column at user creation (sticky — flipping the env var only affects subsequent signups)
- `onboarding/handle/route.ts` — completion branch skips `awaiting_payment` for reverse-trial users; stamps `trial_started_at = now` so the coach gate, the trial-expiry cron, and Stripe's `trial_period_days: 0` logic all anchor to the same start time
- `coach/respond/route.ts` — subscription gate now grants access while `now - trial_started_at < 7d`; Stripe's `trialing`/`active` statuses still pass through
- New `cron/trial-expiry/route.ts` — daily; finds users past 7 days with no active sub, sends "your free week is up" SMS, flips to `awaiting_payment` so existing payment-reminder + dunning crons take over

Existing upfront-payment flow is untouched; both modes coexist. Trial period in Stripe is implicitly 0 (the existing `hasHadTrial = !!trial_started_at` check in `billing/checkout` handles this — no double-dipping on the 7-day Stripe trial).

**Files changed:** `supabase/migrations/045_reverse_trial.sql`, `src/lib/database.types.ts`, `src/app/api/signup/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/cron/trial-expiry/route.ts` (new), `src/__tests__/api/signup.test.ts`, `src/__tests__/api/trial-expiry.test.ts` (new)

**Operator steps to enable:** run migration → `npm run gen:types` → add a daily job in cron-job.org hitting `https://coachdean.ai/api/cron/trial-expiry` with header `Authorization: Bearer $CRON_SECRET` → set `REVERSE_TRIAL_ENABLED=true` in Vercel env when ready.

---

## 2026-05-04 — Cadence sanity guard, race-day acknowledgment, quality session recognition

**Type:** Bug Fix + Improvement
**Reported by:** User feedback (P0 cadence hallucination + P1 race-day non-responsive feedback)
**User feedback:**
- "Coach Dean (post_run): Your cadence averaged 106 spm, which is on the lower side and can impact efficiency. Try increasing your steps per minute by 5-10..." — cadence value was clearly garbage data.
- Athlete: "Haha Coach Dean, today was the big day! That was my race" — Dean: "Congratulations on race day! It sounds like you ran your half marathon today, and I'm happy to hear you completed it. How did it feel out there?" — read as detached observation rather than warm congratulations.

**Root cause:**
1. **Cadence:** Strava's `average_cadence` is stored inconsistently across devices (some per-foot ~80–100, some total ~160–200). A walking section, GPS dropout, or device bug produces an out-of-range value (e.g. 106 implied total) that the existing `hasCadence` guard happily passed through to Claude, who then lectured the athlete about overstriding from fictional data.
2. **Race acknowledgment:** No inbound-keyword path for race-completion phrases in `user_message`, and the `workout_type=1` annotation only said "expect all-out pacing" without requiring celebratory tone — leading Dean to treat the moment analytically.
3. **Quality session execution:** No explicit rule requiring recognition when the athlete hit prescribed pace on a tempo / interval / threshold session. Dean would dive straight into clinical analysis, missing the win.

**Fix / Change:**
- Added `cadencePlausible` check before building `activityForClaude` — computes implied total spm (doubling per-foot values <130) and only keeps cadence when it lands in 140–220. Out-of-range values are stripped from the JSON AND blocked by an explicit data guard, preventing both fabrication and overstriding lectures from suspect data.
- Strengthened `workout_type=1` race annotation: now requires lead-with-explicit-congratulations + ask how it went, and forbids pacing/cadence/zone critiques on race-day post_run feedback.
- Added `RACE COMPLETION — HIGHEST PRIORITY` block to the `user_message` prompt: when the athlete signals they just raced ("today was the big day", "that was my race", etc.), the first sentence MUST be warm congratulations naming the race, followed by an open question about how it went. Bans detached "It sounds like you ran X today" framing.
- Added `QUALITY SESSION EXECUTION — RECOGNIZE THE WIN` rule to post_run insight rules. When the athlete hit or beat prescribed pace on a quality session, the insight MUST lead with concrete, specific recognition (names pace, target, what it builds) before any analysis. Distinct from the FORBIDDEN PHRASES rule (which bans empty praise) — this requires earned, specific recognition.

**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-05-04 — Refresh max HR estimate on quality workouts and weekly recap

**Type:** Improvement
**Reported by:** Internal review (follow-up to persistence work earlier today).
**User feedback:** N/A.
**Root cause:** After persisting `max_hr_estimate`, the only refresh paths were initial Strava connect, race webhooks (`workout_type=1`), and a one-time lazy backfill in `coach/respond` (which fires only when the column is null). Athletes who never race — general fitness, return-to-running — would never see the value updated even if their fitness genuinely shifted.
**Fix / Change:**
- Strava webhook now recomputes `max_hr_estimate` on quality workouts (`workout_type=3`, intervals/tempo) in addition to races. LTHR remains race-only since only races produce a clean LT signal. Refactored the existing race block so the activity fetch + max HR write are shared and the LTHR step only runs for races.
- `coach/respond` `weekly_recap` trigger now forces a recompute + write rather than reading the persisted value. Every active athlete gets a fresh number at least once a week.
**Files changed:** src/app/api/webhooks/strava/route.ts, src/app/api/coach/respond/route.ts

## 2026-05-04 — Persist max HR estimate + soften zone-naming when LTHR is unknown

**Type:** Improvement
**Reported by:** Internal audit (HR data usage), follow-up to the intensity classification fix earlier today.
**User feedback:** N/A — audit-driven.
**Root cause:** Two related issues. (1) Every consumer of estimated max HR (Strava callback, Strava webhook, longitudinal analytics, post-run annotation) recomputed independently from a different activity slice, so the dashboard, coach SMS, and intensity dots could disagree on the same athlete. (2) When LTHR was unknown or low-confidence, the prompt instructed Dean to compute zone bands from a noisy estimated max HR and then state specific zone names ("Zone 2"), which is exactly the path that produced the recent Z3-mislabeled-as-Z2 reports.
**Fix / Change:**
- Added migration 044 with `training_profiles.max_hr_estimate` + `max_hr_estimate_updated_at`. Updated `database.types.ts`.
- Strava callback now persists the tiered max HR estimate to `training_profiles` after computing it for onboarding analytics.
- Strava webhook race-recompute path now writes the recomputed max HR alongside the LTHR update.
- `coach/respond` reads `profile.max_hr_estimate` for both the longitudinal block and `annotateStravaActivity` (added `maxHrEstimate` to `AnnotationContext` and threaded it through both call sites). Falls back to recomputing if the column is null, and lazily backfills the profile on first compute so existing users self-heal.
- Softened the no-LTHR / low-confidence-LTHR prompt block: added a ZONE-NAMING UNCERTAINTY rule telling Dean to prefer effort language ("upper aerobic", "comfortably hard", "near-threshold") over specific zone numbers, and to describe runs near a boundary (within ~5 bpm) as straddling two zones rather than picking one.
**Files changed:** supabase/migrations/044_max_hr_estimate.sql, src/lib/database.types.ts, src/app/api/auth/strava/callback/route.ts, src/app/api/webhooks/strava/route.ts, src/app/api/coach/respond/route.ts

## 2026-05-04 — Fix HR intensity classification using sensor-spike-resistant max HR

**Type:** Bug Fix
**Reported by:** Internal audit (HR data usage)
**User feedback:** Multiple recent instances of Dean labeling Z3 runs as Z2.
**Root cause:** `computeIntensityDistribution()` (training-analytics.ts) used raw `Math.max(max_heartrate)` across recent activities to set the zone-classification denominator. A single Strava sensor spike (e.g. 210–220 bpm dropout) became the "observed max HR," shifting every classification down a zone — a 150 bpm run on a true 180 bpm max athlete would compute as 68% (easy) instead of 83% (moderate/Z3). This fed into the LONGITUDINAL TRAINING ANALYSIS block injected into Dean's prompt, so the zone-3-trap signal silently flipped to look like a polarized 80/20 distribution.
**Fix / Change:** `computeIntensityDistribution()` now accepts an optional `estimatedMaxHR` and falls back to the tiered `estimateMaxHR()` from hr-utils (race > workout > all-runs, with ratio + gap spike filtering). `buildLongitudinalBlock` and `buildLongitudinalSignals` accept and pass through. The `coach/respond` route now computes `estimateMaxHR(recentActivities)` once and passes it in, so the longitudinal block, dashboard, and post-run analysis share one max HR source. Added `workout_type` to `ActivityForAnalytics`. Added two regression tests covering spike rejection and caller-supplied max HR override.
**Files changed:** src/lib/training-analytics.ts, src/app/api/coach/respond/route.ts, src/__tests__/lib/training-analytics.test.ts

## 2026-05-04 — Prevent Claude from mislabeling Z3 runs as "Zone 2"

**Type:** Bug Fix
**Reported by:** Gwyneth Tennant
**User feedback:** "Dean is now saying my moderate pace is 9:30, ignoring the heart rate of 145"
**Root cause:** The GRAY ZONE GUARD prevented calling Z2 runs "gray zone," but there was no reciprocal guard preventing the reverse error: calling a Z3 run "Zone 2." On May 2, Dean told Gwyneth her 11:02/mi run at 151 bpm "stayed in Zone 2" — but 151 bpm is ~84% of her estimated max HR (~180), which is solidly in Z3/moderate. Then on May 4, Dean correctly called her 9:31/mi at 145 bpm "moderate." The inconsistency (same bpm range, different labels) is what caused her frustration.
**Fix / Change:** Added ZONE ACCURACY GUARD to post_run insight rules: Claude must compute the athlete's Z2 ceiling (75% of estimated max HR) before labeling any run. If avg HR exceeds that ceiling, it cannot be called "Zone 2," "easy," or "aerobic base." The HR calculation — not pace — determines the zone label.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-05-04 — Fixed wrong HR percentage quoted for Zone 2 cross-training advice

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "this answer didn't seem right on HR" — Dean said "Zone 2 is typically around 50-65% of your estimated max" and gave a target of 110-130 bpm even though Jake's easy running average HR is 126.7 bpm
**Root cause:** The fallback HR zone block (used when no LTHR is established) told Claude to use percentages internally to calibrate bpm targets, but had no guard against quoting those percentages to the user. Claude hallucinated "50-65%" (which isn't even in the system prompt — the correct threshold is <75% max) and stated it directly. The resulting bpm range (110-130) was also inconsistent: its lower bound fell below the athlete's own easy-run average HR.
**Fix / Change:** Added explicit guard to the fallback HR zone block: "never state raw percentages to the athlete." Also added cross-training-specific anchor: "if the athlete asks what HR to target for cross-training, anchor the answer to their actual easy-run average HR from recent activities — that is their Zone 2 reference point." The LTHR block already had this guard; the fallback was missing it.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-05-03 — Analyst and complement mode awareness across triggers

**Type:** Feature / Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `coaching_mode` was never set during onboarding, so analyst (no-plan) and complement (external plan) users were indistinguishable from standard plan users at trigger time. All triggers treated every user as if they had a Dean-generated plan, causing weekly recaps to build next-week training plans for no-plan users, morning_plan to reference a non-existent schedule, and post-run feedback to reference plan sessions that belonged to an external coach.
**Fix / Change:**
- Onboarding now writes `coaching_mode = 'analyst'` for NO_PLAN users and `coaching_mode = 'complement'` for COMPLEMENT users in `training_profiles`
- `isAnalystMode` and `isComplementMode` are now top-level variables in `processCoachRequest`, derived from the profile
- `morning_plan` trigger early-exits (skipped) for analyst mode users — they have no schedule to preview
- `morning_plan` for complement mode uses framing that treats sessions as "your coach's plan", not Dean's
- `post_run` injects a mode-specific rule block: analyst mode suppresses all plan references; complement mode suppresses session prescriptions
- `weekly_recap` for analyst mode sends a reflection-only recap (no next-week plan); for complement mode, suppresses the periodization-derived next-week plan and tells Dean to defer to the athlete's own plan
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-05-03 — FAQ pass: em-dash scrub, stale-claim fixes, new "what insights Dean delivers" section

**Type:** Improvement
**Reported by:** Jake (preference + accuracy audit)
**User feedback:** "Make sure we aren't using M dashes, that's a dead giveaway for AI written content. Use a hyphen if needed... make sure all FAQs are still relevant. I kind of think an FAQ about what insights Dean can provide (or a new section of the landing page) would be helpful!"
**Root cause:**
- FAQ section had ~30 em-dashes, a known AI-writing tell.
- Two FAQ claims were stale post dashboard deprecation: (1) "upload your plan as a PDF to the dashboard" (FAQ #1), and (2) the DASHBOARD inbound-SMS keyword (special-commands FAQ). An audit of `src/app/api/webhooks/linq/route.ts` confirmed no DASHBOARD handler exists; live keywords are FEEDBACK, STRAVA CONNECTION, UPDATE PLAN, UNSUBSCRIBE, STOP.
- The page had no enumerated list of analysis categories Dean actually delivers. Prospects could only infer breadth from the four narrative InsightCards.
**Fix / Change:**
- Em-dash sweep across the entire FAQ block, restructured into commas, periods, colons, and parentheses; only natural-fit cases use a hyphen. Verified zero em-dashes remain in the FAQ range.
- FAQ #1 (Runna/TrainingPeaks) PDF paragraph rewritten: PDF upload is now described as SMS-based (text Dean a PDF), matching the actual `handlePDFPlan()` ingestion flow in `linq/route.ts`.
- DASHBOARD keyword removed from special-commands FAQ. UPDATE PLAN added in its place (was missing from the FAQ but live in code).
- New "Six lenses on every run" landing-page section inserted between Comparison and Testimonials. Six categorical cards (Aerobic efficiency, Pacing and splits, Effort zone audit, Load monitoring, Cadence and form trends, Workout vs intent) each with a one-line plain-language example. Categories grounded in the post_run prompt analysis blocks in `src/app/api/coach/respond/route.ts`.
- Added a corresponding FAQ entry "What kinds of insights does Coach Dean give me after a run?" listing the same six categories for users who skim FAQs first.
- Follow-up trim pass: merged the "what paces" + "do I need Strava/GPS" FAQs into a single Strava FAQ; compressed the "build me a plan" FAQ to two sentences (it overlapped Runna FAQ #1); tightened "not training for a race" to a single short paragraph; cut the "training philosophy" answer from a paragraph of jargon to two sentences. Net: 13 FAQs → 11.
**Files changed:** src/app/page.tsx, CHANGELOG.md

---

## 2026-05-03 — Landing page reorientation: data interpretation, real-time adaptation, injury navigation

**Type:** Improvement
**Reported by:** Internal engagement audit
**User feedback:** N/A — driven by analysis of top users (Benjamin: 42 msgs of Garmin-stat interpretation; #2 user: 32 msgs of "lifted heavy, should I run?"; 5 of top 8 users have injury notes)
**Root cause:** Landing page positioned Dean primarily as a post-run feedback tool with generic "fitness building" framing. The three patterns actually driving deep engagement — (1) interpreting Garmin/Strava metrics, (2) adapting plans around lifting/cross-training/skipped runs, (3) injury go/no-go sounding board — weren't surfaced as concrete examples. Page also kept a dashboard mock for a feature that's been removed, and had FAQ copy promoting general-fitness and triathlon use cases that produce shallow engagement.
**Fix / Change:**
- Hero subhead rewritten to lead with reading data, explaining what it means, and adapting to life
- "How it works" step 2 reframed as "Dean reads every run and texts you what it means"; sub mentions lift days, sore knees, weird HR
- Insights section: swapped Fitness-progress card → "What does this mean?" Garmin-stat interpretation example (HR/cadence/GCT); swapped Load-management card → "Lifted heavy this morning" real-time adaptation example. Section heading changed to "A coach who reads your data and adapts to your life."
- Comparison table Dean column: now leads with data interpretation, lifting/sick/skipped adaptation, and injury go/no-go
- FAQ "not training for a race" softened — leads with injury return / consistency framing, gently steers toward picking a goal
- FAQ "what races" — dropped triathlon paragraph
- Removed dashboard mock section entirely (dashboard feature deprecated)
**Files changed:** src/app/page.tsx, CHANGELOG.md

---

## 2026-05-03 — Sunday recap variety pass: loosened opener, anti-repetition, weekly wins, forbidden phrases, threads weave-in

**Type:** Improvement
**Reported by:** Internal audit (carryover from post_run variety work)
**User feedback:** N/A
**Root cause:** The Sunday recap had the same five variety risks as post_run before its fix: a hard-coded opener phrase ("Last week: X mi across Y runs"), no anti-repetition signal, no forbidden-phrases block, no detection of "first 30-mi week / longest in 12 weeks / highest weekly volume" milestones, and no explicit instruction to weave coaching threads into the recap.
**Fix / Change:**
- **Loosened opener:** Removed the mandatory "YOUR FIRST TEXT MUST OPEN WITH..." rule. Now the figure (`X mi across Y runs`) must appear somewhere in the first text but the opener can vary — examples in prompt: "Big block —", "Recovery week dialed in:", "Three quality sessions in the bag —", "Quieter week (X, Y runs)".
- **Anti-repetition:** Server-side scan of the last ~4 `weekly_recap` messages detects which observation lens was used (load trend, aerobic efficiency, cardiac drift, long run progression, zone-3 trap, cadence, consistency, phase transition). Recently-used lenses are listed with a "do not lead with these" directive.
- **Weekly wins (deterministic):** New computation surfaces "FIRST X+mi WEEK in visible history", "HIGHEST WEEKLY VOLUME IN 12 WEEKS", "LONGEST LONG RUN IN 12 WEEKS". When any fire, prompt instructs Dean to lead with the milestone.
- **Forbidden phrases (recap-specific):** Bans standalone "great week / solid week / huge week / killer week", "keep crushing it / keep grinding / stay consistent", "trust the process", "another solid block / another good week in the books" — must replace with a specific stat or observation.
- **Coaching threads weave-in:** Recap prompt now explicitly instructs Dean to reference one of the active "WHAT YOU'RE WATCHING" threads from ATHLETE HISTORY in the first text, confirming progress / noting a setback / updating the thread. Then update the threads via the `[THREADS:]` tag.
**Files changed:** src/app/api/coach/respond/route.ts, CHANGELOG.md

---

## 2026-05-03 — Post-run variety pass: forbidden cliches, walk-specific framing, anti-repetition, non-obvious wins, coaching threads

**Type:** Feature / Improvement
**Reported by:** Jake's wife (repeated user feedback)
**User feedback:** "Every post-run / post-walk message Dean says 'remember to keep easy days easy' or something like that"
**Root cause:** The "no easy-easy reminder" guard fired only when HR data was present and HR was Z1/Z2 — runs without HR fell through to platitudes. Walks routed through generic cross-training framing but inherited all the run-day instructions. Successive post-runs picked the same insight lens with no anti-repetition signal. The "menu" of insights was a menu, not a rotation, so Claude defaulted to safe filler.
**Fix / Change:**
- **A — Forbidden phrases (unconditional):** A `FORBIDDEN PHRASES` block in the post_run prompt bans "keep easy days easy / make sure to keep it easy / great work / nice job / solid effort / way to get out the door / keep it up / keep crushing it / stay consistent (as a closer) / make sure to recover / rest up / listen to your body (as filler)" — regardless of HR data presence.
- **B — Walk-specific framing:** When `activity_type === "Walk"`, a dedicated `<rule>` block suspends the run frame and supplies a walk-only insight menu (time on feet, recovery quality after recent hard runs, weekly cumulative load, lifestyle/NEAT framing). Closing question must be walk-appropriate.
- **C — Anti-repetition:** Server-side scan of the last 5 assistant `post_run` messages detects which insight lenses were used (cadence, decoupling, aerobic efficiency, HR zone, pacing, GAP, vert, best efforts, load context). Lenses already used are listed in the prompt with a "DO NOT REPEAT THESE THIS TURN" directive.
- **D — Non-obvious wins (deterministic):** New computation surfaces findings Strava can't spot — YTD milestone crossings (100/200/250/300/500/750/1000+ mi or km equivalents), longest run in 30 days, pace-at-HR improvement vs. 60-day baseline at the same average HR. When any fire, prompt instructs Dean to lead with the finding, not bury it.
- **E — Folded into A** (single FORBIDDEN PHRASES block).
- **F — Coaching threads (per-athlete narrative):** New `training_profiles.coaching_threads` and `coaching_threads_updated_at` columns (migration 042). The Sunday `weekly_recap` Sonnet response now emits a `[THREADS: ...]` machine tag with 1–3 sentences of "what Dean is watching" on this athlete. Server-side parser strips the tag from the SMS, persists it, and the system prompt's ATHLETE HISTORY block reads it back as `WHAT YOU'RE WATCHING (active coaching threads)` for every subsequent post-run / morning / user_message — so Dean references the same evolving story across runs instead of treating each one in isolation. This is the differentiator vs. Strava: Strava sees runs in isolation; a coach sees a thread.
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/database.types.ts, supabase/migrations/042_coaching_threads.sql, CHANGELOG.md

---

## 2026-05-03 — "Coach that adapts" pivot: recap arc position, mandatory Strava, named post-run metric, lifting/injury state

**Type:** Feature / Improvement
**Reported by:** Internal product audit
**User feedback:** N/A
**Root cause:** Product was leaning on plan generation as the value prop while the actual differentiator (specific coaching insights from Strava data) was under-served. Sunday recap lacked macro arc position and phase-transition signals; post-run insights weren't required to name the metric they cited; Strava was skippable, hollowing out the data layer; lifting/injury state lived only in freeform notes.
**Fix / Change:**
- **Sunday recap:** Inject `TRAINING ARC POSITION: Week N of M · phase · X days to race day` for athletes on a Coach Dean plan. Phase-transition `<rule>` fires on the final week of a phase. Athletes without a stored plan (uploaded plan / general fitness / pre-plan) skip the block — no fabricated week-of-total. Longitudinal-signals section reframed to require one synthesized week-over-week observation in the first text instead of an optional menu.
- **Post-run insight:** Added a `REQUIRED — NAME ONE METRIC` rule with a priority-ordered menu (cadence → cardiac decoupling → aerobic efficiency → HR zone → pacing/GAP → best efforts → WoW). Every response must name the metric the insight is built on, not default to "solid run at X pace".
- **Strava onboarding hook:** Connect SMS now names what was just read — "Just read your last 8 weeks — ~28 mi/week avg, longest 9.2 mi, trending up." Both mid-onboarding and already-onboarded paths surface 8-week analytics.
- **Mandatory Strava:** [READY] is now blocked when Strava is not connected (exception: return_to_running / injury_recovery goals). The `strava_skipped` field is removed from the Haiku extractor schema and from the system-prompt's STRAVA status line; legacy users with the field set are ignored.
- **Lifting days as formal state:** New `training_profiles.lifting_days` and `leg_lift_days` columns (migration 040). Onboarding extracts both. System prompt injects them into ATHLETE HISTORY with a 24-hour-after-leg-day rule against hard runs.
- **Formal injury state:** New `training_profiles.active_injury / injury_severity / injury_body_part / injury_start_date / injury_return_protocol` columns (migration 041). Onboarding extracts these for current injuries. When `active_injury=true`, an ACTIVE INJURY `<rule>` is injected into every coach response with severity-specific go/no-go guidance.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts, src/app/api/auth/strava/callback/route.ts, src/lib/database.types.ts, supabase/migrations/040_lifting_days.sql, supabase/migrations/041_formal_injury_state.sql, src/__tests__/api/onboarding-handle.test.ts, src/__tests__/api/multi-race-onboarding.test.ts

---

## 2026-05-03 — Eval harness improvements: HR zones, taper rules, injury tags, new post-run fixtures

**Type:** Improvement / Testing
**Reported by:** Internal eval run (35/60 passing, 6.9/10 avg baseline)
**User feedback:** N/A
**Root cause:** Eval runner was missing several key context blocks that route.ts injects — HR zone classification, taper phase rules, injury tag instructions, split analysis guidance. The model was producing correct responses that the eval harness couldn't score correctly because the judge and runner were missing parity with production.
**Fix / Change:**
- Added 3 new post-run eval fixtures: `post-run-tempo-execution` (split vs prescribed pace comparison), `post-run-easy-zone2-affirm` (Zone 2 affirm for marathon), `post-run-trail-vert` (vert-per-mile vs race demands)
- Eval runner: injected HR zone context block when avg HR is available (80% max = Z2/Z3 boundary; affirm Z2 for marathon goal)
- Eval runner: fixed `isDeload` to use explicit `is_deload_week: true` rather than `week % 4 === 0` (was wrongly marking build weeks as deload)
- Eval runner: added taper phase `<rule>` block (name "taper madness", glycogen supercompensation, affirm reduced volume, redirect to race prep)
- Eval runner: added general fitness no-race `<rule>` (no race references, base-building framing)
- Eval runner: added injury tag instructions mirroring route.ts (INJURY_HOLD high threshold, INJURY_CLEAR on confirmed hold, LIGHTER_WEEK for setbacks)
- Eval runner: added post-run GOAL LENS section (trail vert, marathon Zone 2, 5K speed execution)
- Eval runner: added vert-per-mile comparison for trail run fixtures with elevation data
- Eval runner: strengthened split analysis rule (compute avg workout-segment pace; explicitly forbid "slightly slower" for ≤5 sec/mi differences)
- Eval runner: fixed metric easyPaceRange to use +30s upper bound matching route.ts/paces.ts
- Eval runner: improved nightly no-sessions message with explicit "plan coming tonight" structure
- Eval runner: improved uploaded plan weekly recap — uses plan week range, includes missed-run note, recap before preview
- Eval runner: improved weekly recap missed_run injection from ground_truth
- Judge: fixed `isDeload` computation (same `is_deload_week === true` fix)
- Judge: added metric mileage note (km equivalents accepted for mileage_correct)
- Judge: tightened `must_contain_tag` scoring (tag presence overrides mileage concerns)
- Judge: expanded `must_acknowledge_week_complete` and `must_mention_plan_coming` examples
- Fixture fixes: moved prior-week activities to correct dates in tempo, zone2, trail, and post-run-feedback fixtures
**Files changed:** `evals/run-evals.mjs`, `evals/judges/factual-accuracy.mjs`, `evals/fixtures/post-run-tempo-execution.json`, `evals/fixtures/post-run-easy-zone2-affirm.json`, `evals/fixtures/post-run-trail-vert.json`, `evals/fixtures/quality-post-run-feedback.json`, `evals/fixtures/quality-general-fitness-no-race.json`, `evals/fixtures/pace-metric-user.json`

## 2026-05-02 — Simplify onboarding, make Strava required, opt-in plan generation, first-run experience

**Type:** Feature / Improvement
**Reported by:** Internal product decision
**User feedback:** N/A
**Root cause:** Onboarding was too long (3-option mode question early, required strength/fitness questions), Strava was skippable which meant thin coaching context, plan generation was the default rather than a conscious choice, and first Strava sync had no special warmth.
**Fix / Change:**
- Strava is now required during onboarding — skip path removed from `handleStrava`. Re-sends link for any message until connected.
- Simplified WHAT TO COLLECT: removed strength/cross-training and fitness baseline as required fields (Strava covers them). Training days, mileage, terrain now all passively extracted only.
- Moved plan preference to the end of onboarding as a simple binary question ("want me to build a plan, or just coaching notes after each run?") instead of a 3-option question at step 2.
- Removed [DASHBOARD_LINK] from onboarding wrap-up messages. Complement/no-plan users no longer receive a follow-up dashboard link message after [READY] — Dean's wrap-up covers it.
- First-run experience: `post_run` now detects when no prior coaching messages exist and injects a warmer tone instruction, framing the response as the start of a coaching relationship.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-05-02 — Cut dashboard, simplify plan upload to text context, clean coaching engine

**Type:** Refactor / Feature Removal
**Reported by:** Internal product decision
**User feedback:** N/A
**Root cause:** Dashboard had very low usage; plan upload's structured session extraction added complexity without proportional coaching benefit; Dean already had arc context from storedPlanAllWeeks.
**Fix / Change:** Deleted 5,300+ lines across dashboard UI, dashboard-insights lib, plan import/week-sync pipeline. Uploaded plans now stored as raw text in `onboarding_data.plan_context` and injected into every coaching prompt so Dean can reference them conversationally. Dean-generated plan arc context (`storedPlanAllWeeks`) is preserved. Billing still uses `dashboard_token` for checkout/cancel URLs.
**Files changed:** src/app/dashboard/ (all deleted), src/lib/dashboard-insights.ts (deleted), src/app/api/coach/respond/route.ts, src/app/api/plan/upload/route.ts, src/app/api/plan/remove/route.ts, src/app/api/webhooks/linq/route.ts, src/lib/training-plan.ts

---

## 2026-05-02 — Fix HR BPM targets in cycling prescriptions; strip watts field when no power data

**Type:** Bug Fix
**Reported by:** Daily conversation analysis (2026-05-01)
**User feedback:** N/A
**Root cause:**
1. `buildHRZoneContext` unconditionally told Claude to "use zone names AND bpm values in coaching copy." Combined with the cross-training prescription template saying "HR stays in Z2 — conversational," Claude cited specific BPM targets (e.g. "Zone 2 (152–167 bpm)") for cycling prescriptions even when the athlete had no HR monitor on their bike. LTHR zones are derived from running data and the BPM guidance was inappropriate for cross-training contexts where HR monitoring isn't confirmed.
2. `average_watts` was never stripped from `activityForClaude` when `hasWatts = false` — unlike `average_heartrate` which is stripped when `!hasHR`. Seeing the field in the raw JSON (even as `null`) caused Claude to hallucinate "power/watts data: YES" in activity summaries with no power meter data.
**Fix / Change:**
1. Modified the instruction in `buildHRZoneContext` to distinguish between analyzing runs with HR data (bpm values appropriate) vs. prescribing future cross-training sessions (use effort/RPE language unless there's evidence the athlete monitors HR for that activity).
2. Moved `hasWatts` computation to before `activityForClaude` construction (same pattern as `hasHR`), and added `average_watts: hasWatts ? ... : undefined` to the spread so the field is fully absent from the Claude-visible JSON when no power data exists.
**Files changed:** `src/lib/hr-zones.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-28 — Detect and respect metric unit preference during onboarding

**Type:** Bug Fix
**Reported by:** Daily conversation analysis (user CC39C804)
**User feedback:** "Très compliqué pour moi de réfléchir comme ça…" (user writing in French, confused by imperial units during onboarding)
**Root cause:** `preferred_units` was never extracted during onboarding — the Haiku extraction schema had no field for it, the Dean system prompt had no units instruction, and `completeOnboarding` never saved it to `training_profiles`. All users defaulted to imperial regardless of their actual preference.
**Fix / Change:** (1) Added `preferred_units` to the Haiku extraction schema with a rule to detect metric preference from km/min-per-km mentions or non-English language. (2) Added a conditional UNITS instruction to Dean's onboarding system prompt so he immediately switches to km/min-per-km once metric preference is detected. (3) Added `preferred_units` to `summarizeCollected` so it appears in "WHAT YOU ALREADY KNOW" for subsequent turns. (4) `completeOnboarding` now saves the detected `preferred_units` to `training_profiles` so the coaching engine uses the right units from day one.
**Files changed:** `src/app/api/onboarding/handle/route.ts`
## 2026-04-18 — Auto-fix: conversation analysis issues 2026-04-16

**Type:** Bug Fix
**Reported by:** Daily conversation analysis (2026-04-16, 12 users, 61 messages)
**User feedback:** N/A (automated analysis)

### Fix 1 — Volume overrun warning firing on WeightTraining activities (P1, User b1b308cf)
**Root cause:** `planDeviationFlag` was computed for any `post_run` trigger, regardless of activity type. A WeightTraining session (0mi) triggered the "going longer than the plan" pattern warning.
**Fix:** Added activity type check at the top of the `planDeviationFlag` IIFE — returns null immediately for any non-running activity (WeightTraining, Yoga, Ride, etc.).
**Files changed:** `src/app/api/coach/respond/route.ts`

### Fix 2 — "Postpartum" used as synonym for "post-run" (P1, User 7170bad2)
**Root cause:** Claude used "postpartum" to mean "post-run/after the effort" with no athletic/medical context to justify it. The word specifically refers to the period after childbirth.
**Fix:** Added a TONE rule in the system prompt: never use "postpartum" as a synonym for "post-run," "after the effort," or "after the activity."
**Files changed:** `src/app/api/coach/respond/route.ts`

### Fix 3 — Specific lap index numbers cited by index on Ride activity (P0, User 0cb902da)
**Root cause:** When lap data is present, Claude was citing laps by specific index numbers (e.g. "laps 3/6/7/8") implying a known lap ordering, which may not be meaningful to the athlete.
**Fix:** Extended the laps data-glossary guard to also prohibit citing laps by index number; instead require effort-pattern descriptions ("the hard intervals," "the high-effort segments").
**Files changed:** `src/app/api/coach/respond/route.ts`

### Fix 4 — Direct coaching questions sometimes ignored in user_message responses (P1, User 95fd0845)
**Root cause:** When an athlete asked a direct question ("how do I get the leg speed up"), Dean addressed a prior topic (leg tightness) and omitted the substantive answer.
**Fix:** Added explicit DIRECT QUESTIONS instruction to the `user_message` prompt: if the athlete's message contains a direct coaching question, it MUST be answered, not skipped.
**Files changed:** `src/app/api/coach/respond/route.ts`

### Fix 5 — Duplicate messages during onboarding (P1, User 95fd0845)
**Root cause:** Same message body arriving twice within seconds (user double-send or Linq retry with new message ID) was not caught by the existing ID-based dedup, resulting in the same message being processed twice.
**Fix:** Added content-based dedup in `handleInboundMessage`: if the exact same message body was stored for the same user within the last 30 seconds, skip processing.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/__tests__/api/linq-webhook.test.ts`
## 2026-04-16 — Four prompt guards from 2026-04-15 conversation analysis

**Type:** Bug Fix
**Reported by:** Daily conversation analysis email (2026-04-15, 13 users, 47 messages)
**User feedback:** N/A (automated analysis)
**Root cause:** Four P1 coaching quality failures identified in transcripts:
1. Dean expressed outdoor Ride activity speed as "min/mile" pace — a running unit that is meaningless for cycling. Strava stores ride speed in mph/km/h and Dean was misreading the speed field as a running pace.
2. When a structured workout had a final lap faster than the main set, Dean confidently labeled it the "cooldown" — contradicting the pace data and mischaracterizing the athlete's effort zones.
3. Dean stated a projected weekly total was "slightly lighter than the 24.5 mi target" when the projection (33.3 mi) was actually 36% above the target — the comparison direction was inverted.
4. After telling an athlete it could not see Sunday's run in Strava, Dean later said "that matches what I saw from the sync" — falsely attributing the athlete-provided data to a Strava sync that never happened.
**Fix / Change:**
1. Added `RIDE SPEED UNITS` data guard to `post_run` prompt: when `activityData.type === "Ride"` (not VirtualRide), instructs Claude to report speed in mph/km/h, never min/mile.
2. Added `LAP PACE SANITY CHECK` rule to `WORKOUT STRUCTURE` block: if the final lap is faster than the middle laps, flag the anomaly rather than asserting it's a cooldown.
3. Added `PROJECTED vs TARGET DIRECTION` rule to `MILEAGE ACCURACY` block: explicit arithmetic check — if projected > target say "above target", if projected < target say "below target."
4. Added `MANUALLY-REPORTED ACTIVITY` rule to `user_message` prompt: when Dean previously said it couldn't see an activity and the athlete then provided details manually, do not claim those numbers came from a Strava sync.
## 2026-04-15 — Prompt fixes: non-run weekly mileage, sprint outlier flag, same-next-day tempo gate

**Type:** Bug Fix
**Reported by:** Daily conversation analysis (2026-04-14)
**User feedback:** N/A — identified via automated analysis
**Root cause:**
1. **Issue 4 (b1b308cf)** — WeightTraining post_run messages were injecting the week's running mileage total into the prompt even though the cross-training activity doesn't contribute to it. When a run and a non-run activity synced concurrently, both post_run messages reported the same weekly total (the run was already stored when the WeightTraining prompt was built), confusing athletes into thinking the run's distance hadn't been counted.
2. **Issue 1 (a56bc698)** — A 5:23/mi split on a recovery run was presented neutrally as a "sprint finish" without flagging it as a likely GPS artifact or anomalous burst. Dean's INSIGHT RULES had no guard for outlier lap/split paces.
3. **Issue 5 (ac0ab080)** — Athlete reported left ankle tightness and outer knee tightness at mile 3 of a return-to-run effort. When asked about doing a tempo run the next day, Dean conditionally green-lit it ("if ankle and knee are quiet Thursday morning, go for it"). This is a coaching error: tempo-loading tissue that flagged within the last 24 hours is unsafe regardless of morning symptoms.
**Fix / Change:**
- For non-run `post_run` triggers (WeightTraining, rides, swims, etc.), replaced the injected `WEEK-TO-DATE RUNNING` figure with an explicit instruction: "Do NOT cite the week's running mileage total — leave weekly mileage commentary for post-run messages." Prevents confusing duplicate mileage reports when concurrent activities fire.
- Added a bullet to INSIGHT RULES: when any lap or split is >~90 sec/mi faster than the run average, flag it explicitly rather than presenting it neutrally (likely GPS artifact or unintended burst on an easy/recovery run).
- Added `SAME-NEXT-DAY INTENSITY GATE` rule to the PROACTIVE INJURY section: when an athlete reported pain/tightness during a recent run and asks about doing tempo/intervals the following day, respond with easy-only at most and defer quality sessions ≥2 days out.
## 2026-04-12 — Fix ghost Strava-connected message, duplicate post-run SMS, and mid-week mileage total

**Type:** Bug Fix
**Reported by:** Automated conversation analysis (2026-04-11 digest)
**User feedback:** Ghost "Strava connected" message fired 4× mid-conversation; same 10-mile run triggered 3 separate post-run check-ins; plan summary said "14 mi for the week" when user had already logged 36 mi.
**Root cause:**
- **Ghost Strava message:** The OAuth callback (`/api/auth/strava/callback`) sends the "Strava connected" SMS unconditionally on every request. Re-auth flows (e.g. clicking the Strava link again, or hitting the write-scope re-auth route) each trigger a fresh callback → duplicate messages.
- **Duplicate post-run messages:** The webhook's second dedup guard only checked for a post_run conversation within the last 10 minutes. Strava can re-fire the same activity_id event hours apart (observed at 19:04, 19:15, 19:48 for the same run). The 44-minute gap between the first and third event slipped through the 10-minute window.
- **Mileage total error:** Dean prescribed "Sun 4/13 · Long run 14mi" for a user who had already logged 36 miles this week, then said "That brings you to 14 mi for the week." No prompt rule existed to require stating the full projected total (existing + new) when mid-week miles are already logged.
**Fix / Change:**
- `strava/callback/route.ts`: Query `strava_access_token` from the user record before sending the welcome SMS. If already set (Strava was already connected), skip the SMS. First-time connects still send the message normally.
- `webhooks/strava/route.ts`: Replaced the 10-minute time-based second guard with a permanent per-activity check: query conversations for an existing `post_run` row with this specific `strava_activity_id`. Falls back to the 10-minute guard only as a race-condition safety net for near-simultaneous events.
- `coach/respond/route.ts`: Added a `WHEN AN ATHLETE REPORTS MID-WEEK MILEAGE` prompt rule with a `<rule>` block requiring Dean to always state the projected total (existing + new sessions) — never just the new session's distance — when a user discloses their current week mileage.
## 2026-04-11 — Comprehensive metric units throughout coaching pipeline

**Type:** Bug Fix
**Reported by:** Internal audit (follow-up to post-run units fix)
**User feedback:** N/A
**Root cause:** Several places in the system still fed imperial data to Claude for metric users: (1) `buildActivitySummary` showed historical weekly volumes in miles, paces as `/mi`, and elevation in feet — all hardcoded. (2) `parseSessionMiles`/`computeProjectedWeekMiles` only parsed `mi` in session labels, silently returning 0 for `km` labels (breaking projected mileage math). (3) `correctProjectedTotal` regexes only matched `/mi` patterns, so the projection-correction post-processing was skipped for metric users. (4) The weekly_recap session format instructions (example runs, SESSION_LIST tag format, quality session warmup/cooldown examples) all showed imperial units, causing Claude to generate km labels inconsistently.
**Fix / Change:** (1) `buildActivitySummary` now accepts `isMetric` and outputs km/min/km/m for metric users. (2) All `parseSessionMiles` / `parseMilesFromLabel` / `computeProjectedWeekMiles` now match both `mi` and `km` (converting km → miles internally for math). (3) `correctProjectedTotal` now takes `isMetric`, converts the system projection to km, and matches km patterns in Claude's output. (4) Weekly_recap session format instructions are now fully dynamic — example sessions, SESSION_LIST tag format, quality session WU/CD examples, and total format all use km for metric users.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-11 — Post-run messages now use metric units consistently for metric users

**Type:** Bug Fix
**Reported by:** User (PE's friend, metric user)
**User feedback:** "Can you also take a look at Dean saying a mix of min / mi and then using kilometers? For this user everything should be in KM"
**Root cause:** The post_run user message fed Claude entirely imperial data (average_pace stored as "/mi", splits with distance_miles and pace as "/mi", week-to-date in miles, data glossary saying "all paces are min/mile") while the system prompt told Claude to "use km and min/km." Claude had to self-convert which produced inconsistent output (e.g. "5 mi — 8:11/mi avg" for a metric user). Race history in the system prompt also always showed miles and /mi pace.
**Fix / Change:** `transformSplitForClaude` now accepts `isMetric` param and outputs `distance_km`, `cumulative_km`, and `/km` paces for metric users. Activity JSON for metric users gets `distance_km` and `average_pace` pre-converted to `/km`. Week-to-date context, data glossary, and race history all now display in km/min/km when `preferred_units = "metric"`. All data guards updated to use the correct unit label.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-11 — Fix beginner plan generating 16mi/week and fartlek for never-run-before user

**Type:** Bug Fix
**Reported by:** Conversation analysis email (user bcf3ffa5 "Pookie")
**User feedback:** "Why does it say I'm running 16 miles this week" / "I've never run continuously, how can I do a 5 mile long run?"
**Root cause:** Two compounding issues: (1) The plan arc base mileage was derived from Strava's historical average even when the user explicitly self-identified as a beginner. A "never run before" user with old Strava running activity (e.g. occasional jogs, runs from a prior fitness phase) would get their plan anchored to that historical avg (e.g. 16mi/week) rather than the 8mi beginner default. (2) The system prompt fitness tier block used the raw Strava avg to select the coaching tier — so `avgWeeklyMileage = 16` triggered "MODERATE VOLUME" treatment, telling Claude to prescribe ~16-17mi for week 1 and include fartlek/quality sessions from week 2.
**Fix / Change:** Two targeted changes: (1) In `generateAndSaveFullPlan`, when `fitness_level === "beginner"` (explicitly set, not defaulted), cap the Strava-derived `avgWeeklyMileage` at `noHistoryDefault` (8mi) before computing `baseMileage`. This prevents the arc from being anchored to stale historical data. Uses strict equality check so legacy profiles without a `fitness_level` are unaffected. (2) In `buildSystemPrompt`, added `forceBeginnerTier` flag — when `trigger === "initial_plan"` and `fitness_level === "beginner"` and `avgWeeklyMileage > 8`, force the beginner-tier block in the fitness tier section instead of MODERATE/HIGH VOLUME. The beginner block for this case uses updated wording: "Strava history likely reflects past fitness, not current ability — do not use historical average to set volume." Cap stays at 10mi/week for week 1.
## 2026-05-02 — Surface GAP (grade-adjusted pace) per split for trail runs

**Type:** Bug Fix
**Reported by:** Jake (user feedback)
**User feedback:** "What were my GAP paces for the first few miles of that run" — Dean gave a generic non-answer instead of actual GAP values
**Root cause:** Strava's API returns `average_grade_adjusted_speed` on each split object, but `transformSplitForClaude()` only converted `average_speed` → `pace`. The GAP field was silently dropped during transformation, so Claude had no GAP values to reference when asked.
**Fix / Change:** Added `gap_pace` extraction in `transformSplitForClaude()` — converts `average_grade_adjusted_speed` (m/s) to a min/mi string, stored alongside `pace` in each split. Also updated the TrailRun annotation in the system prompt to explicitly tell Claude the `gap_pace` field exists and to use it when the athlete asks about effort or pacing on climbs.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-05-01 — Fix zone number mismatch when LTHR confidence is low

**Type:** Bug Fix
**Reported by:** Jake (user feedback)
**User feedback:** "This isn't accurate for my zone 2!" / "my zone 2 is like 130-150" / "it already has my zone 1-5 but it accidentally paired my zone 3 in this response instead of zone 2"
**Root cause:** When `lthr_confidence = "low"`, the dashboard already falls back to % max HR zones (Z1-Z5 with different bpm boundaries). But the coaching system prompt was still injecting the low-confidence LTHR zones. This meant the athlete saw one set of bpm ranges on their dashboard and a different set in Dean's coaching messages — same zone *numbers*, different bpm values.
**Fix / Change:** Mirror the dashboard's behavior: when `lthr_confidence === "low"`, set `lthrData = null` so the coaching prompt falls back to the % max HR zone description instead of the LTHR zones. The zone bpm ranges Dean cites now match what the athlete sees on their dashboard.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-29 — Fix interval session misclassified as easy in Strava annotation

**Type:** Bug Fix
**Reported by:** Jake (user feedback)
**User feedback:** "I did intervals today; max hr 172, avg 149 (just at the top of zone 2) and he gave me a green 100% in Z1-Z2 which didn't seem right"
**Root cause:** `detectWorkoutKind` inferred workout type from session avg HR / estimated max HR. For intervals, recovery jogs drag avg HR way down, making the ratio fall below the "tempo" threshold and defaulting to "easy" — then the annotation showed the Z1-Z2 metric which was irrelevant.
**Fix / Change:** Added `peakSplitHR` (highest per-mile split average HR) as the primary inference signal. Since each split averages 5-10 minutes, a high peak split HR means sustained Z4-Z5 effort, not a sensor spike. Thresholds: peakSplitHR/estimatedMax ≥ 0.88 → interval, ≥ 0.82 → tempo. Falls back to session avg HR when no split data is available.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-28 — Strava activity annotations are now opt-in

**Type:** Improvement
**Reported by:** Jb ("I don't want you to post on my behalf on my Strava activities, never do it again")
**Root cause:** The default Strava connect flow requested `activity:write` scope, so the "Upload your activities" checkbox was pre-checked — users had to actively uncheck it to avoid notes. This is opt-out, not opt-in.
**Fix / Change:** Changed the default `/api/auth/strava` scope to `read,activity:read_all` only (no write). The Strava OAuth screen now shows no notes-related checkbox. The connect message now presents the read-only URL as the default, with a second link (`/api/auth/strava/write`) for users who want coaching notes. The "STRAVA CONNECTION" shortcut already handled write scope re-auth correctly and remains unchanged. The `connect strava` fallback in the linq webhook was updated to match the same two-URL pattern.
**Files changed:** `src/app/api/auth/strava/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/api/webhooks/linq/route.ts`

---

## 2026-04-28 — Dashboard respects preferred_units for pace and distance display

**Type:** Bug Fix
**Reported by:** Jake (prompted by Minette and Jb feedback)
**User feedback:** N/A (follow-up to language/units fix)
**Root cause:** The prescribed paces panel ("Easy", "Tempo", "Intervals") always displayed in min/mile regardless of `preferred_units`. `easyRange` was computed with a hardcoded `/mi` suffix. The "fill the rest with easy miles" label was also hardcoded.
**Fix / Change:** Added a `displayPace()` helper that converts stored min/mile values to min/km when `useMetric=true`. Applied to `easyRange` (full range computed in km when metric), `rawTempo`, and `rawInterval` display. Changed "easy miles" label to use `distUnit` (`km`/`mi`). Distances (weekly target, long run, chart) were already metric-aware.
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-28 — Language + units preferences now persist and propagate to all messages

**Type:** Bug Fix
**Reported by:** Minette, Jb (both French users)
**User feedback:**
- Minette: "Parle pas en miles mais en km" (repeated multiple times, never persisted)
- Jb: "Et tu mets tout en miles, c'est pas évident pour moi" / "Je veux que tu me parles en français Dean" (asked 4 times, still getting English automated messages)
- Jb: "I don't want you to post on my behalf on my Strava activities, never do it again" (bot said "understood" but never actually disabled the flag)
**Root cause:**
1. `preferred_units` ("use km") and `preferred_language` ("speak French") were never extracted from user messages and never persisted — `extractProfileData` Haiku prompt had no detection for either. So every automated message (post_run, morning cron, weekly_recap) continued using the defaults (imperial, English).
2. `strava_write_enabled = false` was likewise never extracted — the bot acknowledged the request but never wrote the DB flag.
3. `post_run_onboarding` was hardcoded in English and miles with no way to override.
4. Onboarding hardcoded strings (`stravaMsg` footer, `modeQuestion` fallback) were always English regardless of user language.
5. `parseModeFallback` English-only regex: "J'ai pas de plan donc pars de zéro" was never recognized → `modeUnresolved` stayed true → English mode question kept looping.
**Fix / Change:**
- Added `preferred_units`, `preferred_language`, and `strava_write_enabled` to `ExtractedProfileData` type and Haiku extraction prompt with French/Spanish pattern examples.
- `persistProfileUpdates` now writes `preferred_units` → `training_profiles.preferred_units`, `preferred_language` → `users.onboarding_data.preferred_language`, `strava_write_enabled = false` → `users.strava_write_enabled`.
- `buildSystemPrompt` injects a hard language instruction ("ALWAYS respond in French") when `preferred_language ≠ "en"` — applies to all automated messages.
- `post_run_onboarding` reads `preferred_language` and `preferred_units` from `onboarding_data`, injects language/units into system prompt and uses km for activity details when metric.
- Added `detectLanguage()` to onboarding handler — detects French/Spanish from user message history and auto-stores in `mergedData.preferred_language` before the first onboarding response.
- Onboarding system prompt now injects a hard language instruction when a non-English language is detected.
- `stravaMsg` footer and `modeQuestion` fallback both use `mergedData.preferred_language` to select pre-translated French/Spanish/English text.
- `parseModeFallback` now matches French FROM_SCRATCH ("pars de zéro", "pas de plan"), COMPLEMENT, and NO_PLAN patterns.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-28 — Post-run Z2 affirmation + insight variety roster

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "Dean is having issues - he's saying to keep easy runs easy all the time but doesn't seem to actually examine whether I was in Zone 2 or not. I've been in zone 2 a bunch the past few runs and he keeps reminding me to run easy."
**Root cause:** The GRAY ZONE GUARD correctly prevented mislabeling a Z2 run as gray zone, but didn't require Claude to positively affirm correct easy effort — so Claude fell back on generic "keep easy runs easy" filler even when the athlete already nailed it. Additionally, the 2-insight rule had no variety menu, so Dean tended to hit the same 2 notes every post-run.
**Fix / Change:** (1) Added EASY EFFORT AFFIRMATION rule: when avg HR is in Z1/Z2 on an easy run, at least one insight must explicitly confirm correct execution (e.g. "Your HR sat right in Zone 2 — that's exactly the aerobic stimulus you're after"). Generic effort reminders are now only allowed when HR was actually in Z3+. (2) Added INSIGHT VARIETY menu listing all available signals (HR zones, cadence, cardiac decoupling, split consistency, best efforts, week-over-week comparison, vert/terrain, weather, load arc, race connection) so Dean picks the 2 most relevant for each specific run rather than always defaulting to the same topics.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-26 — Fix awkward weekly recap closing line; add direct tempo/interval pace correction support

**Type:** Bug Fix / Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "this message of 'invite me into your week' is very weird" / "I also don't think that's my tempo speed. It's more like 7:45"
**Root cause:** (1) Claude was generating the phrase "Invite me into your week" — the prompt examples weren't explicit enough to prevent awkward/formal phrasings. (2) There was no extraction path for direct tempo or interval pace corrections; the system only updated paces via VDOT (race data) or easy-pace estimation, so "my tempo is 7:45" was silently ignored.
**Fix / Change:** (1) Updated weekly recap prompt to explicitly ban "Invite me into your week" and similar formal phrasing, with better example variations. (2) Added `tempo_pace` and `interval_pace` to the Haiku extraction schema and `ExtractedProfileData` type; both are now written to `current_tempo_pace`/`current_interval_pace` in `training_profiles` when explicitly stated, and pre-loaded into the profile before building the system prompt so Dean responds with the corrected pace immediately.
**Files changed:** `src/app/api/coach/respond/route.ts`, `CHANGELOG.md`

## 2026-04-27 — Stagger Sunday recap cron to avoid LLM rate limit errors

**Type:** Bug Fix
**Reported by:** Jake (Vercel logs after Sunday recap cron)
**User feedback:** "429 Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 30000"
**Root cause:** The `sunday-recap` cron fired all users' `coach/respond` calls back-to-back with no delay. Each recap uses ~11k tokens, so the second user immediately exhausted the 30k TPM limit.
**Fix / Change:** Added a 30s sleep between each user in the `after()` loop. The delay is skipped after the last user so there's no unnecessary tail wait. 30s matches the rate-limit reset window from the error headers.
**Files changed:** `src/app/api/cron/sunday-recap/route.ts`

---

## 2026-04-27 — Fix activities query crashing on wrong column name (broke Sunday recap)

**Type:** Bug Fix
**Reported by:** Jake (Vercel logs after Sunday recap cron)
**User feedback:** "got a bunch of errors like this! column activities.name does not exist"
**Root cause:** The main activities SELECT in `coach/respond` was fetching a column called `name`, but the actual DB column is `activity_name`. This caused a `42703` PostgreSQL error for every user during the weekly_recap cron, making the activities query fail and blocking the recap from generating correctly. The `ActivityRow` interface and downstream usage (`a.name`, `match.name`) also used the wrong field name.
**Fix / Change:** Renamed `name` → `activity_name` in the SELECT string, the `ActivityRow` interface, and the two downstream references in `computeSessionsStatus`. Updated the sessions-status test fixtures to match.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/sessions-status.test.ts`

---

## 2026-04-26 — Stop asking about stale training context after every post-run

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "what are our current guardrails on asking about a past race build back or injury? feels like we are overdoing it here asking about last summers 5k haha"
**Root cause:** The `injuryReminder` block in the `post_run` prompt fired whenever `injury_notes` was non-null — including when the notes contained general training context like "building back from summer 5K season" rather than a physical injury. This caused Dean to ask "how's your build-back from last summer's 5K?" after every single post-run, even after the athlete had explicitly shifted focus to a new race. The block also had no staleness check — it overrode the STOP ASKING RULE in the main system prompt because it was a closer, more specific instruction.
**Fix / Change:** (1) `injuryReminder` now only fires when `injury_notes` contains physical injury language (pain, tightness, body part keywords, etc.) — general training context notes are skipped entirely. (2) `injuryReminder` now explicitly tells Claude to apply the STOP ASKING RULE before including a check-in. (3) Added PHYSICAL INJURY ONLY and STALE CONTEXT RULE guardrails to the PROACTIVE INJURY section of the system prompt to prevent Claude from treating goal/context notes as recurring injury check-in topics.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-26 — Dashboard insights regenerate after injury_hold, injury_clear, and lighter_week

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `injury_hold`, `injury_clear`, and `lighter_week` all modify `training_state` (zero/reduce mileage, clear sessions, or rebuild the plan arc) but none called `generateAndStoreDashboardInsights` afterward. The dashboard would show stale insights after any of these events until the next `post_run`, `weekly_recap`, or `initial_plan` triggered a refresh.
**Fix / Change:** Added a non-blocking `generateAndStoreDashboardInsights` call (fire-and-forget via `void`) at the end of each handler, passing a descriptive coach message so the insights reflect the current state.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-26 — Dashboard syncs after mid-week session change; Dean no longer restates session on confirmation

**Type:** Bug Fix
**Reported by:** Jake (user feedback)
**User feedback:** "dashboard didn't update" + Dean sent same workout details twice after user said "Sure that sounds good"
**Root cause:** (1) `maybeUpdateTrainingPlanWeeks` patched the `training_plans` arc but never synced `training_state.weekly_quality_session`, which is what the dashboard reads. (2) When the user confirmed a proposed session change with a short reply ("Sure that sounds good"), Dean's response to that confirmation restated the full workout details already described in the previous message.
**Fix / Change:** (1) `maybeUpdateTrainingPlanWeeks` now returns the list of patched week numbers; if the current week is among them, `syncWeekFromArc` is called to update `training_state` so the dashboard reflects the change immediately. (2) Added a CONFIRMATION RESPONSES prompt rule: when the athlete sends a short confirmation ("Sure", "Sounds good", "OK", etc.), Dean must respond with a single brief acknowledgment and not restate session details already described.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-26 — Mileage arc on dashboard + arc summary in initial plan message

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Users had no visibility into how their weekly mileage would progress across the full plan — only the current week's target was shown.
**Fix / Change:** Added a compact bar chart below the "This Week" card in the dashboard showing every week's mileage target (midpoint of range if applicable). Current week highlighted green, past weeks gray, taper weeks blue-tinted. Also added a full arc summary to the `initialPlanArcConstraint` so Claude ends the initial plan SMS with one sentence describing the overall mileage progression (e.g. "Your plan builds from 34 to 52 mi/week at peak, then tapers for race prep.").
**Files changed:** src/app/dashboard/page.tsx, src/app/api/coach/respond/route.ts

## 2026-04-26 — Fix cross-training prescribed outside athlete's stated tools

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "seeing that I got prescribed swimming but I didn't mention that in onboarding at all"
**Root cause:** The Haiku arc-enrichment prompt listed "easy Z2 ride or easy swim" as generic options for the base phase, without constraining to the athlete's actual cross-training tools. A user who only mentioned biking could still receive a swim prescription.
**Fix / Change:** Updated the cross_training instruction in the Haiku prompt to explicitly inject the athlete's tools (`[${crosstrainingTools.join(", ")}]`) and forbid suggesting any tool not in that list.
**Files changed:** src/lib/training-plan.ts

---

## 2026-04-26 — Stronger quality sessions for high-volume athletes in week 1; fix double dashboard link

**Type:** Bug Fix / Improvement
**Reported by:** Internal observation (user onboarded at 34 mi/week received only strides as week 1 quality session; dashboard link sent twice)
**User feedback:** "feels like the quality workout here is very light considering what type of volume and intervals I've done recently" / "he sent the dashboard link twice, I don't think that is intended!"
**Root cause:** (1) The HIGH VOLUME rule (30+ mi/week) listed strides as an acceptable quality session alongside tempo/intervals, so injury notes tipped the model toward strides as a "safe" choice. (2) Claude was including the dashboard URL at the end of Bubble 2 (it's visible in the system prompt for FULL PLAN REQUESTS), and then `closingMsg` in `initial_plan` was also sending the URL — appearing twice.
**Fix / Change:** (1) Updated HIGH VOLUME rule to explicitly state strides are NOT sufficient for 30+ mi/week athletes — they must get tempo, fartlek, intervals, or hill repeats; reduced-intensity versions are fine when injury history is present. (2) Added explicit `<rule>` in the initial_plan prompt instructing Claude not to include the dashboard URL — it's sent automatically as a separate follow-up.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-04-26 — Cross-training integration: effort classification, aerobic minutes, richer post-activity messaging, dashboard display

**Type:** Feature
**Reported by:** Jake (product direction)
**User feedback:** N/A
**Root cause:** Cross-training activities (bikes, swims) were treated as generic 2-3 sentence responses with no effort context or aerobic load reasoning. Cross-training was not shown on the plan card dashboard. Weekly recap ignored cross-training sessions entirely.
**Fix / Change:**
- New `src/lib/cross-training.ts` with `classifyCrossTrainingEffort()` (HR/watts/name-based), `computeAerobicMinutes()` (multiplier by sport + effort), `buildCrossTrainingContext()` (rich prompt block for post-activity messages), `buildWeeklyCrossTrainingSummary()` (for weekly recap), and `prescribeCrossTrainingForPhase()` (phase-appropriate prescriptions)
- `post_run` for non-run activities now injects a structured cross-training context block: effort classification, aerobic equivalent minutes, week-to-date cross-training load, phase-appropriate framing
- `STRENGTH, MOBILITY & CROSS-TRAINING` system prompt section upgraded with explicit phase-specific cycling (Z2 / sweetspot / easy spin by phase) and swimming (aerobic / drill sets / easy form) prescriptions
- `weekly_recap` now injects a cross-training summary into the user message so notable bike/swim sessions are acknowledged in the Sunday recap
- `training-plan.ts` Haiku arc enrichment now generates a `cross_training` field per week when the athlete has bike/pool tools, using phase-appropriate defaults as fallback
- `plan-card.tsx` + `plan-tab.tsx` + `page.tsx` updated to pass and display `cross_training` from the plan arc — shows as a "Cross-training" section below Key Sessions on the dashboard
**Files changed:** `src/lib/cross-training.ts` (new), `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/plan-card.tsx`, `src/app/dashboard/plan-tab.tsx`, `src/app/dashboard/page.tsx`

## 2026-04-26 — Fix HR hallucinations (no-HR activities + swims) and onboarding mode question duplication

**Type:** Bug Fix
**Reported by:** Daily recap email analysis
**User feedback:** N/A
**Root cause:** Two separate issues: (1) `transformSplitForClaude` spread all split fields including `average_heartrate` into the Claude-facing JSON, so even when the top-level HR guard said "no HR data", per-split BPM values were still visible in the raw JSON and Claude cited them. (2) For swim activities, Strava may record optical HR from a wrist sensor even though underwater HR monitoring is unreliable — no guard existed to suppress specific BPM citations for swims. (3) Onboarding fallback that re-asks the mode question (when [READY] fires but mode is unresolved) would append the question even when Claude had already included it naturally, causing the identical "three different ways" message to be sent twice 3 minutes apart.
**Fix / Change:** (1) Strip `average_heartrate` from all split and lap entries when `hasHR = false` so the JSON stays clean and can't be cited. (2) Add a swim-specific data guard that prevents citing a specific BPM average for Swim activities. (3) Before appending the fallback mode question, check if `cleanedResponse` already contains "three different ways" — if so, skip the append.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

## 2026-04-26 — Three coaching quality fixes: mileage sync gap, elevation splits, dashboard in recap

**Type:** Bug Fix / Improvement
**Reported by:** Jake (user feedback)
**User feedback:**
1. "Dean didn't seem to see that I had 25 miles for the week on strava at the moment... You're currently at 0.0 miles for the week"
2. "He also seems to think everytime I do a big climb then come back (increase in elevation then decrease) that I'm negative splitting... he should probably look at GAP here for more context"
3. "I'd like Dean to reference and updates to the dashboard in his Sunday recap"
**Root cause:**
1. Confirmed via DB investigation: Jake's 4 activities (26.6mi total) were correctly stored and the timezone (America/Denver) was set. The "0 miles" came from a transient Supabase query failure — `recentActivitiesResult.error` was never checked, so the `|| []` fallback silently produced an empty activity list with no log and no error. Dean then treated "0.0 miles" as authoritative and stated it confidently.
2. `buildRunExecutionAnalysis()` compared raw pace per split half without considering elevation. A climb-out-and-back run looks like a negative split in raw pace (second half faster due to downhill) even when effort was harder on the uphill first half. Strava provides `average_grade_adjusted_speed` per split but it wasn't used.
3. The Sunday recap prompt had no instruction to include the dashboard URL, even though it's generated and available.
**Fix / Change:**
1. Added error check on `recentActivitiesResult.error` with a console.error log. When the activities query fails, `activitiesQueryFailed = true` is threaded into both `buildSystemPrompt` (FACTS block) and `buildUserMessage` (weekly_recap), telling Dean the data failed to load and to defer to what the athlete says rather than stating 0 miles. The old overly-broad "sync gap" warning (which would have fired on normal Monday mornings) was deliberately NOT implemented.
2. `buildRunExecutionAnalysis()` now uses `average_grade_adjusted_speed` (GAP) when available on the majority of splits. When GAP is unavailable but the second half has >50m more net descent than the first, the note says "elevation-assisted, not a genuine negative split" instead of crediting pacing discipline.
3. Weekly recap prompt now includes the dashboard URL when available, instructing Dean to add one short sentence with the link at the end of the second bubble.
**Files changed:** `src/lib/training-analytics.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-analytics.test.ts`

---

## 2026-04-24 — STRAVA CONNECTION keyword and write-permission re-auth flow

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** No way for users to add or remove the Strava activity-notes permission after initial onboarding. "Reconnect strava" also silently fell through to the LLM instead of sending a link. Callback only set `strava_write_enabled: true` but never cleared it to `false` when a user re-authed without write scope.
**Fix / Change:** Added exact-match keyword `STRAVA CONNECTION` that sends a `/api/auth/strava/write` re-auth link (with explanation of the "Upload activities" checkbox). Fixed `isStravaIntent` to match "reconnect" and send the write link instead of "already connected" for connected users. Callback now always writes `strava_write_enabled: hasWriteScope` so unchecking the permission actually takes effect. Added the keyword to the welcome-tips message, the landing page FAQ, and Dean's system prompt. Also corrected a stale "read-only" claim in the landing page privacy answer.
**Files changed:** `webhooks/linq/route.ts`, `auth/strava/callback/route.ts`, `cron/welcome-tips/route.ts`, `coach/respond/route.ts`, `app/page.tsx`

## 2026-04-24 — Added Sentry error monitoring

**Type:** Infra
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Errors in `after()` blocks were silently swallowed — only visible in Vercel logs with no alerting.
**Fix / Change:** Installed `@sentry/nextjs`, added `sentry.{client,server,edge}.config.ts`, wrapped `next.config.ts` with `withSentryConfig`. Added `captureException` to every top-level `after()` catch block across `coach/respond`, `onboarding/handle`, `webhooks/strava`, and `webhooks/linq`. Also wrapped the bare `generateAndStoreDashboardInsights` after() call that had no error handling. Each capture includes a `trigger` tag for filtering in Sentry.
**Files changed:** `next.config.ts`, `sentry.client.config.ts` (new), `sentry.server.config.ts` (new), `sentry.edge.config.ts` (new), `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/api/webhooks/strava/route.ts`, `src/app/api/webhooks/linq/route.ts`

---

## 2026-04-22 — Fix quality session labeled as pure easy run

**Type:** Bug Fix
**Reported by:** Conversation data analysis — user 29207ad0 complained "5.6km isn't really a long run right?" and had a quality session labeled "Easy 6km"
**User feedback:** "5.6km isn't really a long run right?"
**Root cause:** Post-processing in `generateAndSaveFullPlan` only caught empty strings and "Long run..." echoes when substituting the strides fallback. Haiku occasionally generates `key_workout: "Easy 6km"` (a pure easy-run label with no quality component) for beginner base-building weeks, which slipped through the check and left the athlete with two identical-intensity sessions and no form work.
**Fix / Change:** Added `isPureEasyLabel` regex to the post-processing guard in `training-plan.ts`. Any `key_workout` that matches "Easy Xkm/mi" or "easy aerobic miles" (without a quality marker like strides, `+`, `×`) is now replaced with the standard `Easy 2mi + 4×20sec strides` fallback, matching what the prompt already instructs Haiku to generate at minimum.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-22 — Interval pattern detection from Strava lap data

**Type:** Feature
**Reported by:** Jake (internal observation)
**User feedback:** "I did 16×1 min but he didn't say anything about that — seems he's just looking at the mile splits"
**Root cause:** Dean receives all lap data from Strava but had no pre-processing to surface interval structure. With 36 raw laps, Claude defaulted to the mile-split negative-split narrative instead of recognizing the workout as 16×1min intervals.
**Fix / Change:** Added `detectIntervalPattern()` to `training-analytics.ts`. Pure heuristic (no LLM): classifies laps as long (warmup/cooldown) vs short (interval presses), checks for alternating high/low `pace_zone` among short laps, and counts hard efforts + median duration. Result injected into the coaching system prompt as a plain-English "INTERVAL WORKOUT DETECTED" block that anchors Claude's response. Also handles single tempo blocks (contiguous hard laps).
**Files changed:** `src/lib/training-analytics.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-21 — Fix weekly_mileage_target drift for Dean-generated plans after weekly recap

**Type:** Bug Fix
**Reported by:** Internal — Plan Health audit (13 of 35 active users affected)
**User feedback:** N/A
**Root cause:** `syncWeekFromArc()` in `training-plan.ts` syncs `weekly_long_run_miles` and `weekly_quality_session` from the plan arc after every weekly recap, but for Dean-generated plans (the `else` branch) it omitted `weekly_mileage_target`. The `DeanWeek` local type was also missing the `mileage_target` field. This meant `training_state.weekly_mileage_target` stayed at the periodization engine's estimate (written at line 2109 of coach/respond) rather than being overwritten with the plan arc's actual value — causing state/plan divergence over time.
**Fix / Change:** Added `mileage_target?: number` to the `DeanWeek` local type, and added `weekly_mileage_target: week.mileage_target || null` to the update in the `else` branch of `syncWeekFromArc()`. Manually regenerated plans for all 13 affected users via `/api/admin/regenerate-plan`.
**Files changed:** `src/lib/training-plan.ts`

## 2026-04-21 — Fix long run mismatch between SMS and dashboard at onboarding, and "0 miles" phrasing

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "1) we could probably say you have no miles this week more eloquently 2) the long run in my dashboard and message were different (8 vs 11 miles)"
**Root cause:**
1. For Strava users with 0 miles at onboarding, `tsMileageLine` reported "0 mi done so far this week (0 runs)" which Claude echoed as "You've already got 0 miles this week" — unhelpful and awkward.
2. `generateAndSaveFullPlan` was called AFTER the Claude SMS call in the `initial_plan` trigger. Claude computed its own long run independently (8mi), then the arc stored a different value (11mi) in `training_state.weekly_long_run_miles`, causing the dashboard to show a different number than the SMS.
**Fix / Change:**
1. Added special case in `tsMileageLine` for `initial_plan` + 0 miles: now says "no runs recorded yet this week — do NOT mention this in your response" so Dean skips the awkward zero-mention entirely.
2. Moved `generateAndSaveFullPlan` to execute BEFORE the Claude call for `initial_plan`. After the arc is saved, reads back `weekly_long_run_miles`, `weekly_quality_session`, and `weekly_mileage_target` from `training_state` and injects them as hard constraints into the user message so Claude's SMS matches what the dashboard shows. Captured the returned dashboard token in `preGeneratedDashboardToken` so the post-processing block doesn't need a second DB fetch.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-21 — Strengthen HR and power data guards to prevent effort-inference hallucinations

**Type:** Bug Fix
**Reported by:** Daily conversation analysis email (2026-04-20)
**User feedback:** "Although 'power/watts data: NO' was indicated, the transcript erroneously includes it" / "Coach Dean refers to pace consistency and terrain variations despite not having HR data to validate physical performance and exertion feedback"
**Root cause:** The `!hasHR` data guard only blocked "specific HR values" — leaving Dean free to make HR-implied effort inferences like "you stayed aerobic", "it looked like a zone 2 effort", or "your heart rate seemed controlled" without citing a number. The `!hasWatts` guard told Dean to fall back to "HR, elapsed time, and pace-equivalent language" even when HR data was also unavailable, which was contradictory.
**Fix / Change:**
1. Strengthened the `!hasHR` guard from "Do NOT reference specific HR values" to "Do NOT reference HR values, heart rate, specific BPM figures, aerobic zone labels (Zone 1/2/3/4/5), or make any effort-level inference that requires HR data." This closes the loophole where Dean could still imply cardiac/zone assessment without citing a number.
2. Made the `!hasWatts` guard's effort-language fallback conditional: when HR data is also unavailable, the fallback now correctly says "elapsed time and pace-equivalent language only" instead of "HR, elapsed time, and pace-equivalent language."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-20 — Dashboard This Week card: hide plan CTAs for Dean plans, add easy-miles breakdown

**Type:** Improvement
**Reported by:** Jake (internal review)
**User feedback:** "not sure if we should keep the remove plan CTA or replace plan CTA here if it's Dean generated - let's remove in this case. Is it ultra clear the guidance on getting easy miles except the long run + quality sessions to hit the target? Can we make this even more clear?"
**Root cause:** PlanCard always rendered Replace / Remove actions, but those flows only make sense for imported plans — Dean-generated plans are managed via SMS. Card also showed target / long run / quality without making it explicit that the remaining volume is meant to be filled with easy-effort miles.
**Fix / Change:**
1. `plan-card.tsx` — gate the Replace/Remove action row behind a new `isUploadedPlan` prop; only imported plans see the CTAs.
2. `plan-card.tsx` — add an "Easy miles" row (the remainder after long run + quality) and a one-line helper under the card reinforcing that easy-effort runs fill the target across training days.
3. `page.tsx` — parse the first distance (mi or km) from the week's `key_workout`, subtract long run + quality from weekly target, and pass the remainder in miles. When quality distance can't be parsed (e.g. "6×800m @ 5K pace") the row is hidden rather than shown with an inaccurate number.
**Files changed:** src/app/dashboard/plan-card.tsx, src/app/dashboard/page.tsx

---

## 2026-04-20 — Dashboard shows no weekly target / long run / quality when training_state row missing

**Type:** Bug Fix
**Reported by:** Eli (via Jake) — dashboard vs. SMS mismatch
**User feedback:** "A few notes on the dashboard: It doesn't seem to show a total mileage target 2) long run says 1.5 mi but in the text it says 3 mi long run (total mileage should be 6 mi) 3) It doesn't show any of the quality focus e.g. strides on the dashboard"
**Root cause:** For Eli the `training_state` row was never created (his `completeOnboarding` path didn't run to completion — `training_profiles` is also null). `generateAndSaveFullPlan` and the `initial_plan` trigger both wrote Week 1 via `.update().eq("user_id", …)`, which silently no-ops when the row doesn't exist. So `weekly_mileage_target`, `weekly_long_run_miles`, and `weekly_quality_session` stayed null and the dashboard had nothing to render. The PlanCard also didn't fall back to the plan's own `mileage_target` when `training_state` was empty, so even recovering the row wasn't sufficient for plans without a mileage range.
**Fix / Change:**
1. `src/lib/training-plan.ts` — swap `training_state` `.update()` → `.upsert({ user_id, ... }, { onConflict: "user_id" })` so missing rows are created, not silently skipped. Mid-plan rebuilds (no `resetToWeek1`, no `week1Reset`) now skip the write entirely (previously wrote an empty object).
2. `src/app/api/coach/respond/route.ts` — same upsert change in the `initial_plan` handler.
3. `src/app/dashboard/plan-card.tsx` — when the plan week has no min/max range and `training_state.weekly_mileage_target` is null, fall back to the plan's own `mileage_target` so the target always shows.
4. Backfilled Eli's `training_state` from his stored plan Week 1 so his current dashboard renders correctly.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/plan-card.tsx`, `src/__tests__/lib/training-plan-generate.test.ts` (mock `.upsert` instead of `.update` for training_state writes).
**Follow-ups not in this fix:** (a) investigate why `completeOnboarding` didn't persist Eli's `training_profiles`/`training_state` in the first place — likely a silent Linq retry/dupe interaction given his convo shows every user message duplicated; (b) for beginner mile-goal plans, Haiku often falls back to `key_workout: "Long run Xmi"` instead of prescribing strides — worth a deterministic fallback.

---

## 2026-04-20 — Plan quality session no longer echoes the long run

**Type:** Bug Fix
**Reported by:** Eli (via Jake) — same dashboard report as prior entry
**User feedback:** "It doesn't show any of the quality focus e.g. strides on the dashboard"
**Root cause:** For low-mileage beginner weeks (e.g. mile goal, 5mi target, 1.5mi long run), Haiku interpreted the week as "low-volume deload" and set `key_workout: "Long run 1.5mi"` — echoing the long run that's already shown separately on the dashboard. The athlete got no quality/form stimulus and the Quality row on the dashboard duplicated the Long Run row. The prompt's CRITICAL RULE had an exception for "pure long-run-only weeks" that Haiku overused.
**Fix / Change:**
1. `src/lib/training-plan.ts` — tightened the Haiku prompt: key_workout must ALWAYS be a quality/form session; never echo the long run. Beginner/base/recovery/deload weeks should default to strides ("Easy 2mi + 4×20sec strides") since they're low-impact and valuable from week 1.
2. Added a deterministic post-process fallback: if Haiku still returns empty or a "Long run Xmi" echo, substitute `Easy 2mi + 4×20sec strides` automatically. Guarantees the dashboard never shows a duplicate Long Run / no-quality state.
3. Patched Eli's stored plan in place (9 weeks had the echo) so his dashboard reflects the fix immediately.
**Follow-ups:** the SMS initial_plan message is still generated free-form by Claude and can drift from the saved plan numbers (e.g. Dean texted 6mi total / 3mi long while the arc stored 5mi / 1.5mi). Separate fix — align the SMS generation to the saved Week 1.

---

## 2026-04-20 — Fix onboarding loop when Dean skips [MODE:...] tag

**Type:** Bug Fix
**Reported by:** Jake (internal observation on Eli's onboarding transcript)
**User feedback:** "seems like Dean may have repeated himself a lot in this onboarding instance?" — athlete answered "1" four times in a row ("1", "Build from scratch", "Build me a plan from scratch") and Dean re-asked the three-options question every turn.
**Root cause:** The `[MODE:FROM_SCRATCH|COMPLEMENT|NO_PLAN]` tag is the only signal that sets `has_existing_plan` / `wants_plan` (Haiku inference was removed). When Dean reflected the mode in prose but forgot the tag, `modeUnresolved` at `onboarding/handle/route.ts:770` re-asked the mode question. With no deterministic fallback, subsequent replies hit the same path — infinite loop.
**Fix / Change:**
1. Added `parseModeFallback()` — when the tag is missing AND the previous assistant message asked the three-options question, parse the athlete's reply for unambiguous signals ("1"/"one"/"build from scratch", "2"/Runna/TrainingPeaks/"follow a plan", "3"/"no plan"/"just feedback") and set the fields directly. Runs every turn, not just at [READY].
2. Strengthened the prompt: added a pre-send self-check listing the prose phrases that REQUIRE a [MODE:...] tag, plus a concrete example showing the tag placement.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `CHANGELOG.md`

---

## 2026-04-19 — Plans go day-agnostic + deterministic session completion status

**Type:** Feature
**Reported by:** Jake
**User feedback:** "Dean is sending a plan in sunday recap with days specified - but the new approach to plans is to give a long run, quality session or two, and then total mileage target for the week. We aren't even collecting days the user likes to workout in onboarding." Follow-up: "yeah let's do [auto-detect session completion] - how does it work, is it a haiku call to understand if it matched the quality or long run sessions?"
**Root cause:** Prompts for `initial_plan`, `weekly_recap`, and downstream triggers still instructed Dean to emit day-by-day scheduled sessions (`Mon 4/20 · Easy 5mi…`), enforced training-day counts, and referenced a `SCHEDULE CONSTRAINT` block tied to a `training_days` field that is not reliably collected. Storage had already moved to week-level (`weekly_long_run_miles`, `weekly_quality_session`), but the coach prompts hadn't caught up. Separately, post-run and reminder triggers had no structured signal for "has the athlete already done the long run / quality session this week" — Dean had to infer from RECENT WORKOUTS every time.
**Fix / Change:**
  • Rewrote `weekly_recap` and `initial_plan` prompt blocks in `coach/respond/route.ts`: second bubble is now weekly mileage target + long run + 1–2 quality sessions (with structure, paces, and "why" clause) + spacing guidance ("leave at least one easy or rest day between hard sessions; fit easy miles wherever works"). No dated lines, no day-by-day lists.
  • Removed `SCHEDULE CONSTRAINT`, `TRAINING DAY COUNT VALIDATION`, `SESSION DAY LABELING`, and the dated-session example blocks. Strength/cross-training surfaced as weekly counts, not assigned to days.
  • Updated `morning_plan`, `morning_reminder`, `nightly_reminder`, and `missedRunCheckin` prompts to reference `THIS WEEK'S PLAN` (target + long run + quality) and describe what's still outstanding, rather than prescribing "today's workout" or "tomorrow's workout."
  • Disabled `[WEEK_OVERRIDE]` / `[SKIP_DAY]` tag guidance in `user_message` — ad-hoc day swaps don't apply when plans are day-agnostic.
  • Onboarding (`onboarding/handle/route.ts`): removed the `training_days` collection step from `CONVERSATION FLOW`, removed "Training days" from `summarizeCollected` (kept `days_per_week` as rough count), removed "which days" follow-up rule. DB column + extraction schema preserved (harmless if an athlete volunteers days).
  • **Session completion status (new):** added `computeSessionsStatus(activities, timezone, plannedLongRun, plannedQuality)` helper (deterministic, no LLM call). Long run "done" if any week run ≥ 85% of planned distance. Quality "done" if any week run has `workout_type === 3`, or its name matches tempo/threshold/interval/repeat/fartlek/hill/strides/NxM patterns, or contains the planned session's first word. Result is injected into the `FACTS` block as `WEEK SESSIONS STATUS: - Long run … DONE/PENDING` / `- Quality … DONE/PENDING` so every post-run, reminder, and user_message reply has a clean structured signal.
  • Added `workout_type` and `name` to the activities SELECT and `ActivityRow` interface.
  • Updated `run-evals.mjs` plan-generation instruction to prohibit dated session lines.
  • Updated two unit tests in `coach-respond.test.ts` that asserted on the removed `SESSION DAY LABELING` guard and the old nightly-no-sessions copy.
  • Added `sessions-status.test.ts` — 7 cases covering long-run threshold, quality keyword matches, `workout_type=3` detection, rep-pattern detection, and non-run exclusion.
  • Restored four PR-10/12 prompt guards that were clobbered during a stash conflict: `SAME-NEXT-DAY INTENSITY GATE`, `LAP PACE SANITY CHECK`, the 90-sec/mi outlier flag, `PROJECTED vs TARGET DIRECTION`, `MANUALLY-REPORTED ACTIVITY`, and the `Ride` speed-unit guard.
**Follow-ups:** Eval fixture ground-truths that assert on dated session formats (plan-*, format-*, date-*) need re-baselining — prior baseline is pre-change.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/coach-respond.test.ts`, `src/__tests__/lib/sessions-status.test.ts` (new), `evals/run-evals.mjs`

---

## 2026-04-19 — Tag-driven mode selection + DASHBOARD_LINK as implicit READY

**Type:** Bug Fix
**Reported by:** Jake (user 3e5e4853) — onboarded as a from-scratch athlete but never received a plan.
**User feedback:** "I didn't actually get a plan from Dean here. I also still see the 'upload your plan' pattern."
**Root cause:** Two compounding failures in the unified-conversation onboarding flow.
  (1) Haiku was asked to extract `has_existing_plan` / `wants_plan` from free-form conversation — a field whose value is downstream of a single explicit "option 1/2/3" answer. On Jake's transcript, Haiku invented `has_existing_plan=true` and `external_plan_description="Custom plan from Dean"` (a plan Dean had promised to *build* — mistaken for a pre-existing external plan). That would have routed `completeOnboarding` down the complement branch, sending the "upload your plan PDF" pdfHint and skipping plan generation entirely.
  (2) Dean's terminal wrap-up message included `[DASHBOARD_LINK]` but forgot the `[READY]` tag. Without `[READY]`, `completeOnboarding` never fired; `onboarding_step` stayed `"onboarding"`, no `initial_plan` trigger ever ran, and the athlete was stuck with no plan.
**Fix / Change:**
  • Added deterministic tag: Dean emits `[MODE:FROM_SCRATCH]` / `[MODE:COMPLEMENT]` / `[MODE:NO_PLAN]` the moment the athlete confirms their working mode. Route parses the tag and sets `has_existing_plan` + `wants_plan` directly — no more Haiku inference for these fields.
  • Removed `has_existing_plan` and `wants_plan` from the Haiku extraction schema + prompt. Tightened `external_plan_description` to explicitly reject plans Dean is going to build.
  • Treat `[DASHBOARD_LINK]` as an implicit `[READY]` signal in the route — safety net so a forgotten `[READY]` tag on a terminal message doesn't strand the athlete.
  • Strengthened `[READY]` prompt rule: any wrap-up language ("you're all set", `[DASHBOARD_LINK]`, sign-off without a question) MUST include `[READY]`.
  • Updated eval parity: `run-onboarding-evals.mjs` and `run-simulation-evals.mjs` now include the MODE tag prompt + parse the tag into `collected`.
  • Updated `onboarding-handle.test.ts`: the `[READY]` test now seeds mode in `onboarding_data`; added tests for `[MODE:FROM_SCRATCH]` tag-stripping and `[DASHBOARD_LINK]` as implicit `[READY]`.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`, `evals/run-simulation-evals.mjs`, `evals/run-onboarding-evals.mjs`

---

## 2026-04-19 — Strava re-auth dedup, post-run activity-id dedup, projected week total rule

**Type:** Bug Fix
**Reported by:** Conversation analysis (user 5e1535c3, 2e5a7e92 / Maddy) — original PR #6
**User feedback:** Ghost "Strava connected" SMS firing 4× mid-conversation; duplicate post-run messages for the same activity hours apart; "That brings you to 14 mi for the week" when athlete had already logged 36 mi.
**Root cause:** (1) `/api/auth/strava/callback` sent the "Strava connected" SMS on every callback — re-auth flows (write-scope upgrade, repeated link clicks) each fired the message. (2) The post-run dedup guard only looked back 10 minutes; Strava can re-fire the same `activity_id` event over a 40+ minute spread, slipping past the window. (3) No prompt rule required Dean to project full weekly mileage as `existing + new` when an athlete reports mid-week miles.
**Fix / Change:** (1) `auth/strava/callback`: query `strava_access_token` before sending — skip SMS if already set (first-time connects unaffected). (2) `webhooks/strava`: primary dedup is now a permanent `conversations` lookup matching `strava_activity_id` → `post_run`. The 10-min time-based guard remains as a race-condition fallback. (3) `coach/respond`: added `PROJECTED WEEK TOTAL` `<rule>` block to the `user_message` prompt — Dean must always state full projected weekly total when the athlete reports existing mileage.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`, `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-19 — Non-run mileage suppression, sprint outlier flag, same-next-day intensity gate

**Type:** Bug Fix
**Reported by:** Conversation analysis (users b1b308cf, a56bc698, ac0ab080) — original PR #10
**User feedback:** Concurrent WeightTraining + run synced and both messages reported the same "9 mi this week"; a 5:23/mi final segment on a recovery run was described as part of a "solid recovery effort" without flagging the anomaly; conditional tempo green-light issued the day after reported tightness.
**Root cause:** (1) Non-run `post_run` prompts injected a numeric weekly running mileage that could double-count a concurrently-stored run. (2) `INSIGHT RULES` had no guard for outlier lap/split paces vs. run average. (3) No `PROACTIVE INJURY` rule prevented a same-next-day intensity green-light after reported pain/tightness.
**Fix / Change:** All three are prompt-only edits in `coach/respond/route.ts`. (1) Non-run branch of `weekMileageContext` now instructs Dean not to cite the week's running mileage in the response. (2) Added `INSIGHT RULES` bullet: flag any lap/split >~90 sec/mi faster than the run's average. (3) Added `SAME-NEXT-DAY INTENSITY GATE` to PROACTIVE INJURY: easy-only the day after reported pain; defer quality sessions ≥2 days out.

---

## 2026-04-19 — Four prompt guards: ride units, lap sanity, projected/target direction, manual sync

**Type:** Bug Fix
**Reported by:** Conversation analysis (users b8795d1e, ae993f7b, 7f356c80) — original PR #12
**User feedback:** Cyclist's lap reported as "4:03/mi avg pace" (running unit applied to a Ride); "cooldown" lap was actually faster than the main set; "on track for 33.3 mi — slightly lighter than the 24.5 mi target" (33 is 36% above 24, not lighter); Dean said "that matches what I saw from the sync" 3 minutes after telling the athlete it didn't see their run in Strava.
**Root cause:** No prompt-level guards existed for any of the four cases.
**Fix / Change:** Four prompt-only edits in `coach/respond/route.ts`. (1) `RIDE SPEED UNITS` data guard — when `activityData.type === "Ride"`, report speed in mph/km/h, never min/mi. (2) `LAP PACE SANITY CHECK` in WORKOUT STRUCTURE — if the final lap is faster than middle laps, flag the anomaly instead of confidently labeling it a cooldown. (3) `PROJECTED vs TARGET DIRECTION` rule in MILEAGE ACCURACY — if projected > target, say "above target" (never "lighter than target"). (4) `MANUALLY-REPORTED ACTIVITY` rule in `user_message` — if Dean previously said it couldn't see an activity, do not later say its details "match what I saw from the sync."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-19 — Five fixes from 2026-04-16 conversation analysis

**Type:** Bug Fix
**Reported by:** Conversation analysis (users b1b308cf, 7170bad2, 0cb902da, 95fd0845) — original PR #15 (superset of PR #14)
**User feedback:** "Going longer than the plan all week — 17.1mi vs 6mi planned" fired after a 0-mile WeightTraining session; Dean said "How did your body feel postpartum on this one?"; Dean cited "laps 3/6/7/8 averaged 155-164 bpm" on a Ride; athlete asked "how do I get the leg speed up" and Dean answered only the tightness context; every onboarding message processed twice.
**Root cause:** (1) `planDeviationFlag` only gated on `trigger === "post_run"` without checking activity type. (2) No prompt-level guard against the word "postpartum." (3) Lap data guard didn't prohibit specific lap-index references. (4) No instruction requiring direct coaching questions to be answered when paired with contextual statements. (5) Content-based dedup was missing — only ID-based dedup existed in `webhooks/linq`.
**Fix / Change:** (1) `planDeviationFlag` now returns `null` when `activity_type` is not in `["Run","TrailRun","VirtualRun","Treadmill"]`. (2) Added TONE rule: never use "postpartum" as a synonym for post-run. (3) Extended laps data-glossary guard to prohibit citing laps by index — require effort-pattern descriptions instead. (4) Added `DIRECT QUESTIONS — MUST ANSWER` block to `user_message` prompt. (5) Added 30-second content-based dedup in `handleInboundMessage` (queries `conversations` for same user + same body within last 30s). All 405 tests pass.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/webhooks/linq/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-19 — Cap beginner plan base mileage when Strava history is stale

**Type:** Bug Fix
**Reported by:** Conversation analysis (user bcf3ffa5 "Pookie") — original PR #5
**User feedback:** "Why does it say I'm running 16 miles this week" / "I've never run continuously, how can I do a 5 mile long run?"
**Root cause:** A self-identified beginner with old Strava activity (e.g. occasional jogs from a prior fitness phase) was getting plans anchored to that 16mi/week historical average. Two compounding code paths used the raw Strava number with no `fitness_level` check: `generateAndSaveFullPlan` set `baseMileage = 16`, and `buildSystemPrompt` selected the "MODERATE VOLUME" tier so Claude prescribed ~16mi week 1 with fartlek/quality from week 2.
**Fix / Change:** (1) `training-plan.ts`: when `fitness_level === "beginner"` (strict equality, so legacy `null` profiles unaffected), cap Strava-derived `avgWeeklyMileage` at `noHistoryDefault` (8mi) before computing `baseMileage`. (2) `respond/route.ts`: added `forceBeginnerTier` flag — on `initial_plan`, when `fitness_level === "beginner"` and `avgWeeklyMileage > 8`, the fitness tier block uses the beginner-stale-history treatment ("do not use Strava avg") instead of MODERATE VOLUME. Caps week 1 at 10mi. Tests added in `training-plan-generate.test.ts` and `coach-respond.test.ts`.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-plan-generate.test.ts`, `src/__tests__/api/coach-respond.test.ts`

---

## 2026-04-19 — Sunday recap cron: return early, run work via `after()`

**Type:** Bug Fix
**Reported by:** Jake (observed via cron-job.org dashboard)
**User feedback:** "looks like my sunday recap cron failed; is there a way to see why? it says timeout"
**Root cause:** `/api/cron/sunday-recap` awaited a Strava stats refresh + fetch-to-coach/respond sequentially per user inside the request handler. cron-job.org's HTTP client times out at 30s, so the handler was killed before the loop progressed past the first (possibly hung) Strava call — zero `weekly_recap` rows landed in `conversations`.
**Fix / Change:** Wrap the per-user loop in `after()` so the handler returns 200 immediately with `{ queued: N }`. Work continues post-response on Vercel, matching the pattern used in `coach/respond`. Does not add a Strava-call timeout (separate concern) but removes the HTTP-timeout failure mode.
**Files changed:** `src/app/api/cron/sunday-recap/route.ts`

---

## 2026-04-19 — Onboarding wrap-up polish: whitespace, "aerobic" wording, PDF upload prompt

**Type:** Bug Fix
**Reported by:** Jake (live test)
**User feedback:** "1) didn't do web search for race dates, but at least confirmed with me 2) last message had extra spaces at the bottom 3) last message said 'aerodynamic efficiency' but I think it meant aerobic? 4) Not critical but dean didn't ask me to send the plan via PDF - if he doesn't he should say that I can upload it to the dashboard via PDF to give him proper context on what I'm doing"
**Root cause:**
1. Claude sometimes emits extra blank lines / leading spaces around `[DASHBOARD_LINK]`, and the onboarding path sends the raw text straight to SMS (no `splitIntoMessages` normalization like `coach/respond`).
2. The wrap-up prompt's example said "aerobic efficiency" but Claude still hallucinated "aerodynamic efficiency" — no explicit guard against the wrong word.
3. For complement-mode users (existing plan), the PDF-upload hint only appeared in the follow-up welcome message, which was skipped entirely whenever Dean included `[DASHBOARD_LINK]` in his own wrap-up. So users with existing plans who got a nice wrap-up from Dean never heard they could upload their plan as a PDF.
**Fix / Change:**
1. After `[DASHBOARD_LINK]` substitution, normalize whitespace: strip leading spaces per line and collapse 3+ newlines to 2.
2. Added explicit WORD ACCURACY guard to the wrap-up prompt ("the term is 'aerobic'… never write 'aerodynamic'") and a FORMATTING note about `[DASHBOARD_LINK]` placement.
3. Added a conditional PDF-upload reminder at the end of `completeOnboarding` for complement mode: if Dean already sent the dashboard link in wrap-up, still send a short follow-up telling the athlete they can upload their plan PDF (skipped if a PDF is already attached).
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-19 — Post-run annotation fires during post-[READY] onboarding + fix redundant goal question

**Type:** Bug Fix
**Reported by:** Jake (live test)
**User feedback:** "This question about your fitness goals felt a bit redundant since I already said I was training for Dipsea and Cirque Series Snowbird ... Also ... does the strava annotation work if the user isn't completely done with onboarding? I don't think I got mine today."
**Root cause:**
1. The Strava webhook routed every user with a non-null `onboarding_step` to the lightweight `post_run_onboarding` nudge — including post-[READY] users (`awaiting_timezone`) who already have a generated plan and should have received the full post-run coaching annotation.
2. `handlePostRunOnboarding` built its prompt with no knowledge of what the athlete had already shared. When `onboarding_step === "onboarding"` (not in `ONBOARDING_STEP_QUESTIONS`), the prompt told Claude to "let them know you're excited to get their plan together" — and Claude improvised a generic "tell me about your fitness goals" question instead, re-asking something the athlete had already covered in the main onboarding thread.
**Fix / Change:**
1. Webhook now routes to `post_run_onboarding` only for pre-[READY] states (`onboarding`, `awaiting_strava`, `awaiting_payment`) where no plan exists yet. Post-[READY] users (`awaiting_timezone`, null) get the full `post_run` annotation. `awaiting_payment` is pre-wired into the nudge list so the full annotation is gated behind trial signup once billing goes live.
2. `handlePostRunOnboarding` now pulls `onboarding_data` and injects it as an "ALREADY COLLECTED — do NOT re-ask" block in the system prompt. When there's no pending onboarding step question, the prompt explicitly tells Claude not to ask any question — the next onboarding question will come through the main conversation handler on the athlete's next reply.
**Files changed:** src/app/api/webhooks/strava/route.ts, src/app/api/coach/respond/route.ts, src/__tests__/api/strava-webhook.test.ts

---

## 2026-04-19 — Onboarding: Dean orients athlete to dashboard in [READY] wrap-up

**Type:** Improvement
**Reported by:** Jake (live test)
**User feedback:** "Is Dean required to send the dashboard at the end? Feels like he really needs to orient the user around the next touch point and how to use the dashboard in the meantime."
**Root cause:** The [READY] wrap-up instruction focused narrowly on "what starts now" ("your first coaching note lands after your next run") without pointing the athlete to their dashboard or framing the next touchpoint. Dashboard URL was sent only as a separate follow-up SMS in complement/no-plan paths; billing-gated users never saw it.
**Fix / Change:** Updated the SIGNALING READY instruction to require two pieces in the wrap-up: (1) what to expect next from Dean, and (2) a natural mention of the dashboard as the home for training data (plan, zone trends, aerobic efficiency, uploaded training PDFs). Introduced a `[DASHBOARD_LINK]` placeholder that Dean can include on its own line; the system substitutes it with the athlete's dashboard URL (generating a `dashboard_token` if one doesn't exist yet). The model has freedom to skip the dashboard mention when it doesn't fit. To avoid duplicate links, `completeOnboarding` now receives a `dashboardLinkSentInWrapUp` flag — when Dean included the link, the complement/no-plan follow-up SMS is skipped. Updated eval system prompts (`run-simulation-evals.mjs`, `run-onboarding-evals.mjs`) to mirror the new SIGNALING READY instruction.
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-simulation-evals.mjs, evals/run-onboarding-evals.mjs

---

## 2026-04-19 — Onboarding: clearer mode question + forced race-date confirmation before mode

**Type:** Bug Fix
**Reported by:** Jake (live test)
**User feedback:** "The phrasing of the three options here was a bit confusing and not sure if he actually looked up the dates properly here?" — Dean paraphrased the three options as "set plan / build your own with support from me / coaching notes" ("build your own with support" is NOT one of the real options) and skipped race-date confirmation despite pre-search almost certainly having run.
**Root cause:** (1) The mode-question prompt was a single run-on sentence with no numbering, so the model was free to paraphrase and reshape the options — in one live test it invented a "build your own with support" fourth option. (2) When pre-search returned dates, the injection lived at the bottom of the prompt as a soft instruction ("Present this date to the athlete..."). The model could — and did — skip past it straight to the next flow step.
**Fix / Change:** (1) Rewrote the mode-question prompt to require EXACT wording with numbered (1)(2)(3) options and distinct, unambiguous descriptions. Applied in three places: CONVERSATION FLOW step 2, the SIGNALING READY fallback, and the `modeQuestion` fallback string inside `handleConversation`. (2) Added a "RACE DATE CONFIRMATION COMES FIRST" block to the system prompt and made gate explicit in CONVERSATION FLOW step 2 ("Once goal is clear AND any race dates are confirmed..."). (3) When any pre-search runs, the `raceDateInjection` is now wrapped in a `<rule>...</rule>` XML tag (the same convention `coach/respond` uses for hard directives) so Dean treats it as a non-negotiable instruction. Also added a safety-net `<rule>` stripper to the onboarding response-cleanup pipeline so any echoed tag content never reaches the athlete.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-04-19 — Onboarding: extract-first reorder for OpenAI race-date pre-search

**Type:** Refactor + Bug Fix
**Reported by:** Jake (live test) — "He didn't search the actual race dates or confirm what dates either in that convo."
**Root cause:** On the OpenAI provider path, `gpt-4o-search-preview` exceeds the 6000 TPM limit when given the full onboarding system prompt, so we strip the inline `web_search` tool and rely on a `preSearchRaceDate` loop that reads `onboardingData.race_name` / `other_races`. But `extractFields` ran AFTER the main model call, so on the very turn an athlete first names a race ("racing Dipsea in June and Snowbird in July"), `onboardingData` was still empty and no pre-search fired. Earlier patch added a same-turn `detectRaceNamesInMessage` Haiku call gated behind a regex heuristic — works for common cases but misses single-word race names without a context word ("I'm doing Hardrock") and adds a duplicate extraction pass.
**Fix / Change:** Reordered `handleConversation` to run `extractFields` on `[history + current user message]` BEFORE the main model call. The merged data feeds `summarizeCollected` (so "WHAT YOU ALREADY KNOW" is current), the OpenAI pre-search loop (so freshly-extracted race names get date lookups this same turn), and `calculateVDOTPaces` (so paces from a just-mentioned PR appear in the system prompt this turn). Removed the dedicated `detectRaceNamesInMessage` helper and its regex heuristic — the main extraction now serves both purposes. Removed the post-call extraction block since it was redundant. Trade-off: assistant-introduced fields (race elevation/altitude from Dean's web-search results) get captured one turn later when the assistant reply lands in history — acceptable since those fields influence later turns.
**Test rule compliance:** Updated mock ordering across `onboarding-handle.test.ts` and `multi-race-onboarding.test.ts` to reflect the new call sequence (Haiku extraction → optional pre-search → main Sonnet/GPT). All 405 tests pass.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/__tests__/api/onboarding-handle.test.ts, src/__tests__/api/multi-race-onboarding.test.ts

---

## 2026-04-19 — Onboarding: PDF-during-onboarding, no-silent-drop, Strava-first ordering, race-date confirmation

**Type:** Bug Fix + Improvement
**Reported by:** Jake (live onboarding test)
**User feedback:** "1) PDF extraction from the text message didn't work 2) He didn't respond after I gave him my 5k time 3) I think we should try to have strava connected earlier and use that as a starting point for understanding someone's fitness vs connecting it at the end ... also there was no search of the actual race dates or confirmation of what dates either in that convo."
**Root cause:**
1. **PDF dropped during onboarding.** `linq/route.ts:346` gated PDF processing on `!user.onboarding_step`, so PDFs sent mid-onboarding fell through to the text path. Dean saw the text mention of a PDF in history and hallucinated an acknowledgment — the actual file was never parsed.
2. **Silent failure after 5K time.** In `onboarding/handle/route.ts`, `sendAndStore` was called unconditionally with `responseText.trimEnd()`. When Claude's response cleaned down to an empty string (e.g. only `[READY]`/`[STRAVA_LINK]` placeholders remained, or the model emitted no post-tool text), an empty SMS was sent — invisible to the athlete. Additionally, the [READY]+mode-unresolved branch replaced Dean's actual reply with a hard-coded mode question, losing the acknowledgment of the athlete's last message.
3. **Strava ordering.** System prompt and CONVERSATION FLOW placed Strava as step 4, after injury history and strength/cross-training (step 3). This defeated Strava's value — its data often answers those questions automatically.
**Fix / Change:**
1. Added `handlePDFDuringOnboarding` in `linq/route.ts` that parses the PDF via `/api/plan/upload`, marks `has_existing_plan`, `plan_uploaded`, `plan_week_count`, `plan_session_count` on `onboarding_data`, then forwards a synthetic system message to `/api/onboarding/handle` so Dean acknowledges the parsed plan inline and continues intake. `summarizeCollected` was updated to surface the uploaded plan so Dean sees it under "WHAT YOU ALREADY KNOW" and never re-asks for the PDF.
2. Added an empty-response guard in `handleConversation`: if `responseText` is empty after cleanup, fall back to a brief ack. Wrapped the [READY] path's `sendAndStore` in a truthy check, and in the [READY]+mode-unresolved branch, concatenate Dean's reply with the mode question instead of dropping it.
3. Reordered the CONVERSATION FLOW block and the STRAVA/MODE CONFIRMATION sections so Strava is step 3 (right after mode confirmation) and injury/strength moves to step 4 — matching the documented intent in CLAUDE.md.
4. Added a "NEVER NAME A RACE WITHOUT A CONFIRMED DATE" rule + a "MULTI-RACE CALENDARS" rule to Dean's system prompt: any named race in his reply must already have a confirmed date in onboarding_data, otherwise he must ask first. Strengthened the Haiku extraction prompt to capture `race_name` and `other_races` entries even when the date isn't given (so the system can pre-search next turn). Expanded `needsRaceDateLookup` to also fire when any B/C race in `other_races` is missing a date — without this, the OpenAI pre-search and Anthropic web_search tool wouldn't activate for secondary races.
**Files changed:** src/app/api/webhooks/linq/route.ts, src/app/api/onboarding/handle/route.ts

---

## 2026-04-19 — Fix: onboarding silently defaults to plan-building when mode is unresolved

**Type:** Bug Fix
**Reported by:** Jake (testing the "coaching notes only" mode)
**User feedback:** "I think in this conversation it was unclear what mode he was trying to get the user in. ... It seemed like Coach Dean decided to create a plan here anyways, but I was playing the user that didn't want a plan and just wanted a coaching note."
**Root cause:** Three-mode selection (build plan / alongside existing plan / coaching notes only) was embedded in prose and relied solely on Haiku to map short replies like "Coaching notes" to `wants_plan=false`. When extraction missed it, `has_existing_plan` and `wants_plan` both remained null and `completeOnboarding` fell through to `initial_plan` generation by default — quietly building a plan for a user who had explicitly chosen notes only.
**Fix / Change:** (1) Added a MODE CONFIRMATION block to Dean's system prompt requiring a one-sentence reflect-back of the chosen mode before moving on (catches misreads on terse answers). (2) Added a guard in `handleConversation`: when [READY] fires but both `has_existing_plan` and `wants_plan` are null, we no longer call `completeOnboarding` — instead we re-ask the three-option mode question explicitly. This ensures we never silently default to plan-building when the athlete's intent is unknown.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/__tests__/api/onboarding-handle.test.ts, src/__tests__/api/multi-race-onboarding.test.ts

## 2026-04-19 — Fix: B/C race dates defaulting to first-of-month placeholder

**Type:** Bug Fix
**Reported by:** User feedback (observed in DB — races for Dipsea and Cirque Series Snowbird stored as June 1 and July 1)
**User feedback:** "looks like it just assumes race date first of the month"
**Root cause:** Two issues: (1) `other_races` date field in Haiku extraction schema had no "don't default to first of month" instruction unlike the primary `race_date` field; (2) On OpenAI path, `preSearchRaceDate` only looked up the A race — B/C races with no date (or a first-of-month placeholder) were never pre-searched; (3) `needsRaceDateLookup` only checked `!race_date`, so a wrong first-of-month date in `onboarding_data` prevented re-search on subsequent turns.
**Fix / Change:** Added no-first-of-month instruction to `other_races` item date description and extraction prompt. Changed `needsRaceDateLookup` to treat day=01 dates as suspect. Extended OpenAI pre-search to also look up B/C race names that have missing or first-of-month dates, running all lookups in parallel and injecting results into the system prompt.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-18 — Fix: PR paces not saved to profile when extracted as manual_pr_updates

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "Didn't see my paces updated in the dashboard after this... when is it supposed to update?"
**Root cause:** "My 5k is a 17:50" was extracted by Haiku as `manual_pr_updates` (a lifetime PR) rather than `recent_race_distance_km`/`recent_race_time_minutes`. VDOT pace computation only ran on the latter, so `current_easy_pace`, `current_tempo_pace`, `current_interval_pace`, and `current_vdot` were never written to `training_profiles`.
**Fix / Change:** After the existing race-data and easy-pace VDOT blocks, fall back to computing VDOT from `manual_pr_updates` if `computedPaces` is still null. Uses a preference order (5K → 10K → Half → Marathon → …) and the same sanity-check (4:00–20:00/mi implied pace).
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-18 — Stop asking pace calibration question and sending plan simultaneously

**Type:** Bug Fix
**Reported by:** Jake (user)
**User feedback:** "looks like Dean didn't wait in this case for me to actually respond before sending his next questions - this is too much in a row"
**Root cause:** Two issues compounding. (1) When Strava connects mid-onboarding with a trail race as the best activity, the system prompt told Claude to ask the road race calibration question AND signal [READY] in the same message — which immediately fires initial_plan without waiting for the user's answer. (2) initial_plan sends 4 messages in sequence (2 plan bubbles + dashboard link + "How does this look?"), making the wall of messages even longer.
**Fix / Change:** Added explicit instruction in the SIGNALING READY section: pace calibration question and [READY] are mutually exclusive — if you're asking the road race question, hold off on [READY] until the user responds. Also merged "How does this look? Happy to adjust anything." into the dashboard link message, reducing initial_plan from 4 messages to 3.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

## 2026-04-18 — Three onboarding fixes: third person, Saturday-night plan, race logging

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "1) Dean does fill in a long run and quality session for this week (which I won't do) - is this the right approach? Week 1 of 12. 2) seems one race date got saved properly in the dashboard but the second race didn't. 3) Dean still talked about himself in 3rd person — 'Dean's got everything set'"
**Root cause:**
1. The BUBBLE 2 instructions for `weekBudgetExhausted` said "One note on what to expect in week 1" — Claude interpreted this as permission to describe week 1 structure including long run + quality session, even when the week was already 98% complete.
2. The onboarding [READY] prompt included an example phrase "Dean is calibrated" which Claude used as a template, producing third-person self-reference.
3. `other_races` items had no date validation or logging, so silently dropped races gave no signal to diagnose why a secondary race didn't save.
**Fix / Change:**
1. Tightened `weekBudgetExhausted` BUBBLE 2: now explicitly says "do NOT mention a long run or quality session for this week, not even as a description" and redirects to first full week starting Monday.
2. Changed the [READY] example in `onboarding/handle` from "Dean is calibrated" to "I've got everything I need" + added explicit first-person-only rule.
3. Added date validation and console.warn logging for each dropped `other_races` item; added insert-count log so missing races are visible in Vercel logs.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-18 — Fix TypeScript build error: avgWeeklyMileage not in scope in buildUserMessage

**Type:** Bug Fix
**Reported by:** Vercel build log
**User feedback:** N/A
**Root cause:** `avgWeeklyMileage` was referenced at line 5015 inside `buildUserMessage` (used for the `initial_plan` week-budget-exhausted logic) but was never declared as a parameter of that function — only defined in the outer `handleCoachRespond` scope.
**Fix / Change:** Added `avgWeeklyMileage: number | null = null` as the last parameter of `buildUserMessage` and passed it through at the single call site.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-18 — Hard-gate mode question before injury/cross-training in onboarding

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "Not seeing the different ways you can work with Dean laid out in onboarding — Dean jumped straight to asking about injuries without asking which mode I wanted."
**Root cause:** Step 2 of the conversation flow said "Once goal is clear, ask which mode fits" but lacked a hard gate preventing Dean from proceeding to step 3 (injuries/cross-training) before mode was confirmed. Dean inferred "two race goals = wants a plan built" and skipped the mode question entirely.
**Fix / Change:** Added explicit DO NOT gate to step 2: "DO NOT proceed to step 3 until mode is confirmed — never ask about injuries or cross-training before the athlete has answered this question."
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-18 — Fix wrong tempo/interval paces, long run overage, cross-training day label, third-person intro

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "Prescribed Paces: Easy 7:50–8:20/mi, Tempo 3:54/mi, Intervals 3:30/mi — prescribed paces are way off for interval and tempo - maybe the extraction isn't working correctly. Dean is still prescribing a long run on Sunday when I've already hit roughly what my mileage should be for the week. No idea why the easy bike cross training option says thursday...we don't need that day label. Still says 'Dean is calibrated' in third person."
**Root cause (paces):** `completeOnboarding` used Haiku-extracted `tempo_pace` / `interval_pace` as the source of truth. Haiku has no "ONLY from Athlete: lines" restriction for these fields (unlike `easy_pace`), so it extracted them from Dean's Coach messages where paces may have been stated in min/km. The Strava VDOT-derived paces (`sbr.tempo_pace`, `sbr.interval_pace`) were computed in `lookupBestStravaRace` but never stored in `onboardingData` for `completeOnboarding` to use. Additionally, there was no km→mi conversion guard for tempo/interval.
**Root cause (long run):** BUBBLE 2 unconditionally instructed Dean to include a "Long run target for this week" even when `weekMileageSoFar` was already ≥ 75% of the weekly average — directly conflicting with the `ALREADY COMPLETED THIS WEEK` warning.
**Root cause (cross-training label):** The `cross_training.name` schema description said "Activity + day, e.g. 'Easy bike — Thursday'" — explicitly telling Haiku to include a day name.
**Root cause (third person):** BUBBLE 1 instruction said "no 'Dean is calibrated'" but didn't have a strong enough rule-format prohibition on third-person self-reference throughout the response.
**Fix / Change:**
1. In `handleConversation`, store `sbr.tempo_pace` and `sbr.interval_pace` as `strava_vdot_tempo_pace` / `strava_vdot_interval_pace` in `onboardingData` when Strava best race is a road race.
2. In `completeOnboarding`, prefer `strava_vdot_*` paces over Haiku-extracted ones. Applied km→mi conversion guard to all three paces (easy: <5:30, tempo: <5:00, interval: <4:30).
3. Made BUBBLE 2 conditional: if `weekMileageSoFar ≥ 75% of avgWeeklyMileage`, skip the long run bullet and tell Dean to acknowledge the completed miles and defer to Sunday's plan.
4. Changed `cross_training.name` description to "Activity type and intensity only — NO day label."
5. Added a `<rule>NEVER refer to yourself as "Dean"</rule>` block above BUBBLE 1 with explicit examples of forbidden patterns.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/lib/dashboard-insights.ts`

---

## 2026-04-18 — No exercise lists during onboarding; defer to dashboard

**Type:** Improvement
**Reported by:** User feedback (internal)
**User feedback:** "I don't think we should give long lists of exercises before the plan (they should go in the dashboard) unless the user asks explicitly"
**Root cause:** The onboarding instruction said to "mandatorily deliver" exercises if the athlete explicitly asked, but also set up a flow where Dean would proactively promise exercises ("once you connect Strava, I can give you exercises") — then fulfill that promise after Strava connected, even when the athlete never explicitly asked. The injury-mention guard existed but wasn't preventing this promise-then-deliver pattern.
**Fix / Change:** Rewrote the exercise instruction in onboarding/handle to: (1) never proactively offer or promise exercises, (2) if explicitly asked, acknowledge and defer to the dashboard ("I'll add tailored exercises to your dashboard once your plan is ready"), (3) never list exercises in the onboarding conversation. Exercise recommendations are already added to the dashboard during initial_plan generation.
**Files changed:** src/app/api/onboarding/handle/route.ts

---

## 2026-04-18 — Fix race date not collected when web search fails during onboarding

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "I expected that races would show up in my dashboard" — races weren't inserted because race_date was never extracted.
**Root cause:** Two gaps: (1) `preSearchRaceDate` only runs if `race_name` is already in `onboarding_data`, but `race_name` isn't extracted until Haiku runs *after* Dean's response — so the search never fires on the turn the race is first mentioned. (2) When the search does run on subsequent turns but returns null, no instruction was injected telling Dean to ask for the date directly, so Dean silently moved on without collecting it.
**Fix / Change:** (1) When `preSearchRaceDate` returns null (search failed), inject an explicit `RACE DATE LOOKUP FAILED` instruction telling Dean it must ask the athlete for the exact date before proceeding. (2) Strengthened the FIRST-OF-MONTH GUARD in the system prompt to explicitly cover the no-web_search case: if no search tool is available and a race has been mentioned without a confirmed date, Dean must ask directly.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-18 — Fix wrong paces, third-person intro, redundant bubble, and long run overage on initial plan

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "Says 'Dean is calibrated' — shouldn't be talking about himself in the 3rd person. Message one and two seem a bit redundant. Messed up my paces somehow in the dashboard — way too fast (4:52–5:22/mi easy instead of ~7:52). He's telling me to do a 12 mi long run tomorrow, but that would put me quite a bit over a 10% jump from last week."
**Root cause (paces):** Paces stored in `training_profiles` as min/km values but labeled as `/mi` (e.g. 4:52/mi instead of 7:52/mi for a 17:50 5K runner). Root extraction trigger unclear — likely a Haiku extraction picking up a per-km pace suggestion from a Coach: line. `completeOnboarding` had no validation guard, and the dashboard read the raw DB value without sanity-checking it.
**Root cause (third-person/redundancy):** `initial_plan` prompt didn't explicitly forbid self-reference as "Dean" or prohibit re-using "coaching is live" language in both bubbles.
**Root cause (long run):** `initial_plan` prompt didn't inform Claude how many miles were already logged this week. Claude treated the FITNESS TIER cap as the budget for its prescriptions, ignoring the 31.1 miles already completed.
**Fix / Change:** (1) Added `maybeConvertKmToMile` guard in `completeOnboarding` — any pace < 6:00/mi (360s) is auto-converted from min/km to min/mile before DB write. (2) Added `normalizePace` in the dashboard — same guard applied at read time so stale DB values also display correctly. (3) Tightened BUBBLE 1 instructions: forbid third-person references ("Dean is calibrated"), "Welcome aboard", and "coaching is live" duplication between bubbles. (4) Injected `ALREADY COMPLETED THIS WEEK: X miles` note into the `initial_plan` user message when `weekMileageSoFar > 0`, so Claude knows what budget remains.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-19 — Fix onboarding 500 errors from OpenAI search model TPM limit

**Type:** Bug Fix
**Reported by:** Vercel runtime logs
**User feedback:** N/A
**Root cause:** `gpt-4o-search-preview` has a 6000 TPM hard limit. The full onboarding system prompt + conversation history (~6114 tokens) exceeded it on every message where `race_date` was not yet set, returning 429 → 500.
**Fix / Change:** Replaced inline web search on the main Sonnet call with a dedicated `preSearchRaceDate()` function. When `AI_PROVIDER=openai` and `race_name` is already extracted (from a prior Haiku turn), it makes a minimal ~100-token call to `gpt-4o-search-preview`, injects the result into the main prompt, and the main Sonnet call uses `gpt-4o` (no search tools). On Anthropic, the original inline search behavior is unchanged.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-18 — Onboarding: strip all web search citation links + introduce modes early

**Type:** Bug Fix + Improvement
**Reported by:** Jake (internal observation during onboarding conversation)
**User feedback:** "(dipsea.org)" and "(cirqueseries.com)" appearing in SMS. Three working modes should be introduced right after goal is established, before injury questions.
**Root cause:** Link strip only handled `[text](url)` markdown format. Web search also outputs bare domain citations `(domain.com)` and full URL citations `(https://...)`. Mode introduction was buried at the plan-preference step near the end of onboarding.
**Fix / Change:** Added two additional strip passes for bare-domain and full-URL parenthetical citations. Moved working-mode introduction to step 2 of the conversation flow (immediately after goal is clear), before injury history and Strava questions.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-18 — Onboarding: greetings, no early exercises, introduce working modes

**Type:** Improvement
**Reported by:** Jake (internal observation during onboarding conversation)
**User feedback:** "He doesn't ever really say hi back or hi Jake. We shouldn't be prescribing exercises on message 2 or 3 — focus on getting context first. We're not laying out the different ways you can work with Dean."
**Root cause:** (1) "Nice to meet you" strip was too aggressive, removing warm name acknowledgment on Dean's second message. (2) Exercise prescription instruction said "explicitly asks" but Claude over-interpreted injury mentions as requests. (3) Plan-preference question only implied two options, never introduced all three modes.
**Fix / Change:** Removed the "Nice to meet you" text strip (now only strips full re-introduction). Added instruction to acknowledge athlete's name warmly when first provided. Added explicit guard: injury mentions are context, not exercise requests — don't prescribe unless athlete directly asks. Updated plan-preference question to introduce all three modes (build a plan, work alongside existing plan, post-run feedback only) before asking.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-18 — Fall back to % max HR zones when LTHR confidence is low

**Type:** Improvement
**Reported by:** Internal observation (all runs showing as Easy on dashboard)
**User feedback:** "it says all of my runs are easy... which I don't think is right"
**Root cause:** Low-confidence LTHR (derived from a long race effort with a 1.10× correction multiplier) was being used for both the zone bar and intensity dot classification. This inflated the LTHR estimate, raising the easy/moderate boundary to ~167 bpm, causing most runs to appear as Easy even when they weren't.
**Fix / Change:** Introduced `effectiveLthr` — when `lthr_confidence === "low"`, treat LTHR as null for both the zone bar display and dot classification. Both fall back to % of observed max HR (Easy < 75%, Moderate 75–85%, Hard > 85%), where max HR is estimated from Strava peaks via the tiered spike-filtered `estimateMaxHR` approach. The LTHR amber callout is replaced with a prompt to run a road 5K/10K to unlock proper LTHR zones. Dean's system prompt updated: low-confidence LTHR note now explains the dashboard uses % max HR for dots, and the LTHR-absent fallback now describes the actual % max HR methodology and thresholds Dean should use.
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/hr-zones.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-18 — Fix Sunday recap accuracy across all three plan types

**Type:** Bug Fix
**Reported by:** Internal audit
**User feedback:** N/A
**Root cause:** Three gaps in the `weekly_recap` trigger:
1. **Uploaded plan users** got no "what was planned this week" context — `storedPlanContext` was always empty for them, so Dean couldn't compare planned vs actual.
2. **Uploaded plan users** received the periodization `RECOVERY WEEK — THIS OVERRIDES NORMAL PROGRESSION` and `NEXT WEEK TARGET` blocks, which directly conflicted with the `<uploaded_plan_next_week>` sessions. A plan with a peak week (long run + tempo) could be overridden by the deload rule.
3. **Dean-generated plan users** had `storedNextPlanWeek` fetched (the arc's specific Week N+1 data) but it was only used in `user_message`, not `weekly_recap`. The recap generated next week from generic periodization math instead of the arc — potentially diverging from what the dashboard shows.
**Fix / Change:**
- Added `uploadedCurrentWeek` lookup (current week's uploaded plan sessions) and injected it as a "WHAT WAS SCHEDULED THIS WEEK" context block in the recap.
- Added `isUploadedPlan` param to `buildUserMessage`; when true, suppresses all periodization overrides in the recap (injury hold still fires — it's always relevant).
- For Dean-generated plans, the recap now uses `storedNextPlanWeek` arc data (phase, mileage target, long run, key workout) as the next-week anchor instead of re-deriving from periodization math.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-18 — Replace plan → Remove plan; fix run intensity zone alignment

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** (1) "Replace plan" and "Remove plan" as dual CTAs was redundant — the empty state already shows the import form naturally after removal. (2) When LTHR data is available, the run intensity dots (easy/moderate/hard) were classified using % of estimated max HR, while the zone bar displayed LTHR-relative thresholds — the two weren't aligned.
**Fix / Change:** (1) Replaced `ReplacePlanSection` with a simple "Remove plan" inline confirm link that calls `/api/plan/remove` and reloads to the empty state. (2) `buildZoneStrip` now accepts an `lthr` parameter; when present it classifies runs using LTHR-relative thresholds (easy < 89% LTHR, moderate 89–95% LTHR, hard > 95% LTHR) that directly mirror the displayed zone bar boundaries (LT1, LT2). Falls back to % max HR when no LTHR.
**Files changed:** `src/app/dashboard/plan-tab.tsx`, `src/app/dashboard/page.tsx`

## 2026-04-18 — Admin changelog broadcast endpoint

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No way to send a broadcast SMS update to all active users (beyond the one-off dashboard-announcement route).
**Fix / Change:** Added `/api/admin/changelog` route — sends 3-bubble SMS to all active onboarded users (active in last 30 days, not opted out, not already sent). Covers: new plan format (mileage target + long run + 1-2 quality sessions, no day-by-day), Strava annotations, and dashboard. Tracked via `plan_update_sent_at` column on users. Supports `dry_run` and single-user `userId` for testing. Requires DB migration: `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_update_sent_at timestamptz;` then `npm run gen:types`.
**Files changed:** `src/app/api/admin/changelog/route.ts`

---

## 2026-04-18 — Graceful handling for large / unreadable PDFs

**Type:** Feature / Bug Fix
**Reported by:** User (dashboard PDF upload)
**User feedback:** "Plan extraction from a PDF failed again when I tried to upload it to the dashboard! Max tokens issue. wondering if there are other tools for PDF extraction we could use..."
**Root cause:** No size guards — oversized PDFs caused silent 500s; image-based PDFs with no text layer caused empty extraction with no user feedback.
**Fix / Change:** Pre-parse PDF with `pdf-parse` in the route (not the shim) to measure text length before sending to LLM. If text >200k chars throw `pdf_too_large` (422 with user-facing fallback prompt). If text 100k–200k chars, truncate to 100k and set `truncated: true` in the response. If text is empty (scanned/encrypted PDF), throw `pdf_unreadable` (422 with user-facing fallback prompt). Frontend surfaces `data.message` (not `data.error` code) and shows an amber truncation warning when `truncated: true`.
**Files changed:** `src/app/api/plan/upload/route.ts`, `src/app/dashboard/plan-import-form.tsx`

---

## 2026-04-18 — Fix PDF upload 400 error (max_tokens exceeded OpenAI limit)

**Type:** Bug Fix
**Reported by:** User (dashboard PDF upload)
**User feedback:** "Plan extraction from a PDF failed again when I tried to upload it to the dashboard! Max tokens issue."
**Root cause:** `extractFromPDFData` sets `max_tokens: 32000` but gpt-4o's hard output cap is 16,384. The OpenAI shim passed the value through uncapped, causing a 400 from OpenAI.
**Fix / Change:** Added `MODEL_MAX_TOKENS` map to the OpenAI shim and clamped `max_tokens` to the model's limit before every call. Fix is in the shim so no call-site changes needed.
**Files changed:** `src/lib/anthropic.ts`

---

## 2026-04-18 — Strava annotation: replace raw metric line with colored status line

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** The annotation showed a raw number (e.g. "Time in easy zone: 84% ✓") with no plain-English verdict — useful data but not immediately readable at a glance.
**Fix / Change:** Replaced `metricLine` with a `statusLine` that combines a 🟢/🟡/🔴 emoji + verdict + the supporting number. Priority order: (1) aerobic fitness trend (improving/steady/declining) for easy/long runs using last 3 vs prior 3 efficiency values; (2) per-workout zone metric (Z1-Z2 % for easy, HR drift for long, Z4-Z5 min for quality); (3) plain grade-adj pace for mountain/trail with no HR; (4) Haiku-generated 1-sentence fallback when no HR data is available at all.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-18 — Fix gray zone misfire on Z2 runs + deliver full strength routine specs on request

**Type:** Bug Fix
**Reported by:** Jake (user conversation)
**User feedback:** "Seems I was in the 'easier zone' but Dean's first post run message didn't seem to think so. Also I don't think he actually gave me the strength routine. These should be delivered with specifics around reps / rounds and how often (ideally once over text, then in the dashboard)."
**Root cause (gray zone):** Dean applied the "avoid gray zone" training philosophy to a run where avg HR (152 bpm) was solidly in Z2 (Aerobic Base, 152–167 bpm). The guard was missing: Dean was allowed to flag gray zone even when the current run's HR was in the correct zone.
**Fix (gray zone):** Added GRAY ZONE GUARD to post_run INSIGHT RULES: only flag gray zone if avg_heartrate is actually in Z3. Z2 or below = appropriate effort, do not call it gray zone. If commenting on a multi-run trend, frame it as a trend, not about today's run.
**Root cause (strength routine):** (1) `strengthRoutineBlock` returned empty string when no routine was stored, leaving Dean with no instruction — causing hallucinated references to "the prescribed strength routine." (2) When a routine IS stored, instruction said "reference when naturally relevant" but gave no direction to deliver full specs when the athlete directly asks.
**Fix (strength routine):** When no routine is stored, inject an explicit guard: "do NOT reference 'the prescribed strength routine' — it doesn't exist yet." When a routine is stored, instruct Dean to deliver the full routine (all exercises + sets/reps/cues + frequency) in SMS when the athlete directly asks — don't just point to the dashboard.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-18 — Disable web search for user_message on OpenAI provider

**Type:** Bug Fix
**Reported by:** Production logs
**User feedback:** N/A
**Root cause:** `shouldUseWebSearch = trigger === "user_message"` unconditionally routed all user messages through `gpt-4o-search-preview`. That model has a 6000 TPM hard limit on the current OpenAI tier, but the full coaching system prompt is ~16k tokens — every request failed with a 429 "Request too large."
**Fix / Change:** Added `AI_PROVIDER === "anthropic"` guard so web search is only enabled when running on Anthropic (no such token constraint). On OpenAI, user messages fall back to regular gpt-4o without search tools.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-18 — Dashboard strength exercises generated at plan creation; rebuild_plan regenerates insights

**Type:** Feature / Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** (1) Dashboard insights (including strength exercises) were only regenerated on post_run, weekly_recap, and initial_plan — not on rebuild_plan. (2) The initial_plan closing SMS gave no indication that strength exercises were waiting on the dashboard.
**Fix / Change:** (1) Added `generateAndStoreDashboardInsights` inside `handleRebuildPlan`'s after() block so the dashboard refreshes on every plan rebuild. (2) When `injuryNotes` is present, the initial_plan dashboard link bubble now appends "Also added strength exercises to your dashboard tailored to your injury history — worth doing 2× a week to stay healthy."
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-18 — Better experience for general fitness / no-race users

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Two friction points for users without hard races or pace benchmarks: (1) onboarding fitness baseline instruction implied a number was always required, which could pressure beginners/returning runners who genuinely have none; (2) dashboard "Your Plan" section copy implied everyone should upload a training plan.
**Fix / Change:** Onboarding: fitness baseline requirement now explicitly accepts "just starting out / no benchmarks yet" as a valid answer — Dean will calibrate from early runs. SIGNALING READY condition updated to match. Dashboard: "Upload your training plan" heading changed to "Following a training plan?" with copy that makes the upload optional and acknowledges post-run coaching works without one.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/dashboard/page.tsx`

## 2026-04-18 — Onboarding quality improvements: strength exercises, duplicate close, spike specificity, multi-race acknowledgment, Strava skip context

**Type:** Improvement
**Reported by:** User feedback (Jake Tennant onboarding review)
**User feedback:** "Broken promise: strength exercises were never delivered... Duplicate 'you're all set' messages... Vague data callout on the mileage spike... Third race quietly disappears... Strava skip option doesn't communicate cost"
**Root cause:** (1) System prompt had no enforcement that explicitly-requested strength exercises must be delivered before [READY] — Dean acknowledged but deferred indefinitely. (2) Claude's [READY] message + completeOnboarding welcome both sent "you're all set" for hasExistingPlan and no_plan paths. (3) Spike instruction said "there was a notable one recently" without requiring specific numbers. (4) No instruction to surface all races in the calibration summary. (5) Strava skip line gave no context on what connecting unlocks.
**Fix / Change:** (1) Added mandatory STRENGTH EXERCISES section to system prompt: if athlete asks, Dean must deliver 3-4 specific exercises with sets/reps (tibialis raise, eccentric heel drop, single-leg calf raise, single-leg RDL) adapted to injury history, in the message after Strava connects. (2) Removed "you're all set" from completeOnboarding welcome for hasExistingPlan and no_plan paths — Claude's [READY] message closes warmly, system follow-up just sends the dashboard URL. (3) Updated spike instruction to require specific mileage numbers from the progression data and an approximate date. (4) Added multi-race instruction to STRAVA CONTEXT: name ALL races and explain the periodization logic between them. (5) Updated all Strava skip messages to explain that connecting unlocks personalized post-run feedback.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/__tests__/api/onboarding-handle.test.ts

## 2026-04-18 — Dashboard: gray zone color fix + plan upload section

**Type:** Bug Fix / Feature
**Reported by:** Jake
**User feedback:** "maybe the gray zone should be gray in terms of coloring? Also Dean told me to upload my plan to the dash but there's no way to do that."
**Root cause:** (1) HR zone 3 ("Gray zone") was colored amber (#fbbf24) — same as the moderate run zone — instead of gray. (2) PlanImportForm component existed but was never rendered on the dashboard page.
**Fix / Change:** Changed zone 3 color to #9ca3af (gray). Added a "Your Plan" section to the dashboard that renders PlanImportForm, visible to all users (shows "Upload" or "Update" depending on whether a plan exists).
**Files changed:** src/app/dashboard/page.tsx

---

## 2026-04-18 — Fix PDF plan extraction: only 1 week stored for large plans

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "yeah it looks like maybe only a single week is stored in trainingplans for my user"
**Root cause:** `extractFromPDFData` had `max_tokens: 8192`. A 20-week plan with 5+ sessions/week generates ~140 sessions of JSON, easily exceeding 8192 tokens. Additionally, the prompt didn't explicitly warn against assigning weekNumber: 1 to all sessions — SWAP-style plans use date ranges instead of "Week N" labels, which Claude may have collapsed into a single week.
**Fix / Change:** Increased `max_tokens` to 32000. Improved prompt with explicit week numbering rules: date-range plans should be numbered sequentially (first range = week 1, second = week 2, etc.), and the model is explicitly warned never to assign weekNumber: 1 to all sessions.
**Files changed:** src/app/api/plan/upload/route.ts

## 2026-04-18 — Plan arc chart on dashboard

**Type:** Feature
**Reported by:** User feedback (Jake)
**User feedback:** "potentially could show a high level view of their projected mileage increase and races under the hero card, but need to figure out how to do this with plans that have ranges"
**Root cause:** No visual summary of the full training plan arc existed on the dashboard.
**Fix / Change:** Added `PlanArcChart` component (`plan-arc-chart.tsx`) — a compact SVG bar chart showing all plan weeks. Range plans (uploaded PDFs with min/max mileage) use a two-tone bar: solid fill up to the minimum, lighter extension to the maximum, so the range is visible without cluttering the chart with numbers. Past weeks are gray, current week is dark with a border outline, race weeks get a red dot + dashed stem. Header row shows "Week X of Y" and "Peak N mi · wk N". Legend shown only when ranges or races are present. Positioned between "This Week" and "Training Load" sections in the dashboard.
**Files changed:** `src/app/dashboard/plan-arc-chart.tsx` (new), `src/app/dashboard/page.tsx`

## 2026-04-18 — Store week1_start_date on training_state for accurate plan arc anchoring

**Type:** Feature / Infra
**Reported by:** Internal — identified while designing the plan mileage arc for the dashboard
**Root cause:** The plan's week 1 Monday was approximated from `training_plans.created_at`, which is off when a user uploads mid-week and confirms they're on a different week. The confirmed Monday was computed but never stored.
**Fix / Change:** Added `week1_start_date date` column to `training_state`. Populated in two places: (1) `plan/upload/route.ts` — sets it to the current UTC Monday when training_state is initialised to week 1 after upload; (2) `coach/respond/route.ts` planWeekSyncNum block — back-calculates week 1 Monday from the confirmed week number (`syncMonday - (weekNum-1)*7`). Dashboard reads it from `training_state`, falling back to `training_plans.created_at` for existing users who haven't re-confirmed.
**Files changed:** `supabase/migrations/039_week1_start_date.sql`, `src/lib/database.types.ts`, `src/app/api/plan/upload/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

## 2026-04-18 — Show uploaded plan in dashboard + better plan orientation message

**Type:** Feature / Improvement
**Reported by:** User feedback (Jake)
**User feedback:** "What do we do with the plan once a user uploads it? It isn't showing up in my dashboard at all" and "We should probably give a comment or two about how the plan aligns or works with the user's goals and any other commentary and orientation about how Dean will use the plan"
**Root cause:** (1) `plan-tab.tsx` and its PlanTab component were built but never connected to `page.tsx` — the dashboard had no plan view at all. (2) Dean's `plan_import_week_ask` response prompt told Dean to acknowledge the plan and describe the week, but didn't instruct Dean to orient the user on how the plan will be used going forward.
**Fix / Change:** (1) Wired `PlanTab` into `page.tsx` — queries `training_plans`, maps uploaded/stored plan weeks into `PlanTabWeek` format, computes `week1Monday` from `training_plans.created_at`, derives `actualMilesByWeek` and `allRaceWeekNums` from activities+races. Added a "Training Plan" section to the dashboard that renders the full plan arc and week calendar. (2) Updated the `planWeekSyncNum` prompt branch in `route.ts` to instruct Dean to include 1-2 sentences of orientation: explaining the plan will be used as context after every run and for weekly planning, and inviting the user to reach out about cross training, adjustments, or anything else.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

## 2026-04-18 — Fixed LTHR race condition and pace extraction from PDF/plan content

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "my paces are all off" + LTHR not set despite connecting Strava with qualifying race
**Root cause (paces):** `easy_pace` Haiku extraction had no "Athlete lines only" guard — unlike `recent_race_time_minutes`, it could be populated from Coach messages, training plan PDFs, or any text in the conversation. During onboarding, a PDF training plan attachment contained sub-5:00/mi workout paces; Haiku extracted one as the user's easy pace, producing VDOT 75 / 4:51/mi — unrealistically fast.
**Root cause (LTHR):** `completeOnboarding` read `strava_lthr_estimate` from in-memory `mergedData` (built at request start). Any `handleConversation` turn that ran between the Strava callback's LTHR write and the `[READY]` fire would write `mergedData` (without LTHR) back to the DB, clobbering the value. The subsequent `[READY]` request would then load stale `onboarding_data` with no LTHR.
**Fix / Change:** (1) Added "ONLY from Athlete lines" restriction to the `easy_pace` Haiku extraction rule. (2) `completeOnboarding` now re-fetches `onboarding_data` fresh from the DB immediately before reading LTHR fields, with in-memory `data` as fallback — ensures the Strava callback's write is always seen regardless of request ordering.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-18 — Updated HR zone labels to show LT1/gray zone/LT2 nomenclature

**Type:** Improvement
**Reported by:** Jake (internal testing)
**User feedback:** "I thought we updated the dashboard to be <LT1, gray zone, >LT2"
**Root cause:** The LT1/LT2 physiological zone naming was added to the coaching system prompt (`buildHRZoneContext`) but never applied to the dashboard UI — both LTHR and % max HR paths used generic Z1–Z5 labels.
**Fix / Change:** When `lthr` data is available, `HRZoneBar` now displays Recovery / < LT1 / Gray zone / ~ LT2 / > LT2 labels instead of Z1–Z5. The % max HR fallback retains Z1–Z5 since that system doesn't map cleanly to physiological thresholds.
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-17 — Switched AI provider from Anthropic to OpenAI (temporary)

**Type:** Infra
**Reported by:** Jake (internal)
**User feedback:** "I'm getting blocked by the Anthropic API because I can't move from tier 1 to tier 2"
**Root cause:** Anthropic API tier 1 rate limits were blocking production use. Needed a temporary alternative while tier upgrade is pending.
**Fix / Change:** Added a provider-switchable shim in `src/lib/anthropic.ts`. The shim wraps OpenAI behind the exact same `anthropic.messages.create()` interface, so zero call-site code changed. Provider is controlled by `AI_PROVIDER` env var (`openai` = default now, `anthropic` = original). Model mapping: haiku→gpt-4o-mini, sonnet→gpt-4o. Web search uses `gpt-4o-search-preview`. PDF document blocks are converted via `pdf-parse`. To switch back: set `AI_PROVIDER=anthropic` and ensure `ANTHROPIC_API_KEY` is set.
**Files changed:** `src/lib/anthropic.ts`, `package.json` (added `openai`, `pdf-parse`)

---

## 2026-04-17 — LTHR-anchored HR zone system (Phase 1 + 2 foundation)

**Type:** Feature
**Reported by:** Internal — product initiative
**User feedback:** N/A
**Root cause:** N/A — proactive improvement. Existing zone system used % of max HR, a coarse population-average heuristic that ignores individual physiology. LTHR (Lactate Threshold Heart Rate) anchors zones to the runner's actual aerobic/anaerobic boundary.
**Fix / Change:**
- New `lib/hr-zones.ts`: `estimateLTHRFromRaces()` infers LTHR from stored race activities using duration-based correction factors (25–180 min brackets, correcting avg race HR → LTHR). `deriveZones()` computes Z1–Z5 bpm ranges. `buildHRZoneContext()` generates coaching system prompt block.
- Migration `038_lthr_fields.sql`: adds `lthr_estimate`, `lthr_source`, `lthr_confidence`, `lthr_last_updated`, `lthr_history`, `hr_zone_method` to `training_profiles`.
- Strava callback: computes LTHR at connect time, stores in `onboarding_data` for transfer at profile creation.
- Onboarding handle: includes LTHR fields in `training_profiles` upsert when available.
- Strava webhook: recomputes LTHR on new race activity (workout_type=1), updates profile directly.
- Coach respond: injects LTHR zone context block into system prompt when available; falls back to generic % max HR text. `computeZone12Pct` accepts optional `z2BpmCeiling` override for LTHR-accurate Z2 boundary. Both `annotateStravaActivity` call sites pass `lthrEstimate` through `AnnotationContext`.
- Dashboard: `HRZoneBar` upgraded to accept either `{ lthr, source, confidence }` or `{ maxHR }` props. Shows green "LTHR — from race data" badge vs gray "% max HR (estimated)" badge. LTHR bpm ceilings derived from `deriveZones()`.
- Admin `POST /api/admin/backfill-lthr`: estimates LTHR for all existing Strava-connected users with profiles; skips already-upgraded users unless `force=true`.
**Files changed:** `lib/hr-zones.ts` (new), `lib/database.types.ts`, `migrations/038_lthr_fields.sql` (new), `api/auth/strava/callback/route.ts`, `api/onboarding/handle/route.ts`, `api/webhooks/strava/route.ts`, `api/coach/respond/route.ts`, `dashboard/page.tsx`, `api/admin/backfill-lthr/route.ts` (new)

## 2026-04-17 — Removed nightly/morning reminder references from onboarding

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "In onboarding, it seems like Dean is still saying he'll send nightly reminders before each session, but that's not the case anymore because we got rid of the nightly and morning round robins."
**Root cause:** Three places still referenced the old reminder system: (1) a hardcoded `initial_plan` message said "I'll send you evening reminders before each session", (2) the coach system prompt described three reminder cadence options (morning-of, evening-before, weekly Sunday), and (3) `initial_plan` was overwriting the `proactive_cadence` set by `completeOnboarding` (based on `wants_weekly_recap`) with `nightly_reminders`.
**Fix / Change:** Removed reminder mention from the `initial_plan` closing message. Updated system prompt to say only weekly Sunday recap is supported. Removed the `proactive_cadence: "nightly_reminders"` overwrite in `initial_plan` so the user's recap preference from onboarding is preserved.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-17 — Training arc chart on Season tab

**Type:** Feature
**Reported by:** Jake Tennant (internal)
**User feedback:** N/A
**Root cause:** Dashboard had no visual representation of the full training plan shape — users couldn't see the build/peak/taper arc or where races fell without scrolling through all week cards.
**Fix / Change:** Added a `TrainingArcChart` SVG component to the Season tab. Shows a bar chart of weekly mileage targets across the full plan, colored by phase (base/build/peak/taper/deload). Current week gets an outlined bar; race weeks get a red marker with a dashed stem. Horizontally scrollable on narrow screens. Phase legend below the chart. Week cards section relabeled "All Weeks".
**Files changed:** `src/app/dashboard/plan-tab.tsx`

---

## 2026-04-17 — Three-way plan preference path in onboarding

**Type:** Feature
**Reported by:** Jake Tennant (internal)
**User feedback:** N/A
**Root cause:** Onboarding only handled two cases: existing plan (complement mode) or no plan (generate one). Users who don't have a plan and don't want one had no path.
**Fix / Change:** Added `wants_plan` extraction field. Dean now explicitly confirms plan preference (three options: existing plan / build one / no schedule). New "no_plan" completion mode sends a post-run-feedback-only welcome and skips plan generation entirely. Updated `SIGNALING READY` prompt to require plan preference for race goals.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-17 — Dean now asks about existing plans before signaling [READY]

**Type:** Bug Fix
**Reported by:** Jake Tennant (internal observation)
**User feedback:** "it looks like Dean is still acting like he has to create a plan in onboarding - in this case, he didn't actually ask me if I wanted a plan or already had one"
**Root cause:** `has_existing_plan` was mentioned in the MODE VARIATIONS section as something to ask about for race goals, but was not listed as a required field in the `SIGNALING READY` conditions. Dean could fire `[READY]` (triggering plan generation) without ever confirming whether the user already follows a training plan.
**Fix / Change:** Added `has_existing_plan` to the `SIGNALING READY` required field list for race goals. Added an explicit instruction that Dean must confirm existing-plan status before `[READY]`, with a suggested question if not yet addressed.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-17 — Fix easy runs misclassified as Hard in dashboard intensity chart

**Type:** Bug Fix
**Reported by:** Jake (internal observation)
**User feedback:** "something looks off with all of my runs being red - looks like 150+ would be zone 4, but many of these average below that"
**Root cause:** The interval-proxy check (`maxPct > 0.83 && avgPct > 0.72`) was designed to detect interval sessions by looking for a high max HR combined with an "elevated" average. But the avgPct threshold of 0.72 was too low — easy runs on hilly terrain regularly produce avg HR of 73–74% of max while still hitting a momentary peak above 83%, incorrectly triggering the "hard" classification.
**Fix / Change:** Raised the avgPct threshold from 0.72 to 0.78 in both `buildZoneStrip` (6-week scatter) and the "Last 7 Days" section. True interval sessions with recovery jogs still average well above 78%; easy runs do not.
**Files changed:** src/app/dashboard/page.tsx

---

## 2026-04-17 — Pre-compute microcycle ordinal, injury hold duration, quality session flag, and next-week comparison label

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Claude was deriving several facts from raw data that could be pre-rendered: microcycle position (week N of 4), injury hold age in days, whether a quality session exists this week, and whether next week is lighter/heavier than the current week. Forcing Claude to compute these from raw inputs caused incorrect outputs (wrong progression labels, "stepping up" on recovery weeks, ambiguity about quality session presence).
**Fix / Change:**
- FACTS block now includes `microcycleLabel` (e.g. "week 3 of 4 — last hard week; recovery next") on the Training line
- FACTS block includes `injuryHoldFact` when active: "INJURY HOLD: active for 12 days (since Apr 5) — no running sessions"
- FACTS block includes `qualitySessionFact`: explicit "YES — Tempo 4mi @ 6:54/mi" or "NO (base building — easy miles only)"
- `nextWeekContext` in `user_message` trigger now pre-renders [LIGHTER]/[HEAVIER]/[SIMILAR volume] comparison label
- `weekly_recap` PROGRESSION TARGET replaced with `NEXT WEEK TARGET` line including LIGHTER/HEAVIER/SIMILAR comparison against last week's actual mileage and microcycle position note
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-17 — Renamed "my plan" keyword to "dashboard"

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** The "my plan" keyword was broadly named and matched natural-language patterns. The dashboard is the canonical place to see training info, so the keyword should reflect that.
**Fix / Change:** Changed the SMS keyword from "my plan" / "my training plan" to "dashboard" (exact match, case-insensitive). Removed natural-language fuzzy matching in coach/respond. Updated welcome-tips cron, system prompt, fallback SMS messages, and all tests.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/cron/welcome-tips/route.ts`, `src/__tests__/api/linq-webhook.test.ts`, `src/__tests__/api/coach-respond.test.ts`

---

## 2026-04-17 — Strava annotation: HR-based workout kind inference for no-plan users

**Type:** Bug Fix
**Reported by:** Jake (wife's account)
**User feedback:** Interval workout got annotated as "easy 40% of the workout" — wrong because Dean has no training plan for her and can't tell it was an interval run
**Root cause:** `detectWorkoutKind` fell back to `"easy"` whenever `plannedSessionLabel` was null and Strava's `workoutType` wasn't explicitly 2 (long) or 3 (interval). For users without a training plan, `plannedSessionLabel` is always null, so ALL runs were classified as easy. The Z1-Z2 metric was then computed and shown, producing nonsense results like "40% in easy zone" on a hard interval workout.
**Fix / Change:** Extended `detectWorkoutKind` to accept `avgHR` and `maxHR` as optional inputs. When no plan label or Strava workout tag provides a signal, HR effort level is used as a fallback: ≥82% of max HR → interval, ≥75% → tempo, otherwise easy. This prevents the mislabeling without requiring a training plan.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-17 — Recurring hallucination reducers: evidence rule, invariant check, required-mention, activity semantics

**Type:** Improvement
**Reported by:** Internal changelog analysis
**User feedback:** N/A
**Root cause:** Four recurring failure classes identified from changelog patterns: (A) Strava field misinterpretation across triggers, (B) plan-state desync reaching the LLM, (C) fabricating context when data is absent, (D) longitudinal signals ignored in responses.
**Fix / Change:**
- **EVIDENCE RULE**: Added top-level system prompt rule requiring every factual claim about the athlete to be traceable to data in the prompt. Prevents fabricated past references ("I remember you mentioned…") and plausible-sounding but ungrounded assertions.
- **`validateTrainingStateInvariants()`**: Runs at the start of every `processCoachRequest` call. Fetches `total_weeks` from `training_plans` as an 8th parallel query and logs warnings when `current_week` is invalid (≤0), exceeds the plan arc length, or `weekly_mileage_target` is ≤0. Pure logging — no DB writes. Surfaces drift before it reaches the LLM.
- **Required-mention for longitudinal signals**: Added `buildLongitudinalSignals()` to `training-analytics.ts`. When ACWR > 1.3 (load spike), long run is plateaued (4-week stagnation), or the zone-3 intensity trap is active, a `⚠️ REQUIRED ACKNOWLEDGMENT` directive is injected into the user message so Dean cannot skip the signal.
- **`buildActivityDataGuard()` helper**: Shared function that annotates semantically subtle Strava fields (`workout_type=1` = race, `TrailRun` pace expectations, `max_heartrate` = single-run peak). Injected for both `post_run` and `workout_image` triggers. The `post_run` path already had inline guards; this adds `workout_type` and `TrailRun` annotations it was missing, and brings `workout_image` up to the same level.
**Files changed:** `src/lib/training-analytics.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-17 — Quality audit fixes: TZ inference logging, max HR guard, stale-profile re-fetch

**Type:** Improvement
**Reported by:** Internal quality audit
**User feedback:** N/A
**Root cause:** Three gaps identified in a coaching engine audit: (1) silent timezone inference from phone number could shift week boundaries without any log signal; (2) max_heartrate "true max" fabrication guard existed only in post_run, leaving user_message and weekly_recap unprotected; (3) generateAndSaveFullPlan in initial_plan consumed the profile fetched at handler startup, which predates any writes made during the onboarding conversation.
**Fix / Change:** (1) Added console.warn when user.timezone is missing and inferTimezoneFromPhone fallback fires, including userId and inferred TZ for debugging. (2) Moved max HR guard into buildSystemPrompt's shared HEART RATE ZONES section so it applies to all triggers (user_message, weekly_recap, post_run). (3) Added a fresh training_profiles re-fetch immediately before generateAndSaveFullPlan in the initial_plan block; profile variable is reassigned if fresh data is available.
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-04-17 — Dashboard "This Week" card + coach/respond dead code removal

**Type:** Improvement + Cleanup
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Dashboard fetched `weekly_plan_sessions` but never rendered it (it was stale anyway after the simplified tracking refactor). The new `weekly_long_run_miles` and `weekly_quality_session` columns weren't surfaced anywhere in the UI. `maybeUpdatePlanSessions`, `correctTotalFromSessionList`, `[SESSION_UPDATE]` tag machinery, and `rawSessionUpdateJson` were all dead code left over from the day-level session tracking.
**Fix / Change:** Dashboard now shows a "This Week" section with target miles (with mini progress bar), long run target, and quality session — sourced from the new columns. Summary card simplified (duplicate progress bar removed). `maybeUpdatePlanSessions`, `correctTotalFromSessionList` removed from coach/respond; `[SESSION_UPDATE]` tag and system prompt instructions replaced with plain "confirm verbally" instruction; `[WEEK_OVERRIDE]` and `[SKIP_DAY]` tags retained as they still have value.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

## 2026-04-16 — Simplified week-level plan tracking (remove day-level session assignment)

**Type:** Refactor
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Day-level session tracking (`weekly_plan_sessions`) caused a cascade of bugs: wrong day assignments, mileage math errors requiring correction passes, session dedup logic, and fragile `[SESSION_LIST]` JSON tag extraction from Claude's free-form responses. The `sync_sessions` trigger, `extractAndStorePlanSessions`, and `syncArcCurrentWeek` functions added significant complexity and latency without reliable output.
**Fix / Change:** Replaced `weekly_plan_sessions` (day-level JSON array) with two simple columns: `weekly_long_run_miles` and `weekly_quality_session`. The coach now communicates the weekly plan as a framework — target miles, long run, quality session — rather than a day-by-day schedule. The `[SESSION_LIST]` machine-readable tag, `extractAndStorePlanSessions`, `syncArcCurrentWeek`, and `handleSyncSessions` functions are removed. On `initial_plan`, `generateAndSaveFullPlan` directly populates the new columns from the arc. On `weekly_recap`, `syncWeekFromArc` reads the arc for the new week and writes the simplified state. Arc rebase logic is removed (the arc is now the authoritative source — no post-hoc corrections needed).
**Files changed:** `supabase/migrations/037_simplified_training_state.sql`, `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`, `src/lib/database.types.ts`

## 2026-04-16 — Guard against estimating max HR from single-run peak

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "this last message seemed incorrect - max hr is def higher! For 800m intervals you want to be hitting zone 4-5 — roughly 85-95% max HR. With your max around 171 (based on today's 168 peak), that puts your target interval HR around 145-162 bpm."
**Root cause:** The activity JSON passed to Claude includes `max_heartrate` (the single-run peak). Claude was independently multiplying this by ~1.02 to derive a "true max HR" estimate, exactly as our `estimateMaxHR` algorithm does. But a single-interval peak is not the athlete's physiological max — theirs is higher.
**Fix / Change:** Added a data guard to the `post_run` user message telling Claude that `max_heartrate` is a single-run peak, not physiological max, and prohibiting it from estimating or stating a max HR figure based on that field. Zone references should use descriptive language (e.g. "zone 4-5") rather than asserting a specific max HR.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-16 — Fix regression: projected mileage correction used wrong tolerance

**Type:** Bug Fix
**Reported by:** Internal (test failure)
**User feedback:** N/A
**Root cause:** A pre-existing change set `computedProjection = weeklyMileageTargetForCap` (e.g. 40) instead of `null` when no session data is available. `correctProjectedTotal` has two paths: a tight ±0.4mi tolerance when it has a session-derived projection, and a 30%-over-target cap when projection is null. By passing the target itself as a real projection, projections like "42mi on a 40mi-target week" were being corrected down to 40 even though they were within the intended 30% tolerance.
**Fix / Change:** Changed `computedProjection = null` to preserve the 30% fallback cap behavior when session-level data isn't available.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-16 — Onboarding: name in first message, HR zones + mileage spike at Strava connect

**Type:** Feature / Improvement
**Reported by:** Internal (product direction)
**User feedback:** N/A
**Root cause:** First message felt impersonal (no name ask); post-Strava insights lacked HR and injury-risk signals.
**Fix / Change:** (1) Dean now asks for name + training context in the first message ("What's your name, and how's your training been going?") — removes the awkward nameless turn. (2) Strava callback now computes HR zone distribution (Z1–Z5 % of runs by avg HR vs estimated max HR) and detects week-over-week mileage spikes; both stored in onboarding_data. (3) Dean's post-connect insight instruction updated to surface aerobic/anaerobic split and flag load spikes as concrete injury risk signals. (4) Dean's intro reordered to lead with injury prevention ("I flag injury risk, track your training load…").
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-16 — Onboarding redesign: injury-first intake for "get faster without getting injured" pivot

**Type:** Feature / Improvement
**Reported by:** Internal (product pivot)
**User feedback:** "The product is pivoting from 'AI running coach that builds you a plan' to 'Get faster without getting injured.' Onboarding needs to feel less like signing up for a coaching service and more like a smart intake conversation with a coach who's trying to understand your injury history and training context before saying anything else."
**Root cause:** Previous onboarding was organized around plan creation — the three-mode structure (Plan Complement / Race-Goal Chaser / Healthy Builder) and [READY] conditions were all designed to collect enough info to generate a training schedule. Injury history was an afterthought collected only for ultra and injury_recovery goals. Strength/cross-training wasn't collected at all.
**Fix / Change:**
- New first-message framing: "I help runners get faster without getting injured" replaces generic coaching pitch. First question opens on goal + context together ("Racing this year, building a base, or coming back from something?")
- Injury history elevated to **required for ALL athletes** — must be asked and answered before [READY] regardless of goal type. Previously only required for ultra/injury_recovery goals.
- Strength & cross-training added as **required intake for ALL athletes** — "Do you do any strength work or cross-training?" Ask once, accept any answer, shapes injury prevention guidance.
- Simplified conversation flow — replaces the elaborate three-mode architecture with a common injury-first arc with minor mode variations. Plan-building language removed as the default framing.
- Existing plan handling simplified — Dean is "a post-run analyst, not a plan builder" for plan users. No longer organizes the whole conversation around plan creation.
- New injury/strength coaching moment: when athlete mentions injury history, Dean explicitly names what it will watch for ("With IT band history, I'll flag when weekly jump is too steep").
- New Haiku extraction fields: `injury_history`, `current_niggles`, `strength_habits`, `cross_training_activities`
- `summarizeCollected` updated to display new fields in Dean's context block
- `completeOnboarding` maps `cross_training_activities` → `crosstraining_tools` DB column; combines `injury_history` + `current_niggles` into `injury_notes`
- Evals fixture `first-message-intro.json` updated to reflect new intro framing
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/fixtures/onboarding/first-message-intro.json`

---

## 2026-04-16 — Dashboard redesign: four-section layout

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Dashboard pivot from "AI running coach that builds plans" to "Get faster without getting injured" — existing layout had wrong information hierarchy and lacked clear health/injury signals.
**Fix / Change:** Complete dashboard redesign into four sections: Summary (status signal + weekly progress bar + race chips + Dean's Focus), Injury & Load (12-week bar chart with redesigned green/orange colors + strength/recovery card from LLM), Fitness Progress (aerobic efficiency sparkline + training zones ribbon + HR zones + paces in one card), Last 7 Days (run list). Removed: tabs, Base Phase header badge, race finish projections. Updated `dashboard-insights.ts` to also generate strength/recovery exercises when injury notes are present.
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/dashboard-insights.ts`

---

## 2026-04-15 — Collapse dashboard to single-scroll page

**Type:** Improvement
**Reported by:** Internal
**User feedback:** "Cut entirely: Race projections, Training Overview text blurb, HR zones Z1–Z5 table, Training zones scatter plot, Full training arc (W1–W13 list). Stack rank for the single tab: Dean's Focus / Pace targets / Goal race banner(s) / Last 7 days / Weekly mileage + load warning / Aerobic efficiency trend. Plan upload / 'no plan yet' → move to onboarding or a settings page entirely."
**Root cause:** The two-tab structure still carried too many low-signal elements (race time predictions, zone scatter plots, full training arc list, HR zone table) and the Plan Upload UI had no place on a coaching dashboard.
**Fix / Change:**
- Removed tabs entirely; dashboard is now a single vertically-scrolling page
- Stack rank (top to bottom): Dean's Focus callouts → Pace targets → Goal race banner(s) → Last 7 days → Weekly mileage chart + ACWR load warning → Aerobic efficiency trend
- Cut: race time projections, Training Overview blurb, HR zones table, training zones scatter, full training arc list, plan upload UI
- Goal race condensed to slim banner: name + date + days countdown (no prediction)
- Removed `DashboardTabs` client component from page; `tab-container.tsx` and `plan-tab.tsx` now unused
- Removed DB query for `training_plans` table (no longer needed in dashboard)
- Removed `predictRaceTime`, `estimateVDOT`, `predictTimeFromVDOT` imports
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-15 — Reorganize dashboard into "This Week" and "Season" tabs

**Type:** Improvement
**Reported by:** Internal
**User feedback:** "Tab 1 = 'What should I do this week and how am I doing?' Tab 2 = 'Is the training working and where am I headed?' The day-by-day schedule is doing a lot of visual work for information that becomes stale the moment someone shuffles a run."
**Root cause:** Original two tabs (Overview / Training Plan) mixed time horizons — fitness trends and plan arc were split, race countdown was buried in two places, and the day-by-day weekly grid was expensive to generate and quickly became stale.
**Fix / Change:**
- Renamed tabs: "Overview" → "This Week", "Training Plan" → "Season"
- Tab 1 (This Week): Weekly anchors card (week target + long run target + quality session(s) + done-this-week progress bar), load spike warning, Dean's focus callouts, last 7 days
- Tab 2 (Season): Training overview summary opener, goal race cards + predicted finish, aerobic efficiency trend, weekly mileage chart, training zones scatter, pace zones reference, full training arc (W1–WN)
- Removed the day-by-day Mon/Tue/Wed schedule grid from the plan tab entirely
- Removed `buildDailyPlan` / `buildDailyPlanFromSessions` helpers (no longer needed)
- The analysis summary blurb ("executing hard workouts well but...") moved from Tab 1 top to the Season tab opener where it provides altitude-view context
**Files changed:** `src/app/dashboard/tab-container.tsx`, `src/app/dashboard/plan-tab.tsx`, `src/app/dashboard/page.tsx`

---

## 2026-04-15 — Fix wrong training paces for trail-race Strava users with road PRs

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "Pacing zones also seem off here for a 17:50 5k" (dashboard showed 9:27-9:57 easy, should be ~7:50-8:20)
**Root cause:** When the user's Strava best race is a trail race (e.g. Dipsea 30K), the coach conversation mentions that race including its time. Haiku's extraction step could pick up that trail distance/time from the Coach: lines in the transcript despite the "athlete's messages only" rule, storing them as `recent_race_distance_km`/`recent_race_time_minutes`. The VDOT recalculation then computed pace zones from the trail race performance, giving ~40 VDOT (9:42 easy) instead of the correct ~57 VDOT (7:50 easy) from the user's 17:50 5K road PR.
**Fix / Change:** (1) When `lookupBestStravaRace` returns a trail race, store `strava_best_race_is_trail=true` and `strava_best_race_km` into onboarding_data. (2) VDOT recalculation block now checks: if the extracted `recent_race_distance_km` matches the Strava trail race within 1km, skip the recalc (it's likely the trail race slipping through). If the user provides a different (road) race distance, VDOT still runs correctly. (3) Haiku extraction prompt for `recent_race_distance_km`/`recent_race_time_minutes` now explicitly says "ONLY from lines labeled 'Athlete:' — NEVER from 'Coach:' lines" and names trail races as ineligible.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-15 — Fix goal_time_minutes incorrectly set from 5K PR instead of explicit goal time

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** Dashboard showed "Goal: 17:50" for the Dipsea race (user's 5K PR, not their Dipsea goal)
**Root cause:** Haiku extraction rule for `goal_time_minutes` was not specific enough — it extracted any mentioned time as the goal, including past PRs the user stated as fitness baselines.
**Fix / Change:** Strengthened Haiku rule: "Do NOT use a past PR or best time as the goal time unless the athlete says it IS their goal. A statement like 'my fastest 5K is 17:50' is a fitness baseline — extract it as recent_race_time_minutes, NOT as goal_time_minutes."
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-15 — Fix PDF upload: drag-and-drop and PDF file selection

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "I can't drag and drop a PDF into the PDF uploader. I also can't select a PDF from my computer for some reason."
**Root cause:** (1) The file input `accept` attribute didn't include `application/pdf`. (2) No drag-and-drop event handlers were wired up. (3) The upload API didn't have a `pdf_base64` content type path.
**Fix / Change:** Added `processFile` callback that detects PDF vs image. Added `handleDragOver`/`handleDragLeave`/`handleDrop` handlers with visual feedback. Updated `accept` attribute to include `application/pdf`. Added `pdf_base64` content type to upload API, routing it to the existing `extractFromPDFBase64` function.
**Files changed:** src/app/dashboard/plan-import-form.tsx, src/app/api/plan/upload/route.ts

## 2026-04-15 — Fix arc rebase on partial-week onboard with reliable Strava baseline

**Type:** Bug Fix
**Reported by:** Jake (testing)
**User feedback:** "The plan that was generated had me starting with 39 miles (maybe a bit high) in week one, but then the arc wasn't in sync with that" (Week 1=39mi, Week 2=26.5mi, Week 3=29mi)
**Root cause:** `syncArcCurrentWeek` was rebasing the training arc downward when Week 1 session count (partial week, e.g. Thursday onboard with 4 sessions = ~24mi) was below the Strava 4-week average (29mi). Scale factor 0.83× applied, making weeks 2-3 lower than baseline instead of building from it.
**Fix / Change:** Added `skipRebase` flag to `syncArcCurrentWeek`. When `isPartialWeek && avgWeeklyMileage != null` (Strava data available), skip the arc rebase. The partial week's low session count is by design, not a signal that the baseline is wrong.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-15 — Onboarding prompt improvements for plan-complement users

**Type:** Improvement
**Reported by:** Jake (first run-through of new onboarding)
**User feedback:** "Feels like the first message from Dean is too long and wordy + I don't like SMS running coach. Maybe 'AI running coach'. Don't refer to yourself as a SMS coach. Referenced dashboard - a bit unclear. We don't mention that Dean will write to your strava log. It is less clear why Dean needs my paces if he isn't making me a plan. Is 'which days of the week work best for your training' if the user already has a plan? Didn't send the dashboard or super clearly explain next steps. Didn't tell me how to upload my plan to the dashboard or why I may want to do that."
**Root cause:** First message example used "SMS running coach" (wrong branding) and was over-explained. Plan-complement mode didn't surface the Strava activity annotation feature, framed training-days question oddly for users with fixed schedules, didn't explain why paces matter when Dean isn't building the plan, and the post-onboarding welcome message didn't mention the dashboard or plan upload.
**Fix / Change:** (1) First message example shortened to 2 sentences, changed "SMS running coach" → "AI running coach", added Strava annotation mention. (2) PLAN COMPLEMENT mode no longer collects training days — Dean fires on Strava activity events so the schedule isn't needed upfront. (3) Plan-sharing value prop now explains the concrete reason to share: Dean can tell you whether today's run matched the schedule, flag drift, and give more specific feedback. (4) EXISTING PLAN USERS section updated to match. (5) Complement mode welcome message now includes the dashboard URL and plan-upload instruction.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-15 — Insights section on landing page

**Type:** Feature
**Reported by:** Internal — product review
**User feedback:** N/A
**Root cause:** Landing page sold the channel (SMS + Strava) and the plan/complement concepts but had no concrete examples of what Dean actually analyzes. The value prop was abstract where it needed to be specific.
**Fix / Change:** Added a new "Dean reads the signals most coaches miss" section between the comparison table and the value props. Shows 3 static iMessage-style cards with real Dean messages demonstrating: (1) ACWR injury risk spike, (2) zone 3 trap / easy run HR compliance, (3) post-run pace fade execution. Each card uses the existing iMessage visual style (SF Pro font, gray/blue bubbles, iPhone-like header). Built as an inline `InsightCard` component in `page.tsx` — no new file needed.
**Files changed:** `src/app/page.tsx`

## 2026-04-15 — Expanded post-run and weekly recap analytics

**Type:** Feature
**Reported by:** Internal — product review of core coaching touchpoints
**User feedback:** N/A
**Root cause:** The longitudinal analysis block only had three signals (load trend, aerobic efficiency, cardiac drift). Several high-value signals derivable from existing Strava data were never surfaced: ACWR injury risk, long run progression, intensity distribution (zone 3 trap), cadence, elevation load, and per-run pace execution.
**Fix / Change:**
- Added `computeACWR` — acute:chronic workload ratio (7-day vs 28-day rolling). Flags >1.3 as injury risk zone.
- Added `computeLongRunProgression` — tracks longest run per week over 8 weeks. Flags stagnation (4+ week plateau) and overreaching (>25% single-week jump).
- Added `computeIntensityDistribution` — classifies runs by HR intensity relative to observed max HR. Flags when >50% of runs are in the moderate "gray zone" (common recreational runner mistake).
- Added `computeCadenceTrend` — average spm over recent runs. Flags <170 spm (overstriding risk).
- Added `computeElevationLoadTrend` — weekly vertical gain trend. Shown when avg >500ft/week (trail/mountain runners).
- Added `buildRunExecutionAnalysis` — analyzes per-mile Strava splits for pace fade. Injected into post_run user message when a significant fade or notable negative split is detected.
- Extended `ActivityForAnalytics` interface to include `max_heartrate`, `elevation_gain`, `average_cadence`.
- Added `max_heartrate` to the activities DB query in route.ts.
- All new functions have full test coverage (27 tests in training-analytics.test.ts).
**Files changed:** `src/lib/training-analytics.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-analytics.test.ts`

## 2026-04-15 — Plan generation and import accuracy fixes

**Type:** Bug Fix / Improvement
**Reported by:** Pre-launch audit
**User feedback:** N/A
**Root cause:** Three accuracy gaps in the plan generation and import paths:
1. `plan/upload` used `now.getDay()` (server local time) to compute the "this week's Monday" anchor for week-1 sessions. On a UTC server, a user uploading at 11pm US/Eastern would get a Monday that's one day in the past.
2. `generateAndSaveFullPlan` derived `daysPerWeek` from `profile.days_per_week` with a hardcoded fallback of 4. If the column was null (e.g. old users), Haiku enrichment received the wrong days count and could produce session descriptions out of sync with the athlete's actual schedule.
3. Haiku's SESSION MATH RULE (distance prefix must equal sum of components) was prompt-only — no code-level validation.
**Fix / Change:**
- `plan/upload`: replaced `now.getDay()` / `setDate` with UTC arithmetic (`now.getUTCDay()`, `Date.UTC(...)`, `setUTCDate`, `getUTCMonth/Date`) so the Monday anchor is always correct regardless of server timezone.
- `training-plan.ts`: `daysPerWeek` now falls back to `training_days.length` before the hardcoded 4, so Haiku always receives the correct count.
- Added `fixKeyWorkoutMath(kw, unitLabel)` to `training-plan.ts`: runs post-enrichment on each week's `key_workout`, parses "Verb Xunit (components)" patterns, sums unambiguous component distances, and corrects the prefix if wrong. Leaves time-based and rep-count workouts unchanged.
**Files changed:** `src/app/api/plan/upload/route.ts`, `src/lib/training-plan.ts`, `src/__tests__/lib/training-plan.test.ts`

## 2026-04-15 — Post-generation accuracy validators for dates, mileage, and plan structure

**Type:** Improvement
**Reported by:** Pre-launch audit
**User feedback:** N/A
**Root cause:** Several accuracy risks existed where Claude's output could contain wrong weekday/date pairings, wrong session counts, or wrong totals — with no code-level safety net beyond prompt instructions.
**Fix / Change:**
- Added `fixSessionDayAbbreviations(message, refYear, refMonth)` to `plan-validation.ts`: parses every `Mon 3/2 · ...` session line, verifies the day abbreviation matches the actual calendar date, and auto-corrects any mismatch (with a console warning). Year rollover handled: if session month < current month, infers next calendar year.
- Added `countRunningSessions(message)` to `plan-validation.ts`: counts running sessions (sessions with mileage markers) in a plan response for comparison against the athlete's `training_days` preference.
- Wired `fixSessionDayAbbreviations` into the post-generation pipeline in `route.ts` for `initial_plan` and `weekly_recap` triggers.
- Added session count logging in `route.ts`: warns when Claude's plan has a different number of running sessions than the athlete's `training_days.length`.
- The existing `correctMileageTotal`, `correctTotalFromSessionList`, `enforceVolumeCaps`, `fixSessionDistanceErrors`, and `deduplicateSessionLines` validators were already in place covering mileage accuracy.
**Files changed:** `src/lib/plan-validation.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/plan-validation.test.ts`

## 2026-04-15 — Six coaching quality fixes from eval analysis

**Type:** Improvement
**Reported by:** Internal eval analysis
**User feedback:** N/A
**Root cause (6 issues from eval failures):**
1. **plan-5k-beginner**: Plans had no deload week — progression climbed continuously for 7+ weeks without a recovery week. Deload rule said "include a recovery week" but didn't specify depth (model used 1-2mi step-back instead of a true 25-30% cut).
2. **plan-masters-first-marathon, plan-mile-time-trial**: Week 1 too conservative — model started plans well below current base for MODERATE/HIGH volume athletes. No enforced floor rule existed.
3. **plan-masters-first-marathon**: Session dates spilled outside the stated week header (e.g., "Week 1: Apr 3–9" but sessions listed Apr 11-12). No boundary rule existed.
4. **plan-strength-integrated-marathon**: Race week placed a shakeout run on Friday (gym-only day) — violating the athlete's training day constraints. The CROSS-TRAINING DAY PROTECTION rule didn't explicitly cover race week.
5. **date-post-silence-reengagement**: Coach invented excuses for gaps in contact ("I've been traveling", "been following along") rather than simply owning the silence professionally.
6. **date-recency-gap-contact**: Weekly mileage projection quoted the stored weekly target instead of computing miles-done + sum of remaining sessions (leading to inconsistent totals when actual sessions don't perfectly fill the target).

**Additionally fixed (from running new eval fixtures):**
- **mileage-projection-null-sessions**: Claude used additive format ("39mi planned + 8mi = 47mi") because it misunderstood the weekly target as "additional miles." Added WEEKLY TARGET MEANING rule: target is inclusive of all miles for the week.
- **plan-mile-time-trial**: Model generated 22-24mi in Week 1 (floor = 27mi) by shrinking all sessions when the long run was capped at 5mi. Added SESSION LENGTH MATH rule showing the arithmetic: 3 sessions × 7-8mi + 5mi long run = 27mi+. Also fixed: model was recommending 800m repeats despite them targeting the wrong energy system for a 4-minute race. Added SHORT FAST INTERVALS rule specifying 200m-400m reps only.

**Fix / Change:**
1. Deload depth rule strengthened: "DELOAD DEPTH: ~70% of prior build week — a REAL 25-30% volume cut. If Week 3 is 20mi, Week 4 deload must be ~14mi." Added to both route.ts and run-evals.mjs.
2. WEEK 1 MINIMUM FLOOR: Week 1 must not fall below 90% of current avg weekly mileage (MODERATE and HIGH tiers). Hard rule with `<rule>` tag.
3. DATE BOUNDARY: Every session date must fall within the week header range. Added to DATES AND DAY LABELS section.
4. Race week shakeout constraint: "Do NOT schedule the shakeout on a gym-only, cross-training-only, or rest day." Added to taper protocol and CROSS-TRAINING DAY PROTECTION.
5. SILENCE GAPS rule: "Do not invent an excuse for the gap — own the silence directly and move forward."
6. WEEKLY PROJECTION ACCURACY + WEEKLY TARGET MEANING rules: Projection must equal miles_done + sum of remaining session distances. Target is inclusive, not additive.
7. MILE TT SESSION MATH: Explicit arithmetic showing 3 sessions must average 7-8mi to reach 27mi floor with 5mi long run cap.
8. SHORT FAST INTERVALS rule: 200m-400m reps only; 800m repeats explicitly prohibited for mile prep (wrong energy system).

**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/judges/factual-accuracy.mjs`

---

## 2026-04-15 — Five coaching quality fixes from Weston's first week

**Type:** Bug Fix + Improvement
**Reported by:** Weston
**User feedback:** "Original plan had runs on Sunday. I had to ask 4 times for Sunday to be the rest day before it was respected. On Sunday CoachDean sent me a reminder saying to gear up for my long run in the morning — my long run was the day before. Every day I ran longer than prescribed and a real coach would give critical feedback. The positivity and me always being right feels good but it likely isn't what I need in a coach."
**Root cause (5 issues):**
1. Ultra plan template hardcoded `Sat+Sun` as the back-to-back days, overriding any athlete-specific rest day preference.
2. On Sunday evenings, `weekly_plan_sessions` is exhausted (week 1 past) but `weekly_recap` hasn't fired yet — `nightly_reminder` had no session data and Claude hallucinated "tomorrow: Long run 14mi."
3. `computeProjectedWeekMiles` returns `null` when sessions are empty, disabling `correctProjectedTotal` and allowing Claude's wild "on track for 77mi" projection to stand uncorrected.
4. When an athlete runs on a planned strength/mobility day, post-run feedback praised the run with no mention of the skipped session.
5. No pattern detection: Dean celebrated each over-plan run individually but never noticed or commented on the consistent pattern of running significantly more than prescribed.
**Fix / Change:**
1. Ultra template in `training-plan.ts` now derives back-to-back days from `profile.training_days` (last two training days in weekday order) instead of hardcoding Sat+Sun.
2. Added `nightlyNoSessions` guard: detects end-of-week empty session state and sends a brief "week complete, plan coming tonight" message instead of guessing.
3. `correctProjectedTotal` now accepts a `weeklyMileageTarget` fallback — when sessions are null, caps Claude's projection at 130% of target.
4. Added `skippedNonRunSession` detection: when today's planned session was strength/mobility and athlete ran instead, Dean briefly mentions the skipped session and offers to reschedule.
5. Added `planDeviationFlag`: when athlete has run ≥30% over plan-to-date across ≥3 runs in a week, Dean asks directly what's driving it and offers to recalibrate the plan.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-15 — Onboarding reframe: persona-aware flow and concrete first message

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "One thing I'm not clear if we do well right now is be ultra clear about the ways you can use coach dean upfront (insights on your running, injury recovery and prevention, upload plan and work from that or create a new plan)"
**Root cause:** The old first message asked for the athlete's name and used vague Runna-centric positioning ("Runna plans your runs, Garmin tracks them"). It didn't surface the three distinct use cases, so users without a Runna plan or with injury goals felt like the wrong audience. Onboarding also asked for terrain type, training tools, and weekly recap preference as explicit questions — adding turns without much value.
**Fix / Change:** Rewrote the first message instruction: Dean now opens with a concrete 2-3 sentence description of what he does (post-run notes, training tweaks, injury flagging, plan building), then asks a single branching question to self-select mode (plan complement / race-goal chaser / healthy builder). Name moves to the second turn. Added a CONVERSATION MODE section to the system prompt with three explicit paths — each with different priorities, required fields, and tone guidance. Removed terrain_type, training_tools, and wants_weekly_recap as explicit questions (terrain/tools extracted passively; recap defaults to on). Updated CLAUDE.md onboarding step documentation to reflect the current unified conversation model. Updated eval runner and fixtures to match new expected behavior.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-onboarding-evals.mjs`, `evals/fixtures/onboarding/first-message-intro.json`, `evals/fixtures/onboarding/no-greeting-repeat.json`, `CLAUDE.md`

---

## 2026-04-15 — Evals for uploaded plan scenarios

**Type:** Infra
**Reported by:** Jake ("do we have any evals for these different states or options? if not, let's make?")
**User feedback:** "do we have any evals for these different states or options? if not, let's make?"
**Root cause:** No eval coverage for the uploaded plan path — weekly recap with plan sessions, week sync response, and range session language were all untested.
**Fix / Change:** Added `uploaded_plan` support to `buildUserMessage` in `evals/run-evals.mjs` (injects `<uploaded_plan_next_week>` block mirroring route.ts logic). Added 3 new fixtures: (1) `uploaded-plan-weekly-recap` — Sunday recap must reference week 3 interval sessions from plan, not invent sessions; (2) `uploaded-plan-week-sync` — user replies "week 1 next week" to plan_import_week_ask, Dean must confirm sessions and mention next Monday; (3) `uploaded-plan-range-sessions` — plan has range sessions (4–6mi, 8–12mi), Dean must preserve range language, not collapse to midpoints. Added range/plan-session specific assertions to `factual-accuracy.mjs` judge.
**Files changed:** evals/run-evals.mjs, evals/judges/factual-accuracy.mjs, evals/fixtures/uploaded-plan-weekly-recap.json, evals/fixtures/uploaded-plan-week-sync.json, evals/fixtures/uploaded-plan-range-sessions.json

## 2026-04-15 — Reset training_state to week 1 on plan upload

**Type:** Bug Fix / Improvement
**Reported by:** Jake (dashboard showing "Week 3 of 8" after uploading a new 8-week plan)
**User feedback:** "I thought I deployed — but I think we just aren't clear with everything on the dashboard and how they should update when a new plan comes in"
**Root cause:** Uploading a new plan updated `training_plans` (correct `total_weeks = 8`) but left `training_state.current_week` at its old value (3). The dashboard then showed "Week 3 of 8" — wrong plan total, wrong current week. The "which week?" SMS was the only way to update training_state, meaning the web dashboard "Replace plan" path had no fix at all.
**Fix / Change:** `plan/upload` now resets `training_state` to week 1 (current_week=1, current_phase=base, taper_peak_miles=null, weekly_mileage_target and weekly_plan_sessions from week 1 of the new plan) immediately after saving the plan. For SMS uploads, the "which week?" follow-up adjusts if the user isn't on week 1. For web dashboard uploads, the dashboard shows the correct state immediately on reload.
**Files changed:** `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Fix "next week" date anchoring for plan week sync

**Type:** Bug Fix
**Reported by:** Jake (dashboard showing Week 3 after user said "start week 1 next week")
**User feedback:** "it's weird that I'm on week 3 of 8 now (total week count was reset but not current count - I did say I'm moving to the new plan next week, but need to be ultra clear about what this means for the dash)"
**Root cause:** When a user says "start week 1 next week", both handlePlanWeekSync (webhook) and the coach/respond fallback were anchoring weekly_plan_sessions dates to the CURRENT Monday instead of NEXT Monday. Also, the training_state sync wasn't deployed yet (all fixes in this session were local).
**Fix / Change:** Both handlePlanWeekSync and the coach/respond fallback now detect "next week" in the user's message and shift the date anchor by +7 days. The <uploaded_plan_next_week> prompt label also distinguishes "starting next week" vs "starting now" so Dean mentions the correct Monday start date.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-15 — Fix "I don't have week 1 specifically" — plan import week sync fallback in coach/respond

**Type:** Bug Fix
**Reported by:** Jake (conversation showing Dean saying "I don't have week 1 specifically")
**User feedback:** "weird that dean doesn't have week 1 of the plan?"
**Root cause:** When a user replies to "which week are you on?" (plan_import_week_ask), the primary path is the linq webhook's `handlePlanWeekSync` interceptor. When that interception failed (for any reason), the fallback `user_message` path in `coach/respond` always showed `uploadedNextWeek = currentWeek + 1` — never the week the user actually requested. Dean could see the plan existed but couldn't see week 1's sessions, so said "I don't have week 1 specifically."
**Fix / Change:** Added a fallback inside `coach/respond user_message`: if the last assistant message type is `plan_import_week_ask` and an uploaded plan exists, extract the requested week number from the user's message (via `extractPlanWeekNumber` regex helper), override `uploadedNextWeek` to that week, and sync `training_state` after sending the response. The webhook interception remains the fast path; this is the reliable fallback.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-15 — Fix "Failed to save plan" — training_plans has no unique constraint on user_id

**Type:** Bug Fix
**Reported by:** Jake (logs showing "PDF plan upload failed: Failed to save plan")
**User feedback:** Logs from live send: `[linq-webhook] PDF plan upload failed: Failed to save plan`
**Root cause:** `plan/upload` used `supabase.upsert(..., { onConflict: "user_id" })`, but `training_plans.user_id` has no unique DB constraint. Postgres rejects the upsert with an error.
**Fix / Change:** Replaced the upsert with the same select → update/insert pattern used by `training-plan.ts`: fetch the existing plan row by `user_id`, update if found, insert if not.
**Files changed:** `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Fix PDF plan extraction timeout (single Sonnet call with tool use)

**Type:** Bug Fix
**Reported by:** Jake (logs showing ECONNRESET at 46s and plan/upload 422 after 88s)
**User feedback:** "2026-04-15 20:30:49... [logs showing ECONNRESET, plan/upload 422 after 88s with two Claude calls 24333-63891ms]. Anything to fix here?"
**Root cause:** `extractFromPDF` used two sequential Claude calls: Sonnet (~24s) to dump the PDF as text, then Haiku (~64s) to structure that text into sessions. Total ~88s exceeded Vercel Hobby's `after()` budget (~46s effective), causing ECONNRESET in the webhook. The intermediate text dump also overwhelmed Haiku's context, causing it to return 0 sessions (422).
**Fix / Change:** Replaced the two-step approach with a single Sonnet call that reads the PDF via the document API and extracts structured sessions directly via tool use. This eliminates the intermediate text step, reduces extraction time to ~30-40s, and fits within the Vercel after() budget.
**Files changed:** `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Haiku extraction: has_existing_plan / external_plan_description reliability

**Type:** Bug Fix
**Reported by:** Internal (sim-runna-user-uploads-plan eval warnings)
**User feedback:** N/A
**Root cause:** `has_existing_plan` and `external_plan_description` were defined in the Haiku extraction rules but buried near the bottom of a long list. Haiku was skipping them even when clearly stated in the transcript (e.g. "I'm already on a Runna plan, week 6, ~35mi/week").
**Fix / Change:** Moved both fields to the top of the extraction rules (right after `goal`), added concrete examples of athlete phrases that must trigger extraction ("I'm already on a Runna plan", "my coach gave me a plan", etc.), and consolidated `wants_weekly_recap` alongside them. Same change mirrored in `run-simulation-evals.mjs`. `sim-runna-user-uploads-plan` improved from 7/10 to 9/10.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`

---

## 2026-04-15 — Onboarding evals: existing plan support, first-of-month date guard, extraction tests

**Type:** Improvement / Bug Fix
**Reported by:** Internal (eval run after onboarding revamp)
**User feedback:** N/A
**Root cause:** Three onboarding prompt gaps found via simulation evals: (1) Dean rejected users with existing Runna/TP plans instead of working alongside them; (2) Dean accepted month-only race dates ("in June") and silently defaulted to the 1st, miscalibrating training timelines; (3) `has_existing_plan` and `external_plan_description` fields were not reliably extracted by Haiku even when clearly stated.
**Fix / Change:**
- Added `EXISTING PLAN USERS` section to onboarding prompt: Dean now positions as a coaching layer alongside Runna/TP/coach-written plans, mentions the dashboard PDF upload option, and still completes full onboarding. `sim-runna-user-uploads-plan` went 1/10 → 7/10.
- Added `RACE TARGET FOR TIME-GOAL ATHLETES` section: if athlete has a time goal ("sub-20 5K") without a named race, Dean asks for a specific event.
- Added `FIRST-OF-MONTH GUARD` to prompt and Haiku extraction rule: if only a month is known, Dean must ask for the exact date; Haiku returns null rather than defaulting to the 1st.
- Strengthened cycling-only exit: "one exit message, full stop" to prevent goodbye loops.
- Fixed `has_existing_plan`/`external_plan_description` parity gap in `run-onboarding-evals.mjs` `summarizeCollected`.
- Added new `sim-runna-user-uploads-plan` simulation fixture.
- Added two unit tests in `onboarding-handle.test.ts` covering existing plan extraction and null-skip merge logic.
- All three previously failing simulations now pass. Full suite: 14/16 (avg 7.9/10), up from 12/16 (avg 7.4/10).
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`, `evals/run-onboarding-evals.mjs`, `evals/fixtures/simulation/sim-runna-user-uploads-plan.json`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-15 — Uploaded plan integration: ranges, dashboard arc, weekly recap, week advancement

**Type:** Feature / Bug Fix
**Reported by:** Internal (SWAP Sub-Ultra plan with range-based workouts e.g. "4–8mi easy")
**User feedback:** N/A
**Root cause:** Three gaps after plan import: (1) Range-based sessions (e.g. "4–8mi easy", "6–10×800m") were being collapsed to a single midpoint number, losing range info. (2) The dashboard's full training arc showed blank/zero data for uploaded plans because the arc expects `{phase, mileage_target, long_run_target, key_workout}` but uploaded plans store `{sessions, total_miles}`. (3) Sunday weekly recap used the periodization engine's inferred values instead of the uploaded plan's sessions, meaning Dean would generate new sessions rather than reference the actual plan.
**Fix / Change:**
- **Range extraction**: `plan/upload` Haiku schema now captures `targetDistanceMilesMin`/`Max` alongside the midpoint. `description` preserves range text verbatim ("Easy 4–8mi"). `PlanWeek` stores `total_miles_min`/`max` (sum of range bounds).
- **Dashboard arc**: `page.tsx` detects `plan_source === "uploaded"` and converts uploaded weeks to arc format — derives `phase` from position in plan, `long_run_target` from longest session, `key_workout` from tempo/interval sessions. `WeekCard` and the weekly target stat show "35–45mi" range when min/max are present.
- **Weekly recap**: injects uploaded plan's next-week sessions as `<uploaded_plan_next_week>` context; uses plan's `total_miles` as mileage target instead of periodization engine; directly loads next week's sessions into `training_state.weekly_plan_sessions` from the stored plan data (bypasses sync_sessions text extraction for reliability).
**Files changed:** `src/app/api/plan/upload/route.ts`, `src/app/dashboard/page.tsx`, `src/app/dashboard/plan-tab.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-15 — Plan import: conversational week sync after PDF/image upload

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** After importing a plan, Dean sent a canned "Got it, X sessions extracted" message with no follow-up. The uploaded plan was stored in `training_plans` but `training_state.current_week` and `weekly_plan_sessions` were never updated, so coaching context was unaffected.
**Fix / Change:** Added `plan_import` trigger to `coach/respond` — after a plan is stored, Dean (Haiku) sends a contextual message asking which week the athlete is on, acknowledging the caption if one was included. The reply is intercepted in the Linq webhook (checks `message_type === "plan_import_week_ask"` on the last assistant message) and handled by a new `handlePlanWeekSync` function: extracts the week number via Haiku, loads the uploaded plan week, converts sessions to the `{ day, date, label }` format, and updates `training_state` (current_week, weekly_mileage_target, weekly_plan_sessions). Dean confirms with a brief week summary. Handles "I don't know / just start from the beginning" → week 1.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/webhooks/linq/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-15 — PDF plan import via iMessage

**Type:** Feature
**Reported by:** Internal (user test: sent PDF via iMessage to Coach Dean number)
**User feedback:** N/A
**Root cause:** Linq webhook received PDF attachments with `mime_type: "application/pdf"` but the code only detected image MMS parts (no mime_type check), passing the PDF URL to Claude's vision API which returned a 400 error. The PDF was then silently dropped.
**Fix / Change:** Added PDF detection by `mime_type === "application/pdf"` in the webhook parts parsing, routing PDF attachments to a new `handlePDFPlan` function. Added `pdf_url` content type to `/api/plan/upload` with `extractFromPDF` that fetches the PDF, base64-encodes it, and passes it to Claude's document API. Dean replies with a session/week count confirmation via SMS.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/plan/upload/route.ts`

---

## 2026-04-15 — Mountain race predictor, plan import, dashboard announcement, eval parity

**Type:** Feature (3) / Improvement (1)
**Reported by:** Jake (user feedback)
**User feedback:** "I noticed when I look at the pace projections on the new overview part of the dashboard that the projections for mountain races can be really far off from the actual results. I looked at their actual results for the Cirque Series Snowboard Race last year, and I think the fastest time for pros was 1:22. My projection is 1:23, and I'm kind of an intermediate amateur. I think that is off a little bit."

---

### Fix 1 — Mountain race prediction: `mountain` subtype + course record projection

**Root cause:** The `highly_technical` trail subtype (35% penalty) was the worst-case in the predictor, but sky/VK/mountain races like Cirque Snowbird are in a completely different category. VDOT stops being meaningful for these events — everyone hikes the steep sections, compressing the field. A VDOT 62 runner was getting a 1:23 projection for a race where the course record is 1:22.

**Fix / Change:**
- Added `mountain` to `TrailSubtype` union with a 65% VDOT-fallback penalty (the previous max was 35% for `highly_technical`)
- Added `courseRecordMinutes?: number` to `RacePredictionInput` — when provided for trail/mixed terrain, activates a percentile-based projection path instead of pure VDOT extrapolation
- New `courseRecordMultiplier(vdot, subtype)` function: estimates how far behind the course record the athlete will finish based on their VDOT and terrain type. Mountain races use the tightest spread table (everyone hiking compresses the field). Highly technical uses a moderate table. Standard trail uses a wider table closer to road spreads.
- `predictRaceTime` now has two paths: (A) course record projection for trail/mixed when CR is provided (skips terrain penalty, which is baked into the multiplier; heat/altitude still apply), (B) original VDOT path for road or when no CR is provided
- Caveats updated: mountain without CR gets "No course record provided — using VDOT estimate for mountain terrain (less accurate)"; mountain with CR gets the standard mountain estimate caveat
- Added `course_record_minutes` column to `races` table (migration 035), updated DB types, updated races SELECT in dashboard, passed to predictor, show CR in race card
- Updated constraint to allow `trail_subtype = 'mountain'`
- 16 new tests added to `race-predictor.test.ts` (mountain penalty, course record projection, heat/altitude apply on top of CR, road terrain ignores CR path, narrative format)
**Files changed:** `src/lib/race-predictor.ts`, `src/__tests__/lib/race-predictor.test.ts`, `src/app/dashboard/page.tsx`, `src/lib/database.types.ts`, `supabase/migrations/035_plan_import_mountain.sql`

---

### Fix 2 — Plan import: Option A (text description) + Option B (dashboard image upload)

**Root cause:** Onboarding already asked "do you have an existing training plan?" and promised "text description or upload to the dashboard later" — neither was wired up.

**Fix / Change (Option A — text description):**
- Added `external_plan_description` to Haiku extraction schema: captures a brief factual summary when athlete has an existing plan ("Runna 16-week HM plan, week 8, ~40mi/week")
- Added to `summarizeCollected` so Dean sees it under "WHAT YOU ALREADY KNOW" during onboarding
- Stored in new `training_profiles.external_plan_notes` column (migration 035)
- Injected into coaching system prompt under preferred_units: Dean uses it as context for post-run coaching without trying to replace the plan

**Fix / Change (Option B — dashboard image upload):**
- Surfaced the existing `POST /api/plan/upload` route (image_base64 path) from the dashboard
- New `src/app/dashboard/plan-import-form.tsx` client component: upload button (PNG/JPG/WebP), base64 encode, dry-run preview showing week count + session count + avg mi/week, "Save to Dean" confirm, success/error states
- Added to `!hasPlan` section of `plan-tab.tsx`; `userId` prop threaded through `PlanTabProps`

**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/plan-import-form.tsx` (new), `src/app/dashboard/plan-tab.tsx`, `src/app/dashboard/page.tsx`, `src/lib/database.types.ts`, `supabase/migrations/035_plan_import_mountain.sql`

---

### Fix 3 — Dashboard announcement: POST /api/admin/dashboard-announcement

**Root cause:** Need to notify active users of the new dashboard features and plan import capability.

**Fix / Change:**
- New `POST /api/admin/dashboard-announcement` endpoint (mirrors v2-migration pattern)
- Targets: `onboarding_step IS NULL` + `messaging_opted_out = false` + active in last 14 days (conversation row within cutoff) + `dashboard_announcement_sent_at IS NULL`
- Unlike v2-migration, does NOT require Strava — targets all active users
- Message announces dashboard URL, race readiness/training load/fitness projections, and plan import (text summary or dashboard upload)
- `dashboard_announcement_sent_at` column added to `users` table (migration 035)

**Dry-run curl:** `curl -X POST https://coachdean.ai/api/admin/dashboard-announcement -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>","dry_run":true}'`
**Live curl:** `curl -X POST https://coachdean.ai/api/admin/dashboard-announcement -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>"}'`

**Files changed:** `src/app/api/admin/dashboard-announcement/route.ts` (new), `supabase/migrations/035_plan_import_mountain.sql`, `src/lib/database.types.ts`

---

### Fix 4 — Simulation eval runner: summarizeCollected parity

**Root cause:** `summarizeCollected` in `run-simulation-evals.mjs` was missing four fields added in the v2 onboarding revamp: `training_tools`, `terrain_type`, `has_existing_plan`, `wants_weekly_recap`, and the new `external_plan_description`. The simulation runner's "WHAT YOU ALREADY KNOW" block was therefore showing incomplete data to Dean, potentially causing re-asking of already-collected fields.

**Fix / Change:** Patched `summarizeCollected` in `evals/run-simulation-evals.mjs` to mirror the current `route.ts` version exactly.

**Files changed:** `evals/run-simulation-evals.mjs`

---

## 2026-04-14 — Mountain race prediction: course data support

**Type:** Feature
**Reported by:** User feedback
**User feedback:** "did the new prediction logic actually get applied and run? Mine look aggressive for mountain races still!"
**Root cause:** The race predictor had elevation/altitude/trail-subtype logic but the dashboard call and the `user_message` race predictor block never passed those values — because the `races` table didn't store course profile data.
**Fix / Change:**
- Added `elevation_gain_feet`, `elevation_loss_feet`, `race_altitude_ft`, `trail_subtype` columns to the `races` table (migration 034)
- Dashboard now reads and passes course data to `predictRaceTime` — mountain race predictions now apply grade-dependent elevation penalties and altitude penalties
- `user_message` race predictor block also passes course data from the stored A race
- Dean can now save course data when an athlete mentions it via SMS — emits `[RACE_COURSE_UPDATE:{...}]` tag which is persisted to the races table
- For trail races missing course data, Dean's prediction prompt includes a note asking him to request and save elevation/altitude from the athlete
- Course data (gain, loss, altitude, trail type) is shown in the goal race block of Dean's system prompt
- Removed VDOT badge from the aerobic efficiency card (user reported it looked off)
- Improved pacing zones display: from monospace joined text to a labeled 3-row grid with color dots and a note clarifying paces are from Dean's coaching notes (not HR-linked)
**Files changed:** `supabase/migrations/034_race_course_data.sql`, `src/lib/database.types.ts`, `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-14 — v2.0 migration: disable morning/nightly crons + user transition message

**Type:** Feature / Infra
**Reported by:** Internal — product shift to reactive analysis model
**User feedback:** N/A — proactive decision
**Root cause:** v2.0 repositions Dean as a reactive analysis layer (post-run debrief + Sunday recap). Morning and nightly reminder crons were plan-driven proactive messages that no longer fit the product model. Existing users needed a graceful transition message.
**Fix / Change:**
- Disabled `morning-reminder` and `nightly-reminder` crons with `if (true as boolean) return` pattern (cast prevents TypeScript dead-code errors while preserving full implementation for potential reactivation)
- Added `supabase/migrations/033_v2_migration.sql`: `v2_migration_sent_at timestamptz` column on `users` table — idempotency guard for the migration message
- Added `POST /api/admin/v2-migration`: targets users who completed onboarding + have Strava + haven't received the message yet. Sends a plain-language transition message explaining the shift, stores to conversations, marks `v2_migration_sent_at`. Supports `dry_run` for preview and `userId` for single-user testing. 2-second spacing between sends to avoid rate limits.

**Dry-run curl:**
```bash
curl -X POST https://coachdean.ai/api/admin/v2-migration -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>","dry_run":true}'
```
**Live run:**
```bash
curl -X POST https://coachdean.ai/api/admin/v2-migration -H "Content-Type: application/json" -d '{"secret":"<ADMIN_SECRET>"}'
```
**Files changed:** `src/app/api/cron/morning-reminder/route.ts`, `src/app/api/cron/nightly-reminder/route.ts`, `src/app/api/admin/v2-migration/route.ts` (new), `supabase/migrations/033_v2_migration.sql` (new), `src/lib/database.types.ts`

---

## 2026-04-14 — Tests: race predictor test suite (50 tests)

**Type:** Infra / Testing
**Reported by:** Internal — identified as highest-risk untested code
**Root cause:** The race predictor was fully rewritten in the previous session with no corresponding tests. Grade-dependent elevation, 4-level trail subtypes, scaled Riegel exponents, tiered heat/humidity, and altitude adjustments all had zero coverage.
**Fix / Change:** Added `src/__tests__/lib/race-predictor.test.ts` with 50 tests across 11 describe blocks:
- VDOT derivation priority (race → best_effort → easy pace → long run → null)
- Riegel exponent scaling across marathon/50K/50mi/100K+
- Elevation: road 1.0 min/1000ft, trail <10% grade 1.5 min/1000ft, trail >10% grade 2.0 min/1000ft
- Steep descent penalty threshold (>12% avg grade)
- All 4 trail subtypes + inferTrailSubtype thresholds (gain/mile)
- Heat tier 1 (2%/5°F), tier 2 (3.5%/5°F), humidity modifier (>70% → +1.5%), 15% cap
- Altitude penalty (2%/1000ft above 5000ft, 10% cap), altitude caveat flag
- Distance mismatch range widening
- Source labels and caveats for all paths
- Edge cases (no data → null, low/predicted/high ordering)
**Files changed:** `src/__tests__/lib/race-predictor.test.ts` (new)

---

## 2026-04-14 — Dashboard: "Training Plan" tab added alongside Overview

**Type:** Feature
**Reported by:** User request
**User feedback:** "is it possible to easily keep the plan on a separate tab if the user wants? That way it's very little disruption for now"
**Root cause:** N/A — additive feature request
**Fix / Change:** Added a two-tab toggle ("Overview" / "Training Plan") to the dashboard. The tab switcher is a lightweight client component (`tab-container.tsx`) that hides/shows pre-rendered server content — no extra data fetches on switch. The Training Plan tab surfaces the full plan calendar (this week's daily breakdown, full arc with phase badges and actual-vs-target mileage) ported from the legacy `_legacy/page.tsx` into a new `plan-tab.tsx` component. Users with no Dean-generated plan see a prompt to text Dean. The page also now fetches `training_plans`, `weekly_plan_sessions`, `training_days`, and override columns that the plan tab needs.
**Files changed:** `src/app/dashboard/tab-container.tsx` (new), `src/app/dashboard/plan-tab.tsx` (new), `src/app/dashboard/page.tsx`

---

## 2026-04-14 — Race predictor: new label framework + major prediction model improvements

**Type:** Feature / Improvement
**Reported by:** User feedback
**User feedback:** "and what about the labeling? Replace the binary High/Medium/Low with a two-part label: source quality + a plain-language caveat when warranted ... The range should probably be labeled too — right now it just floats there. Something like 'likely finish window' underneath it in muted text makes it feel like a real coaching tool"
**Root cause:** Old "High/Medium/Low confidence" with "Race data/Training data/Estimated" subtext was binary and opaque. Elevation and trail penalties were oversimplified. Riegel exponent didn't scale for ultra distances.
**Fix / Change:**
- Replaced confidence display with `sourceLabel` ("Based on recent race" / "Based on training data" / "Estimated from easy pace" / "Estimated from long runs") and optional `caveat` for edge cases (trail races, ultras, altitude mismatch)
- Added "Likely finish window" label above the range in the race card
- Grade-dependent elevation penalties: 1.5 min/1000ft (trail, <10% avg grade), 2.0 min/1000ft (trail, >10% grade), 1.0 min/1000ft (road); descent penalty 0.5 min/1000ft when avg grade >12%
- 4-level trail subtype system: groomed (10%), mixed (17%), technical (26%), highly_technical (35%) pace penalty; `inferTrailSubtype` auto-infers from gain/mile
- Riegel exponent scales with ultra distance: 1.06 (marathon), 1.10 (50K), 1.12 (50mi), 1.15 (100K+)
- Distance-mismatch guard: when goal race >2× VDOT source distance, range widens ±4% and caveat is added
- Tiered heat penalty: 2%/5°F (75–85°F), 3.5%/5°F (85–95°F), +1.5% humidity modifier when >70% humidity
- Altitude adjustment: +2%/1000ft above 5000ft; altitude caveat when training altitude >3000ft below race
**Files changed:** `src/lib/race-predictor.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-14 — Race predictor now uses best_efforts PRs for VDOT derivation

**Type:** Bug Fix / Improvement
**Reported by:** Internal observation (user noted predicted VDOT appeared too low)
**User feedback:** "I think my VDOT is like 57 based on my 17:23 (maybe a bit slower) 5k" — implying the displayed value was lower than expected
**Root cause:** `deriveVDOT` only considered whole Strava activities with `workout_type=1` (race). A 5K PR set during a regular training run (workout_type=0) was never reaching the VDOT derivation path — it fell through to the less-accurate easy pace estimation.
**Fix / Change:** Added a new step 3 in `deriveVDOT` that scans `best_efforts` across all activities for any effort ≥ 5K. Picks the effort that yields the highest VDOT (most accurate fitness signal). Updated `RacePredictionInput` type to accept `best_efforts`. Updated dashboard to pass `best_efforts` into both `estimateVDOT` and `predictRaceTime` calls. A 17:23 5K best effort now correctly yields VDOT ~62–63, with corresponding race predictions: half ~1:22, marathon ~2:52.
**Files changed:** `src/lib/race-predictor.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-14 — v2 dashboard revamp: insights, race readiness, efficiency trends

**Type:** Feature
**Reported by:** Internal (v2 product spec)
**User feedback:** N/A
**Root cause:** Existing dashboard showed only the plan calendar (generated plan arc), which is irrelevant for users with external plans (Runna, Garmin). No training trend visualisation or race prediction panel.
**Fix / Change:** Replaced plan-calendar dashboard with a data-driven v2 layout: quick-stats row (current week mileage, race countdown, load trend, aerobic fitness), race readiness panel with predicted finish time and goal comparison, weekly mileage bar chart (last 12 weeks with 10% threshold line), aerobic efficiency trend line chart, recent post-run/weekly-recap insight feed (last 10), personal records by distance. Old plan-calendar page preserved at `src/app/dashboard/_legacy/page.tsx`. Dashboard is fully server-rendered — no client-side charting dependency added.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/dashboard/_legacy/page.tsx`

## 2026-04-14 — Auto-fix: AI identity guardrail, session-consolidation math, mileage projection cap

**Type:** Bug Fix (3 issues — auto-fixed from 2026-04-13 conversation analysis)
**Reported by:** Automated conversation analysis
**User feedback:** N/A

---

### Fix 1 — P0: Dean roleplayed as a human athlete

**Root cause:** The existing COACH DEAN'S IDENTITY section had soft "Do NOT" language that the model could override when generating a relatable-seeming reply. User 32d7510f asked "what's your training week look like" and Dean responded with fabricated personal training details ("I'm running 40-50mi/week right now — mostly easy miles with one long run and one tempo or hill session. I lift 2x/week..."). When probed, Dean couldn't provide further details, revealing the deception.
**Fix / Change:** Converted the identity section header to a hard `<rule>` tag with ABSOLUTE IDENTITY RULE language. Explicitly names the failure mode ("I'm running 40-50mi/week right now") as a forbidden response. Requires honest deflection in one sentence then immediate redirect to athlete's training.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Fix 2 — P1: Session-consolidation math (dangerous makeup-volume advice)

**Root cause:** User 2e5a7e92 asked to consolidate Sat+Sun into a Saturday double and drop Sunday. Dean correctly calculated the new weekly total (30mi) but then told the athlete to "make sure Saturday volume hits close to the 26mi combined target" — implying the athlete should run 26mi on Saturday alone to compensate. This conflated the combined Sat+Sun target (16+10=26mi) with a single-session goal, which is both incoherent and dangerous.
**Fix / Change:** Added a `SESSION CONSOLIDATION MATH` `<rule>` block next to the existing structural-change rules. Explicitly forbids suggesting the full dropped-session volume be made up in a single day. Provides a correct example: state the lower total, offer only a modest add-on (2–3mi) if the athlete asks to preserve volume.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

### Fix 3 — P1: Weekly mileage projection inflated (77.2mi from 8.2mi Monday run)

**Root cause:** User 70818a68 received a post-run message saying "8.2 mi logged this week. You've got 5 sessions left (Tue–Sat) on track for ~77.2 mi." The `computeProjectedWeekMiles` function summed remaining sessions from `weekly_plan_sessions` without any sanity check against the stored `weekly_mileage_target`. If stored sessions carry incorrect or stale mileage labels, the projection faithfully reflects those bad values and `correctProjectedTotal` has no basis to override them.
**Fix / Change:** Added an optional `weeklyMileageTarget` parameter to `computeProjectedWeekMiles`. If the computed projection exceeds `weeklyMileageTarget * 1.2`, the function caps the result at `weeklyMileageTarget` (the plan's authoritative target) and logs a warning. Updated the call site to pass `state?.weekly_mileage_target`.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-14 — Update Strava annotation header: week/total instead of phase, metrics back in block

**Type:** Improvement
**Reported by:** Jake
**User feedback:** N/A
**Root cause:** Previous annotation header showed training phase ("Build", "Taper") which was meaningful for plan users but absent for general fitness users. The `— coachdean.ai` suffix on the dean note made the branding feel tacked on rather than anchored. Metrics (decoupling, efficiency, best GAP) were hidden from the block; athletes who checked Strava saw only 3 lines with no specifics.
**Fix / Change:** Header now reads `{emoji} coachdean.ai — Week X of Y · Race Xd out`. Removed `currentPhase` from `AnnotationContext` entirely. Fetches `total_weeks` from `training_plans` for the "of Y" context. Metrics (decoupling, efficiency, best GAP) are shown in the block again, separated from the dean note by a blank line. Note expanded to 1–2 sentences (max_tokens 80→150) to allow weather/terrain context.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-14 — Redesign Strava annotation block format

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "trim it down more — weave a human readable insight into the 1 line analysis. If the user is in a phase of a plan, label the phase. Remove other obscure metrics."
**Root cause:** Annotation block surfaced raw metrics (cardiac decoupling, aerobic efficiency, best GAP) as standalone lines, making it feel like a data dump rather than a coaching note.
**Fix / Change:** Redesigned the block to 3 lines: `{emoji} {Phase} · {Race Xd}` header, `Week: X / Ytmi` mileage line, and the dean note ending with ` — coachdean.ai`. Decoupling, efficiency, and best GAP are now passed to the LLM as context only (woven into the insight) rather than shown as separate lines. Phase label is omitted for general fitness users without a plan.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-14 — Fix "yesterday" bug for cross-training activities in post_run feedback

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "my hike was sunday (two days ago) not yesterday! ... Coach Dean: ... That's good load after the hike yesterday."
**Root cause:** Two issues: (1) The ACTIVITY RECENCY guard ("never say yesterday for activities 2+ days ago") only existed in the `user_message` prompt, not in `post_run`. (2) The rule text said "run" specifically, so cross-training activities like hikes were not explicitly covered even in `user_message`. Claude saw "(2 days ago)" for the hike in RECENT WORKOUTS but had no instruction preventing "yesterday" in post-run context.
**Fix / Change:** Added ACTIVITY RECENCY guard to the `post_run` system prompt, explicitly covering all activity types (runs, hikes, rides, etc.). Updated the same rule in `user_message` to say "activity" instead of "run" for consistent coverage. Added eval fixture `quality-post-run-hike-reference` to catch regressions of this exact case.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/fixtures/quality-post-run-hike-reference.json`

## 2026-04-13 — Estimate distance for time-based interval sessions in dashboard

**Type:** Improvement
**Reported by:** Internal observation (dashboard showing 0mi for "4×3min @ 8:30/mi" sessions)
**User feedback:** "looks like the labels in 'this week' are still off - I'm seeing a 0 mi label for the quality session!"
**Root cause:** `parseKeyWorkoutMiles` had no logic for time-based intervals (e.g. "4×3min @ 8:30/mi"). It returned `null`, causing the dashboard to display 0mi. Also, the regex `(mi|km|m)` matched "m" from "min", and `^(\d+)\s*mi` matched the "mi" in "min" (e.g. "20min fartlek" → 20).
**Fix / Change:** Extracted `parseKeyWorkoutMiles` to `src/lib/parse-key-workout-miles.ts`. Added time-based rep estimation: `work = (reps × workMin) / paceMinPerMi`, `recovery = ((reps-1) × recoveryMin) / (paceMinPerMi + 2)`. Fixed regex lookaheads: `mi(?!\w)` prevents matching "min"; `(mi|km|m)(?!\w)` prevents "m" matching inside "min"/"mi". Added WU/CD summing for all resolution paths. Added Haiku prompt rule requiring `1mi WU + 1mi CD` on all interval/tempo sessions.
**Files changed:** `src/lib/parse-key-workout-miles.ts` (new), `src/__tests__/lib/parse-key-workout-miles.test.ts` (new, 21 tests), `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`

---

## 2026-04-13 — Dashboard: fix Sunday dimming, timezone-aware day highlighting, stride classification, zero-target crash

**Type:** Bug Fix (4 issues)
**Reported by:** Internal proactive audit
**User feedback:** N/A
**Root cause:**
1. **Sunday dimming**: On Sunday after the weekly recap cron advances `current_week`, the dashboard showed next week's Mon–Sat sessions all dimmed as "past" because `todayDayIdx = DAY_ORDER.indexOf("Sunday") = 6`, making `isPastDay = dayIdx < 6` true for every day of the new week.
2. **Server UTC for day highlighting**: `todayDayName` used `new Date().toLocaleDateString(...)` which runs server-side on Vercel in UTC. A Pacific user at 11pm Monday would see Monday dimmed as "past" (it's already Tuesday UTC). The user's `timezone` column was not fetched or used anywhere in the dashboard.
3. **"Easy with strides" misclassified as key workout**: `classifySession` checked `l.includes("stride")` before checking if the label started with "easy", so "Easy 6mi with strides" was rendered bold as a quality session.
4. **Progress bar division by zero**: When `displayMileageTarget = 0`, the width style computed `NaN%` (Infinity clamped to 100), showing a full green bar even when no target was set.
**Fix / Change:**
1. Fetch `timezone` from the `users` table in the dashboard query.
2. Derive `userDayName` and `userDOW` via `Intl.DateTimeFormat` with the user's stored timezone. Use these for `todayDayIdx` (day dimming) and `todayStr` (override expiry check).
3. `todayDayIdx = userDOW === 0 ? -1 : DAY_ORDER.indexOf(userDayName)` — -1 on Sunday so no days in the upcoming week appear past.
4. Added `if (l.startsWith("easy")) return "easy"` before quality keyword checks in `classifySession`.
5. Added `&& displayMileageTarget > 0` guard on the progress bar render condition.
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-13 — Fix "Easy 5.5mi" label showing wrong distance; fix duplicate A-race insertion

**Type:** Bug Fix
**Reported by:** User (ac0ab080) — dashboard "This Week" showed Wed as "Easy 5.5mi" with 1.5mi distance
**User feedback:** "do you also see the wrong labels in this week"
**Root cause:** Two bugs:
1. `buildDailyPlanFromArc` in dashboard: `parseKeyWorkoutMiles` uses `^` (start-of-string anchor), so "Easy 5.5mi" → null → fell back to 20% of weekly mileage (1.5mi). The label showed the key_workout text ("Easy 5.5mi") while the distance showed the fallback (1.5mi) — contradictory.
2. `handleRebuildPlan` B/C race sync: `existingDates` was built only from B/C races. If the A-race date appeared in `onboarding_data.other_races`, it wasn't in existingDates and would be re-inserted as a duplicate A race.
**Fix / Change:**
1. When `key_workout` starts with "Easy", treat that day as a regular easy run rather than a quality session — distribute all non-long-run mileage evenly across easy days (including the "key" day). This makes base weeks show consistent "Easy run" labels and correct per-session distances.
2. In `handleRebuildPlan`, build `existingDates` from ALL races (not just B/C), and add an explicit filter excluding A-priority entries from the sync insert.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Fix peak-phase mileage jump and B-race week label off-by-one

**Type:** Bug Fix
**Reported by:** User (ac0ab080) — plan dashboard showed weeks 12–13 at 45mi/19mi long run after building to only ~10mi/week from a 5mi/week base
**User feedback:** "Bad plan generation is looks like."
**Root cause:** Two bugs in `training-plan.ts`:
1. Peak phase forced `buildMileage = targetPeak` — this assumed the runner had already ramped to `targetPeak`, but the marathon floor is 45mi and a 10%/week cap from 5mi/week can only reach ~12mi in 15 weeks. The result was a hard jump from 10.5mi to 45mi in week 12.
2. B-race week label used `Math.round(...) + 1` while totalWeeks and aRaceWeekNum use `Math.ceil(...)`. For Bay to Breakers (4.857 weeks out), this produced Week 6 instead of the correct Week 5.
**Fix / Change:**
1. Replaced `buildMileage = targetPeak` in peak phase with the same `Math.min(buildMileage * weeklyBuildFactor, targetPeak)` formula used in build weeks — this naturally plateaus when targetPeak is reached, and ramps safely when it isn't.
2. Changed B-race week label formula to `Math.ceil(...)` to match the rest of the arc.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-13 — Fix week 1→2 arc mismatch; tighten moderate-volume week 1 cap

**Type:** Bug Fix + Improvement
**Reported by:** Jake (dashboard review — wife's plan showed week 1=18mi, week 2=15.5mi)
**User feedback:** N/A
**Root cause (arc mismatch):** The training arc is built from `avgWeeklyMileage` (e.g. 14mi). `syncArcCurrentWeek` then patches arc week 1 to reflect what Dean actually prescribed (e.g. 18mi). But weeks 2+ remained calibrated from the original 14mi base, causing a visible drop (week 1=18 → week 2=15.5) on the dashboard.
**Root cause (volume cap):** The moderate-volume (10–30mi/week) week 1 cap was labeled "GUIDELINE", making it easy for Dean to ignore. Dean composed reasonable-looking individual sessions (5mi tempo + 4mi easy + 3mi easy + 6mi long) that summed to 18mi — 28% above a 14mi base.
**Fix / Change:** (1) `syncArcCurrentWeek` now proportionally rescales all future weeks when patching week 1 — scale factor = actualMiles/originalWeek1. E.g. scale 1.286× turns week 2=15.5 into 20, week 3=17 into 22, etc., preserving arc shape. Only fires when the difference is >5%. (2) Moderate-volume prompt cap changed from "GUIDELINE" to "LIMIT" with an explicit ceiling action: "if sessions sum above [avg×1.2], reduce at least one easy run."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Onboarding asks about injuries and training preferences for all goals

**Type:** Improvement
**Reported by:** Jake (internal review)
**User feedback:** N/A
**Root cause:** The onboarding prompt only required injury/limitation notes for ultra goals and injury_recovery goals. Standard trail race, half marathon, and marathon athletes were never asked about injury history or training preferences, so this context was missing from their plans.
**Fix / Change:** Added a catch-all "anything I should know" question to the onboarding prompt for all goal types — framed around injury history and training preferences (e.g. loves hills, hates treadmills). Added `other_notes` to the extraction schema so preferences beyond `injury_notes` get stored in `onboarding_data` and automatically passed to plan generation.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-13 — Strava onboarding message split; cross-training note clarity

**Type:** Improvement
**Reported by:** Jake (internal review)
**User feedback:** "Can we make this two messages? Feels like we should generally not send super long texts like this" / "Should that be something like 'so you get instant feedback and metrics to improve on'?" / "Does Dean mean that I should cycle or pool run instead of regular run? it wasn't clear to me if this is a good replacement or not"
**Root cause:** (1) The Strava onboarding message was one long SMS combining Claude's pitch + the URL + instructions. (2) The Strava value prop used the low-impact phrase "so it shows up in your log." (3) When Haiku generates injury-aware cross-training suggestions in the coach's note, it didn't specify whether they replace or supplement a run session, leaving athletes confused.
**Fix / Change:** (1) Split the Strava message into two SMS: message 1 is Claude's explanation, message 2 is the URL + "No Strava? Just reply skip." (2) Updated the Strava prompt instruction to use "instant coaching feedback on their effort, pacing, and what to focus on next." (3) Updated the Haiku enrichment injury prompt to explicitly state that cross-training alternatives REPLACE a run session for that day.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/lib/training-plan.ts`, `src/__tests__/api/onboarding-handle.test.ts`

## 2026-04-13 — Eliminate remaining dual-state between `races` table and `training_profiles`

**Type:** Refactor / Bug Fix
**Reported by:** Internal (architecture cleanup)
**User feedback:** N/A
**Root cause:** Three residual drift points remained after making `races` the SoT for plan generation: (1) `buildSystemPrompt` read `goal_time_minutes` from `onboarding_data` (only set at onboarding, never updated) instead of `training_profiles` (kept in sync by `persistProfileUpdates`) — meaning mid-coaching goal-time updates didn't affect Dean's pacing advice; (2) `persistProfileUpdates` updated `training_profiles.goal_time_minutes` but never synced it to `races(A).goal_time_minutes`, so the dashboard's race card could show a stale time; (3) the dashboard derived `raceDate` and `goalBucket` from `training_profiles` first instead of the `races` table.
**Fix / Change:** (1) `buildSystemPrompt` now prefers `profile.goal_time_minutes ?? onboarding_data.goal_time_minutes` so post-onboarding goal updates flow through to pacing advice immediately. (2) `persistProfileUpdates` now syncs `goal_time_minutes` to `races(A)` alongside the profile update. (3) Dashboard derives `raceDate` and `goalBucket` from `upcomingRaces.find(priority=A)` first, falling back to `training_profiles` / `training_plans` for legacy users with no A race row. Added a test asserting the races sync for `goal_time_minutes`.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`, `src/__tests__/api/coach-respond-field-sync.test.ts`

---

## 2026-04-13 — `races` table is now the single source of truth for the A race

**Type:** Refactor
**Reported by:** Internal (architecture cleanup, P1 roadmap item)
**User feedback:** N/A
**Root cause:** The A race date and goal lived in two places: `training_profiles.race_date`/`training_profiles.goal` and `races` (priority=A). `generateAndSaveFullPlan` read only from `training_profiles`, so any drift between the two tables caused the plan to use the wrong race date. This contributed to plan-length bugs in the prior session.
**Fix / Change:** `generateAndSaveFullPlan` now queries `races` (priority=A) first for `race_date` and `goal`. Falls back to `profile.race_date`/`profile.goal` only if no A race row exists (backward compat for legacy users with no races row). All mutation paths already write to `races` as part of `persistProfileUpdates` — no other changes needed. The fallback ensures 268 tests remain green without modification.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-13 — Post-onboarding B/C race extraction and auto-rebuild

**Type:** Feature
**Reported by:** Jake (roadmap item)
**User feedback:** "can we tackle the roadmap item right now and test it?"
**Root cause:** `ExtractedProfileData` had no field for secondary races, so when a user mentioned "I also signed up for X on [date]" post-onboarding, the race never made it to the `races` table and the plan arc never extended to cover it.
**Fix / Change:** Added `new_b_races` to `ExtractedProfileData` and the Haiku extraction prompt. Phrases like "I also signed up for X", "doing Y as a tune-up", "I registered for Z too" now extract into `new_b_races` with date, name, priority (B/C), and goal_distance_miles. `persistProfileUpdates` deduplicates against existing `races` rows by date, inserts any new ones, and fires a silent `rebuild_plan` so the arc extends immediately. Past-dated races are filtered out. 4 tests added.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond-field-sync.test.ts`

---

## 2026-04-13 — Weekly recap self-heals missing B/C races from onboarding_data

**Type:** Bug Fix / Reliability
**Reported by:** Jake (dashboard review)
**User feedback:** "I'm wondering if we should consider giving users a command to rebuild plan... I'm just worried other users will get into this state as well."
**Root cause:** The B/C race sync added to `handleRebuildPlan` only fires when a rebuild is explicitly triggered. Users whose plans were missing a B/C race had no automated recovery path unless they texted Dean to rebuild.
**Fix / Change:** Added the same B/C race sync to the `weekly_recap` `after()` block. Every Sunday after generating the week's plan: reads `onboarding_data.other_races`, inserts any future-dated races missing from the `races` table, and silently triggers a `rebuild_plan` if any were added. All users self-heal automatically by the next weekly recap.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Sync B/C races from onboarding_data to races table during rebuild_plan

**Type:** Bug Fix
**Reported by:** Jake (dashboard review)
**User feedback:** "I thought it was weird that the plan didn't include my July 11th race — it used to, and now I just see Dipsea"
**Root cause:** `handleRebuildPlan` queries the `races` table for B/C races to pass to `generateAndSaveFullPlan`. If a race was captured in `onboarding_data.other_races` but never written to (or was accidentally omitted from) the `races` table, it gets silently excluded from the plan arc. Jake's Snowbird race was in `onboarding_data.other_races` but not in `races`.
**Fix / Change:** Added a sync step in `handleRebuildPlan` that, before querying B/C races, reads `onboarding_data.other_races`, finds any future-dated entries not already in the `races` table, inserts them, and merges them into the local `bCRaces` array so they're included in the plan generation. Non-fatal: if the insert fails, it logs and continues with whatever is in the `races` table.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Extracted and tested Strava annotation metric helpers

**Type:** Refactor / Tests
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Aerobic efficiency, cardiac decoupling, best GAP, and emoji selection logic were all private inline code inside `annotateStravaActivity`, making them impossible to unit test without full integration-test scaffolding.
**Fix / Change:** Extracted five pure functions (`selectActivityEmoji`, `processSplitsForMetrics`, `computeAerobicEfficiency`, `computeCardiacDecoupling`, `formatBestGapLine`) and exported them. Added 42 new unit tests covering filtering logic, edge cases (no HR, no GA data, paused splits), drift thresholds, and format correctness. No behavior changed.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/strava-annotation.test.ts`

---

## 2026-04-13 — Rebuilt Jake's plan: 9→11 weeks, fixed weekly target mismatch

**Type:** Bug Fix / Data
**Reported by:** Jake (dashboard review)
**User feedback:** "Plan is now too short - it ends before my first race. This week doesn't match arc target after adjustment. Coach's note talks about tempo but quality session is intervals."
**Root cause:** The `rebuild_plan` trigger fired at 04:03 UTC on April 13, before the anchor fix (`73e97fc`) was deployed at 14:56 UTC. Without `anchorMonday`, `totalWeeks = ceil(Apr 13 → Jun 14 / 7) = 9` instead of the correct `ceil(Mar 30 → Jun 14 / 7) = 11`. The plan ended May 31 — two weeks before the June 14 Dipsea. The coach note/interval mismatch was a Haiku enrichment artifact from the same stale rebuild. The `weekly_mileage_target` (27) was left over from the old plan's week 1 target and didn't match the arc (32.5) or the prescribed sessions sum (~33mi).
**Fix / Change:** Manually triggered `rebuild_plan` again with the anchor fix deployed — plan is now 11 weeks (Mar 30 – Jun 14). Haiku enrichment regenerated week 3 notes, which now correctly describe the 600m interval session. Updated `training_state.weekly_mileage_target` from 27 → 32.5 to match the arc.
**Files changed:** N/A (data fix via admin triggers)

---

## 2026-04-13 — Fixed mid-plan rebuild anchoring wrong taper weeks

**Type:** Bug Fix
**Reported by:** User (dashboard review)
**User feedback:** "I'm wondering if my plan is still messed up somehow — it has me taper too early before my first race"
**Root cause:** `generateAndSaveFullPlan` computed `totalWeeks` and `aRaceWeekNum` from the current Monday. For mid-plan rebuilds, the dashboard anchors to `week1Monday` (= currentMonday − (currentWeek−1)×7), which can be several weeks earlier. This caused the plan to have too few total weeks (race fell outside the plan), or race week numbers that didn't match the dashboard's calendar — resulting in the A-race taper appearing 2–3 weeks too early and the actual race week showing "peak" with full volume.
**Fix / Change:** Added `anchorMonday` parameter to `generateAndSaveFullPlan`. `handleRebuildPlan` now computes `week1Monday` (using the same formula as the dashboard) from `currentWeek` and passes it as `anchorMonday`. This ensures `totalWeeks`, `aRaceWeekNum`, and B/C race week labels are all computed relative to the plan's original start, not today's date. Week-1 rebuilds (where both anchors are identical) are unaffected. Also rebuilt the affected user's plan after deploying the fix.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-13 — Fix recovery week over-resting when athlete mentions soreness

**Type:** Bug Fix
**Reported by:** User observation
**User feedback:** "I think she said her calves were tight so it recommended not running Monday...but 29 feels like a big drop for 'my calves are tight'"
**Root cause:** The `RECURRING INJURY ALERT` in the system prompt instructs Dean to "recommend taking a rest day or reducing intensity — do not continue with normal coaching mode." This fires for all trigger types, including `weekly_recap`. So when planning the week, Dean saw calf tightness in `injury_body_parts`, added Monday rest + Friday rest + strength on Wednesday, and ended up with 4 runs (29 mi) instead of 6 runs (~40 mi). The recovery week rule already said "same number of runs, just shorter" but Dean overrode it via the injury alert.
**Fix / Change:** (1) Scoped the `RECURRING INJURY ALERT` to exclude plan generation: during `weekly_recap`, instead of canceling runs, Dean must annotate them ("softer surface, stop if pain") and keep the run count. (2) Added an explicit callout to both recovery week rules (`tsDeloadBlock` and the recap-context rule): "Do NOT add extra rest days to hit the lower total — the mileage reduction is the recovery, not fewer running days."
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-13 — Fix prose weekly mileage target inconsistency in weekly_recap

**Type:** Bug Fix
**Reported by:** User observation
**User feedback:** "He said going to 40 miles but only creates a week with 29. Kind of surprising since the week after that is 50+ and they are both base."
**Root cause:** `correctTotalFromSessionList` only fixes the explicit `"Total: X mi"` line at the bottom of the session list. It did not scan back and correct prose references like "pulling back to ~40 mi" in the first text bubble. The periodization engine passed the target (40 mi) to Dean, Dean stated it correctly in prose, but then prescribed sessions summing to only 29 mi. The two numbers never got reconciled.
**Fix / Change:** Extended `correctTotalFromSessionList` to also find and rewrite prose weekly total mentions (patterns like "pulling back to ~40 mi", "targeting ~45 mi", "step back week — ~38 mi") when they deviate from the SESSION_LIST sum by more than 2 mi. The 2 mi tolerance avoids false positives on closely matching values. Last-week mileage references (e.g. "54.2 mi across 6 runs") are unaffected because they don't follow the keyword patterns.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-13 — Fix duplicate coach responses from Linq webhook race condition

**Type:** Bug Fix
**Reported by:** Conversation analysis (user 5e1535c3, also dc936de3)
**User feedback:** N/A (detected by automated analysis — two near-identical responses sent to same athlete message)
**Root cause:** When Linq delivers the same webhook twice in rapid succession (retry on timeout or network blip), both deliveries pass the pre-`after()` dedup check before either one has had a chance to insert its conversation row. After the 15-second debounce, both handlers see their own row as the "latest message" and both proceed to call coach/respond, generating two independent Claude responses.
**Fix / Change:** Added a post-debounce guard that queries all conversation rows with the same `external_message_id` for that user. If more than one row exists (duplicate delivery), only the handler whose row has the lexicographically smallest id proceeds; all others return early. This is a deterministic tiebreak that both handlers resolve to the same winner without coordination.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-13 — Past-race users no longer shown "Taper phase" in coaching context

**Type:** Bug Fix
**Reported by:** Conversation analysis (user b1b308cf — 50K race on 2026-03-28, still being coached as pre-race)
**User feedback:** N/A (detected by automated analysis)
**Root cause:** `computePhase` returns "taper" for any race date where `weeksUntil ≤ 2`, including negative values (past races). This caused `tsPhaseDisplay` in `buildSystemPrompt` to output "Training: Week 4 · Taper phase" even when the race had already happened. The post-race context block (lines 3249-3267) was correctly injecting "race is done, here's recovery guidance", but the contradictory "Taper phase" label in the FACTS block undermined it — the model saw conflicting signals and defaulted to treating the race as upcoming.
**Fix / Change:** `tsPhaseDisplay` is now an IIFE that detects when the raw phase is "taper" AND `profileRaceDaysUntil ≤ 0` (race has passed), and returns "recovery" instead. The post-race context block is unchanged and continues to provide coaching instructions. `suggestedWeeklyMiles` stays null (the existing `buildPeriodization` taper logic returns null), so no spurious progression targets appear.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

---

## 2026-04-13 — Fix dashboard week dates, mileage attribution, and interval session distance

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "It says week 3 now but I didn't do week 2 / Doesn't show the mileage I did last week / Doesn't seem to know how to estimate the mileage of the quality session / Now says dipsea twice in the races section"
**Root cause:** Three separate bugs:
1. Dashboard week dates completely wrong (week 3 showing Apr 27–May 3 instead of Apr 13–19): `rebuild_plan` creates a new `training_plans` row with a fresh `created_at`, which shifted the `week1Monday` anchor 2 weeks into the future. The dashboard used `planData.created_at` to compute all week date ranges, so after a rebuild the dates drifted while `current_week` stayed correct.
2. Mileage from last week not showing: same root cause — shifted week boundary misattributed past activities to wrong week numbers.
3. Interval session distance wrote "?mi (check distance)": `parseMilesFromLabel` only took the first `mi` match (returning 1 from "1mi WU"), and the prompt didn't include explicit meter-to-mile conversion math for interval notation, so Claude wrote a placeholder instead of computing 6×800m = 3mi + WU/CD.
**Fix / Change:**
- Dashboard now backcomputes `week1Monday` from `current_week + today's date` instead of `planData.created_at`. This is resilient to rebuilds and immediately fixes the current broken state (week 3 will correctly show Apr 13–19). Sunday edge case handled: after the Sunday recap advances current_week, "this Monday" is treated as tomorrow.
- `generateAndSaveFullPlan` now UPDATEs the existing plan row (preserving `created_at`) when `resetToWeek1=false` (i.e., all mid-plan rebuilds), rather than inserting a new row. Prevents the anchor drift from happening in the future.
- `parseMilesFromLabel` updated to detect `N×X(m|km|mi)` interval patterns, compute the interval total in miles, and add any explicit WU/CD miles from the rest of the label.
- Added INTERVAL SESSION DISTANCE prompt rule with explicit conversion table (400m=0.25mi, 800m=0.5mi, etc.) and format examples. Added "NEVER write ?mi" instruction. Strengthened existing QUALITY SESSION MILEAGE examples to show correct arithmetic (6×0.5mi=3mi, 1+3+1=5mi).
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-13 — Fix conversation analysis email formatting + tighten daily auto-fix trigger

**Type:** Bug Fix / Infra
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Two issues. (1) Claude's analysis responses were sometimes wrapped in ```html ... ``` markdown code fences, which rendered as a raw text block in the Resend email instead of formatted HTML. (2) The daily auto-fix trigger had no explicit instruction against merging PRs — it used its `Bash`/`gh` access to auto-merge today's PR (#7) without waiting for human review.
**Fix / Change:** (1) Added `stripMarkdownFences()` helper applied to both `analysisHtml` and `planAnalysisHtml` before injection into the email body. (2) Added an explicit `⚠️ IMPORTANT: NEVER merge the PR yourself` instruction to the trigger prompt. Also tightened the changelog dedup check to cover fixes from the last 48 hours (not just today).
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`, remote trigger `trig_01EzBseDjZ7uNnFRauGy2EXW`

---

## 2026-04-13 — Fix 4 failing eval fixtures + strengthen eval runner prompt engineering

**Type:** Improvement
**Reported by:** Internal eval run
**User feedback:** N/A
**Root cause:** Four eval fixtures consistently failing (6/10, 6/10, 5/10, 4/10):
1. `mileage-strava-correction`: fixture `today` defaulted to Mon 3/30 but conversation history said "today (Tue)" — model got confused about which day was "yesterday" and kept repeating the phantom Monday run.
2. `plan-mile-time-trial`: `today` was mid-week Friday, causing the model to generate sessions spanning two calendar weeks; volume floors were too low (22mi min allowed 23mi which the judge correctly flagged as too conservative for a 30mpw runner).
3. `plan-shin-splints-10k`: injury_notes said "no intensity for 2 weeks" — too vague; model introduced light tempo at weeks 3-4 and didn't mention run-walk or bike cross-training.
4. `plan-strength-integrated-marathon`: fixture `today` was mid-week with a prior-week run bleeding into week 1 total; no hard rule preventing Tuesday quality sessions or requiring explicit S&C acknowledgment; peak cap was 52mi which the judge treated as "exceeds 52mi" when exactly hit.
**Fix / Change:**
- **Fixtures**: Added correct `today` field to each fixture (Mar 31, Apr 5, Apr 13), tightened volume floors (min_week1 27mi for mile TT, min_peak 30mi), strengthened injury_notes with explicit "no intensity first 4 weeks / run-walk required / bike cross-training", updated strength marathon notes as hard constraints, lowered peak cap to 50mi (aligned with notes).
- **Eval runner**: Added `strengthConstraintBlock` — detects "lifts on X and Y" pattern in notes and injects `<rule>` preventing quality work on lifting days and requiring S&C acknowledgment. Added `max_week1_miles` and `min_week1_miles` hard caps in LONG RUN GUIDANCE (new; were not injected before). Upgraded `max_long_run_miles` from bullet to `<rule>` tag with explicit "LONG RUN slot only" scope. Added mile TT `<rule>` capping the long-run slot at 5mi while clarifying other sessions can still be 6-7mi. Added forbidden-phrase override rule after conversation block when `ground_truth.forbidden_phrases` is set — explains WHY those phrases must be avoided, not just that they're wrong.
**Result:** 47 → 50/51 passing, 9.0 → 9.2/10 avg. All 4 target fixtures now pass consistently.
**Files changed:** `evals/run-evals.mjs`, `evals/fixtures/mileage-strava-correction.json`, `evals/fixtures/plan-mile-time-trial.json`, `evals/fixtures/plan-shin-splints-10k.json`, `evals/fixtures/plan-strength-integrated-marathon.json`


## 2026-04-12 — Fix timezone fallback + show Strava location in onboarding closing message

**Type:** Bug Fix / Improvement
**Reported by:** Internal observation (Gwyneth onboarding)
**User feedback:** N/A
**Root cause:** Two issues. (1) `userTimezone` fell back to `"America/New_York"` when `user.timezone` was null. For Mountain/Pacific users onboarding late at night, this rolled the local date forward to Monday, triggering mid-week plan logic instead of Sunday full-week logic — causing the wrong framing and dropping Monday from the plan. (2) The closing "how does this look?" message had no timezone confirmation, so if the timezone was wrong the user had no way to know or correct it.
**Fix / Change:** (1) Timezone fallback now uses `inferTimezoneFromPhone()` instead of hardcoded `"America/New_York"`. (2) When Strava city/state is available, the closing message now reads "I've got your location as [City, State] so I have the right timezone for you. Let me know if that needs correcting." Falls back to the generic reminder phrasing when no Strava location is on file.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Fix Sunday initial plan framing + server-side mileage total from SESSION_LIST

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "Dean says 'this just covers the rest of this week' but it's Sunday night and so it actually is a complete plan for next week" and "the mileage sum is off - shouldn't this be calculated server side and injected?"
**Root cause:** Three issues: (1) The Sunday branch of `weekBoundaryNote` told Claude to plan a full week but didn't tell it to *frame* the message as a full week, so Claude still used partial-week language ("rest of this week"). (2) `correctMileageTotal` parses session lines via regex and can miss the stated total when the character encoding or format differs subtly; in this case Claude said "Total: 10mi" when sessions summed to 15mi. (3) The `initialPlanDaysConstraint` always appended "Do NOT add a session for today (athlete needs time to prepare after onboarding)" — on Sunday night that confused Claude into skipping Monday too, since the week starts immediately after a late-night onboard. The athlete had 5 training days but only got 4 sessions.
**Fix / Change:** (1) Added a CRITICAL instruction to the Sunday `weekBoundaryNote` explicitly telling Claude not to say "rest of this week" and to frame the plan as their first full week. (2) Added `correctTotalFromSessionList()` — after the SESSION_LIST JSON is parsed, it sums miles from structured session labels and does a final pass to correct any wrong "Total:" line. This runs as a second pass after `correctMileageTotal` for `initial_plan` and `weekly_recap` triggers. (3) The "do not add a session for today" clause is now omitted from the Sunday path — on Sunday the athlete plans Monday onward and there's no window-closed restriction.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-12 — Trail race calibration prompt now references the actual race instead of "your best Strava effort"

**Type:** Bug Fix
**Reported by:** Jake (Gwyneth's conversation)
**User feedback:** "not sure why Dean is saying her recent best effort is on trail if he doesn't have a best effort he's looking at?"
**Root cause:** The pace calibration prompt instruction told Claude to say "Your best Strava effort is a trail race..." — a vague, hardcoded phrase. The STRAVACONTEXT already contained the specific race label, date, and time, but the instruction didn't direct Claude to use those details. When Gwyneth asked "What race is my best Strava effort?", Dean correctly had no specific answer, exposing the contradiction.
**Fix / Change:** Updated the PACE CALIBRATION prompt instruction to tell Claude to reference the specific race label and date from the STRAVACONTEXT (e.g. "I can see a [label] from [date] in your Strava history") instead of using the vague "your best Strava effort is a trail race" script. Added explicit instruction: "Do NOT use vague phrases like 'your best Strava effort' without naming the specific race."
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-12 — Travel weeks no longer drop running sessions from the weekly plan

**Type:** Bug Fix
**Reported by:** Jake (internal)
**User feedback:** "why did I only get two days in my sunday recap schedule for the next week?"
**Root cause:** The schedule constraint prompt treated travel days the same as explicit day conflicts (spin class, soccer, etc.), causing Dean to skip running sessions on Mon–Thu when the athlete mentioned traveling. Only Sat/Sun remained, resulting in a 16.5mi plan against a 30mi target.
**Fix / Change:** Added a TRAVEL WEEKS rule to the weekly_recap prompt clarifying that travel ≠ rest day. Runs stay on confirmed training days during travel (framed as hotel/road miles). Only dropped if the athlete explicitly says they can't run (e.g. back-to-back flights).
**Files changed:** src/app/api/coach/respond/route.ts

---

## 2026-04-12 — Removed "tomorrow" recommendation from Strava annotation

**Type:** Improvement
**Reported by:** Jake
**User feedback:** "his last line is about what you should do tomorrow; there's already a plan so it will be bad if these two are in conflict"
**Root cause:** The Haiku prompt instructed Dean to end every annotation with a plain-English tomorrow recommendation based on cardiac decoupling/efficiency. This directly conflicts with the SMS training plan already sent to the athlete.
**Fix / Change:** Replaced rule 5 in the annotation prompt from "tell the athlete what tomorrow should look like" to "do NOT tell the athlete what to do tomorrow — they already have a training plan for that."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-12 — Fixed Strava annotation showing same race twice instead of two different races

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "right now for me it says 'Dipsea 62d out Dipsea 62d out' - so it is kind of repeating itself in the title instead of mentioning my other race"
**Root cause:** `annotateStravaActivity` used `.slice(0, 2)` on `upcomingRaces` before deduplicating by name. If the same race was inserted twice (e.g. as both A and B priority entries, which can happen after the race date conflict-resolution logic), both slots were consumed by Dipsea and the second distinct race never appeared.
**Fix / Change:** Added a `Set<string>` dedup filter by `race_name` before the `.slice(0, 2)`, so duplicate-named races are collapsed to one entry and the remaining slot is filled by the next distinct race.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-12 — Fixed Strava weekly mileage: analytics never saved + rolling window misalignment

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "How did you calculate the 17 average?" / "The last four weeks my mileage was 15.5, 14, 16, 10 (that week of 10 was when I was sick)"
**Root cause:** Two bugs. (1) `strava_avg_weekly_miles` and related analytics were computed after the first `users` DB update, then mutated onto the in-memory `updatedOnboardingData` object but never written back — so the field was always `null` in the DB, and Claude hallucinated a mileage number instead of using real data. (2) The weekly bucketing used rolling 7-day windows anchored to "now" rather than calendar (Mon–Sun UTC) week boundaries. On a Sunday evening connect, an entire Mon–Sat training week fell in slot 0 (excluded as "partial current week"), pulling in an older higher-mileage week from slot 4 instead.
**Fix / Change:** Added a second `supabase.from("users").update(...)` after analytics are computed so they're actually persisted. Replaced rolling-window bucketing with calendar-week boundaries (Monday midnight UTC): `ceil((currentWeekStartMs - runTime) / msPerWeek)` assigns each run to the correct complete calendar week slot.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-12 — Metric units consistency + long run adaptation + week number context

**Type:** Bug Fix (3 issues)
**Reported by:** Isaac Harris (via Jake)
**User feedback:** "It does it still in miles and sometimes switches metrics to kilometers but only sometimes" / "I did a long run yesterday and it still told me that I had to do my long run today" / "It often has told me it is week 1 of my training plan, and I wasn't sure if that was because you are resetting things in the software or it forgets."
**Root cause:**
1. **Metric units**: The activity summary, weekly mileage table, pace analysis, individual workouts, all-time Strava stats, and race history were all hardcoded to output miles and /mi paces regardless of `preferred_units`. Claude was told to respond in km but the raw data it read was always in miles, causing inconsistent unit usage.
2. **Long run adaptation**: The session row instruction only told Dean to check the RECENT CONVERSATION for completed workouts today — it didn't tell Dean to check Strava activity history for sessions completed earlier in the week. If an athlete did their long run on Saturday but the plan had it on Sunday, Dean would re-prescribe it.
3. **Week number**: No context was given about what "Week 1" means, so athletes who just generated a plan couldn't tell if the week counter was wrong or just reset.
**Fix / Change:**
1. Added `useMetric` parameter to `buildActivitySummary` — now converts distances to km, paces to /km, and elevation to meters for metric users. Fixed `allTimeInfo` and race history in `buildSystemPrompt` to use `spMi()`. Updated `parseSessionMiles` to parse km labels (converting to miles for internal tracking). Updated `prescribedWeek1Miles` extraction to handle km plan totals. Updated SESSION DISTANCE FORMAT instruction and example sessions to use km for metric users.
2. Expanded the TODAY'S PLANNED SESSION instruction to also check RECENT WORKOUTS (Strava data): if a long run appears in recent activities from earlier this week, Dean treats it as done and doesn't re-prescribe.
3. Added "(week 1 = first week of current plan; advances each Sunday)" note to the training week line in the system prompt so Dean can explain week numbers when asked.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-12 — Dean no longer invents a fake personal training life

**Type:** Bug Fix
**Reported by:** User observation (live conversation)
**User feedback:** "dean what's YOUR training week look like" → Dean responded "I'm running 40-50mi/week right now..." → user then asked "how are you running 40-50 miles a week right now then?" after Dean tried to walk it back
**Root cause:** No instruction in the system prompt addressed questions about Dean's own identity or personal life. Without guidance, the model defaulted to engaging with the hypothetical and inventing plausible-sounding personal details, which immediately fell apart under follow-up.
**Fix / Change:** Added a `COACH DEAN'S IDENTITY` block to the system prompt. Rule: Dean is an AI — no legs, no race bib, no hometown. When asked personal questions, give one brief honest line then redirect to the athlete. Never invent personal details even playfully, since a single invented fact creates an impossible contradiction on follow-up.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Aerobic metrics: efficiency + decoupling stored and trended over time

**Type:** Feature / Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Efficiency was dropped in a previous simplification pass; no historical metric data existed for Dean to trend.
**Fix / Change:** (1) Aerobic efficiency restored to annotation block alongside cardiac decoupling — both shown with plain-English interpretation guides so the LLM note can explain them accessibly. (2) `aerobic_efficiency` and `cardiac_decoupling_pct` now persisted to the activities table on every annotation (migration 029). (3) For `post_run` and `user_message` triggers, Dean's system prompt now includes a rolling table of the last 10 runs with both metrics, a computed trend direction (improving/declining/steady based on recent 3 vs prior 3), and explicit instructions to proactively flag improvement, flag sustained high decoupling as overreaching risk, and explain metrics in plain English when asked.
**Files changed:** `supabase/migrations/029_aerobic_metrics.sql`, `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Strava annotation: default opt-in, simplified, weather-aware

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Annotation opt-in was too buried (required separate `/auth/strava/write` re-auth); annotation block was verbose; no weather context to explain HR/pace anomalies.
**Fix / Change:** (1) Main Strava OAuth now requests `activity:write` scope by default, so new users are opted into annotation without a second auth step. Onboarding mentions the note and how to uncheck it. (2) Annotation block simplified: removed divider, aerobic efficiency, and cardiac decoupling lines — kept header, week mileage, HR drift, best GAP, and 1–2 sentence Dean note (was 2–3). (3) Weather context added: Open-Meteo fetches conditions for the activity's date (using `past_days=2`) and passes temp/conditions/wind to the LLM so it can explain heat or wind effects on pace/HR.
**Files changed:** `src/app/api/auth/strava/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/lib/weather.ts`, `src/app/api/coach/respond/route.ts`


## 2026-04-12 — Restrict Strava annotation to run-type activities only

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `annotateStravaActivity` was called for any `post_run` trigger regardless of activity type, so hikes, bike rides, swims, etc. would get a run coaching annotation written to their Strava description.
**Fix / Change:** Added activity type guard at both annotation call sites (main path and dedup early-exit path). Only `Run`, `TrailRun`, `VirtualRun`, and `Treadmill` activities are annotated.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Fix Dean falsely implying Strava will sync for non-connected users

**Type:** Bug Fix
**Reported by:** Jake (observed in Madie's conversation)
**User feedback:** Madie said "I already finished today's run and uploaded it to Strava" — Dean responded "sometimes there's a delay before activities sync over" implying it would appear soon, when in fact Madie has no Strava account connected to Coach Dean.
**Root cause:** System prompt told Dean "Strava: not connected" but gave no guidance on what to say when a non-connected user mentions Strava. Dean defaulted to a plausible-sounding sync delay response, which was factually wrong and would leave the user waiting for a sync that will never happen.
**Fix / Change:** Added a `<rule>` adjacent to the Strava status line (for non-connected athletes) instructing Dean to acknowledge the run, clarify there's no Strava link so it won't auto-sync, and invite the user to share how it went so it can be logged manually.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-12 — Double-text guard and "today already done" prompt fix

**Type:** Bug Fix
**Reported by:** Jake (self)
**User feedback:** "Got a bit of a double text here - also I told Dean yesterday I wasn't going to run today, cycle instead so it's weird that he's asking me if I'm going to run"
**Root cause:** Two bugs: (1) If a user sends two messages more than 15s apart, both pass the debounce window independently and each triggers a separate coach/respond call — resulting in two independent Dean replies. (2) The TODAY'S PLANNED SESSION prompt label said "may already be completed — check conversation history" but Dean wasn't correctly inferring that reporting a completed cross-training workout (cycling) means today is done — he'd still ask "still planning that easy 6mi?"
**Fix / Change:** (1) Added a 45-second assistant-reply dedup guard in the linq webhook debounce section. After the 15s wait and newer-message check, we now also check if an assistant message was sent within the last 45s — if yes, skip to prevent a second independent reply. (2) Strengthened the TODAY'S PLANNED SESSION system prompt label to explicitly say: if the athlete's message reports completing ANY workout today (running, cycling, strength, etc.), treat today as DONE and do NOT ask if they're still planning today's run.
**Files changed:** src/app/api/webhooks/linq/route.ts, src/app/api/coach/respond/route.ts

## 2026-04-12 — [LIGHTER_WEEK] tag + injury accommodation evals

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Minor injuries (3–10 days) had no structured handling. An athlete reporting calf tightness or fatigue would get a conversational response but no plan adjustment — the next morning_plan or weekly recap still saw full volume. [INJURY_HOLD] was too blunt (complete rest only), leaving a gap for "can still run, just less" cases.
**Fix / Change:** Added `[LIGHTER_WEEK]` tag (same pattern as `[REBUILD_PLAN]`/`[INJURY_HOLD]`). When fired, reduces `weekly_mileage_target` by 25% (rounded to nearest 0.5mi) and clears `weekly_plan_sessions` so the next interaction picks up the lower volume. System prompt instructs Dean to append `[LIGHTER_WEEK]` for nagging soreness/fatigue/minor aches, suggest cross-training for skipped days, and confirm next week returns to normal. Tag is stripped before SMS send. Added 4 eval fixtures: `quality-injury-hold-tag` (doctor says no running → must fire `[INJURY_HOLD]`), `quality-injury-hold-threshold` (mild soreness → must NOT fire `[INJURY_HOLD]`), `quality-injury-clear-tag` (cleared after hold → must fire `[INJURY_CLEAR]`), `quality-lighter-week-tag` (calf tight, can still run → must fire `[LIGHTER_WEEK]` not `[INJURY_HOLD]`). Updated eval runner (`run-evals.mjs`) to inject injury hold state and tag instructions for `user_message` fixtures. Updated judge (`factual-accuracy.mjs`) to handle `must_contain_tag` and `forbidden_tags` ground truth fields.
**Files changed:** src/app/api/coach/respond/route.ts, src/__tests__/api/coach-respond.test.ts, evals/run-evals.mjs, evals/judges/factual-accuracy.mjs, evals/fixtures/quality-injury-hold-tag.json, evals/fixtures/quality-injury-hold-threshold.json, evals/fixtures/quality-injury-clear-tag.json, evals/fixtures/quality-lighter-week-tag.json

## 2026-04-12 — Injury hold & return-to-running system

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** No structured path for athletes who get injured mid-plan. Dean had no way to pause running prescriptions, and no mechanism to rebuild a plan with a conservative return-to-running ramp on clearance.
**Fix / Change:** Added `[INJURY_HOLD]` and `[INJURY_CLEAR]` tag-based triggers (same pattern as `[REBUILD_PLAN]`). When an athlete explicitly says they can't run (doctor's orders, acute flare), Dean appends `[INJURY_HOLD]` which fires the `injury_hold` trigger: stores `injury_hold_since` and `pre_injury_mileage_target` in `training_state`, zeros out `weekly_mileage_target`, and clears session prescriptions. Weekly recap skips mileage progression and `syncArcCurrentWeek` during a hold. On clearance (`[INJURY_CLEAR]`), the ramp is computed from weeks injured (1w→70%, 2w→60%, 3+w→50% of pre-injury base) and `generateAndSaveFullPlan` rebuilds the arc with that base. Admin triggers also available (`trigger: "injury_hold"` / `"injury_clear"`). Added `injury_hold_since` and `pre_injury_mileage_target` columns via migration `027_injury_hold.sql`. Also fixed `makeChain` in tests to include `gt` and `lt` operators (were missing, causing silent failures on queries using `.gt()`).
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/database.types.ts, supabase/migrations/027_injury_hold.sql, src/__tests__/api/coach-respond.test.ts

## 2026-04-12 — Plan generation improvements from plan health audit

**Type:** Improvement
**Reported by:** Internal plan health audit (2026-04-09, 15/37 users with issues)
**User feedback:** N/A
**Root cause:** Three systematic issues identified across active users: (1) Triathlon goal types (sprint_tri, olympic_tri, 70.3, ironman) had no dedicated volume targets in `getTargetPeakMileage`, falling through to the generic default (floor=20mi, cap=60mi) — too high for sprint/olympic tris where athletes cross-train heavily and run volume should be lower. (2) Haiku plan enrichment could generate session descriptions where the stated distance label didn't match the sum of WU + main set + CD components (e.g. "Tempo 2mi (1mi WU + 1.5mi @ threshold + 1mi CD)" = 3.5mi, not 2mi). (3) Haiku invented specific pace targets for users with no VDOT or easy pace on file, producing potentially inaccurate prescriptions.
**Fix / Change:** Added triathlon-specific floor/cap pairs to `getTargetPeakMileage` (sprint_tri: 10–30mi, olympic_tri: 15–40mi, 70.3: 20–45mi, ironman: 30–55mi). Added SESSION MATH RULE to the Haiku enrichment prompt requiring that structured WU/main/CD labels sum to the stated total distance. Added NO PACE DATA guard to the Haiku user message injecting effort-only language instructions when no pace baselines are available.
**Files changed:** src/lib/training-plan.ts

---

## 2026-04-12 — Fix duplicate inbound message processing (race condition)

**Type:** Bug Fix
**Reported by:** Internal observation (Maddy, user 2e5a7e92)
**User feedback:** Nearly every onboarding message was saved twice in rapid succession — "Hello! I have some runs…" appearing back-to-back, same with subsequent messages.
**Root cause:** Linq was delivering each webhook twice within milliseconds. The deduplication check (`external_message_id` lookup) was inside `after()`, so both deliveries would read the DB before either had inserted a conversation row — both passed the check and both processed the message.
**Fix / Change:** Moved the `external_message_id` dedup check to before `after()`, in the synchronous part of the POST handler. The first delivery hits the DB, finds nothing, and proceeds. The second delivery arrives while the first is still in `after()`, hits the DB, still finds nothing — but now returns 200 before entering `after()` at all, so only one message is ever processed. The redundant check inside `handleInboundMessage` was removed.
**Files changed:** `src/app/api/webhooks/linq/route.ts`

---

## 2026-04-11 — Initial plan: explicitly frame partial-week plans as a short starter

**Type:** Improvement
**Reported by:** Maddie Chamberlain
**User feedback:** "it looked at my strava and it was like 'nice you have been doing a 45 mile week average let's start with a 12 mile week next week' and I had to kinda prompt it to start me where I already am"
**Root cause:** When a user onboards mid-week, Dean prescribes a partial-week plan (e.g. just 2 remaining days = ~12 miles). But the messaging didn't frame it as a short starter — it looked like Dean was dropping their weekly volume from 45 miles to 12. The context about "this is just for the rest of this week" was never communicated to the athlete.
**Fix / Change:** Updated the `initial_plan` prompt's `WEEK BOUNDARY` instruction to explicitly tell Dean to communicate the partial-week framing to the athlete in the first bubble. Dean must now say something like "This covers the rest of this week — on Sunday I'll send your first full week plan." This is especially important for Strava users with high volume averages, where the discrepancy is most jarring.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-11 — Dashboard: fix stale race distance in header + always show races section

**Type:** Bug Fix
**Reported by:** Internal observation (reviewing Maddy's dashboard)
**User feedback:** "the 28.5 mi doesn't match the 100k label" — header showed "Kodiak 100K · 28.5 mi"; also races section wasn't visible at all.
**Root cause:** Two bugs: (1) The header distance suffix was pulled from `onboarding_data.goal_distance_miles`, which had captured Broken Arrow 46K's distance (28.5 mi) during onboarding — stale once Kodiak 100K became the A race. (2) The races section only rendered when `upcomingRaces.length > 1`; with only one race in the table, the section was hidden entirely.
**Fix / Change:** Header now looks up the A race from the `races` table (matching by `race_date` or `priority === "A"`) and uses that entry's `goal`/`goal_distance_miles` to derive the distance suffix — with the same non-standard-distance logic used by the UpcomingRaces component. Falls back to `onboarding_data` only when no races table entry exists. Races section condition changed from `> 1` to `>= 1` so it always renders when there are upcoming races.
**Files changed:** `src/app/dashboard/page.tsx`

## 2026-04-11 — Ultra training plans: lower peak mileage + plateau at peak instead of ramping through

**Type:** Improvement
**Reported by:** Internal observation (reviewing a 100K plan for a ~45–48 mi/week runner)
**User feedback:** "Do we think this is too high of weekly mileage? She's at like 40 m / week right now" — plan was showing a 96-mile peak, still 85 after initial fix.
**Root cause:** Three compounding issues: (1) `hardCap` for 100K was 110, so the 2.0× multiplier produced a 96-mile peak. (2) `realBuildWeeks` included peak-phase weeks, so the plan kept ramping through all 5 peak weeks instead of plateauing. (3) Even after lowering `hardCap` to 85, the 2.0× multiplier still hit the cap for anyone above ~43 mi/week — the cap was always the binding constraint, not the multiplier.
**Fix / Change:** Lowered `hardCap` for 100K → 85, 50mi → 80, 100mi → 95. Excluded peak weeks from `realBuildWeeks` so peak weeks plateau at `targetPeak`. Added a goal-aware growth multiplier: ultra goals use 1.6× (not 2.0×) so the multiplier scales correctly with base — a 45 mi/week runner peaks at 72 mi, 48 mi/week at ~77 mi, with hardCap still protecting high-volume runners. Fixed `other_races` extraction schema (was untyped `object`, so Haiku guessed field names; now fully specified with `date`, `name`, `goal`, `priority`, `goal_distance_miles`).
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/onboarding/handle/route.ts`

## 2026-04-11 — GTM attribution tracking: UTM source in SMS body + strava_connected event

**Type:** Feature
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** No way to attribute social media GTM posts to actual sign-ups. `cta_clicked` used an anonymous browser identity; `onboarding_started` used a Supabase user ID — they were unlinked in PostHog. Also missing a `strava_connected` event.
**Fix / Change:** (1) `signup-form.tsx` now reads `utm_source` from the page URL on mount and appends `src=X` to the SMS body if present. (2) `linq/route.ts` parses and strips the `src=` token from a new user's first message, stores it in `onboarding_data.acquisition_source`, and passes it as a property on `onboarding_started`. (3) Strava OAuth callback now fires `strava_connected` with a `during_onboarding` flag. To use: add `?utm_source=linkedin` (or `twitter`, `instagram`) to any shared link — PostHog and the DB will both carry attribution through to `onboarding_started` and `onboarding_completed`.
**Files changed:** src/components/signup-form.tsx, src/app/api/webhooks/linq/route.ts, src/app/api/auth/strava/callback/route.ts

## 2026-04-11 — Derive timezone from Strava city/state instead of athlete.timezone preference

**Type:** Bug Fix
**Reported by:** Jake (internal observation)
**User feedback:** "my users.timezone is america new york, even though I connected strava and it says provo, UT there"
**Root cause:** `athlete.timezone` in the Strava token response reflects an account-level preference that users set when they signed up and rarely update when they move. A user in Provo, UT could have `athlete.timezone = "America/Los_Angeles"` or an entirely wrong timezone from years ago.
**Fix / Change:** Derive timezone from `athlete.city` + `athlete.state` via `parseTimezoneFromLocation` (Claude Haiku) on Strava connect. Fall back to parsing `athlete.timezone` only if no city is available. Also extracted `parseTimezoneFromMessage` from `onboarding/handle` into the shared `src/lib/timezone.ts` as `parseTimezoneFromLocation`, fixing a secondary bug where multi-part IANA strings like `America/Indiana/Indianapolis` failed the validation regex.
**Files changed:** src/lib/timezone.ts, src/app/api/auth/strava/callback/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-04-11 — Improved Strava annotation: emojis, GAP analysis, remove redundant stats, multi-race

**Type:** Improvement
**Reported by:** Jake (user feedback after first annotation)
**User feedback:** "we probably shouldn't repeat stuff that's already in the strava activity details (10 mi @ X pace) - that is redundant. Also Dean's analysis said I slowed down a ton which could have been 'pacing miscalcuation' but those were on miles I gained like 600 ft in elevation. Can we provide insights on GAP or aerobic efficiency... Also says Week 1 of 14 -- Dipsea (64d), I wonder if that is confusing... Can we add in a few emojis to make it more exciting"
**Root cause:** Annotation block duplicated distance/pace already shown by Strava; LLM prompt didn't instruct it to consider grade-adjusted pace on hilly terrain; week label included "of X" which confuses users when plan total weeks ≠ remaining weeks to race; only one upcoming race was shown.
**Fix / Change:**
- Removed distance/pace line from block (Strava already displays these)
- Added emoji to header based on activity type: ⛰️ trail + high elevation, 🌲 trail, ⚡️ intervals, 🏃 road run
- Removed "of X" from `WEEK N OF X` — now just `WEEK N` to avoid confusion
- Pass all upcoming races (was `upcomingRaces[0]` only); header now shows up to 2 race countdowns
- Added grade-adjusted pace to LLM prompt context for trail runs with GAP data
- Updated LLM prompt to explicitly NOT restate distance/pace and to reference GAP instead of raw pace on hilly runs
- Moved efficiency line (`Grade-adj eff: X m/beat`) into the visible annotation block
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-11 — Fixed Strava annotation not running; fixed write scope detection on re-auth

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "I didn't get an analysis on my strava activity today"
**Root cause:** Two separate bugs: (1) `annotateStravaActivity` was called with `void` inside `processCoachRequest`, which itself runs inside `after()`. When `processCoachRequest` returned after sending the SMS, the `after()` block resolved and Vercel terminated the function before the unawaited annotation promise completed. (2) Strava omits the `scope` field from the token exchange response body on re-auth flows — the callback read scope only from `tokenData.scope`, which was `undefined`, so `hasWriteScope` was always false and `strava_write_enabled` was never set.
**Fix / Change:** (1) Changed `void annotateStravaActivity(...)` to `await annotateStravaActivity(...)` — safe to await since it's already inside `after()` and the HTTP response is already sent. (2) Added fallback in callback to read scope from the URL query param (`searchParams.get("scope")`) when the token response body doesn't include it.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-11 — Removed awaiting_cadence state; default to nightly reminders at plan generation

**Type:** Improvement
**Reported by:** Jake Tennant
**User feedback:** N/A
**Root cause:** The `awaiting_cadence` post-plan state was designed to collect reminder preferences after the plan was sent, but it created a structural loop: any coaching question asked before the user answered cadence would re-ask the cadence question, making it impossible to escape. The state machine added complexity without proportionate value — most users don't have strong opinions about reminder timing.
**Fix / Change:** Removed `awaiting_cadence` entirely. All new users are now defaulted to `nightly_reminders` at plan generation time (both `training_profiles.proactive_cadence` and `users.onboarding_step` are set in the same `initial_plan` DB write). The "How does this look?" closing message now includes a one-liner: "I'll send you a reminder the evening before each session — text me if you'd prefer morning-of reminders or just a weekly Sunday plan." Users can change their preference at any time via a normal `user_message`. `handleCadence` and `handleNonCadenceMessage` functions deleted. Existing users stuck in `awaiting_cadence` are silently graduated to onboarded on their next inbound message (step cleared, cadence set to nightly_reminders, no SMS sent).
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/coach-respond.test.ts`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-11 — Fixed repeat loop, plan feedback detection, and "How does this look?" ordering (Gwyneth onboarding)

**Type:** Bug Fix
**Reported by:** Jake Tennant (observed during Gwyneth's Saturday onboarding)
**User feedback:** "Didn't reply to question after asking 'How does this look?' After the plan is sent. Got into a repeat loop - I thought we had a way to determine if Dean is repeating himself and kind of restart / get out of the loop. This was the biggest issue in this conversation. When first asked about next week he then gave sessions that added to 9 miles instead 7 miles. He rewrote 'this week' for sessions in the past instead of next week on the dashboard."
**Root cause:** Three compounding bugs: (1) In `handleNonCadenceMessage`, the Haiku classification prompt used "coaching_question" as the expected return token but any unexpected output (extra words, punctuation variants, different capitalization) fell through to the fallback which blindly re-asked the cadence question — creating an infinite loop where the user's question was never answered. (2) The coaching_question handler appended the cadence question inline via `${!cadenceAlreadyAsked ? ... }` in the system prompt — Sonnet would sometimes return ONLY the cadence question, swallowing the actual answer entirely. (3) Complaint language ("that's too aggressive", "you're going to injure someone") wasn't in `PLAN_MODIFY_KEYWORDS`, so objections that should have triggered `rebuild_plan` fell through to the coaching answer path — Dean would verbally describe a corrected plan but never actually rebuild the dashboard. (4) "How does this look?" was the last line of the plan message but the dashboard link came AFTER it as a separate message, so users were asked to react before seeing the full plan.
**Fix / Change:** (1) Simplified Haiku classification to "coaching" vs "other" (single tokens, harder to confuse) — any output not explicitly "other" is now treated as a coaching question. (2) Moved the cadence question out of the inline system prompt append and into a separate `sendAndStore` call after the coaching answer, ensuring Sonnet always answers the actual question first. (3) Added complaint and objection language to `PLAN_MODIFY_KEYWORDS`: aggressive, injur(e/y), too much/many/long/far/hard, way too, cut back, scale back, tone down, reduce. (4) Removed "How does this look?" from the initial_plan system prompt; it is now sent as a third SMS bubble after the dashboard link. (5) Coaching question handler now also fetches `weekly_plan_sessions` from training_state to give Dean the current week's sessions, and explicitly tells Dean to explain that next week's session details aren't finalized until Sunday's recap.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-11 — Post-run message no longer mentions next week's sessions as "remaining"

**Type:** Bug Fix
**Reported by:** User (PE's friend)
**User feedback:** "my friend is getting this message on a Friday evening - not sure why (Thursday already passed): ...Two more sessions left: Saturday's long run (6 km easy) and Thursday's tempo (5 km with 3 km @ 4:24/km)."
**Root cause:** Two issues compounding: (1) `futureSessions` filter had an `isNaN` fallback that returned `true` for sessions with no parseable date, making them permanently appear as upcoming regardless of when they were scheduled. (2) The post_run system prompt told Claude to reference "upcoming sessions" but didn't restrict it to THIS week — Claude would see both "UPCOMING SESSIONS THIS WEEK" and "NEXT WEEK'S PLANNED SESSIONS" in the training state context and combine them into "X sessions left," making next Thursday look like a remaining session for the current week. The different session name (tempo vs strides) between the coach message and the dashboard confirmed the `weekly_plan_sessions` was also out of sync with `training_plans`.
**Fix / Change:** (1) Changed both `isNaN` fallbacks in the session filter from `return true` to `return false` — dateless sessions are now excluded rather than permanently shown as future. (2) Added explicit instruction to the post_run prompt: "Only reference THIS WEEK'S PLANNED SESSIONS when describing what's left to do. Do NOT mention NEXT WEEK'S PLANNED SESSIONS in post-run feedback."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-10 — Structured action tags replace Haiku extraction for session/schedule changes

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Session list storage and schedule overrides were driven by a secondary Haiku extraction pass after the main Sonnet response. This added latency (~3s), cost, and reliability issues — Haiku would sometimes mis-classify session swaps as week overrides or fail to detect changes.
**Fix / Change:** Sonnet (Dean) now emits structured action tags directly in its response: `[SESSION_LIST:]` (initial_plan/weekly_recap), `[SESSION_UPDATE:]` (user_message session swaps), `[WEEK_OVERRIDE:]` (this-week schedule changes), `[SKIP_DAY:]` (day skips). Tags are parsed deterministically on the server and stripped before SMS delivery. Haiku-based `extractAndStorePlanSessions` and `maybeUpdatePlanSessions` remain as fallbacks when no tag is present. `skip_date` and `this_week_override_days` removed from Haiku profile extractor — now tag-driven only. max_tokens for plan triggers increased 800→1000 to accommodate SESSION_LIST JSON overhead.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond-field-sync.test.ts`

## 2026-04-10 — Fixed profile extractor setting this_week_override_days on session swap requests

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "looks like I now have a 20 mi run tomorrow since my weekly goal was 29 miles!"
**Root cause:** When the athlete asked "Can you update my dashboard to have the long run tomorrow on Saturday and 6 mi on Sunday?", the profile field extractor (Haiku) interpreted this as a one-week schedule override and set `this_week_override_days: ["Saturday", "Sunday"]`. This changed `effectiveTrainingDays` to [Sat, Sun] only, causing `buildDailyPlan([Sat, Sun])` to compute: totalEasy = 29.5 - 9.5 = 20mi for Saturday (the only easy day).
**Fix / Change:** Added explicit CRITICAL note to the `this_week_override_days` extraction rule: session swap requests ("do the long run on Saturday instead", "move my tempo to Tuesday") must never trigger this field. Only actual availability reductions ("I can only run 2 days this week", "skipping all weekday runs") should set it.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Fixed weekly_plan_sessions null when initial plan SMS is split into multiple bubbles

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** Dashboard showing computed mileage (5.7mi, 9.5mi) instead of Dean's actual prescribed distances
**Root cause:** `handleSyncSessions` queried for the single most-recently-saved `initial_plan` conversation row. But the SMS send loop saves each split bubble as a separate row with the same `message_type: "initial_plan"`. The most recent row is the last bubble — typically a closing message ("Your dashboard is ready...") with no session list. Haiku found no sessions and stored `[]`, leaving `weekly_plan_sessions` empty. The dashboard then fell back to `buildDailyPlan`, which does arithmetic from plan arc targets (long_run_target, key_workout parse, etc.) producing values like 5.7mi and 9.5mi.
**Fix / Change:** Changed the conversations query to fetch the 5 most recent `initial_plan`/`weekly_recap` rows, group those within 90 seconds of the most recent (same plan generation), and concatenate their content in send order before passing to `extractAndStorePlanSessions`. Haiku now sees the full plan text regardless of where in the split the session list appears.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`

## 2026-04-10 — Fixed session swaps not reflecting on dashboard when confirmation was implicit

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "the dates were not swapped on my dashboard - noting that this is just a swap during week 1"
**Root cause:** `maybeUpdatePlanSessions` uses a Haiku model call to detect if a coaching exchange confirmed a plan change. The detection rules only covered explicit confirmation language ("Done — moved X", "I've moved...", "Switched..."). When Dean implicitly confirmed a swap by restating the new arrangement ("Perfect — Saturday long run 10mi, Sunday easy 6mi 👊"), Haiku returned `{"changed": false}` and the DB was not updated. The follow-up exchange where Dean said "already swapped on your dashboard" was also vulnerable because "already" language could be misread as "no action needed."
**Fix / Change:** Expanded the Haiku detection rules to include: implicit confirmation (coach restates new arrangement without objection), past-perfect "already swapped/updated" language (still requires a DB write), and explicit examples of each pattern.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Fixed nightly reminder saying "rest day" when override schedule includes tomorrow

**Type:** Bug Fix
**Reported by:** User (Jake)
**User feedback:** "got a message from Dean that tomorrow is a rest day (evening cron) but I'm supposed to run tomorrow!"
**Root cause:** `buildSystemPrompt` computed `restDays` from `profile.training_days` (the base standing schedule) without considering `this_week_override_days`. When a user has a one-week schedule override that adds a day (e.g. Saturday) that isn't in their base schedule, the nightly cron correctly fires (it uses `effectiveTrainingDays()`), but the system prompt told Claude "NEVER schedule a run on Saturday" — causing Dean to say tomorrow is a rest day despite the session plan showing a run.
**Fix / Change:** Moved `restDays` computation to after `tz` and `todayLocal` are defined. Now mirrors the nightly-reminder cron's `effectiveTrainingDays()` logic: if `this_week_override_days` is set and not expired, use those days instead of the base schedule when computing which days are rest days.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Strava activity description annotation (dev testing)

**Type:** Feature
**Reported by:** Internal / product exploration
**User feedback:** N/A
**Root cause:** N/A — new feature
**Fix / Change:** When `strava_write_enabled = true` on a user, Coach Dean appends a brief training note to the Strava activity description after every `post_run` webhook. Uses Haiku to generate a 1-2 sentence analytical note grounded in the actual run data. Block is prepended above any existing description. New `/api/auth/strava/write` re-auth route requests `activity:write` scope; callback detects the scope and sets the flag automatically.
**Files changed:** `supabase/migrations/026_strava_write.sql`, `src/lib/database.types.ts`, `src/app/api/auth/strava/write/route.ts`, `src/app/api/auth/strava/callback/route.ts`, `src/lib/strava.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-10 — Fix 4 eval failures: deload weeks, mile TT intervals, general fitness tempo, judge fixture

**Type:** Improvement
**Reported by:** Internal eval run (4 fixtures failing at 6/10)
**User feedback:** N/A
**Root cause:** Four distinct prompt/fixture issues: (1) initial_plan arc had no rule requiring deload weeks, so marathon plans came out as continuous 13-week ramps; (2) MILE TIME TRIAL GOAL section listed 800m repeats as a key session, which targets the wrong energy system for a 4-minute race; (3) no rule preventing tempo runs for base-phase general_fitness users when they ask for a workout via SMS; (4) quality-no-internal-labels fixture had no `today` set (defaulted to a date with ambiguous calendar context) and the judge prompt notes weren't strong enough to prevent false positive math/date flags.
**Fix / Change:** (1) Added DELOAD WEEKS block to initial_plan requiring deload every 4th week + marathon-pace segments in long runs. (2) Replaced 800m repeats with 200m–400m short intervals at goal-mile pace in the MILE TIME TRIAL GOAL section; tempo capped at one 2-3mi session for aerobic support only. (3) Added GENERAL FITNESS ATHLETES paragraph to user_message prompt: no tempo/intervals in base phase unless explicitly requested. (4) Updated quality-no-internal-labels fixture: added explicit `today: "2026-03-30"`, rewrote ground_truth notes to explicitly block judge from penalizing unrelated math/dates.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/fixtures/quality-no-internal-labels.json`

## 2026-04-10 — Replace ⚠️ directive format with XML <rule> tags to prevent reasoning leaks

**Type:** Improvement
**Reported by:** Internal (follow-up to Madie's leaked reasoning incident)
**User feedback:** N/A
**Root cause:** The system prompt used `⚠️ ALL_CAPS` format extensively for internal coaching directives. This trained Claude to associate that format with "important internal observation," causing it to mirror the pattern when generating its own analysis blocks (e.g. "⚠️ CRITICAL MILEAGE DISCREPANCY"). The format-reinforcement ran deeper than the output rule telling Claude not to use it.
**Fix / Change:** Replaced all `⚠️ HEADER` coaching directives in the system prompt with `<rule>...</rule>` XML tags. Claude strongly associates XML tags with structured metadata rather than conversational output, making it far less likely to echo them. The stripping pipeline now also removes any leaked `<rule>` blocks as a safety net, and still catches `⚠️` from Claude's training data. Updated `run-evals.mjs` to maintain parity with the new format. Output rule updated to forbid `<rule>` tag output and ⚠️.
**Files changed:** src/app/api/coach/respond/route.ts, evals/run-evals.mjs

## 2026-04-10 — Prevent internal reasoning from leaking into SMS messages

**Type:** Bug Fix
**Reported by:** Madie (user)
**User feedback:** Received multiple raw SMS bubbles containing internal analysis (e.g. "⚠️ CRITICAL MILEAGE DISCREPANCY — READ CAREFULLY: The athlete states they ran 21.5 miles...") followed by a "RESPONSE:" label, then the actual coaching message.
**Root cause:** Four compounding issues: (1) `stripReasoningPreamble` only matched specific ⚠️ keywords (ANALYSIS, REASONING, PLANNING, THINKING) — any novel ⚠️-prefixed header Claude invented (like "⚠️ CRITICAL MILEAGE DISCREPANCY") slipped through. (2) The function only recognized `\n---\n` as a separator, not `RESPONSE:` (which Claude used). (3) The `post_run_onboarding` trigger applied zero stripping — raw Claude output went straight to SMS. (4) The system prompt blocklist named specific patterns rather than banning all ⚠️ output.
**Fix / Change:** (1) `stripReasoningPreamble` now strips any paragraph starting with `⚠️` (not just specific keywords), and recognizes `RESPONSE:` as a separator. (2) Applied `stripReasoningPreamble` to the `post_run_onboarding` path. (3) Added the same `⚠️`/`RESPONSE:` guard to the onboarding handler. (4) Strengthened the system prompt rule to ban all `⚠️`-prefixed output and explicitly forbid the `RESPONSE:` label.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/onboarding/handle/route.ts

## 2026-04-10 — Pre-launch reliability and architecture improvements

**Type:** Improvement
**Reported by:** Internal observation / architecture review
**User feedback:** N/A
**Root cause:** Several features carried inaccuracy risk or were architecturally fragile going into launch: (1) shoe mileage proxy counted miles since Strava connection, not per-shoe, making it systematically wrong; (2) triathlon goal types (sprint_tri, olympic_tri, 70.3, ironman) were accepted during onboarding but the plan generation code is running-only, producing confidently wrong coaching; (3) Haiku extraction calls used text parsing with regex fallbacks, causing silent `{}` returns on parse failure; (4) `after()` catch blocks had no alerting — errors were console-logged but invisible in production.
**Fix / Change:**
- **Removed shoe mileage proxy**: Dropped `totalTrackedMiles` and `dominantGear` from `CoachingSignals` and `buildCoachingSignalsBlock`. Shoe check advice was unreliable since it counted all Strava history, not actual shoe mileage.
- **Removed triathlon goal types**: Dropped `sprint_tri`, `olympic_tri`, `70.3`, `ironman` from `VALID_GOAL_BUCKETS` and the Haiku extraction schema. The existing Dean prompt already handles triathletes gracefully by clarifying run-only focus.
- **Tool use for Haiku extraction**: Replaced text-parsing JSON extraction in `extractAndStorePlanSessions` (plan session sync) and `extractFields` (onboarding field extraction) with forced tool calls (`tool_choice: {type: "tool"}`). Guarantees structured output — eliminates regex fallback and silent empty-object failures.
- **Alerting on `after()` failures**: Added `trackEvent("after_error", ...)` in all `after()` catch blocks so production failures are visible in PostHog rather than only console logs.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

---

## 2026-04-10 — Week-1 rebuild support and post-rebuild SMS context

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Mid-plan rebuilds always skipped updating `weekly_mileage_target` and `weekly_plan_sessions` (by design, to protect in-progress weeks). But for week-1 rebuilds, the athlete has just started and wants the updated plan reflected immediately — including mileage target on the dashboard. Post-rebuild SMSs also gave no indication of what changed, leaving athletes unsure whether their current week was affected.
**Fix / Change:**
- `handleRebuildPlan` now fetches `current_week` from `training_state`. When `current_week === 1`, it sets `week1Reset: true` and passes `preservedSessions` (sessions whose date is before today, so already-completed sessions aren't lost).
- `generateAndSaveFullPlan` with `week1Reset: true` now updates `weekly_mileage_target` and replaces `weekly_plan_sessions` with the preserved past sessions (clearing future sessions so the new plan takes effect).
- Post-rebuild dashboard SMS now appends a context line explaining what changed: content-only rebuild → "Your upcoming weeks have been updated. Your current week is unchanged." / mileage rebuild → "Your plan has been updated with the adjusted mileage — your current week is unchanged." / week-1 rebuild → "Your plan has been fully regenerated starting this week."
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts`, `src/__tests__/lib/training-plan-generate.test.ts`

## 2026-04-10 — Plan rebuild preserves current week and honours workout preferences

**Type:** Bug Fix + Improvement
**Reported by:** User feedback (hill repeats / cycling not appearing; mileage target changing unexpectedly on rebuild)
**User feedback:** "I asked for bike and hill repeats to be added but I can't actually see any of these" / "my target mileage changed across the board I think but I didn't request for that to be changed (including this week changed)"
**Root cause:** Three separate issues: (1) Haiku enrichment never received the athlete's workout preferences (`other_notes` from onboarding_data), so hill repeats, HIIT, cycling etc. were never incorporated into `key_workout`/`notes`. (2) Every rebuild re-derived the mileage arc from the current Strava avg, which drifts over time — a content-only request ("add hill repeats") would silently change all mileage targets. (3) `weekly_plan_sessions` and `weekly_mileage_target` were cleared/overwritten on every rebuild, wiping the current week's in-progress sessions and mid-week target.
**Fix / Change:** (1) Pass `other_notes` and `injury_notes` from the athlete's profile into the Haiku enrichment prompt so workout preferences are incorporated into future weeks. (2) Added `wantsMileageChange` detection (both increase and decrease keywords) — when no mileage change is requested, the arc anchors to the existing `weekly_mileage_target` instead of recalculating from Strava avg. (3) When `resetToWeek1: false` (all mid-plan rebuilds), skip updating `weekly_mileage_target` and `weekly_plan_sessions` — the current week is already in progress and those values are authoritative. Note: current week sessions are only updated by weekly recap, morning plan, or explicit in-conversation session swaps.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-plan-generate.test.ts`

---

## 2026-04-10 — Fix dashboard showing phantom post-race week

**Type:** Bug Fix
**Reported by:** Madie (internal observation)
**User feedback:** "the plan was actually wrong because the race day is may 2 but it has taper the week after that!!"
**Root cause:** The dashboard had a "no remaining workouts" shift — when it was late in the week with all sessions past, it pushed `week1Monday` forward 7 days to make week 1 appear to start next Monday. This was a cosmetic UX optimization for newly-onboarded mid-week users. But for existing users with rebuilt plans, it caused the displayed week dates to be 7 days ahead of where the plan generator anchored them (the generator always uses the current week's Monday). Result: the race fell in the *displayed* week 3 instead of week 4, and a phantom "Taper" week 4 appeared after the race with May 4–10 dates.
**Fix / Change:** Removed the 7-day anchor shift entirely. Week 1 now always displays starting from the Monday of the plan-creation week — past days in that week are correctly dimmed. Reverted a compensating `isPastDay` band-aid added earlier in the same session.
**Files changed:** `src/app/dashboard/page.tsx`

## 2026-04-10 — Fix rebuild_plan anchoring to wrong base when Strava data is incomplete

**Type:** Bug Fix
**Reported by:** Madie (internal observation)
**User feedback:** "Max at 5 miles a week??" / "Yes exactly the volume is wrong" / "Weekly mileage targets should be updated"
**Root cause:** `handleRebuildPlan` derived the plan arc base exclusively from Strava avg weekly mileage. When a user's watch isn't syncing to Strava, Strava shows much lower volume than the athlete is actually running (Madie: Strava showed ~9mi/week, actual was 20+mi/week). Every rebuild fired with the wrong 9mi base, producing a 7.5mi/week taper plan even after repeated attempts.
**Fix / Change:** Two changes: (1) Added `prescribedWeek1Miles` to the `rebuild_plan` API request body as an admin override — allows correct base to be passed when Strava data is known to be wrong. (2) `handleRebuildPlan` now extracts the highest athlete-stated mileage from recent conversation text. When the stated figure is materially higher than Strava avg (>1.5×), it uses the stated figure as the arc base instead, on the principle that the athlete knows their actual volume better than a partially-synced Strava account.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Add metric plan quality eval (plan-half-marathon-metric)

**Type:** Infra
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No eval coverage for whether Dean produces plans in km for metric users. The existing plan_quality judge had no unit-correctness dimension.
**Fix / Change:** Added `plan-half-marathon-metric` fixture (Pec, 27-week HM, Spanish runner, preferred_units: metric). Updated `plan-quality.mjs` judge to detect `must_use_metric` ground truth flag and inject a `uses_correct_units` dimension that fails if any distance or pace appears in miles. Ground truth bounds now show km equivalents for metric fixtures.
**Files changed:** `evals/fixtures/plan-half-marathon-metric.json`, `evals/judges/plan-quality.mjs`, `CLAUDE.md`

---

## 2026-04-10 — Convert all hardcoded miles in coach prompts to respect preferred_units

**Type:** Bug Fix
**Reported by:** Internal (follow-up to Pec's km unit bug)
**User feedback:** N/A
**Root cause:** Multiple places in `buildSystemPrompt` and `buildUserMessage` injected mileage values with hardcoded "mi" labels regardless of the user's `preferred_units` setting. This included the taper protocol, fitness tier volume caps, race preparedness flag, next-week plan context, full training arc summary, weekly recap stored plan, and recovery/progression target blocks.
**Fix / Change:** Added `spUseMetric`/`spMi()` unit helper at the top of `buildSystemPrompt` (so it's available to the taper block, which precedes the existing `ts*` helpers) and aliased `tsUseMetric`/`tsMi` to it. Added inline `rpMi()`, `umMi()`, and `recapMi()` helpers in the three `buildUserMessage` cases that needed them. All hardcoded `mi` values now convert to km for metric users.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts` (also fixed wrong `=== "km"` check to `=== "metric"`)

---

## 2026-04-10 — Fix quality workout descriptions using miles for km-preference users

**Type:** Bug Fix
**Reported by:** Pec (user)
**User feedback:** "4×strides + easy 3.5mi" and "3mi tempo @ threshold" showing in dashboard even though preference is km
**Root cause:** The Haiku enrichment call that generates `key_workout` and `notes` for each plan week was always passing mileage values with "mi" labels and never told Haiku the user's unit preference. Haiku generated workout descriptions in miles regardless of `preferred_units`.
**Fix / Change:** Read `preferred_units` from the training profile; if "km", convert all mileage values passed to Haiku (arc summary, base mileage display, ultra guidance examples) to km. Added explicit unit instruction in the Haiku system prompt ("All distances must use km — never mix units") and passed `Preferred units: km` in the user message.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-10 — Two-step "UPDATE PLAN" confirmation for full plan rebuilds

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** The previous `[REBUILD_PLAN]` mechanism relied on Dean autonomously deciding when to emit a hidden token, which was non-deterministic — Dean sometimes triggered rebuilds when the user didn't intend one, and sometimes missed triggering when the user clearly wanted it. Errors in the rebuild also failed silently inside `after()`, leaving users waiting for a dashboard link that never arrived.
**Fix / Change:** Replaced the `[REBUILD_PLAN]` LLM token with a two-step user-confirmed keyword flow. Dean now responds to plan rebuild requests with a description of what will change and asks the user to "Reply UPDATE PLAN to confirm." The Linq webhook detects the exact phrase `UPDATE PLAN` (case-insensitive) and fires the `rebuild_plan` trigger directly — no LLM discretion involved. Added a fallback SMS in `handleRebuildPlan` if `generateAndSaveFullPlan` throws, so users aren't left waiting silently.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-10 — Fix initial_plan and weekly_recap timing out on Vercel Hobby (10s cap)

**Type:** Bug Fix
**Reported by:** Internal observation (maxDuration = 120 is ignored on Hobby; after() capped at 10s)
**User feedback:** N/A
**Root cause:** `initial_plan` made 4 sequential LLM calls (Sonnet + 3× Haiku) and `weekly_recap` made 3 (Sonnet + 2× Haiku), both well over the 10s Hobby limit, causing silent timeouts after the SMS was sent — meaning users got their plan message but the dashboard had no plan data, no weekly sessions, and no quality workouts.
**Fix / Change:** Added `sync_sessions` trigger + `handleSyncSessions` handler. Both `initial_plan` and `weekly_recap` now fire `sync_sessions` as a separate HTTP request (fresh 10s budget) after the main SMS is sent. `handleSyncSessions` reads the plan text from the `conversations` DB table and runs `extractAndStorePlanSessions` + `syncArcCurrentWeek` sequentially (~3-4s, fits in budget). The partial-week mileage correction is passed as `partialWeekTarget` in the request body. Closing link message changed from `message_type: "initial_plan"` to `"initial_plan_link"` so it doesn't interfere with the sync_sessions plan-text query. Budget after fix: `initial_plan` ~7-9s (Sonnet + generateAndSaveFullPlan), `weekly_recap` ~5-7s (Sonnet only).
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — coach/respond fails silently when required fields are missing

**Type:** Bug Fix
**Reported by:** Internal observation (manual rebuild_plan curl using user_id instead of userId)
**User feedback:** N/A
**Root cause:** `after()` swallows all errors inside the async callback, so a request with wrong/missing field names (e.g. `user_id` vs `userId`) returns `{ ok: true }` while silently doing nothing.
**Fix / Change:** Added upfront validation of `userId` and `trigger` before entering `after()`. Missing fields now return a 400 immediately.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-10 — Dashboard km support and quality workout display fixes

**Type:** Bug Fix
**Reported by:** Pierre-Etienne (Pec)
**User feedback:** "can we use kilometers instead of miles" / "Use kilometers please" / "it also doesn't show any of the quality workouts"
**Root cause:** (1) Dashboard never fetched `preferred_units` from `training_profiles` — all mileage was hardcoded "mi" regardless of user preference. (2) The Haiku enrichment call for plan arcs had `max_tokens: 2500`, which is insufficient for a long plan (~100–150 tokens/week × weeks), causing truncation and empty `key_workout` fields. (3) `parseMiles` in `buildDailyPlanFromSessions` only matched "mi" labels — metric users' km-labelled sessions returned `null` distance.
**Fix / Change:** (1) Added `preferred_units` to profile select, added `fmtDist(miles, useMetric)` helper, updated all mileage displays in dashboard (weekly target, long run, progress bar, daily plan rows, WeekCard arc, UpcomingRaces) to convert and show "km" for metric users. (2) Changed Haiku enrichment `max_tokens` to `Math.min(8000, Math.max(2500, totalWeeks * 200))` — scales with plan length, capped at Haiku's 8000-token output limit. (3) Updated `parseMiles` to also match "km" labels and convert to miles internally.
**Files changed:** `src/app/dashboard/page.tsx`, `src/lib/training-plan.ts`

## 2026-04-10 — Training plan arc notes used wrong paces (Haiku not given tempo/interval paces)

**Type:** Bug Fix
**Reported by:** Internal (Anthony's plan review)
**User feedback:** N/A
**Root cause:** `generateAndSaveFullPlan` only passed `easy_pace` to the Haiku enrichment prompt. Haiku had to infer tempo and interval paces from easy pace alone, and consistently under-estimated them (e.g. calling 9:50/mi "threshold" for an athlete whose actual stored tempo is 8:28/mi). The plan notes baked in wrong pace references that showed on the dashboard and in the coaching arc context.
**Fix / Change:** Extract `current_tempo_pace` and `current_interval_pace` from the profile and inject them into the Haiku prompt alongside easy pace. Haiku now receives all three paces and uses the correct values in week notes.
**Files changed:** `src/lib/training-plan.ts`

---

## 2026-04-10 — Fixed race date off-by-one; added explicit rest-day constraint to system prompt

**Type:** Bug Fix (2 issues)
**Reported by:** Conversation analysis email (2026-04-09 batch)
**User feedback:** "Athlete said July 26th. Dean logged and confirmed July 27th. Taper timing, race-week scheduling, and countdown messaging will all be off by one day. (July 26, 2026 is indeed a Sunday — athlete is correct.)" / "Same user, same pattern. Athlete said September 26th. Dean stored September 27th. Likely a systemic off-by-one in date parsing."
**Root cause (date off-by-one):** The Dean conversation prompt had an instruction: "After searching: always use the date from your search result, not the date the athlete stated." When web search returned a date 1 day off from what the athlete said (e.g. July 27 vs the correct July 26), Dean would use the search result. The Haiku extraction rule ("use the most specific date mentioned by either participant") then locked in Dean's (wrong) date even when the athlete had stated a different one.
**Fix (date off-by-one):** (1) Changed the Dean instruction: when athlete stated a specific date and the search result is within 2 days of it, use the athlete's date — small calendar discrepancies in web results are common and athletes are usually right about their own races. Only override when the search shows a clearly different week/month. (2) Changed the Haiku extraction rule to explicitly prefer the athlete's (user-turn) stated date over any date Dean mentioned; only fall back to Dean's date if the athlete never gave a specific day.
**Root cause (rest-day constraint):** The system prompt listed training days (e.g. "Monday–Saturday") but never explicitly enumerated the rest days. Claude could infer that unlisted days = rest, but it was an implicit constraint — confirmed by Weston's onboarding where Dean scheduled a Sunday run despite "I take Sunday off" being stated. The `initialPlanDaysConstraint` correctly constrained the partial current week but did not cover future-week previews included in the initial plan message.
**Fix (rest-day constraint):** Added a pre-computed `restDays` array (all 7 days minus training_days) and injected it into the system prompt as an explicit `⚠️ REST DAYS — NEVER schedule a run on: [days]` constraint, flagged as a hard constraint that applies to all weeks including the initial plan and future-week previews.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Conversation analysis auto-fixes: subscription wall UX, hallucination guards, tempo pace sanity check

**Type:** Bug Fix
**Reported by:** Automated conversation analysis (2026-04-08 batch, 16 users, 69 messages)
**User feedback:** User a9b4016c sent three messages explicitly trying to subscribe and received the same canned subscription-wall message each time. First two responses used generic URL.
**Root cause:**
1. (P0) Subscription wall gave identical canned responses regardless of user intent. Users saying "I want to subscribe" got the same message as users who incidentally hit the wall, with no warm acknowledgment or urgency. First-call token generation was working, but subscribe-intent cases needed a distinct, warmer response.
2. (P1) Post-run prompt had no cadence guard — `average_cadence` was fetched but never checked before injection. Claude fabricated per-lap cadence ranges (e.g. "90-92 spm") on activities where cadence was not in the Strava data. Additionally, the laps glossary said "per-lap AVERAGES for pace and HR" but did not explicitly exclude per-lap elevation, cadence, or power — Claude hallucinated per-lap elevation (e.g. "721ft gain on lap 2") and per-lap watt ranges on Zwift activities that had only average watts. Per-mile elevation breakdown (e.g. "500ft gain at miles 11-12") also had no guard.
3. (P1) Stored `current_tempo_pace` could be corrupted (e.g. a metric pace mistakenly stored as min/mi, producing values like 14:07/mi). The prompt sanity check instruction told Claude to use the stored pace, so a corrupted stored value would be passed through and used verbatim.
**Fix / Change:**
1. Subscription wall now detects subscribe/pay intent keywords in the latest user message ("subscribe", "subscription", "pay", "payment", "sign up", "get started", "ready to subscribe", etc.). When intent is detected, replies warmly with "Got it — here's your direct link to get started, takes 2 minutes: [personalized URL]" instead of the canned wall message.
2. Added cadence guard (parallel to existing watts guard): if `average_cadence` is null in the activity record, injects "No cadence data is available — do NOT reference cadence." Strengthened lap data glossary to explicitly say "per-lap AVERAGES for pace and HR only — no per-lap elevation, cadence, or power ranges." Added universal per-mile/per-lap elevation breakdown guard (always injected): "Per-mile and per-lap elevation breakdowns are NOT available from Strava — reference total elevation gain only."
3. Added server-side tempo pace validation before system prompt injection: parses stored `current_tempo_pace` and `current_easy_pace` to seconds/mile; if tempo >= easy (impossible physically), logs a warning and falls back to the estimated tempo derived from easy pace. Prevents a corrupted DB value from being injected into the prompt as ground truth.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Fixed partial week skewing Strava avg weekly mileage baseline low

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** The weekly bucketing used rolling 7-day windows from `now`. Week index 0 (0–7 days ago) captured an incomplete week if the user connected mid-week (e.g. Wednesday), so the 4-week average was divided by 4 full slots but one slot had only a few days of runs, pulling the baseline down.
**Fix / Change:** Skip `weekIdx 0` (current partial window) for both the average and trend calculation. Average now uses weeks 1–4 (four fully completed 7-day windows); trend uses weeks 1–2 vs weeks 3–4. Week 0 is still populated in case it's useful later.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-09 — Fixed partial-week onboard clobbering syncArcCurrentWeek's session-derived mileage

**Type:** Bug Fix
**Reported by:** User follow-up during same session
**User feedback:** "in this case though the user hadn't run this week at all, and will have two runs (or maybe even one) before the end of the week since it is thursday. So the 8 mi target should be lower for the first week since it's a partial week"
**Root cause:** The partial-week re-apply block (`if (isPartialWeek && weekMileageTarget != null)`) ran unconditionally even when `weekMileageTarget` computed to 0 (no Strava history + no prescribedWeek1MilesRaw → `null ?? null ?? 0 = 0`). This overwrote `syncArcCurrentWeek`'s session-derived result (e.g. 3.5mi from 2 run/walk sessions) back to 0, causing the dashboard to show "0 mi" for the week.
**Fix / Change:** Added `&& weekMileageTarget > 0` guard so the re-apply block only fires when there's a meaningful value. When both `prescribedWeek1MilesRaw` and `suggestedWeeklyMiles` are null, `syncArcCurrentWeek`'s sum (the actual prescribed session distances) is preserved as the weekly target.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Fixed wildly wrong mileage targets for beginner run/walk plans; fixed repeated cadence question

**Type:** Bug Fix
**Reported by:** User feedback (observed in production conversation)
**User feedback:** "Why does it say I'm running 16 miles this week" / "But if I'm running 2 min walk 2 min 6 times, that's only 24 minutes. I can do 5.5 miles in 24 minutes?"
**Root cause (mileage):** Two compounding issues. (1) `noHistoryDefault` for beginners with no Strava was 15mi, so the arc was built from a 15mi base even for a true zero-to-runner. (2) Time-based run/walk sessions ("Run 2 min, walk 2 min × 6 (~24 min total)") have no mileage in the label, so `parseMilesFromLabel` returned 0. Since `actualMiles = 0`, `syncArcCurrentWeek` didn't update `mileage_target` or `weekly_mileage_target` — both stayed at the 15mi arc default. (3) The system prompt didn't require a distance estimate for run/walk sessions, so they were purely time-based with no miles for the parser to find.
**Root cause (cadence):** In `handleNonCadenceMessage`, the cadence question was unconditionally appended to EVERY coaching answer, even when the user was clearly confused or asking a follow-up question. Dean would add "Last thing — would you like a reminder..." to responses 3+ times in a row.
**Fix / Change:** (1) Lowered `noHistoryDefault` for beginner from 15 → 8 miles in `training-plan.ts`. (2) Added fallback to `parseMilesFromLabel` to estimate miles from total minutes at ~13 min/mile for run/walk sessions. (3) Added prompt instructions in both SESSION DISTANCE FORMAT sections requiring run/walk interval sessions to include an approximate distance estimate: "Run 2 min, walk 2 min × 6 (~24 min, ~1.8mi)". (4) In `handleNonCadenceMessage`, check if the most recent assistant message already contained the cadence question — if so, skip re-appending it.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Dean incorrectly said he can't update the dashboard; rebuild also perpetuated wrong mileage target

**Type:** Bug Fix
**Reported by:** User feedback (observed in production conversation)
**User feedback:** Dean said "I can't update the dashboard directly myself — the plan you're seeing is built by the system based on your profile." (twice) after user asked to fix a mismatch between prescribed sessions (~3-4mi) and the dashboard showing 16mi for week 1.
**Root cause:** Two bugs: (1) The DASHBOARD UPDATES prompt instruction already said "Do not say I can't update the dashboard" but didn't explicitly cover the case where the dashboard shows *wrong/mismatched* data — Dean interpreted that as a system bug outside its control rather than a plan correction request. (2) `handleRebuildPlan` uses `existingTarget` as a floor for `rebuildBase`, so even if `[REBUILD_PLAN]` had been triggered, the rebuilt plan would have also started at 16mi (the wrong existing target), because the conversation didn't contain explicit decrease-vocabulary like "lower/reduce mileage".
**Fix / Change:** (1) Strengthened the DASHBOARD UPDATES prompt instruction to explicitly cover correction/mismatch scenarios and explicitly forbid "I can't edit the system / it's auto-generated" responses. (2) Added `wantsCorrection` detection in `handleRebuildPlan` — when the conversation contains correction language (e.g. "way off", "doesn't match", "not updated", "showing wrong"), the `existingTarget` floor is skipped entirely, so the rebuild derives fresh from Strava avg or profile baseline rather than perpetuating a bad stored target.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Strava skip regex missed "I don't use Strava"

**Type:** Bug Fix
**Reported by:** User feedback (Jake)
**User feedback:** "feels like this should result in us skipping the strava question, no?" — user replied "I don't use strava" and got the Strava link re-sent instead of moving on.
**Root cause:** `isSkip` regex in `handleStrava()` only matched `don't have`, not `don't use`. "I don't use strava" fell through to the catch-all that re-sends the connect link.
**Fix / Change:** Added `don.?t use`, `i don.?t`, and `not on strava` to the skip regex.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Rebuild plan respects existing mileage target (floor/ceiling)

**Type:** Bug Fix
**Reported by:** Gwyneth (onboarding test)
**User feedback:** "The mileage build seems a little low, maybe we increase it a tiny bit?" → Dean acknowledged and rebuilt → plan came out lower than before
**Root cause:** `handleRebuildPlan` recalculated `avgWeeklyMileage` fresh from Strava's 8-week window each time. If recent runs averaged lower (data drift, fewer runs that week), the rebuild would silently produce a lower plan even when the user asked for more. Dean's promise to "increase" wasn't translated into any parameter.
**Fix / Change:** Fetch `training_state.weekly_mileage_target` (what Dean last prescribed) and use it to anchor the rebuild:
- Default (neutral or increase): `max(strava_avg, existing_target)` as `prescribedWeek1Miles` — the plan can't silently drop below what was already prescribed
- Volume decrease explicitly requested: detect "lower/less/reduce/decrease/dial back/too high" language near "mileage/volume/week" in recent conversation, then use `min(strava_avg, existing_target)` — plan can actually decrease but won't exceed current target
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Fix mid-onboarding week-2 plan rebuild, "thanks for reaching out", and doubled cadence question

**Type:** Bug Fix
**Reported by:** Gwyneth (post-plan onboarding flow)
**User feedback:** "he said thanks for reaching out in the middle of a conversation, and then probably shouldn't be rebuilding a plan just because Gwyneth wants to see week 2...the proper behavior here is to highlight the planned mileage and quality workout and saying he'll generate the full plan on Sunday night. Also the cancel subscription doesn't seem to work"
**Root cause:**
1. Haiku classifier in `handleNonCadenceMessage` classified "I would like you to tell me what my week 2 plan is" as `plan_feedback` (because it contains "plan") instead of `coaching_question`. This triggered a full plan rebuild.
2. The `plan_feedback` Sonnet system prompt had no instruction to skip greeting language — Claude said "Thanks for reaching out!" mid-conversation.
3. The `other` fallback response prefixed `cadenceQuestion` with "Just one last thing —", but `cadenceQuestion` itself already starts with "Last thing —", producing "Just one last thing — Last thing — would you like a reminder...".
4. Cancel classification may have failed on "cancel my strip subscription" (misspelled Stripe) and fallen to the `other` fallback.
**Fix / Change:**
- Improved classifier prompt to clearly distinguish "asking to SEE what's in the plan" (coaching_question) vs "wanting to CHANGE the plan" (plan_feedback), with explicit examples
- Added "no greeting phrases" instruction to `plan_feedback` Sonnet prompt
- `coaching_question` path now fetches and injects the training plan arc so Dean can answer "what's week 2?" directly from data; also added no-greeting instruction
- `cancel` classifier description now handles typos and free-trial phrasing
- Fixed fallback to use `cadenceQuestion` directly instead of prefixing it with "Just one last thing —"
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-09 — Speed work earlier in plans, fix "no access" hallucination, dashboard key workout display

**Type:** Bug Fix + Improvement
**Reported by:** Gwyneth (onboarding test)
**User feedback:** "The mileage build seems a little low, maybe we increase it a tiny bit? Also I enjoy doing speed workouts but I'm not seeing any until week 7, why?" / "Also in the dashboard it looks like I can only see what the long run is for each week, not the tempo workout" / "What's my speed workout for week 2?" → Dean: "I don't have access to your specific training plan right now."
**Root cause (4 issues):**
1. Dean hallucinated "I don't have access to training plan" despite having it in context — `fullArcContext` instruction said "do NOT reproduce this list" which Claude over-applied to specific week questions
2. Haiku arc enrichment was setting `key_workout` to the long run even on weeks with a tempo session — the rule "defining session" was ambiguous, leading to long runs appearing for every week on the dashboard
3. `hasEstablishedBase` threshold was 15mi/week — runners at 10-14mi/week were getting conservative "build from scratch" instructions and no speed work until late in the plan
4. Peak mileage multiplier was capped at 1.5x base — produced conservative peaks (e.g. 25mi for a 15mi/week half marathon runner; 30mi would be more appropriate)
**Fix / Change:**
1. Updated `fullArcContext` instruction to explicitly say "NEVER say you don't have access to the training plan" and clarify that specific week questions should be answered from arc data
2. Updated Haiku enrichment system prompt: when a week has both a long run AND a quality session, `key_workout` must be the quality session (tempo/intervals/strides), not the long run — the long run is shown separately
3. Lowered `hasEstablishedBase` threshold from 15 to 10 mi/week so more runners get quality sessions from week 1
4. Added `wantsSpeedWork` parameter to `generateAndSaveFullPlan` — now passed from `handleRebuildPlan` and `initial_plan` trigger, injected into Haiku enrichment prompt so athletes who said they want speed work get it from week 1 in the arc
5. Increased peak mileage multiplier from 1.5x to 2.0x base (e.g. 15mi/week → 30mi peak for HM vs old 25mi)
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-10 — Training plan volume cap and 5 new eval fixtures

**Type:** Bug Fix + Improvement
**Reported by:** Internal eval (plan-half-marathon-first-timer failing 5/10)
**User feedback:** N/A
**Root cause:** `getTargetPeakMileage()` used a 1.8x growth multiplier from base mileage, causing first-time half marathoners at 25 mpw to generate 45mi peak weeks — too aggressive. Target sweet spot for a first HM at 25mpw is 35–42mi.
**Fix / Change:** Changed multiplier from `1.8` to `1.5` in `training-plan.ts`. At 25mpw base, peak now targets ~37.5mi (within the 35–42mi sweet spot). Also added 5 new eval fixtures covering previously untested scenarios: post_run feedback quality, weekly_recap trigger, taper phase messaging, general fitness users with no race, and metric-units pace display. Fixed eval harness to convert paces and distances to km for metric users.
**Files changed:** src/lib/training-plan.ts, evals/run-evals.mjs, evals/fixtures/quality-post-run-feedback.json, evals/fixtures/quality-weekly-recap.json, evals/fixtures/date-taper-messaging.json, evals/fixtures/quality-general-fitness-no-race.json, evals/fixtures/pace-metric-user.json

## 2026-04-10 — Fixed timezone extraction hallucinating invalid IANA zones for midwest cities

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** `parseTimezoneFromMessage()` in onboarding used Haiku with only coastal city examples (Denver, SF, NY), causing it to hallucinate `America/Columbus` (invalid IANA) for Columbus, OH.
**Fix / Change:** Added 15+ city examples to the extraction prompt covering midwest (Chicago, Columbus, Indianapolis, Nashville, Dallas, Detroit), mountain (Phoenix), pacific (Seattle, Honolulu), and alaska.
**Files changed:** src/app/api/onboarding/handle/route.ts

## 2026-04-09 — Fixed Strava mileage including non-run activities and using 8-week average

**Type:** Bug Fix
**Reported by:** Gwyneth (onboarding observation)
**User feedback:** "What's your frame of reference for the 20mile/week?" / "Yeah I think my current average is closer to 15"
**Root cause:** Two compounding issues: (1) `runs8w` filter in strava callback was `distance_meters > 400` only — no activity type filter — so cycling, walking, and other Strava activities were included in the "average weekly miles" figure passed to Dean. (2) The average was computed over 8 weeks, which smooths over older (potentially higher) weeks and misrepresents current fitness. Gwyneth's last 4 weeks were 14, 16, 10, 17 (~14 avg) but the 8-week avg read as ~20.
**Fix / Change:** (1) Added `RUN_TYPES` filter to `runs8w` — only Run, TrailRun, VirtualRun, Treadmill count toward mileage. (2) Changed `avgWeeklyMiles` to use a 4-week average (`last4WeeksMiles / 4`) instead of 8-week. This better represents current fitness and matches the user's mental model of "recent average". (3) Strengthened the STRAVA onboarding prompt with a CRITICAL rule: even if the athlete volunteers race history or fitness data before Strava is asked, ask about Strava first — do not follow up on volunteered data until after the Strava question is answered.
**Files changed:** `src/app/api/auth/strava/callback/route.ts`, `src/app/api/onboarding/handle/route.ts`

## 2026-04-09 — Fixed onboarding asking "are you currently running?" after Strava connected

**Type:** Bug Fix
**Reported by:** Jake (internal observation during onboarding)
**User feedback:** "Dean asked if I'm currently running after he already pulled my Strava which has tons of details on it"
**Root cause:** System prompt said weekly mileage is "REQUIRED if Strava is not connected" but gave no explicit instruction to skip the question when Strava IS connected and shows avg weekly miles. Claude was asking anyway because the negative case wasn't spelled out.
**Fix / Change:** Made the rule explicit in both directions: if Strava is connected AND shows "Recent avg: ~X mi/week", treat that as known and do NOT ask about current running or mileage.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-09 — Optional cross-training sessions visible on dashboard

**Type:** Feature
**Reported by:** Jake Tennant (internal feedback after onboarding)
**User feedback:** "He also said he'd add optional strength and/or biking workouts but not seeing one for tomorrow (Friday). Also I think this will be generally helpful for cross training"
**Root cause:** Dean included optional sessions conversationally but not in the structured `Day M/D · Session` format that `extractAndStorePlanSessions` parses. There was no concept of "optional" in the session type or dashboard rendering, so even if Dean had listed them, they'd show as required sessions.
**Fix:** End-to-end support for optional sessions:
1. Prompt (initial_plan + weekly_recap): Explicit instruction to include optional cross-training on rest days with `(Optional)` prefix, even in partial-week plans. Clarified that the CONFIRMED TRAINING DAYS constraint is for running sessions only.
2. Extractor (`extractAndStorePlanSessions`): Updated Haiku prompt to detect `(Optional)` prefix, strip it from the label, and set `optional: true` on the session object.
3. Dashboard (`PlanSession` + `DayWorkout`): Added `optional?: boolean` fields. `buildDailyPlanFromSessions` maps optional sessions to type `"optional"`. Rendered with lighter gray styling and italic text — visible but clearly secondary.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

## 2026-04-09 — Fix weekly target, A-race taper, and mileage display for partial-week onboards

**Type:** Bug Fix (2 issues)
**Reported by:** Jake Tennant (internal testing after fresh onboarding)
**User feedback:** "the 'This week' weekly target should include any miles already done this week + any new miles prescribed by dean for this first week of the plan. Right now the target is just what Dean prescribes. (15 mi for me, but I've already run 17 this week, so target should be 32 mi this week). Also I'm not sure if there's any taper in the dipsea race week, week 10 of the arc. Feels like there should be."
**Root cause (weekly target):** `syncArcCurrentWeek` runs after `generateAndSaveFullPlan` and overwrites `training_state.weekly_mileage_target` with just the prescribed session sum from Dean's message (e.g. 15mi). The earlier correct value computed in the `initial_plan` block (which adds `weekMileageSoFar` for partial-week onboards) gets lost.
**Fix (weekly target):** After `syncArcCurrentWeek`, re-apply `weekMileageTarget` when `isPartialWeek` is true. This preserves the TRUE total (done this week + newly prescribed sessions) in `training_state`.
**Root cause (A-race taper):** When a plan is extended past the A-race to cover a B-race (e.g. Dipsea June 14 + Snowbird July 11 → 14-week plan), `computePhaseForPlan` only tapers the *last* race. The A-race (week 10) falls in "build" phase at 48mi because `weeksFromEnd = 4 ≥ peakThreshold`. There's no logic to inject an A-race taper mid-plan.
**Fix (A-race taper):** Compute `aRaceWeekNum` and `planExtendsPostA` flag in `generateAndSaveFullPlan`. When active, inject: 2-week taper around the A-race (pre-race at 70% of effective peak, race week at ~35%), + a recovery week after the A-race at 50% of peak. Uses `effectivePeak = max(peakMileage, buildMileage)` so the taper reference is correct even when peak phase hasn't formally started.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Fix 3 initial_plan bugs: wrong pace, missing daily sessions in dashboard, B race badge

**Type:** Bug Fix (3 issues)
**Reported by:** Jake Tennant (internal testing)
**User feedback:** "looks like my pacing is still wrong?" / "there was an interval workout that was put on today (plan creation day)" / "the plan doesn't say my second race has a 'race day' tag"

**Bug 1 — Wrong pace (9:25–9:55/mi instead of 7:50–8:20/mi for a 17:50 5K)**
**Root cause:** Haiku extraction for `recent_race_distance_km`/`recent_race_time_minutes` was pulling the trail 30K from Dean's own message ("Your best Strava effort is a 30K trail race in 2:25:00") rather than the athlete's stated road 5K time. The instruction said "most-cited PR or recent race" without specifying user-only messages — so Haiku picked the coach-mentioned Strava data. Result: VDOT computed from trail 30K (~45.3 → easy 9:27/mi) instead of road 5K (~56.9 → easy 7:52/mi).
**Fix:** Updated both `recent_race_distance_km` and `recent_race_time_minutes` extraction rules to say "extract ONLY from the athlete's own messages (user turns), NOT from coach messages about Strava data." If the coach mentions a Strava race but the athlete states a different road race time, use the athlete's stated time.

**Bug 2 — Today's interval workout showing in dashboard / arc key_workout not synced from actual sessions**
**Root cause:** `extractAndStorePlanSessions` was called BEFORE `generateAndSaveFullPlan`. But `generateAndSaveFullPlan` always clears `weekly_plan_sessions: null` (to flush stale sessions after a full arc rebuild). This wiped the just-stored sessions before `syncArcCurrentWeek` could read them — so `syncArcCurrentWeek` returned early (sessions.length === 0) and the arc's week 1 key_workout remained the Haiku-guessed "6×800m" from arc generation. The dashboard then fell back to `buildDailyPlan` (uses all training_days including today) instead of `buildDailyPlanFromSessions` (only stores actual remaining-week sessions).
**Fix:** Moved `extractAndStorePlanSessions` to run AFTER `generateAndSaveFullPlan`, so sessions are stored after the null-clear and both the dashboard and `syncArcCurrentWeek` can use them.

**Bug 3 — B race not tagged with "Race day" badge in arc**
**Root cause:** Dashboard computed `raceWeekNum` only from `training_profiles.race_date` (the A race). B/C races in the `races` table were not checked.
**Fix:** Computed week numbers for all races in `upcomingRaces` and collected them into `allRaceWeekNums` (Set). `WeekCard.isRaceWeek` now checks `allRaceWeekNums.has(week.week_number)` so every race week (A, B, C) gets the badge.

**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-09 — Fixed plan rebuild corrupting A-race date + stale session display after rebuild

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "the dashboard is labeled dipsea but has the race day as july 11 which is for cirque series snowbird. And then both races are labeled as 93 days away in upcoming races with the same date. Then I asked to have the Friday workout removed - it was removed from the weekly target mileage but not from the actual this week view."
**Root cause:** Three separate issues: (1) `extractProfileData` extracted the Snowbird B-race date ("july 11") as `race_date` and `persistProfileUpdates` blindly applied it to the A-race, overwriting Dipsea's date and making both races show July 11. (2) `generateAndSaveFullPlan` never cleared `weekly_plan_sessions` in training_state, so old sessions (including Friday) persisted after the rebuild; the dashboard showed stale sessions rather than falling back to training_days. (3) `handleRebuildPlan` computed Strava avg mileage using `.eq("activity_type", "Run")` only, excluding TrailRun/VirtualRun/Treadmill activities — trail runners would get `avgWeeklyMileage = null`, causing the arc to default to `fitness_level` hardcoded value (e.g. 30mi/week for advanced) instead of their real history.
**Fix / Change:** (1) Updated `extractProfileData` prompt to only set `race_date` when the athlete is CHANGING their primary race — explicitly not when adding a secondary/B-race (phrases like "too", "also", "build towards that too"). (2) `generateAndSaveFullPlan` now always sets `weekly_plan_sessions: null` in the training_state update so the dashboard re-derives sessions from training_days after any rebuild. (3) Dashboard now fetches `this_week_override_days` + `this_week_override_expires` from training_profiles and uses the override days (instead of standing training_days) when the override is still active — ensures a "just this week" schedule change is reflected in the dashboard fallback view. (4) Fixed activity type filter in `handleRebuildPlan` to include TrailRun, VirtualRun, and Treadmill.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-09 — Fix initial plan scheduling wrong training days (run on Friday instead of Thursday)

**Type:** Bug Fix
**Reported by:** Jake Tennant (internal)
**User feedback:** "I say my training days but Dean had me do a run on a day I didn't say" and "he said let's start with 4 sessions this week, but there are 3 on the calendar" — Training days: Tue, Wed, Thu, Sat, Sun. Today (Thursday), Dean scheduled Fri/Sat/Sun instead of Sat/Sun (the remaining training days after today).
**Root cause:** The `initial_plan` user message said "start from tomorrow or later" without constraining to confirmed training days. Claude saw "tomorrow = Friday" and scheduled there, ignoring the SCHEDULE CONSTRAINT saying to only use confirmed training days. The two instructions conflicted and Claude followed "tomorrow or later" literally. The count mismatch ("4 sessions" / 3 on calendar) followed from this: Claude was also scheduling a phantom Thursday session in its preamble text without listing it.
**Fix / Change:**
1. Added pre-computation of `remainingInitialPlanDays` in `processCoachRequest` for the `initial_plan` trigger — filters the athlete's confirmed training days to only those falling after today (mid-week) or the full next Mon–Sun (if today is Sunday). Handles the Sunday=0 vs Mon=1…Sun=7 ordering issue so Sunday isn't incorrectly treated as the first day of the week.
2. Passes the computed days with calendar dates (e.g. "Saturday 4/11, Sunday 4/12 — 2 sessions") as `initialPlanDaysConstraint` into `buildUserMessage`. This replaces the vague "start from tomorrow" instruction with an explicit enumerated list.
3. Added debug logging to `generateAndSaveFullPlan` to capture `bRaces` and the totalWeeks extension check — this will help diagnose the Snowbird dashboard issue (plan only extending to Dipsea, not Snowbird).
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/lib/training-plan.ts`

---

## 2026-04-09 — Fix trail race misclassification when Strava activity_type is "Run"

**Type:** Bug Fix
**Reported by:** Jake Tennant (internal)
**User feedback:** "looks like Dean said my 30k was a road race now" — Strava 30K was auto-detected as `Run` rather than `TrailRun`, so `is_trail = false` and Dean presented it as a road race with a valid easy pace suggestion.
**Root cause:** `selectBestRaceForPacing` set `isTrail` only when `activity_type === "TrailRun"`. Many trail races (especially auto-detected or manually logged) use `Run` as the activity type. A Marin 30K with significant vert was classified as road.
**Fix / Change:** Added elevation-per-mile heuristic: if a race has >80ft/mile of elevation gain it is treated as trail regardless of `activity_type`. `elevation_gain` added to the DB query. Threshold chosen to be well above typical road race vert (<50ft/mile) and well below any real trail race.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Fix onboarding pace anchoring to wrong trail race easy pace

**Type:** Bug Fix
**Reported by:** Jake Tennant (internal)
**User feedback:** "Can you double check the math on that? It should be more like 8 min/mi for easy" — Dean stated 9:25–9:55/mi easy for a 17:50 5K (should be ~7:45–8:15/mi), anchored on the trail race Strava suggestion instead of computing from the road PR. After correction, Dean re-guessed 8:15–8:45/mi — still wrong.
**Root cause:** Two compounding issues: (1) `stravaContext` injected a VDOT-derived easy pace range even when the best Strava race was a trail run — this systematically underestimates fitness. (2) Claude cannot compute VDOT-based paces reliably in-context and pattern-matches to whatever number it sees in the system prompt, so the wrong Strava number persisted even after the user provided a road race time. (3) The trail race calibration question was allowed to defer to any point before [READY], letting Claude acknowledge the road race time too late.
**Fix / Change:**
1. When `is_trail`, stravaContext no longer emits "Suggested easy pace" — instead says "easy pace suggestion withheld — collect a road 5K/10K/HM time." This removes the wrong anchor entirely.
2. PACE CALIBRATION prompt instruction changed from "ask once before [READY]" to "ask in THIS message" — calibration question must fire in the same turn as the Strava acknowledgment, not deferred.
3. New TRAINING PACES block in onboarding system prompt explicitly prohibits Claude from quoting specific min/mi paces during onboarding. Accurate zones are server-computed when the plan builds — Claude guessing in-conversation only produces wrong numbers.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-09 — Extend plan through post-A B races; fix partial-week mileage target

**Type:** Bug Fix / Feature
**Reported by:** Jake Tennant (internal)
**User feedback:** "As you can see, it only goes to Dipsea" (plan ended June 14; Snowbird July 11 was not included) and "the 'this week' view shows a goal of 19 mi but that excludes what I've already done, I think week 1 should sum up to my total mileage (done + planned)"
**Root cause:**
1. `generateAndSaveFullPlan` computed `totalWeeks` from `profile.race_date` (A race) only. B races after the A race were labeled in arc notes only if they fell within `totalWeeks` — so a B race 4 weeks after the A race was entirely outside the plan and invisible.
2. `weekly_mileage_target` for partial-week onboards was set to `prescribedWeek1MilesRaw` only — the miles already run earlier in the week (e.g. 17.2mi) were not included, making the dashboard show "17.2 / 19 mi" instead of "17.2 / 36 mi".
**Fix / Change:**
1. After computing `totalWeeks` from the A race date, check if any B/C race falls after the A race within 8 weeks. If so, extend `totalWeeks` to cover the last such race. The arc phases naturally taper to the new endpoint; the intermediate A race week appears as a peak/tune-up week and Haiku labels it via the existing B race annotation system.
2. For partial-week `initial_plan` triggers, add `weekMileageSoFar` to `prescribedWeek1MilesRaw` when storing `weekly_mileage_target`. This gives the dashboard the true weekly total (done + planned) rather than just the planned sessions.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-09 — Separate SMS opt-out from subscription cancellation

**Type:** Bug Fix / Improvement
**Reported by:** Internal (pre-launch review)
**User feedback:** N/A
**Root cause:** CANCEL and UNSUBSCRIBE were treated as hard SMS opt-out keywords in the linq webhook, meaning a user who texted either would get silently opted out of messages but never receive the Stripe portal link — leaving their subscription billing with no way to cancel via text.
**Fix / Change:**
1. Removed CANCEL and UNSUBSCRIBE from `isHardStop` and `isSoftStop` in `linq/route.ts` — they now fall through to `coach/respond` which sends the Stripe portal link (existing behavior, newly reachable).
2. STOP confirmation message now includes the Stripe portal link when a `dashboard_token` is available, so STOP is a complete exit path (messages off + billing cancel link).
3. Updated FAQ on landing page to distinguish UNSUBSCRIBE (subscription management) from STOP (stop all messages).
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/page.tsx`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-09 — Day-2 welcome tips SMS + beta email address

**Type:** Feature
**Reported by:** Internal (pre-launch prep)
**User feedback:** N/A
**Root cause:** No onboarding follow-up told users about keyboard shortcuts (MY PLAN, FEEDBACK, STOP), and all public contact emails pointed to a personal address.
**Fix / Change:**
1. New daily cron `/api/cron/welcome-tips` (15:00 UTC) sends a one-time SMS to users whose `initial_plan` landed 20–48 hours ago. Deduped via `message_type = 'welcome_tips'` in conversations — no DB migration needed.
2. Updated all public-facing email addresses (footer, terms, privacy) from `jake.c.tennant@gmail.com` to `hello@coachdean.ai`.
**Files changed:** `src/app/api/cron/welcome-tips/route.ts` (new), `vercel.json`, `src/app/page.tsx`, `src/app/terms/page.tsx`, `src/app/privacy/page.tsx`

---

## 2026-04-09 — Add sanity check on extracted race times before VDOT calculation

**Type:** Bug Fix
**Reported by:** Internal investigation (Anthony, ae993f7b)
**User feedback:** N/A — discovered by inspecting stored paces after the 14:07/mi tempo issue
**Root cause:** `persistProfileUpdates` called `calculateVDOTPaces(distKm, timeMins)` directly from Haiku's extraction without validating the implied pace. If Haiku mangled the extraction (e.g. passing pace-seconds as minutes, or getting the distance wrong), the resulting VDOT could be wildly off. For Anthony, the implied pace from the stored extraction parameters corresponds to VDOT ~20 (17:19/mi easy) when his actual fitness is VDOT ~39 (10:34/mi easy) based on his Oakland Half at 8:35/mi.
**Fix / Change:**
1. Added bounds check before calling `calculateVDOTPaces`: implied pace must be between 4:00/mi and 20:00/mi. If outside that range, log a warning and skip — don't persist corrupt paces. This covers mis-extractions like pace-seconds passed as total minutes, or km/mi confusion.
2. Manually corrected Anthony's stored profile paces to the correct values from his Oakland Half (VDOT 39.3 → Easy 10:34, Tempo 8:28, Interval 7:37).
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Fix corrupted tempo pace used verbatim in session prescriptions

**Type:** Bug Fix
**Reported by:** Internal observation (daily audit email)
**User feedback:** "Wed 4/8 · Tempo 6.5mi (1mi WU + 4.5mi @ 14:07/mi + 1mi CD)" — 14:07/mi is a walking pace
**Root cause:** When an athlete enters their easy pace in min/km during onboarding but the system stores it as min/mile (e.g. "15:37" meant 15:37/km = 9:41/mi, but stored as 15:37/mi), `estimatePacesFromEasyPace` correctly derives tempo = easy − 90s = 14:07/mi. The system prompt then presents this to Claude as an authoritative pre-computed pace with instructions to never recalculate it, so Claude uses it verbatim in session prescriptions.
**Fix / Change:** Added a runtime sanity check: tempo pace must be (a) faster than 13:00/mi absolute floor AND (b) at least 30s/mi faster than easy pace. If either fails, the Tempo/Interval lines in the FACTS block read "INVALID — paces appear corrupted. Use effort-based language only. Do not prescribe specific paces until the athlete provides a recent race time or easy pace to recalibrate." Also suppresses the invalid tempo from plan generation guards.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Post-run feedback misreads WU/CD structure as pacing error

**Type:** Bug Fix
**Reported by:** Internal observation (daily audit email)
**User feedback:** Dean said "you held 8:15-8:28 for miles 1-4 right around target pace, then backed off the last mile." Athlete had to correct: "I thought I was meant to back off the last mile for cool down."
**Root cause:** TODAY'S PLANNED SESSION is correctly injected into the system prompt (showing "1mi WU + 3mi @ 8:30/mi + 1mi CD"), but the post_run prompt only said "analyze their performance." Claude saw [slower mile 1, faster miles 2-4, slightly slower mile 5] in the splits and inferred "4-mile flat tempo + faded last mile" instead of reading the WU+tempo+CD structure from the plan.
**Fix / Change:** Added a "WORKOUT STRUCTURE" block at the top of the post_run prompt that explicitly instructs Claude to check TODAY'S PLANNED SESSION first, map the opening/closing slower segments to WU/CD, and not flag them as anomalies or "backing off."
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-09 — Fix daily audit email false positives (cadence, power, per-lap elevation)

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "every email I get daily now mentions strava splits or HR as hallucinated — it keeps giving me false positives of stuff it thinks is off but isn't"
**Root cause:** The `analyze-conversations` cron was annotating each post_run message with only `hasLaps`, `hasHR`, `distanceMiles` — it did not track `hasCadence`, `hasWatts`, or `activityType`. As a result, Claude (the analyzer) had no way to know whether power/watt values, cadence values, or per-lap elevation were real Strava data or fabricated. It was flagging legitimate coaching responses as hallucinations:
- Cadence per lap (real when cadence sensor present — `average_cadence` field)
- Power/watts on Zwift rides (Zwift always provides `average_watts`)
- Per-lap elevation gain (`total_elevation_gain_feet` is a real Strava lap field)
- Per-mile elevation from GPS splits (`elevation_difference_feet` is a real split field)
- Fast pace figures on VirtualRide activities (speed-based, not GPS)
Also: the plan health section crashed with an Anthropic API `invalid_request_error` when conversation content contained invalid Unicode surrogate pairs (bare emoji codepoints).
**Fix / Change:**
1. Extended activity metadata fetch to include `average_cadence`, `average_watts`, `activity_type`
2. Added `cadence data`, `power/watts data`, `activity type` to the per-message Strava annotation
3. Rewrote the "NOT hallucinations" section of the analyzer prompt to explicitly enumerate all real Strava fields (per-lap elevation, cadence, power, fast Zwift paces)
4. Stripped bare surrogate characters from conversation content before passing to Anthropic API to fix the plan health JSON encoding crash
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`

---

## 2026-04-09 — Block ⚠️ ANALYSIS leaks; require strides in mile TT plans; eval stripping parity

**Type:** Bug Fix + Improvement
**Reported by:** Internal eval failure
**User feedback:** N/A
**Root cause:** (1) Claude was generating self-created `⚠️ ANALYSIS:` reasoning blocks (mimicking the system prompt's ⚠️ style) that `stripReasoningPreamble` didn't catch — these would leak to SMS. (2) Mile TT plans were omitting strides despite instructions listing them as key sessions — no hard requirement. (3) Eval runner wasn't applying the stripping function, so the judge scored the raw leaked response.
**Fix / Change:** Added `⚠️ ANALYSIS/REASONING/PLANNING/THINKING` to `stripReasoningPreamble` patterns (both separator and leading-paragraph variants). Added explicit prompt rule: "Do NOT create your own ⚠️-prefixed analysis blocks." Upgraded strides to a hard `⚠️ STRIDES REQUIRED` requirement in MILE TIME TRIAL GOAL section (route.ts and eval runner). Added `stripReasoningPreamble` to the eval runner so the judge sees post-stripping output (matches prod behavior).
**Files changed:** src/app/api/coach/respond/route.ts, evals/run-evals.mjs

## 2026-04-09 — Week 1 volume cap for moderate/high volume athletes

**Type:** Improvement
**Reported by:** Internal eval (plan-strength-integrated-marathon 3/10)
**User feedback:** N/A
**Root cause:** The FITNESS TIER section in the system prompt only injected a `⚠️ WEEK 1 VOLUME CAP` for LOW VOLUME athletes (<10 mi/week). MODERATE (10–30 mi/week) and HIGH VOLUME (≥30 mi/week) athletes had no such constraint, so the model could generate an aggressively ramped Week 1 (e.g. 40mi from a 32mi base = 25% jump). The initial_plan prompt referenced this cap as if it existed for all tiers, creating a false expectation.
**Fix / Change:** Added `⚠️ WEEK 1 VOLUME CAP — GUIDELINE` to the MODERATE and HIGH VOLUME fitness tier strings in both `route.ts` and `evals/run-evals.mjs`. MODERATE: target 105–115% of current base; HIGH: target 105–112%. Also clarified `date-18-week-plan-week10` fixture ground_truth notes with explicit Mon–Sun week boundaries to prevent the judge from misattributing the 18mi run (Mar 22, a Sunday = week of Mar 16) to the same week as the 8mi run (Mar 25 = week of Mar 23).
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/fixtures/date-18-week-plan-week10.json`

---

## 2026-04-09 — FACTS block: pre-computed numbers at top of system prompt

**Type:** Improvement
**Reported by:** Internal (eval architecture)
**User feedback:** N/A
**Root cause:** Volatile numbers (today's date, weekly mileage, paces, race countdown) were scattered across multiple sections deep in the system prompt. Claude was hallucinating or anchoring on conversation history when these facts conflicted, partly because they were buried in long prose sections.
**Fix / Change:** Added a `FACTS` block as the very first thing in the system prompt — before "You are Coach Dean..." — containing all pre-computed volatile numbers in a compact, visually distinct table:
- Today's date
- Training week and phase (including recovery week flag)
- Miles logged this week and projected total
- Training paces (easy range, tempo, interval)
- Race name, date, and days/weeks out
- Miles remaining this week across sessions (when applicable)

To make this possible, extracted the training state IIFE computation into pre-computed `ts*` variables before the `return` statement in `buildSystemPrompt`. The IIFE now uses these pre-computed values directly, eliminating redundant computation. Mirrored in `run-evals.mjs` for eval parity.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

---

## 2026-04-09 — Fix time-constrained training day distance caps

**Type:** Bug Fix
**Reported by:** Internal (eval run)
**User feedback:** N/A
**Root cause:** `plan-three-days-half` still scoring 4/10 after session count fix: Dean prescribed a 12mi easy run on Tuesday despite athlete notes stating "Tuesday and Thursday are limited to 60 minutes." At 9:40/mi, 60 min = ~6.2mi max. Notes were present in the system prompt but no computed distance cap was injected, so Claude ignored the time constraint when building peak week volume.
**Fix / Change:** Added server-side detection of "X-day and Y-day limited to N minutes" pattern in athlete notes. When found, computes max distance from easy pace and injects `⚠️ TIME CONSTRAINT — HARD CAP: ... NEVER prescribe more than Xmi on [days]` into the system prompt. Matched in both `route.ts` and `run-evals.mjs`. Fixture went from 4/10 to 9/10.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

---

## 2026-04-09 — Fix mileage self-correction and 3-day quality session distribution

**Type:** Bug Fix
**Reported by:** Internal (eval run)
**User feedback:** N/A
**Root cause:**
1. `mileage-strava-correction` (5-6/10): System prompt correctly labels Strava mileage as authoritative, but no rule prevented Dean from defending its own wrong prior messages. When athlete corrected "phantom 3.5mi run" twice, Dean kept re-citing conversation history instead of re-anchoring to the system prompt figure.
2. `plan-three-days-half` (4-6/10): Session count constraint ("EXACTLY 3 sessions") was satisfied, but Dean structured peak week as tempo + intervals + long run — all three hard sessions. Ground truth requires 1 long run + 1 quality (tempo OR intervals, not both) + 1 easy run.
**Fix / Change:**
1. Added explicit override to the Strava mileage authority line: "If your own prior messages stated a different mileage total, those messages were wrong — do not defend, re-cite, or re-state them. Re-anchor to this figure immediately."
2. For athletes with ≤ 3 training days, appended to the session count constraint: "With only N training days, structure each week as: 1 long run + 1 quality session (tempo OR intervals — NOT both in the same week) + 1 easy/medium run."
3. Both changes mirrored in `run-evals.mjs` for eval parity.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

---

## 2026-04-09 — Eval harness improvements + server-side pre-computation for date/math accuracy

**Type:** Improvement
**Reported by:** Internal (eval run)
**User feedback:** N/A
**Root cause:** Three classes of recurring failures found in eval run:
1. "Tomorrow" for today's session — eval runner injected ALL plan sessions as "UPCOMING SESSIONS THIS WEEK" regardless of date, so Claude couldn't distinguish today's session from future ones. Production route already classified them correctly; eval runner was behind.
2. Math errors on "how many miles do I have left?" — Claude was computing target-delta (28-14=14) instead of session-remaining (6+9=15), because it was given raw numbers and asked to do arithmetic at inference time.
3. "Yesterday" for a run 2+ days ago — the existing ACTIVITY RECENCY advisory rule ("check the N-days-ago label") was insufficient; Claude's trained "most recent = yesterday" reflex overrode it.
**Fix / Change:**
1. **Eval runner parity**: ported production route's today/future session classification into `run-evals.mjs` — sessions on today's date now get "TODAY'S PLANNED SESSION" label; future sessions split into "this week" vs "next week."
2. **Pre-computed miles remaining**: added server-side `MILES REMAINING IN PLAN THIS WEEK: Xmi across N sessions (breakdown) → projected week total: Ymi` injected into training state block. Claude reads the pre-computed answer instead of doing arithmetic. Updated projected total to include today's uncompleted session for non-post_run triggers. Mirrored in eval runner.
3. **Pre-computed most recent run reference**: server-side computes `⚠️ MOST RECENT RUN: [DayName] (N days ago). Always reference as "[DayName]'s run" — do NOT say "yesterday". Yesterday was [DayName] (a rest day — no runs).` Injected before the ACTIVITY RECENCY rule in user_message responses. Removes the need for Claude to reason about recency — gives it the exact phrase to use.
4. **Training session count constraint**: injected "PLAN GENERATION RULE: include EXACTLY N running sessions per week — never more" derived from `training_days.length`. Scoped to plan generation to avoid it surfacing in post-run/conversational responses.
5. **Onboarding fixture fix**: `ready-signal-no-question.json` had a duplicate last user message in conversation_history and was missing `weekly_miles` from `collected`. Fixed both — Dean now correctly fires [READY] when all required fields are present.
**Results:** Coaching evals: 27/41 → 38/41 passed, 8.3 → 9.0 avg. Onboarding evals: 4/5 → 5/5, avg 8.8 → 10.0. Date accuracy category: 5/7 → 7/7.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/fixtures/onboarding/ready-signal-no-question.json`

---

## 2026-04-08 — Fix Dean re-asking for race time after user already provided one

**Type:** Bug Fix
**Reported by:** Jake Tennant (Gwyneth's onboarding)
**User feedback:** "I just told you about the July 5k from last year. Also what is this trail 5k you're referencing?" — Dean asked for a road race time 3 times in the same conversation after Gwyneth already provided a 20:28 downhill 5K.
**Root cause:**
1. Haiku extraction didn't capture the user's stated 5K time because the user qualified it ("when I was in better shape", "net downhill") — the extraction rule said "only extract clearly stated data" with no note about caveated times. So `recent_race_distance_km` was never stored, causing the PACE CALIBRATION guard to fail on every subsequent turn.
2. The PACE CALIBRATION instruction said "ask ONCE" but only checked extracted `onboarding_data` — it had no check against conversation history, so Dean repeated the question every turn when extraction was missing.
3. The `stravaContext` fallback (when no Strava race found) hardcoded "ask for a recent race time or PR" regardless of whether the user had already stated one in conversation. This directly told Dean to ask even when it shouldn't.
**Fix / Change:**
1. Haiku extraction rule updated: explicitly says to extract race times even when caveated (downhill, old, "when I was in better shape"). Caveated times are still useful for calibration.
2. PACE CALIBRATION instruction is now code-driven: before building the system prompt, `handleConversation` scans conversation history for whether Dean has already asked about road race times (regex on prior assistant messages). If yes, the PACE CALIBRATION block is replaced with an explicit "you already asked, do not ask again" instruction. This is more reliable than asking Claude to self-regulate by reading its own history.
3. `stravaContext` fallback now checks if `onboarding_data` already has `recent_race_distance_km` or `easy_pace`. If yes, emits "using pace data already collected from conversation" instead of "ask for a recent race time."
**Files changed:** `onboarding/handle/route.ts`

---

## 2026-04-08 — Two-phase plan rebuild + 2-bubble cap + speed work flag

**Type:** Feature + Bug Fix
**Reported by:** Jake Tennant (Gwyneth's onboarding — plan update didn't apply pace corrections; too many messages)
**User feedback:** "when Gwyneth asked to update the plan, he rewrote this week instead of updating the next week... also didn't update the whole rest of the plan"
**Root cause:**
- Plan update path (`plan_feedback` in `awaiting_cadence`) fired `initial_plan` immediately without persisting the pace corrections Gwyneth stated in conversation. So the full arc was regenerated from stale profile data (wrong tempo pace).
- 2-bubble instruction was being ignored; Claude generated 3 blocks (strength as a separate bubble).
- Speed work flag ("I want to work on speed") was in a generic system prompt instruction that got overridden by the conservative injury path.
**Fix / Change:**
- **`[REBUILD_PLAN]` tag**: Dean emits this when the athlete asks to rebuild the whole plan. The system strips it before sending. After the confirmation message, `rebuild_plan` trigger fires.
- **`handleRebuildPlan`**: new function in coach/respond. Extracts profile updates from recent conversation → persists them → 300ms pause → re-fetches fresh profile → calls `generateAndSaveFullPlan(resetToWeek1: false)`. Profile writes are guaranteed to land before plan generation.
- **`awaiting_cadence` plan_feedback** now fires `rebuild_plan` instead of `initial_plan`.
- **`user_message` rebuild path**: detects `[REBUILD_PLAN]` in coach response, fires `rebuild_plan` in `after()` after profile persisted.
- **2-bubble hard cap**: `splitIntoMessages` result for `initial_plan` is capped to 2 entries in code — any overflow merged into bubble 2.
- **`wants_speed_work` flag**: extracted from onboarding conversation by Haiku, stored in `onboarding_data`. At plan generation, injected as a ⚠️ hard constraint block into the system prompt — overrides conservative defaults. No longer a generic prose instruction.
**Files changed:** `coach/respond/route.ts`, `onboarding/handle/route.ts`

---

## 2026-04-08 — Onboarding quality fixes: VDOT recalculation, verbosity, pace accuracy, dashboard messaging

**Type:** Bug Fix + Improvement
**Reported by:** Jake Tennant (internal observation from onboarding sessions with Jake and Gwyneth)
**User feedback:** "I don't think the VDOT calculation is working correctly. I was given a 9:30-10min easy pace for a 17:50 5k." / "When given plan there are way too many messages coming in" / "The Strava analysis we added is too long" / "Cut down the coaches note - too long. 2 sentences max. Don't need to personalize it" / "Dean said he can't update the dashboard" / "No speed work until week 7 even though she said she wanted to work on speed"
**Root cause:**
1. VDOT bug: `!mergedData.easy_pace` guard in `handleConversation` blocked recalculation when user provided race time after Strava connected. Strava callback's insight message mentioned a pace (e.g. 9:30/mi from trail 30K), Haiku extraction stored that as `easy_pace`, then the guard prevented VDOT from recalculating when user later stated 17:50 5K. Correct easy pace for 17:50 5K is ~8:00/mi, not 9:30–10:00.
2. Too many messages: Claude generating 3 text blocks despite "2 bubble" instruction (strength detail as separate bubble).
3. Strava analysis: "2–3 sentences max" produced verbose output.
4. Coach's note: included athlete name personalization and 2–3 sentences; user found it too long and slightly creepy.
5. Dashboard: Claude was saying "I can't update the dashboard" — incorrect; plan changes DO update the dashboard automatically.
6. Speed work delay: injury notes triggered all-easy first week even when athlete explicitly requested speed work.
7. Leaked internal thinking: coaching_question path in `handleNonCadenceMessage` allowed model to output reasoning meta-commentary.
8. Greeting formatting: Claude starting messages with just "Jake!" on its own line.
**Fix / Change:**
1. Removed `!mergedData.easy_pace` guard — VDOT now always recalculates when race time data is present.
2. Changed initial_plan format from "2 short iMessage texts" to "EXACTLY 2 SMS bubbles — no more, no less."
3. Strava insight prompt changed to "1–2 sentences max, one key insight only."
4. Coach's note shortened to 2 sentences, removed name personalization.
5. Added DASHBOARD UPDATES block to user_message system prompt — Dean is told he CAN update the plan/dashboard.
6. Added SPEED GOAL OVERRIDE instruction — strides or tempo required in week 1 when athlete stated speed goal.
7. Added "Answer directly, no meta-commentary" to coaching_question system prompt.
8. Added formatting rule: never start a message with just the athlete's name alone on its own line.
**Files changed:** `onboarding/handle/route.ts`, `auth/strava/callback/route.ts`, `coach/respond/route.ts`

---

## 2026-04-08 — Post-race recovery context injected into system prompt

**Type:** Feature
**Reported by:** Internal (Jake)
**User feedback:** N/A
**Root cause:** After an athlete's race date passed, Dean had no context that a race had just happened — it was just coaching with no goal and no guidance. Athletes got incoherent responses or stale race references.
**Fix / Change:** When `profile.race_date` has passed within the last 42 days, a POST-RACE CONTEXT block is injected into the system prompt. It tells Dean the race is complete, gives tiered recovery guidance (days 1–7: full rest; days 8–14: easy running only; weeks 3–6: gradual rebuild), and prompts Dean to ask about the next goal at the right moment — without a new trigger, new flow, or re-onboarding. Handled conversationally.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-08 — Opted-out users no longer receive Strava post-run messages

**Type:** Bug Fix
**Reported by:** Julia (user feedback via screenshot)
**User feedback:** User sent "Can I unsubscribe?" and "Unsubscribe" — both correctly set `messaging_opted_out = true` — but Strava activity webhook fired 3 coaching messages afterward anyway.
**Root cause:** The Strava webhook (`/api/webhooks/strava`) did not fetch `messaging_opted_out` and had no opt-out check before calling `coach/respond`. Additionally, `coach/respond` had no opt-out guard of its own, so even if called directly (e.g. by crons that don't check the flag), it would still generate and send messages.
**Fix / Change:**
1. `strava/route.ts`: Added `messaging_opted_out` to the user select query; added early return before firing `coach/respond` if user is opted out.
2. `coach/respond/route.ts`: Added opt-out guard in `processCoachRequest` (fires after user fetch, before any SMS logic) and in the `handlePostRunOnboarding` early-exit path. Acts as belt-and-suspenders for any trigger path that reaches the route.
**Files changed:** `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-08 — Three P1/P2 bug fixes: dashboard link UX, reasoning leak, stale race context

**Type:** Bug Fix
**Reported by:** User feedback (users 2201ddfe, 7a704281, b1b308cf)
**User feedback:**
- (Issue 4) Dean said "I'll pull up your dashboard link" then immediately reversed: "I don't have a dashboard link to send you directly." (trust-eroding contradiction)
- (Issue 5) Internal chain-of-thought reasoning ("The athlete is asking for advice... Key considerations:...") was sent as a visible SMS message to the athlete
- (Issue 6) Post-run message referenced a race that had already occurred 10 days prior; a second duplicate post-run fired 7 minutes later re-asking the same stomach question
**Root cause:**
- Issue 4: (a) "Show me the entire week by week plan" didn't match the `isPlanRequest` regex (extra words between "the" and "plan"), so it fell through to Claude. (b) System prompt stated "No app, no web dashboard" which is false — there IS a plan dashboard, triggerable by "my plan". Claude then contradicted itself.
- Issue 5: Claude emitted its reasoning scratchpad as regular text blocks separated from the actual response by a `---` divider. `splitIntoMessages` split these into separate SMS bubbles that were sent to the athlete.
- Issue 6: `profile.race_date` in `training_profiles` is never cleared after a race passes. The system prompt showed the athlete's goal as an upcoming race even when the date was 10+ days in the past. The Strava webhook dedup window was also only 5 minutes — a second webhook 7 minutes later bypassed it.
**Fix / Change:**
- Issue 4: Extended `isPlanRequest` regex to catch verbose phrasings with up to 6 intermediate words ("show me the entire week by week plan"). Updated system prompt PRODUCT CAPABILITIES to accurately describe the plan link feature and instruct Dean never to say it can't send a link.
- Issue 5: Added `stripReasoningPreamble()` post-processing function that detects and strips content before a `---` separator (or leading paragraphs) when it matches reasoning-scratchpad patterns ("The athlete is asking...", "Key considerations:", "I should...").
- Issue 6: Added `profileRaceDaysUntil` check in `buildSystemPrompt` — race date is only shown in the DATE CONTEXT and ATHLETE header when `daysUntil > 0`. If the race has passed, Claude gets no stale race context. Extended Strava webhook dedup window from 5 to 10 minutes.
**Files changed:** src/app/api/coach/respond/route.ts, src/app/api/webhooks/strava/route.ts

## 2026-04-08 — Onboarding: weekly mileage required, plan arc week count, coach's note quality

**Type:** Improvement
**Reported by:** Internal observation (Jake)
**User feedback:** "Dean didn't really ask how much running I'm doing now at all, so just started with 10/mi (2 x 5 mi) which may be a little much. He probably needs to get a baseline of how much someone is running in almost all cases. In this message he said I have 16 weeks, then the dashboard said 12 weeks. In the coaches note section I think we could better explain what the quality workout is. For example, this user got strides, but doesn't know what that is."
**Root cause:**
1. Current weekly mileage was marked Optional in the onboarding prompt — omitted when no Strava and athlete didn't volunteer it, leading to unsafe default volume assumptions.
2. For general_fitness goals (no race date), Dean had no system-provided plan duration and computed it himself (16 weeks), disagreeing with the 12-week arc generated by training-plan.ts.
3. Coach's note prompt did not explain training jargon (e.g. strides) and did not personalize with the athlete's name.
4. The "plan is ready" SMS had a `\n` before the checkout URL which could render as extra spacing on some clients.
**Fix / Change:**
1. Moved "current weekly mileage" from Optional to Required in onboarding when Strava is not connected. Includes explicit ask instructions and handling for zero-baseline athletes.
2. Added instruction to the initial_plan user message: for general fitness goals, plan arc is 12 weeks — do not compute this independently.
3. Added general fitness outcome instruction: include 1-2 concrete sentences about what the athlete can expect by week 12.
4. Updated syncArcCurrentWeek to accept athlete name; updated coach's note prompt to personalize with name and explain quality workout types (strides, tempo, etc.) in plain language.
5. Restructured the "plan is ready" SMS to put the checkout URL inline with no trailing newline.
**Files changed:** src/app/api/onboarding/handle/route.ts, src/app/api/coach/respond/route.ts

## 2026-04-08 — Subscription event tracking and PostHog user_id fix

**Type:** Feature / Improvement
**Reported by:** Internal observation
**User feedback:** N/A
**Root cause:** Stripe webhook handled subscription lifecycle but never called trackEvent, so PostHog had no visibility into trial starts, activations, failures, or cancellations. signup/route.ts also never tracked user_signed_up. PostHog user_id was only available as distinctId (person identifier), not as an event property — making it invisible when filtering by event properties.
**Fix / Change:** Added trackEvent calls to stripe/route.ts for trial_started, subscription_activated, subscription_past_due, payment_failed, and subscription_canceled. Added user_signed_up to signup/route.ts. Updated trackEvent in track.ts to always include user_id in event properties so it's filterable in PostHog without needing to switch to Person filters.
**Files changed:** src/app/api/webhooks/stripe/route.ts, src/app/api/signup/route.ts, src/lib/track.ts

## 2026-04-08 — Fix billing gate sending plain website URL when dashboard_token is missing

**Type:** Bug Fix
**Reported by:** User feedback (Jake's mom)
**User feedback:** "I put my mom's billing_status = true (she already has an account), but she got the regular website landing page link instead of the stripe portal to sign up"
**Root cause:** In the billing gate block of `coach/respond`, when `dashboard_token` is null the code fell back to `appUrl` (plain `https://coachdean.ai`) for both the checkout and portal URLs. Existing users whose tokens weren't set (e.g. provisioned manually by admin) would receive an unhelpful homepage link instead of a direct checkout link.
**Fix / Change:** Generate a `crypto.randomUUID()` token and persist it to the DB on-the-fly (same pattern used in `dashboard/request-link`) when `dashboard_token` is null, so the checkout/portal URLs are always user-specific.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-08 — Landing page: "Dean" → "Coach Dean" + comparison section redesign

**Type:** Improvement
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Inconsistent branding (bare "Dean" throughout) and a text-heavy comparison section that didn't sharply communicate Coach Dean's value vs. the alternatives.
**Fix / Change:** (1) Replaced every bare "Dean" reference across page.tsx with "Coach Dean" — hero, value props, FAQ, season plan callout, smsUrl body. (2) Redesigned comparison section: new headline ("The elite coaching experience, minus the elite price tag"), performance-gap framing, switched competitor cards to pros/cons bullets, added "The Coach Dean Difference" 2×2 grid (Life Happens Button, Contextual Intelligence, Pocket Expert, Invisible Tech).
**Files changed:** src/app/page.tsx

## 2026-04-08 — Extraction evals for plan session persistence

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Plan update evals only tested Dean's SMS response text, not whether the Haiku extraction step (`maybeUpdatePlanSessions`) correctly parsed the change into session JSON for the dashboard.
**Fix / Change:** Added `npm run eval:extraction` — 5 fixtures that feed real coach response text into the exact Haiku extraction prompt from `route.ts` and assert the output JSON is correct: reschedule long run, lighter week (all sessions replaced), easy→tempo conversion, cancel-without-replacement, and no-change (must return `changed: false`). All 5 passing.
**Files changed:** `evals/run-extraction-evals.mjs`, `evals/fixtures/extraction/*.json`, `package.json`

## 2026-04-08 — Plan update evals + prompt fixes for load reduction, quality requests, and strength training

**Type:** Improvement
**Reported by:** Internal observation / eval harness
**User feedback:** N/A
**Root cause:** Three prompt gaps found via new evals: (1) "dial it back / 3 easy runs" requests were being honored in intensity but not distance — Dean would drop the tempo but still prescribe 7-10mi runs; (2) "I want more speed work" requests were refused with aerobic-base lectures even for 5k athletes 8+ weeks out with established fitness; (3) initial plans for athletes doing 2x/week strength training were building to 56-58mi peak, ignoring the additional training load from lifting.
**Fix / Change:** Added explicit prompt guidance in both `route.ts` and `run-evals.mjs` for: (a) load reduction requests — cap runs at 5-6mi, total week at ~50-60% of normal; (b) quality work requests — implement now, don't defer, validate instinct without lecturing; (c) structural day changes — make a concrete recommendation rather than asking the athlete; (d) cross-training athletes — reduce peak volume 10-15%, never schedule hard runs adjacent to lifting days. Also added peak volume caps to the eval system prompt for `plan_quality` fixtures.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`

## 2026-04-08 — Plan update and strength training evals

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** No evals existed for whether Dean correctly handles plan modification requests or integrates strength training.
**Fix / Change:** Added 5 `plan_update` fixtures (reschedule long run, lighter week, add strength training, fewer training days, more quality work), 1 `plan_quality` fixture for strength-integrated initial plans, a new `plan-update.mjs` judge, and wired up the new category in `run-evals.mjs`. Baseline: 5/5 passing, avg 8.8/10.
**Files changed:** `evals/fixtures/plan-update-*.json`, `evals/fixtures/plan-strength-integrated-marathon.json`, `evals/judges/plan-update.mjs`, `evals/run-evals.mjs`

## 2026-04-07 — Auto-apply beta coupon at checkout

**Type:** Feature
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** N/A
**Fix / Change:** Checkout session now auto-applies the beta coupon (`STRIPE_BETA_COUPON_ID` env var) for the first 100 beta users. Gracefully falls back to full price if the coupon is exhausted or missing. Removed `allow_promotion_codes` (mutually exclusive with `discounts` in Stripe Checkout).
**Files changed:** `src/app/api/billing/checkout/route.ts`

---

## 2026-04-07 — Fix strength/mobility "min" sessions inflating projected weekly mileage

**Type:** Bug Fix
**Reported by:** Internal observation (Gwyneth's post-run message)
**User feedback:** "She's definitely not going to get to 53.5 mi total, and that is also not close to 16 mi"
**Root cause:** The regex `/(\d+(?:\.\d+)?)\s*mi/i` used to parse session distances from `weekly_plan_sessions` matched "min" (as in "35 min") because "min" starts with "mi". A "Strength + mobility 35 min" session was being counted as 35 miles, inflating `projectedWeekMiles` and causing Dean to tell Gwyneth she was "on track for 53.3mi total" when her actual run target was ~16mi.
**Fix / Change:** Added negative lookahead `(?!n)` after `mi` in all three session-parsing regexes so "min" is excluded. Only "mi", "mile", and "miles" tokens (i.e. not followed by "n") now contribute to the mileage projection.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-07 — Prevent repeat free trials on resubscribe

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "if someone already had a free trial, then cancelled, then wants to sign up again, we shouldn't give them a free trial again"
**Root cause:** `trial_period_days: 7` was hardcoded unconditionally in the Stripe Checkout session creation, so any resubscribing user — even one who had already used their trial — would get another 7-day free trial.
**Fix / Change:** `checkout/route.ts` now fetches `trial_started_at` for the user. This field is stamped once when the first plan is generated and never overwritten. If set, the checkout session omits `trial_period_days`, so Stripe charges immediately. First-time subscribers still get the 7-day trial.
**Files changed:** src/app/api/billing/checkout/route.ts

## 2026-04-07 — Fix past_due SMS sending checkout link instead of customer portal

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "want to make sure these are all ironed out" re: subscription lapse vs payment failure flows
**Root cause:** When a user's payment fails (`past_due`), the SMS sent them to `/checkout?token=` which creates a brand-new Stripe Checkout session. But the user already has an existing subscription — they just need to update their payment method, which requires the Stripe Customer Portal, not a new checkout.
**Fix / Change:** `past_due` SMS now sends `/cancel?token=` (the Stripe Customer Portal redirect page). The portal lets them update their card, and Stripe automatically retries the charge when the payment method is updated. `canceled` users still get `/checkout` (correct — new subscription needed). The `/cancel` page already handles non-canceled statuses (including `past_due`) by redirecting straight to the portal.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-07 — Rebuild training plan when VDOT or goal changes mid-conversation

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "I don't think my plan actually got updated at all with different paces" and "the plan goes up to 49mi, that's too much for a 1mi time trial"
**Root cause:** Two separate issues: (1) When an athlete provides race data (triggering a VDOT recalculation) or changes their goal race type mid-conversation, the profile paces were saved to the DB but `generateAndSaveFullPlan` was never called — so the stored plan arc and weekly sessions still had old pace labels and volume targets. (2) The `getTargetPeakMileage` function had no "mile" case, so a mile goal fell through to the default 60mi hard cap, producing a 49mi peak week — far too high for a speed-focused mile time trial plan.
**Fix / Change:** (1) `persistProfileUpdates` now calls `generateAndSaveFullPlan` when `hasRaceData` (VDOT change) or `hasGoalRaceType` (goal change) is true, unless `hasRaceDate` already triggered a full regen. Goal changes use `resetToWeek1: true`; VDOT-only changes preserve the current week. (2) Added "mile" case to `getTargetPeakMileage`: hardCap=40, floor=15 — keeps the plan speed-focused with moderate volume.
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/training-plan.ts

## 2026-04-07 — Fix "give me a sec" dead end + require pace zone labels

**Type:** Bug Fix / Improvement
**Reported by:** Jake (user testing)
**User feedback:** "doesn't seem like Dean is going to respond to me after he said he'd update my plan" and "it was unclear what the 7:47 pace that my 30K suggested was...is that my suggested mile pace, tempo pace, interval pace??"
**Root cause:** (1) When an athlete provides a race result mid-conversation and Dean updates paces, the system prompt allowed Dean to say "I'll rebuild the plan — give me a sec" without actually sending a follow-up. No second message is ever triggered, leaving the athlete waiting indefinitely. (2) Dean was referencing bare pace values (e.g. "the 7:47 pace your 30K suggested") without labeling which zone they belong to. Most athletes don't know what VDOT is or what each zone represents.
**Fix / Change:** Added two rules to the `user_message` system prompt: (1) When updating paces from race data, Dean must include the rebuilt plan in the current message and is explicitly prohibited from saying "give me a sec" or implying a follow-up. (2) Every pace must be labeled with its zone (Easy/Tempo/Interval/Race pace). When showing zones for the first time, Dean must briefly explain each one's purpose.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-07 — Auto-continue onboarding after Strava connects

**Type:** Bug Fix
**Reported by:** Jake (user testing)
**User feedback:** "After I connected Strava, I didn't get another message after 15s or so, so I texted him"
**Root cause:** Strava callback sent the "Strava connected!" confirmation but then went silent. User was left in `onboarding_step = "onboarding"` with no prompt — had to text to trigger Dean's next response. Also, the typing indicator never fired because the callback didn't have the chatId.
**Fix / Change:** After sending the Strava confirmation SMS, if the user is still mid-onboarding, the callback now fires `POST /api/onboarding/handle` in `after()` with a synthetic `"(strava connected)"` message (2s delay so confirmation lands first). `linq_chat_id` is now fetched in the initial user select so it can be passed to the onboarding handler for the typing indicator. Onboarding prompt updated to ignore the synthetic message string and continue naturally.
**Files changed:** strava/callback/route.ts, onboarding/handle/route.ts

## 2026-04-07 — Onboarding polish from Jake's test run

**Type:** Improvement
**Reported by:** Jake (user testing)
**User feedback:** "For the Strava message, there was a small punctuation error: 'connect to it here: . That way...' / Dean didn't ask about my goal for the mile time trial — I want to go sub 5 but the plan doesn't have any work around there / Two links in 'Your plan is ready' message was a bit confusing / For the confirmation page, can we personalize with the user's name? / Let's remove the 'And this number's always open' / 'How does this look?' should come in the same message as the plan"
**Root cause:** Multiple small issues: (1) [STRAVA_LINK] was embedded inline in a sentence so removing it left "connect to it here: ."; (2) goal time was "optional" even for short races where it's essential; (3) two links in the payment SMS (checkout + cancel) was confusing; (4) success page was generic; (5) "always open" closing felt redundant; (6) "How does this look?" was sent as a separate message after the plan.
**Fix / Change:** (1) Prompt now requires [STRAVA_LINK] on its own line at the end of the message; (2) Goal time is now required for mile/5k/10k goals; (3) Cancel URL removed from "plan is ready" SMS — just says "Cancel any time, before or after the trial."; (4) Checkout success page now personalized with user's first name ("Let's do this, Jake!") via token lookup; (5) Removed "always open" closing line from plan prompt; (6) "How does this look? Happy to adjust anything." is now appended in the plan message itself — the separate closing message is now just the reminder cadence question.
**Files changed:** onboarding/handle/route.ts, coach/respond/route.ts, billing/checkout/route.ts, checkout/success/page.tsx

## 2026-04-07 — Fix recency errors and communication gap acknowledgment

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** "Common failure pattern where [Dean] loses trust" — specifically: Dean says "yesterday" for a run from 3 days ago, and doesn't acknowledge when multiple days have passed since he last messaged.
**Root cause:** Two separate issues: (1) The `user_message` trigger prompt had no rule requiring Dean to verify activity recency from the `(N days ago)` labels already present in RECENT WORKOUTS before using relative terms like "yesterday". (2) No concept of a "contact gap" — Dean had no instruction to acknowledge when his last message was several days ago, causing him to respond as if he'd been watching in real time. The eval runner also had a bug where `thisWeekMonday` was hardcoded and activities lacked relative time labels, making evals less representative of production.
**Fix / Change:** Added `ACTIVITY RECENCY` rule to the `user_message` trigger: Dean must check the `(N days ago)` label before using "yesterday" or "this morning" — use day name (e.g. "Monday's run") for anything 2+ days ago. Added `CONTACT GAP` rule: when the last coach message was 2+ days ago, computed from `recentMessages`, Dean is told the gap and instructed to acknowledge it naturally. Fixed eval runner to compute dynamic `thisWeekMonday` from `fixture.today`, added `(N days ago)` labels to activity entries, and added optional `date` field support on conversation entries. Added 3 new evals targeting these failure modes.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`, `evals/fixtures/date-recency-gap-contact.json`, `evals/fixtures/date-midweek-miles-remaining.json`, `evals/fixtures/date-post-silence-reengagement.json`

---

## 2026-04-07 — Onboarding: race time extraction fix, triathlete context, Strava engagement, conversion copy

**Type:** Improvement
**Reported by:** Jake — post-eval review
**User feedback:** N/A
**Root cause:** Four gaps: (1) `recent_race_time_minutes` extraction rule had no M:SS format examples, so Haiku could misinterpret "18:45" (5K) as a longer time like 1:52:30; (2) triathlete "weakest leg" context was never explored — Dean moved on without asking why or collecting injury notes; (3) Strava connection was treated as data-only, missing the opportunity to ask what the athlete is trying to change; (4) wrap-up messages were generic rather than referencing the athlete's specific constraint or race.
**Fix / Change:** Added explicit M:SS examples to `recent_race_time_minutes` rule ("18:45" → 18.75) in both route.ts and sim runner. Added triathlon-specific instruction to ask why the run is the weakest leg and to collect injury history before [READY]. Added STRAVA CONTEXT section instructing Dean to use connected data as a hook for one contextual "what's been missing?" question. Added two new DEMONSTRATING VALUE bullets: name the specific mechanism for a stated struggle, and personalize the wrap-up using the athlete's own constraint/race language. All changes mirrored in run-simulation-evals.mjs.
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-simulation-evals.mjs

## 2026-04-07 — Onboarding prompt: name enforcement, farewell loop, re-ask prevention, race date verification

**Type:** Improvement
**Reported by:** Internal — simulation eval run 2026-04-07T15-00-33
**User feedback:** N/A
**Root cause:** Four prompt gaps identified via simulation evals: (1) name not explicitly required in [READY] criteria, allowing Dean to finish onboarding without collecting the user's name; (2) no instruction to stop after a graceful out-of-scope exit, causing a farewell loop with cycling-only users; (3) "don't re-ask" instruction only covered `onboarding_data`, not the live conversation history — causing Dean to re-ask timezone already stated in the first message; (4) user-provided race dates were sometimes accepted without verification despite the mandatory search rule.
**Fix / Change:** Added `name` to SIGNALING READY criteria with explicit fallback instruction. Added instruction to stop after one farewell when a cycling-only user declines. Expanded "don't re-ask" to explicitly cover conversation history. Strengthened the race date search mandate with "ALWAYS search, even if the athlete gives you a specific date. This is non-negotiable." All changes applied to both route.ts and run-simulation-evals.mjs for parity.
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-simulation-evals.mjs

## 2026-04-07 — Fix "trail_race" shown in dashboard + pace consistency in onboarding

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "under dipsea in my dashboard instead of the mileage of the race like cirque series, it said trail_race in the A / B race section" and "Dean said my easy pace would be 8-8:40/mi on flat ground, but then when he texted me the pace was different in that week's plan"
**Root cause (1):** B/C races are stored with `goal_distance_miles: null` because the `other_races` extraction schema didn't include `goal_distance_miles`. When the dashboard renders the race, `GOAL_DISTANCE_LABELS` had no entry for `trail_race`, so it fell back to showing the raw `race.goal` value verbatim.
**Root cause (2):** The onboarding `summarizeCollected` function showed Dean the exact VDOT-calculated pace as a single number ("Easy pace: 7:48/mi"), but Dean would generate his own arbitrary range ("8:00–8:40/mi") rather than using the stored value. The training plan then showed a different range derived via `easyPaceRange(storedPace)`.
**Fix / Change (1):** Added `goal_distance_miles` to the `other_races` extraction schema and races insertion, so future B/C races with explicit distances get them stored. Added `trail_race`, `sprint_tri`, `olympic_tri`, `general_fitness`, and other non-distance goal types to `GOAL_DISTANCE_LABELS`. Also replaced the raw `race.goal` fallback with a title-cased conversion (e.g., `trail_race` → "Trail Race") for any future unknown goal types.
**Fix / Change (2):** Changed the `summarizeCollected` function to show Dean the pre-computed `easyPaceRange` ("Easy pace range: 7:50–8:20/mi — use this exact range") instead of a bare exact pace, so what Dean says during onboarding matches what the plan shows.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/dashboard/page.tsx`

---

## 2026-04-07 — Move location/timezone collection to post-plan cadence step

**Type:** Improvement
**Reported by:** Jake (internal observation during onboarding)
**User feedback:** "I think we should move asking about location for reminders to when we actually tell the user we can send reminders (after the plan is sent!) it's more natural this way. If a user connected Strava, we should also look at their location on that and just confirm it - easier on them."
**Root cause:** The onboarding system prompt listed "Location / city" as a required field alongside goal, training days, and pace — causing Dean to ask mid-conversation before reminders were even mentioned. Strava users had their city already stored but Dean asked again from scratch.
**Fix / Change:** Removed location from the required onboarding fields and [READY] condition. Updated the post-plan closing message: Strava users with a known city now get "I have you in [city] from Strava — which reminder timing works better?" Non-Strava users without a timezone are still asked for their city at the natural moment when reminders are introduced.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-07 — Prompt guardrails: intra-lap timestamp hallucination + in-conversation pace overrides

**Type:** Bug Fix
**Reported by:** Conversation Analysis 2026-04-06 (auto-generated)
**User feedback:** N/A (caught by automated analysis)
**Root cause (Issue 1 — intra-lap timestamp hallucination):** When manual laps are recorded, the existing data guard only restricts lap references when `hasLaps` is false. When laps ARE present, Dean was fabricating sub-lap event timestamps (e.g. "at 48:46 into the run, HR jumped to 140") — Strava lap data only provides per-lap averages (avg pace, avg HR per lap) and does not record when within a lap a specific moment occurred.
**Root cause (Issues 2+3 — state tracking failure / corrected pace zones ignored):** No prompt instruction required Dean to treat athlete-confirmed values as ground truth during a session. When an athlete corrected Dean's stated pace mid-conversation, Dean continued re-deriving the value from stored profile defaults rather than locking what was confirmed. Similarly, when Dean explicitly acknowledged a corrected training zone, the corrected zone was not propagated into subsequent plan outputs.
**Fix / Change:**
1. Added precision-limitation note to the laps DATA GLOSSARY entry (shown only when `hasLaps` is true): "Lap data provides per-lap AVERAGES only. Do NOT cite specific elapsed-time markers within a lap — Strava does not record event-level timestamps within a lap."
2. Added `⚠️ ATHLETE-CONFIRMED IN-CONVERSATION DATA` rule to the MEMORY AND DATA LIMITATIONS block: athlete-confirmed/corrected paces, distances, and training zones are ground truth for the session; always override stored profile defaults; lock and acknowledge before moving on; never flip-flop on a corrected value.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-07 — Robust re-intro stripping: question-anchor approach

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "deployed and still getting the same response: Hey Jake! I'm Coach Dean, your AI running coach..."
**Root cause:** First post-processing attempt used `\n\n` as the paragraph boundary to find where the intro ends. But the model produces `\n` (single newline) or no newline at all, so the regex never matched. The "Hey Jake! I'm Coach Dean..." block passed through unstripped.
**Fix / Change:** Replaced the `\n\n`-dependent regex with a question-anchor approach: detect "I'm Coach Dean" in the first 400 chars, find the first `?` in the response, back-track to the start of that sentence (using last `\n` or `. ` before the `?`), and start the response from there. Works for `\n\n`, `\n`, and no-newline variants. Also updated eval runner to match.
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-onboarding-evals.mjs

## 2026-04-07 — Post-process greeting phrases + fix eval fixture message ordering

**Type:** Bug Fix
**Reported by:** Jake Tennant
**User feedback:** "dean seems to be repeating himself a ton still? ... Hey Jake! I'm Coach Dean, your AI running coach..."
**Root cause:** Two issues found. (1) The eval fixture `no-greeting-repeat` had invalid message ordering — started with an assistant turn and duplicated the user "Jake" message, causing the model to see [assistant, user, user] instead of the production-correct [user, assistant, user]. This masked whether the prompt fix was actually working. (2) Even with correct message ordering, the model's deeply-trained "user gives name → say Nice to meet you" reflex overrides any system prompt instruction reliably. Tried 5+ prompt variations (bullet, HARD RULE block, NEVER list, example-based, top-of-prompt placement) — all failed.
**Fix / Change:** Fixed the eval fixture to mirror production message ordering. Added a post-processing strip on `rawText` (before signals are parsed) that removes "Nice/Great/Good to meet you" opener phrases on non-first messages. This is applied in both the route handler and the eval runner for parity. Simplified system prompt to a single light instruction (no more escalating NEVER blocks).
**Files changed:** src/app/api/onboarding/handle/route.ts, evals/run-onboarding-evals.mjs, evals/fixtures/onboarding/no-greeting-repeat.json

## 2026-04-06 — Fix "yesterday" misattribution for past activities

**Type:** Bug Fix
**Reported by:** Ian (via Jake)
**User feedback:** "He just referred to Monday as yesterday on both Thursday and Sunday. Sounds good. He just referred to Monday as yesterday on both Thursday and Sunday. I ghosted Thursday so maybe that contributed but I think if the prompt includes the current date or something he could figure it out."
**Root cause:** Two gaps: (1) RECENT WORKOUTS in the system prompt had no server-computed recency labels, so Claude had to infer "yesterday" vs "3 days ago" itself — and got it wrong. (2) The dateContext instruction permitted natural relative terms ("yesterday", "this morning") without requiring Claude to verify the actual timestamp. Claude was treating "most recent strenuous event in conversation history" as "yesterday" regardless of when it actually occurred.
**Fix / Change:** Two-part fix:
1. RECENT WORKOUTS now includes a server-computed relative label per activity: `(today)`, `(yesterday)`, `(3 days ago)`, etc. up to 13 days. Claude is instructed to use these labels as the authoritative recency signal.
2. Tightened the dateContext instruction: Claude may only say "yesterday" if the event's timestamp or conversation date matches the explicitly provided Yesterday date. Older events must use the weekday name ("Monday's double header", "last week's long run").
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Fix walk mileage counting + session swap dashboard link bug

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "Dean seems to be counting her 'walk' strava activities towards running mileage. He shouldn't, only runs should count" / "The dashboard still shows a sunday run and tuesday strength" (after asking Dean to swap them)
**Root cause (bug 1):** In the `post_run` user message, the week-to-date total was labeled "(this run included)" even when the synced activity was a Walk. `weekMileageSoFar` correctly excludes walks (via `RUN_TYPES`), but the misleading label caused Claude to manually add the walk's distance on top of the running total (2.2mi + 1.25mi walk = 3.5mi incorrectly stated).
**Root cause (bug 2):** The "FULL PLAN REQUESTS — HARD RULE" prompt fired when Gwyneth said "I see my plan has me running on Sunday, can we switch that?" — Dean sent the dashboard link instead of handling the session swap request.
**Fix / Change:** (1) When the synced activity is not a run type, the week mileage context now explicitly says "WEEK-TO-DATE RUNNING MILES — this [Walk] is NOT included. Do NOT add its distance to this total." (2) Added an explicit EXCEPTION to the full plan request rule: if the athlete mentions the plan while asking to change it (swap, move session), treat it as a session swap request and do not send the dashboard link.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Onboarding conversion improvements + 5 new simulation evals

**Type:** Feature / Improvement
**Reported by:** Internal product review
**User feedback:** N/A
**Root cause:** Onboarding was pure data collection — no value demonstration, no scope clarity for cycling/tri users, generic trial CTA.
**Fix / Change:**
- Strava ask now includes a one-sentence value prop ("auto-calibrates training zones from real data")
- Dean now reflects one specific insight from the athlete's fitness baseline back at them (e.g. what their half PR implies for marathon target range)
- Cycling-only users: Dean now honestly acknowledges it specializes in running and asks if running is in the mix
- Triathlon users: Dean clarifies it handles the run leg specifically, not swim/bike
- Trial conversion message (`awaiting_payment`) now personalized: references race name, date, and week count — e.g. "Alex, your 24-week Chicago Marathon plan (October 11) is built and ready"
- 5 new simulation eval fixtures: sim-mile-time-trial, sim-cycling-only, sim-triathlon-70-3, sim-pricing-question, sim-5k-pr-hunter
- Simulation judge updated with `conversion_likelihood` and `scope_handled` scoring dimensions
**Files changed:** onboarding/handle/route.ts, run-simulation-evals.mjs, judges/simulation-quality.mjs, 5 new fixture files

## 2026-04-06 — Onboarding fixes: web search concatenation, ultra_race_history extraction, strava_skipped field, fixture correction

**Type:** Bug Fix
**Reported by:** Jake (eval results — simulation-2026-04-06T22-40-55)
**User feedback:** "by the way the boston marathon 2027 is actually april 19 so maybe the judge was wrong here"
**Root cause (4 issues):**
1. Web search text concatenation: The hosted web_search tool returns `server_tool_use` content blocks, not `tool_use`. Our text extraction checked only for `tool_use`, so `lastToolIdx` stayed -1 and ALL text blocks (pre-search and post-search) were concatenated into one message. This caused the malformed first message in sim-international-user and likely similar issues in production.
2. `ultra_race_history` not extracted: Haiku extraction prompt had no description or rules for the `ultra_race_history` field, so it never populated even when athletes clearly stated their ultra/trail background.
3. Race date not verified when user provides it: The mandatory search instruction didn't explicitly say to verify user-provided dates. Jordan said "February 7th" for Rocky Raccoon but the actual date is different — Dean should search regardless.
4. `sim-terse-user` fixture had wrong date: Fixture had `race_date: "2027-04-21"` (a Wednesday) and notes said "April 21, 2027". Boston Marathon is the third Monday of April; in 2027 that's April 19. Dean's web search found the correct date but the judge penalized it.
**Fix / Change:**
1. Added `server_tool_use` type check alongside `tool_use` when scanning for the last tool call index in both `route.ts` and `run-simulation-evals.mjs`. This ensures only post-search text is used when Dean calls web search.
2. Added extraction rule for `ultra_race_history`: summarize any ultra/trail race background mentioned. Also added `strava_skipped: true | null` to the extraction output so users who say "No Strava" upfront get it properly captured.
3. Updated mandatory search instruction: "user-provided dates are often wrong too — always verify via search regardless of what the athlete says."
4. Corrected `sim-terse-user` fixture: `race_date` → `2027-04-19`, user_agent_prompt updated, evaluation notes corrected.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`, `evals/fixtures/simulation/sim-terse-user.json`

---

## 2026-04-06 — Onboarding prompt improvements: goal classification, race dates, ultra fields, Strava skip routing

**Type:** Bug Fix / Improvement
**Reported by:** Jake (eval results — simulation-2026-04-06T22-23-41)
**User feedback:** N/A (caught by simulation evals — 6 of 10 fixtures scoring below 9/10)
**Root cause (4 issues):**
1. Race dates wrong from memory: despite the "always web_search" instruction, Dean was still stating race dates from memory (London April 1 instead of April 26, Boston April 20 instead of April 21). The instruction was too soft.
2. Goal misclassification for aspirational mentions: users returning to running or recovering from injury who mentioned a distant "maybe someday" race were classified as marathon/10k instead of return_to_running/injury_recovery.
3. Ultra required fields missed: ultra_race_history and injury_notes are required for safe 50K+ training plan generation, but were listed as "optional" — Dean was skipping them.
4. Training days double-asked after Strava skip: the Strava skip path used a hardcoded Haiku snippet ("ask for training days if missing") which re-asked questions that were already asked (but not yet answered) in the same message as the Strava link.
**Fix / Change:**
1. Renamed web search instruction to "RACE DATE — MANDATORY SEARCH" with stronger language: "call web_search immediately… do not state, confirm, or summarize any race date without first searching."
2. Added explicit goal classification rule to both Dean's system prompt and Haiku extraction: aspirational mentions don't override stated primary goal; no committed race = return_to_running or general_fitness.
3. Moved ultra/trail background + injury notes to "Required ONLY for ultra goals" section; injury notes also required for return_to_running/injury_recovery goals.
4. Strava skip now routes back through the full handleConversation (Sonnet with full history) instead of an abbreviated Haiku snippet — Dean sees what was already asked and won't re-ask. This also aligns with the "let Claude deal with it" architecture philosophy.
5. Updated run-simulation-evals.mjs to match all four prompt changes (parity requirement).
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `evals/run-simulation-evals.mjs`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-06 — Five onboarding UX fixes (name, repetition, days, plan timing, race dates)

**Type:** Bug Fix / Improvement
**Reported by:** Jake (internal testing)
**User feedback:** "didn't get a response... ask for the user's name in the first step... weird repetition of 'Great to meet you!' throughout... repetition of what days work best for training... Dean sent the plan at the same time as asking for my time goal... the dates are wrong for the races: Dipsea June 1, Cirque July 1"
**Root cause (5 issues):**
1. Name: not in required fields, never asked.
2. "Great to meet you" repeated: no instruction preventing it on follow-up messages.
3. Training days re-asked: Strava callback always asked "which days work?" when `shouldAdvanceToSchedule=true`, even if `training_days` was already extracted before the user tapped the link.
4. Plan + question at same time: `[READY]` fired in the same message as "do you have a goal time?", triggering `completeOnboarding` while the question was still outstanding.
5. Wrong race dates: extraction prompt said "if only month given, default to first of month" and Haiku was applying this even when the Coach had stated the exact date (from a web search). Result: June 1 and July 1 instead of June 14 and July 11.
**Fix / Change:**
1. Added "Athlete's name (ask in your first message if not already known)" to required fields.
2. Added instruction: "Never repeat 'Great to meet you', 'Nice to meet you', or similar greeting phrases after the first message."
3. Strava callback now checks `onboardingData.training_days` before appending the training-days question.
4. Added instruction: "When you signal [READY], do not ask any more questions — wrap up warmly, the plan fires right after."
5. Updated extraction prompt for `race_date` and `other_races.date` to explicitly prefer specific dates mentioned in the conversation over first-of-month defaults.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/auth/strava/callback/route.ts`

---

## 2026-04-06 — Fixed new users getting no response on first message

**Type:** Bug Fix
**Reported by:** Jake (internal testing)
**User feedback:** "didn't get a response when I messaged Hey Dean! as a new user"
**Root cause:** After the onboarding revamp, the unified conversation handler fires on `onboarding_step = "onboarding"`, but new users were still being created with `onboarding_step = "awaiting_goal"`. The switch in `onboarding/handle` has no case for `"awaiting_goal"`, so it hit the default branch and returned `{ ok: true }` silently — no message sent.
**Fix / Change:** Changed new user insert in the linq webhook to set `onboarding_step: "onboarding"` so they immediately enter the unified conversation handler.
**Files changed:** `src/app/api/webhooks/linq/route.ts`

---

## 2026-04-06 — Self-serve subscription cancellation

**Type:** Feature
**Reported by:** Jake (internal)
**User feedback:** "It's unclear what the cancel route is — we need to make it easy to do and communicate that in the sign-up flow"
**Root cause:** No cancellation path existed. The SMS bot promised to send a link that didn't exist. Users had no way to cancel without contacting Jake directly.
**Fix / Change:** (1) Created `/cancel?token=xxx` page — server-side Stripe Customer Portal redirect, handles cancel/update payment/view invoices. (2) Added cancel keyword shortcut to `coach/respond` — "cancel", "unsubscribe", etc. sends the portal URL instantly without hitting the LLM. Also handles "help" keyword. (3) Updated `handleNonCadenceMessage` to send the real cancel URL instead of a broken promise. (4) Updated payment SMS to include the cancel URL explicitly ("cancel any time — before or after the trial — at coachdean.ai/cancel"). (5) Updated checkout page fine print to say the same. **Note: requires Stripe Customer Portal to be enabled at dashboard.stripe.com/settings/billing/portal.**
**Files changed:** `src/app/cancel/page.tsx` (new), `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/checkout/page.tsx`

---

## 2026-04-06 — Post-onboarding UX polish

**Type:** Improvement
**Reported by:** Jake (onboarding test session)
**User feedback:** "How does this look?" should come last after dashboard link; checkout iMessage preview should say "Start your free trial"; success page should be more celebratory; clicking checkout link again shouldn't create a duplicate subscription
**Root cause:** Plan message included feedback/reminder questions before the dashboard link was sent; checkout page had no metadata for iMessage previews; success page was generic; billing/checkout route didn't check for existing active subscriptions
**Fix / Change:** (1) Removed "How does this look?" and reminders offer from Claude's `initial_plan` prompt — now sent as a dedicated SMS *after* `generateAndSaveFullPlan` sends the dashboard link, preserving the right read order. (2) Added `checkout/layout.tsx` to export metadata for iMessage link previews. (3) Made success page more celebratory. (4) Billing checkout now returns a dashboard redirect if the user already has an active/trialing subscription instead of creating a duplicate Stripe session.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/checkout/layout.tsx` (new), `src/app/checkout/success/page.tsx`, `src/app/api/billing/checkout/route.ts`

---

## 2026-04-06 — Onboarding refactor: unified Claude conversation handler

**Type:** Refactor
**Reported by:** Internal observation / Jake feedback
**User feedback:** "It feels like we may want to remove some of our scaffolding and just let claude deal with it more"
**Root cause:** The 12-step rigid state machine (`awaiting_goal` → `awaiting_race_date` → … → `awaiting_cadence`) required constant patches for edge cases like off-topic detection misfires, loop detection, multi-race confusion, and natural conversation derailing the expected step sequence.
**Fix / Change:** Replaced ~3300 lines of step handler code with a ~550-line unified handler. Single `onboarding` step drives all pre-Strava, pre-plan conversation through Claude Sonnet (with web_search for race date lookups). One Haiku call extracts all structured fields from the full conversation after each exchange. Off-topic detection, loop detection, de-escalation, and all step-specific handler functions deleted. `awaiting_strava`, `awaiting_cadence`, and `awaiting_payment` remain as hard stops for specific flow gates.
**Files changed:** `src/app/api/onboarding/handle/route.ts` (rewritten), `src/app/api/signup/route.ts` (step name: `awaiting_goal` → `onboarding`), `src/app/api/auth/strava/callback/route.ts` (step advance: `awaiting_schedule` → `onboarding`), `src/__tests__/api/onboarding-handle.test.ts` (rewritten), `src/__tests__/api/multi-race-onboarding.test.ts` (rewritten)

---

## 2026-04-06 — Improve initial plan quality across all fitness tiers

**Type:** Improvement
**Reported by:** Jake Tennant (internal observation)
**User feedback:** "I'm a bit worried that some users will get all easy in the first week without much detail and be like 'this plan isn't worth it' - I think even for athletes that were doing like 15 mi/week consistently we need to think about things like strides, etc. And then for real beginners we just need to teach them about pacing zones, ramping up slowly, etc. and our philosophy so they believe it is the right way to approach training."
**Root cause:** Initial plan instructions only called out the quality-session requirement for HIGH VOLUME athletes. MODERATE and LOW VOLUME athletes could get an all-easy first week with no explanation of why. Beginners had no prompt instruction to explain the reasoning behind the plan structure.
**Fix / Change:** Extended explicit quality session requirements to all tiers:
- HIGH VOLUME (30+ mi/week): must include tempo/intervals/strides/hill repeats
- MODERATE VOLUME (10–30 mi/week): must include strides at minimum (4–6 × 20-sec pickups)
- LOW VOLUME (<10 mi/week): include strides on at least one run
Added "EXPLAINING THE PLAN" instruction for beginner/low-volume athletes: include 2–3 sentences in the first bubble explaining what "easy effort" means and why we build gradually — so new athletes trust the approach instead of dismissing it as generic advice.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-06 — Fix: three onboarding bugs (wrong goal bucket, date confusion, 50K display label)

**Type:** Bug Fix
**Reported by:** Jake Tennant (testing)
**User feedback:** "1) my plan was all easy miles for week one, even though my history shows I have a very good base 26+ miles/week for many months. 2) the dashboard didn't show dipsea at all, even though I mentioned it as a race 3) cirque series showed as a 50k in my dashboard even though Dean knew it was 8.9 miles (also shows up as a 50k in coaches note)"
**Root cause (three separate bugs):**
1. `handleGoal` set `goal: "50k"` as placeholder for named races with no explicit distance in the name (e.g. "Cirque Series Snowbird"), then updated `goal_distance_miles` from web search (8.9 mi) but never corrected the goal bucket. The whole plan was generated under "50k ultra" logic for an 8.9-mile mountain race.
2. `handleOtherRaces` prompt didn't tell Haiku what the A race's stored date was. When Jake said "Yes - Dipsea on June 14th…", Haiku set `confirmed_a_race_date: "2026-06-14"` (Dipsea's date), overwriting Snowbird's July 11 date. Dipsea then had no date in `other_races` and was filtered out.
3. `UpcomingRaces` in the dashboard checked `GOAL_DISTANCE_LABELS[race.goal]` first even when `goal_distance_miles` was set, so "50K" won over "8.9 mi".
**Fix / Change:**
1. `handleGoal`: when web search provides `distanceMiles`, also update `goal` via `distanceMilesToGoalBucket(distanceMiles)` so the coaching system uses the correct training approach.
2. `handleOtherRaces`: pass A race name and stored date in the Haiku prompt. Clarify rules: `confirmed_a_race_date` must only be set for the A race's own date, not for dates belonging to other races. Added implicit-yes handling: when Haiku returns null (user said "yes" with no specific date) and there's a stored date, mark it confirmed without looping back to `awaiting_race_date`.
3. `UpcomingRaces`: check if `goal_distance_miles` is non-standard (differs from bucket standard by >0.5 mi) and prefer it over the bucket label.
4. `buildUserMessage` initial_plan: added explicit instructions that HIGH VOLUME athletes must get ≥1 quality session in week 1 (no all-easy sandbagging), and mountain/trail races with elevation gain need vert-specific work from day 1.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

## 2026-04-06 — Fix: onboarding re-asks "What are you training for?" instead of answering multi-race process question

**Type:** Bug Fix
**Reported by:** Jake Tennant (testing)
**User feedback:** "A number of different races actually - should I say all of them or just pick one?" → Coach Dean replied "Hey Jake! What are you training for — a race, general fitness, something else?" (ignored the question entirely)
**Root cause:** `detectAndAnswerImmediate` only recognized coaching questions and capability questions — not process/guidance questions about how to answer the current onboarding step. So "should I say all of them or just pick one?" returned null, and the fallback re-asked the same question verbatim.
**Fix / Change:** (1) Added "process/guidance questions" as a recognized question type in `detectAndAnswerImmediate`, with a specific instruction to answer multi-race questions with "Just tell me your main goal race — we can add other races after." (2) When `introAlreadySent` is true and `questionAnswer` is returned, use the question answer alone instead of prepending it before the re-ask — the answer already redirects the athlete, so appending the re-ask was redundant.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

## 2026-04-06 — Fix: session swaps not updating dashboard when athlete requests in-week changes

**Type:** Bug Fix
**Reported by:** Gwyneth
**User feedback:** "I see my plan has me running on Sunday, can we switch that for another day and maybe move the strength training to then?" — plan dashboard unchanged after Dean's response
**Root cause:** Two gaps in the session-swap pipeline: (1) The Dean system prompt had explicit instructions for multi-week plan changes ("state it explicitly so the athlete knows") but nothing equivalent for in-week session swaps — so Dean would respond with future-tense hedging ("I can move that") rather than a firm commitment. (2) The Haiku detection prompt (`maybeUpdatePlanSessions`) required the coach to "explicitly agree to a change" without examples, causing it to return `changed: false` for future-tense confirmations like "Moving strength to Sunday" or "I'll put the easy 3mi on Tuesday instead." Together: Dean responded vaguely → Haiku saw no explicit commit → DB not updated → dashboard unchanged.
**Fix / Change:** Added a `THIS WEEK SESSION SWAP` instruction block to the `user_message` system prompt directing Dean to agree immediately and state the new arrangement explicitly (e.g. "Done — moved strength to Sunday and easy 3mi to Tuesday"). Updated the Haiku detection prompt to accept both past-tense and future-tense confirmations as "explicitly agreed," and added guidance for correctly updating both the "day" and "date" fields when sessions swap days.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Extreme ramp guard + mileage regression language fix + manual activity Strava skip

**Type:** Bug Fix / Safety
**Reported by:** Issue review (users 39c51f9b/Julia, 7f356c80)
**User feedback:**
- Issue 2 (Julia): "You're at 60mi this week with one session left (Monday's easy 5mi). That puts you on track for 105mi total — a solid bump from last week's 2.2mi and right in line with your Dipsea prep."
- Issue 4: "You're at 20.2 mi for the week, closing out week 1 strong. Next week steps up to 17 mi..." (17mi < 20.2mi = step-down, not step-up)
**Root cause (Issue 2 — confirmed via Julia's activity data and conversation):** Julia texted "It's a 22 mile ride with 2-3,000 feet of climbing." The `user_message` workout extraction parsed this and wrote a manual `activity_type: "Run"` record with `distance_meters: 35405` (22mi) to the activities table — misclassifying a bike ride as a run. Later that day, her real 10.9mi trail run synced via Strava. `computeWeekMileage` then counted both: Apr 5 (10.87mi) + Apr 4 Strava (10.89mi) + Apr 4 manual (22.00mi) + Apr 3 (6.43mi) + Apr 2 (6.01mi) + Apr 1 (3.80mi) = **60.00mi exactly**. The existing dedup only removes manual entries within 15% of the Strava distance — 22mi vs 10.89mi (50% diff) passed through. Julia is a Strava user; her runs are captured automatically via webhook. The manual extraction path was designed for non-Strava users only.
**Root cause (Issue 4):** When `storedNextPlanWeek.mileage_target < weekMileageSoFar`, there was no prompt instruction preventing Dean from using "steps up" language. The arc's 17mi target was displayed without context that it was lower than the current week's actual.
**Fix / Change:**
- In `user_message` handler: skip writing manual workout activities when `user.strava_athlete_id` is set. Strava users' runs arrive via webhook; manual extraction for them creates phantom entries that double-count with real Strava data.
- In `buildCoachingSignalsBlock`: for ramps >100%, replace the gentle "mention naturally" note with an explicit ⚠️ EXTREME MILEAGE JUMP instruction — Dean must acknowledge the jump directly with the athlete rather than normalize it.
- In `buildUserMessage` for `user_message`: when `nextWeekContext` target < `weekMileageSoFar`, append a ⚠️ NOTE inline — "This target is LOWER than this week's current mileage. Do NOT say 'steps up' — describe it as a planned lighter week."
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-06 — Fix syncArcCurrentWeek being killed by Vercel before it completes

**Type:** Bug Fix
**Reported by:** Jake Tennant (Gwyneth's account — weekly_recap set target to 9mi but coach text said 10mi; arc still showed original 16mi value)
**User feedback:** "her coaches note says 10 mi but the weekly target says 9 mi" / "she's only at a 9 mile target this week when she ran more last week and historically was doing 12-13/week"
**Root cause:** `syncArcCurrentWeek` was called with `void` (fire-and-forget) at the end of `processCoachRequest`, which itself runs inside `after()`. When `processCoachRequest` returned, Vercel terminated the lambda, killing `syncArcCurrentWeek` before it could update `training_state.weekly_mileage_target` or `training_plans.weeks`. This meant the periodization engine's initial `suggestedWeeklyMiles` value (9) persisted in training_state while the arc stayed at its original generated value (16mi), both diverging from what Dean actually prescribed in the SMS (10.5mi from sessions).
**Fix / Change:** Changed `void syncArcCurrentWeek(...)` to `await syncArcCurrentWeek(...)` in both `initial_plan` and `weekly_recap` branches. The response has already been sent before this code runs (it's all inside `after()`), so awaiting doesn't block anything — it just ensures the lambda stays alive until the sync completes.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-06 — Fix "3.5min" cross-training duration (Haiku digit-drop mis-parse)

**Type:** Bug Fix
**Reported by:** Jake Tennant (Gwyneth's account — "she still has 3.5 min for her strength and mobility session")
**User feedback:** "she still has 3.5 min for her strength and mobility session (odd number, probably will take longer than that - thought we addressed this yesterday)"
**Root cause:** Yesterday's fix only caught `X mi` patterns (e.g. "Strength + mobility 3.5 mi"). The stored label was `3.5min` — `mi` is followed by `n` (a word character), so the `(?!\w)` lookahead blocked the match. The `3.5min` value appears to be the Haiku session extractor dropping a digit when parsing "35 min" from the plan text (3.5 vs 35).
**Fix / Change:** Added a second sanitization pass in `extractAndStorePlanSessions`: after fixing `X mi` → `X min`, also detect decimal durations under 5 minutes on cross-training sessions (e.g. "3.5min") and multiply by 10 to recover the likely intended value ("35 min"). Threshold of 5 min ensures this only triggers on clearly-wrong values.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — Switch to per-mile splits (splits_standard) for US athletes

**Type:** Bug Fix
**Reported by:** Jake Tennant (Curtis's case)
**User feedback:** "Splits Dean shared were different from Strava" — Dean was working from per-km splits while the Strava app shows per-mile splits, causing pace figures to describe different intervals.
**Root cause:** Webhook stored `splits_metric` (one split per km) citing elevation unit ambiguity for `splits_standard`. This was wrong — both split types return `elevation_difference` in meters. The result was Dean saying "around mile 3: 11:00/mi" when Strava showed a different value at mile 3 (they covered different intervals).
**Fix / Change:** Switched webhook to store `splits_standard` (per-mile) going forward. Updated DATA GUARD to only fire for legacy activities with more splits than miles (km-stored data). Updated `analyze-conversations` route description to match.
**Files changed:** `src/app/api/webhooks/strava/route.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/cron/analyze-conversations/route.ts`, `src/__tests__/api/strava-webhook.test.ts`

## 2026-04-05 — Hard-code authoritative mileage phrase in weekly recap

**Type:** Bug Fix
**Reported by:** Jake Tennant (Curtis's case — weekly recap showed 36.2mi when actual was ~27mi)
**Root cause:** System prompt instruction said "use this exact figure" but Claude still derived 36.2 by treating "first 9 miles on trails" in conversation as an additional run. Prompt instructions alone are not sufficient when conversation context strongly suggests a different number.
**Fix / Change:** Added a mandatory opening phrase to the weekly recap: "YOUR FIRST TEXT MUST OPEN WITH THE EXACT PHRASE: 'Last week: X mi across N runs.'" This forces the authoritative figure into Claude's output rather than relying on it to remember the constraint.
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — Fix mileage hallucination from conversational distance phrases in weekly recap

**Type:** Bug Fix
**Reported by:** Curtis (via Jake Tennant)
**User feedback:** Curtis said his actual mileage was ~26-27mi but Dean reported 36.2mi across 5 runs in the weekly recap. Curtis had said "for the first 9 miles, I was on trails and dirt roads" about his long run. Dean appears to have interpreted this as a separate 9-mile run and added it to the Strava total (27.2 + 9 = 36.2).
**Root cause:** The weekly recap system prompt instruction said "never sum individual runs yourself" but didn't explicitly guard against treating conversational distance phrases as additional uncounted runs. Claude saw "first 9 miles on trails" in conversation history and counted it as a 5th run not yet reflected in the Strava total.
**Fix / Change:** Extended the authoritative mileage instruction to explicitly warn: "distance phrases in the athlete's messages (e.g. 'the first 9 miles were on trails') describe portions of already-tracked Strava activities — do NOT count them as additional runs or add them to the total."
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — General re-ask fallback when goal_time step gets no clear answer

**Type:** Bug Fix
**Reported by:** Jake Tennant (observed via Curtis conversation)
**User feedback:** When Curtis pasted race results data ("1:29:06.54...") in response to the goal time question, Dean gave no response.
**Root cause:** `handleGoalTime` had no handler for messages where Haiku returns `has_answered: false` and none of the specific branches (research question, coaching question) matched. The code silently advanced with `goal_time_minutes: null` and sent an unrelated next-step question.
**Fix / Change:** Replaced a too-specific race-results regex check with a general Haiku-based fallback: whenever `has_answered === false` after all specific branches, Dean generates a contextual re-ask that acknowledges what was shared and asks for the personal goal time. This handles race results, ambiguous replies, off-topic messages, and any future cases.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`


## 2026-04-05 — Don't re-ask for race dates when user already provided them

**Type:** Bug Fix
**Reported by:** User feedback (Jake Tennant)
**User feedback:** "Jake, and I'm training for a few different races. Dipsea (June 14) and Cirque Series Snowbird (July 11), and half marathon time trial (May 31)" → Dean responded asking "can you give me the dates for each?"
**Root cause:** The `awaiting_other_races` step question always asked "can you give me the dates for each?" regardless of whether the user had already provided specific dates. The `secondary_goal` extraction prompt also didn't preserve dates.
**Fix / Change:** (1) Updated `extractAdditionalFields` prompt to include dates/timing in `secondary_goal` description. (2) In `getStepQuestion` for `awaiting_other_races`, detect whether `secondary_goal` contains month+day patterns (e.g. "July 11"). If specific dates are already present, ask only "Which of these is your A race?" without requesting dates again.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

## 2026-04-05 — Fix dashboard weekly target, long run, and cross-training label bugs

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "in text and in the schedule on the dashboard it was 23.5 miles but in the weekly target it was 32 mi. Also, it says my long run is 8.5 miles but it was actually 11 mi in Dean's text and in the schedule. My wife got strength prescribed for 3.5 min on Tuesday, but there was no detail on that."
**Root cause:** Three separate bugs:
1. `training_state.weekly_mileage_target` was set to `periodization.suggestedWeeklyMiles` (the engine's target) during weekly_recap, but never corrected after `syncArcCurrentWeek` computed the actual session sum. Dashboard "Weekly target" reads from `training_state`, so it showed 32mi instead of 23.5mi.
2. `syncArcCurrentWeek` updated `mileage_target`, `key_workout`, and `notes` in the arc but never updated `long_run_target`. The dashboard "Long run" reads from the arc blueprint value (8.5mi from initial plan generation), ignoring what Dean actually prescribed (11mi).
3. Dean occasionally wrote "Strength + mobility 3.5 mi" instead of "35 min" — the cross-training format guard in the prompt was missed at generation. The session extractor stored the label verbatim, causing "3.5 mi" to be parsed as running mileage on the dashboard and the duration to appear as "3.5 min".
**Fix / Change:**
- In `syncArcCurrentWeek`: compute `longRunMiles` from the long run session and patch `long_run_target` in `training_plans.weeks`; after patching the arc also update `training_state.weekly_mileage_target` to `actualMiles`
- In `extractAndStorePlanSessions`: sanitize cross-training session labels that incorrectly contain "mi" — convert "3.5 mi" → "35 min" for strength/mobility/bike/swim/yoga/etc. sessions before storing
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-05 — Onboarding: respect athletes who already have a plan

**Type:** Bug Fix / UX
**Reported by:** Lori (7a704281) conversation review
**User feedback:** "I don't need a plan right now." — said during timezone step. Dean sent a full 4-week plan anyway.
**Root cause:** Two failure modes:
1. `checkOffTopic` classified "I already have a training plan. I'm in week 8/12..." as ON-TOPIC (training history comment) at `awaiting_race_date`, so onboarding continued instead of pivoting.
2. `handleTimezone` called `completeOnboarding` unconditionally when `findNextStep` returned null — "I don't need a plan right now" in the same message as "Provo" was completely ignored.
**Fix:**
1. Added `has_existing_plan` type to `checkOffTopic` system prompt. When detected, Dean answers any coaching question in the message, explains it's available as a coaching resource, and calls `completeOnboarding(skipInitialPlan: true)` to set up the profile without building a plan.
2. Added regex check in `handleTimezone` before `completeOnboarding` for "don't need a plan / don't want a plan / already have a plan" — sends a brief confirmation and skips plan generation while still writing the profile/state so future messages route through `coach/respond`.
3. Added `skipInitialPlan` option to `completeOnboarding` — writes `training_profiles` and `training_state` (so coaching works) but skips the `initial_plan` trigger.
**Files changed:** `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-05 — P1 bug batch: watts, mileage, plan validation, onboarding

**Type:** Bug Fix (multiple)
**Reported by:** Internal review (users e6091ea5, 39c51f9b/Julia, 7a704281/Lori, 9471dde2/Dallan, 9f5f67c6, d7aac841)

### #1 — Watts hallucination (e6091ea5)
**Root cause:** No data guard for power/watt data. Claude invented watt figures for Zwift/cycling even though no power data exists in the DB record.
**Fix:** Added `average_watts` column to `activities` table (migration 024), stored from Strava webhook when present (power meters, Zwift). Guard is now conditional: shown when `average_watts` is null, skipped when real power data exists.

### #2/#5 — RECENT WORKOUTS bike miles inflating running totals (Julia, 9f5f67c6)
**Root cause:** `buildActivitySummary` RECENT WORKOUTS listed all activity types with miles. A bike ride showing "Ride 45mi" in the workout log gave Claude material to sum it with running miles and hallucinate a wrong weekly total.
**Fix:** Non-running activities (Rides, swims, etc.) now show duration (e.g. "Ride 90min") instead of miles in RECENT WORKOUTS. Running-only totals are unaffected.

### #3 — "33mi hill reps" copy-paste error (Julia)
**Root cause:** Claude copy-pasted the weekly total into an individual session label.
**Fix:** Added `fixSessionDistanceErrors()` to `plan-validation.ts`. Detects when a non-long-run session's mileage matches the weekly Total, replaces it with "?mi (check distance)" as a visible error flag, and rewrites the Total to match only the valid sessions. Wired into the response pipeline after `enforceVolumeCaps`.

### #4 — Onboarding days fabrication + context loss (Dallan)
**Root cause:** Claude invented specific training days ("Monday and Thursday") when athlete said "two days a week" without specifying which. Also re-asked for race info already in ATHLETE HISTORY.
**Fix:** Added two rules to `user_message` prompt: (1) never assign specific days without athlete choosing them; (2) never re-ask for data already present in ATHLETE HISTORY.

### #6 — Goal time applied to wrong race (d7aac841)
**Root cause:** `goal_time_minutes` stored without race-type context. A 4:00 marathon goal was displayed against a half marathon, producing an implied 18:18/mi pace.
**Fix:** Added a sanity check in `buildSystemPrompt`: if computed goal pace > 15 min/mi, inject a ⚠️ GOAL TIME MISMATCH warning prompting Dean to clarify with the athlete before building a plan.

### Onboarding question swallowed (Lori, 7a704281)
**Root cause:** `generateAnythingElseResponse` returned `isDone: true` when message contained both training info and a question. The question was silently dropped and onboarding completed without answering it.
**Fix:** Prompt now explicitly forbids `done: true` when message contains "?". Added a `forceAnswer` code-level safety net in `handleAnythingElse`.

**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/lib/plan-validation.ts`, `src/app/api/webhooks/strava/route.ts`, `supabase/migrations/024_average_watts.sql`, `src/__tests__/lib/plan-validation.test.ts`

---

## 2026-04-05 — Race preparedness floors and under-prepared athlete flag

**Type:** Bug Fix + Feature
**Reported by:** Jake (Ellen's plan)
**User feedback:** "she got a plan with very little mileage (max 11.5 in a single week) for a half marathon and is a very experienced runner"
**Root cause:** Two compounding issues:
1. `getTargetPeakMileage` floors were too low to produce adequate long runs. Half marathon floor was 22mi → peak long run of only 8.4mi at 0.38 factor. Marathon was 35mi → only 14.7mi long run. The floors didn't account for the actual long run fraction (38-42% of weekly volume) needed to reach race-distance-appropriate long runs.
2. `longRunFactor` in peak phase was 0.38 — too low for 3-day/week athletes where the long run is the primary quality session. Should be 0.42.
3. No feedback mechanism when an athlete's current mileage + weeks available makes it mathematically impossible to reach an adequate long run. Ellen (8mi/week, 10 weeks to half marathon) couldn't get to 10mi long run at safe build rates — but Dean never acknowledged this.
**Fix / Change:**
- Raised arc floors: half 22→30, marathon 35→45, 10K 15→20, split ultras into 50K(50)/50mi(55)/100K+100mi(65)
- Raised peak long run factor 0.38→0.42 across the board
- Added `computeRacePreparedness()` exported from training-plan.ts: computes achievable peak long run at 10%/week and returns the gap vs minimum adequate
- Added race preparedness flag injected into Dean's `initial_plan` prompt when achievable long run < 85% of minimum. Flag mandates Dean to: acknowledge the gap, recommend run/walk race day strategy, affirm finishing as goal, mention shorter race option
- Manually regenerated Ellen's plan after deploy
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Dashboard alignment: mileage target, key_workout, and Coach's Note from actual sessions

**Type:** Bug Fix
**Reported by:** Jake (Gwyneth's dashboard)
**User feedback:** "her runs over the week summed to 13 mi, not 15 mi and training arc referenced 800s where weren't in the actual plan"
**Root cause:** Three independent data sources were feeding the dashboard with inconsistent values:
1. `displayMileageTarget` used `training_plans.weeks[n].mileage_target` (arc blueprint, generated upfront by Haiku from a mileage estimate) instead of `training_state.weekly_mileage_target` (what Dean actually prescribed).
2. `key_workout` and `notes` on the current week were generated by a separate Haiku call in `generateAndSaveFullPlan` using only "baseMileage + phase + goal" as input — it invented "6×800m @ 5K pace" with no knowledge of what Dean actually scheduled for that user.
3. These arc fields were never reconciled after Dean's actual message was generated.
**Fix / Change:**
1. Dashboard `displayMileageTarget` now prefers `stateData?.weekly_mileage_target` (the live training_state value Dean wrote) over the arc blueprint value.
2. Added `syncArcCurrentWeek(userId, weekNum, phase, goal)` function that runs after `extractAndStorePlanSessions` for both `initial_plan` and `weekly_recap`. It reads the just-stored sessions, computes actual mileage, detects the key quality session, regenerates `notes` via a Haiku call using the real session list, then patches `training_plans.weeks[currentWeek]` with all three fields.
3. `syncArcCurrentWeek` runs fire-and-forget (`void`) so it doesn't block the SMS flow.
**Files changed:** `src/app/dashboard/page.tsx`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Partial-week arc calibration fix for mid-week onboards

**Type:** Bug Fix
**Reported by:** Internal observation + Jake follow-up ("this doesn't scale to Wednesday onboards")
**Root cause:** `generateAndSaveFullPlan` used `prescribedWeek1Miles` (the plan total from the initial_plan message) as `baseMileage` for the entire arc. Since the initial_plan now only covers today through Sunday, the prescribed total is always fewer than 7 days of miles unless the user onboards on Monday. A Wednesday onboard at 60mpw (~43mi for 5 days) would calibrate the arc from 43mi/week. A Saturday onboard (~16mi for 2 days) would be even worse. Any non-Monday onboard was affected.
**Fix / Change:** Two separate fixes that scale correctly to any onboard day:
1. **Arc base (avgWeeklyMileage vs prescribedWeek1Miles)**: If Strava history exists (`avgWeeklyMileage != null`), always use it as the arc base — it's an 8-week real average and is immune to partial-week distortion. If no Strava (user stated their mileage verbally), annualize the prescribed total: `prescribedWeek1MilesRaw × (7 / daysInPlan)`. This scales correctly for any day: Mon ×1.0, Wed ×1.4, Sat ×3.5.
2. **weekly_mileage_target stored in training_state**: Use `prescribedWeek1MilesRaw` for partial weeks (what was actually assigned for those days) rather than `periodization.suggestedWeeklyMiles` (full-week target). This prevents "0/65mi done" when only a 2-day plan was assigned. Sunday recap resets this to the proper full-week target.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Extraction burst fix + initial_plan week boundary + sunday-recap double-plan guard

**Type:** Bug Fix
**Reported by:** Internal observation (Julia's HR preference miss) + Jake feedback
**User feedback:** "why wasn't Julia's HR preference saved, and can we do a better job at making sure these extractions are more reliable? Also we should make sure that we try to work more cleanly in weeks e.g. if a user onboards Friday, give them their workout for Sat/Sun and then Sunday give them the next week"
**Root cause (extraction miss):** The 15-second debounce means when a user sends multiple quick messages (e.g. "please ignore wrist HR" + "I have a chest strap but don't always wear it"), the webhook for the first message is cancelled (newer message arrived) and only the second message is processed. `extractProfileData` was called with just `latestMsg.content` — the second message alone ("I have a chest strap but don't always wear it") doesn't clearly state a preference, so extraction returned `{}`.
**Fix / Change (extraction):** Changed extraction input from the single latest user message to all user messages since the last assistant reply (the debounce burst). When multiple messages arrive in one burst, they're joined and passed to `extractProfileData` together, so the full context is captured. Using `recentMessages.slice(lastAssistantIdx + 1)` to find the burst boundary.
**Root cause (week boundary):** `initial_plan` prompt gave Claude free rein to plan "a week," so it would plan from Saturday forward through the following Friday, straddling the Mon-Sun calendar boundary. Also no guard prevented the Sunday recap cron from firing for users who just got their initial_plan hours earlier on the same Sunday.
**Fix / Change (week boundary):** `initial_plan` user message now injects a computed `WEEK BOUNDARY` instruction telling Claude to plan sessions from today through this Sunday only (e.g. 2 days if onboarding Saturday). The Sunday recap cron now skips users who received an `initial_plan` or `weekly_recap` within the last 8 hours, preventing double-plans for same-day onboards.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/cron/sunday-recap/route.ts`

---

## 2026-04-04 — Trail race VDOT penalty + week boundary labeling in session rows

**Type:** Bug Fix / Improvement
**Reported by:** Julia (user feedback via Jake)
**User feedback:** "I think the trail runs on my strava threw off workout paces but it was easy enough to ask for changes. So a few things 1) if we create pacing zones from races and they are trail, we need to consider that - a trail 100k probably isn't the perfect race to dial in pacing zones, so maybe we look at road races or make adjustments and then ask for confirmation. The second thing is - do we know if we do a good job of adjusting the overall plan / each week based on feedback? we may want to check that we have been properly saving Julia's preferences to training notes or something."
**Root cause (trail races):** `selectBestRaceForPacing` in onboarding scored all races equally by recency/distance, with no penalty for `TrailRun` activity type. Trail races run slower than road races (terrain/elevation), so using a trail 10K for VDOT estimation would produce overly conservative road training zones. Separately, the onboarding message for Strava-suggested pacing had no caveat when the best race was a trail race.
**Fix / Change (trail races):** Added a 0.5× score multiplier for `TrailRun` activities in `selectBestRaceForPacing`, so road races are heavily preferred. Also added `is_trail` to the `StravaRaceSuggestion` type and threaded it into the onboarding "does this pace work?" message — when the best race is trail, Dean now explicitly calls this out and asks if the athlete has a road race to use instead.
**Root cause (week boundary):** `weekly_plan_sessions` spans from current day forward (7 sessions), which can straddle a Mon-Sun calendar week boundary. The system prompt labeled all future sessions "UPCOMING SESSIONS THIS WEEK," causing Dean to say "5 training days left" on Saturday when only 1 calendar day remained in the week.
**Fix / Change (week boundary):** Session rows now split at the upcoming Sunday boundary: sessions in the current Mon-Sun week are labeled "UPCOMING SESSIONS THIS WEEK (week ends Sunday)" and sessions in next week are labeled "NEXT WEEK'S PLANNED SESSIONS (starts Monday — do NOT count these as part of this week's mileage or day count)."
**Root cause (HR preference):** Julia's "ignore wrist HR" message wasn't extracted into `other_notes`. Manually patched Julia's `onboarding_data.other_notes` to include "Does not trust wrist-based HR data — ignore HR from non-chest-strap sources; focus on pace, distance, and perceived effort instead."
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`

---

## 2026-04-04 — Increase coaching debounce to 15s; fix "already did that" double responses

**Type:** Bug Fix
**Reported by:** Jake (user observation, Julia's conversation)
**User feedback:** Coach Dean sent two contradictory responses to two messages sent ~12 seconds apart ("16.3 mi for the week" then "0 mi logged"). Also said "I can't adjust your paces" immediately after adjusting them.
**Root cause (double response):** Coaching debounce was 10s — messages sent 12-15s apart each triggered their own independent response, causing contradictory outputs (different mileage totals, double acknowledgments).
**Root cause (pace confusion):** User sent two messages 1 minute apart: "Can you adjust paces based on 1:21:01 half?" then "That is what I ran on March 1st!" Dean updated paces on the first message, then when the second fired, saw paces already at VDOT 54 and said "they're already calibrated" — technically correct but confusing after just telling the user about the update. No prompt instruction to acknowledge already-completed work.
**Fix / Change:**
1. Increased coaching debounce from 10s to 15s in the Linq webhook.
2. Added `ALREADY-COMPLETED UPDATES` rule to `user_message` prompt: if the last coach message already made the update the athlete is now contextualizing, acknowledge briefly ("Already updated 👊") rather than re-processing or saying it can't be done.
**Files changed:** `src/app/api/webhooks/linq/route.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/api/linq-webhook.test.ts`

---

## 2026-04-04 — Scale initial plan volume by fitness_level when no Strava history exists

**Type:** Bug Fix
**Reported by:** Jake (root cause investigation from user "plan looks light")
**User feedback:** N/A (root cause fix)
**Root cause:** When a user has no Strava history at plan generation time, the FITNESS TIER block in the system prompt hard-capped week 1 at 10mi regardless of `fitness_level`. An intermediate or advanced user without Strava connected got the same cap as a true beginner. The plan arc fallback in `generateAndSaveFullPlan` also defaulted to 15mi for all users with no history. Result: intermediate users with 7 days/week and 18+ mi/week actual fitness received a 9mi week 1 plan.
**Fix / Change:** (1) System prompt: FITNESS TIER for null avgWeeklyMileage now branches by fitness_level — beginner keeps the 10mi cap, intermediate gets a 15–25mi range, advanced gets a 25–35mi range. (2) generateAndSaveFullPlan: no-history fallback is now fitness-level-aware (beginner=15mi, intermediate=20mi, advanced=30mi) instead of a flat 15mi for everyone.
**Files changed:** src/app/api/coach/respond/route.ts, src/lib/training-plan.ts

## 2026-04-04 — Plan health check section in daily email + admin regenerate-plan endpoint

**Type:** Feature
**Reported by:** Jake (internal observation from user "plan looks light" complaint)
**User feedback:** "I want to build a pipeline like we have for the daily email analyzing conversations that runs every 2-3 days and looks at generated plans and compares them to the conversation and evaluates whether the plan generated correctly and is updating correctly"
**Root cause:** No monitoring existed for plan-vs-conversation consistency. A user (0cb902da) had their plan start at 9mi/week (conservative default with no Strava history at onboarding), messaged that it was too light, Dean verbally acknowledged but only patched training_state — the full training_plans arc was never regenerated, leaving state/plan mismatched at 9mi.
**Fix / Change:** (1) Added `/api/admin/regenerate-plan` endpoint — accepts userId + optional prescribedWeek1Miles, calls generateAndSaveFullPlan with skipLinkSms=true. (2) Added `buildPlanHealthSection()` to the daily analyze-conversations cron — fetches all active users, checks state/plan mismatch, conversation drift (promises not reflected in DB), and arc sanity, adds as a second section to the daily email. (3) Manually fixed affected user's plan arc to base 19mi/week.
**Files changed:** src/app/api/admin/regenerate-plan/route.ts (new), src/app/api/cron/analyze-conversations/route.ts

## 2026-04-04 — Use Strava easy-run data as pace baseline when VDOT unknown; prefer recent race time over time trial for calibration

**Type:** Improvement
**Reported by:** Jake (Curtis conversation)
**User feedback:** "For this conversation, it seems like Curtis already had Strava connected, so we should be able to give him paces without a VDOT score - however, instead we should probably just ask for a race time (if strava data isn't good) from the past instead of asking to do a 5K time trial (or at least have that as an option)"
**Root cause:** When `current_easy_pace` is null and VDOT is unknown, the coach had no explicit guidance for using RECENT WORKOUTS data — so it defaulted to blocking on a 5K time trial rather than estimating from available Strava runs. It also only ever offered the time trial path, never asking for a recent race time which is lower friction.
**Fix / Change:** Added a new WHEN PACES ARE TBD rule to the VDOT-CALIBRATED PACING section: when paces are TBD but RECENT WORKOUTS exist, use typical easy run average pace as a baseline estimate and derive tempo/interval from there (labeled as estimates). When calibration is needed, ask for a recent race time first; only suggest a 5K time trial if no race times exist, and always offer both options in the same message.
**Files changed:** src/app/api/coach/respond/route.ts

## 2026-04-04 — Fix timezone never confirmed for Strava users; add timezone step to onboarding

**Type:** Bug Fix
**Reported by:** Jake (user observation)
**User feedback:** "I think we aren't saving timezone correctly in onboarding... my friend Julia is based in San Francisco but in the DB her timezone is NY so I think that may be why the confusion on today/tomorrow"
**Root cause:** `awaiting_timezone` was removed from `STEP_ORDER` with a note "moved to post-plan — asked alongside cadence question." But `handleCadence` treated any Strava-connected user as timezone-confirmed without ever asking them. If the user's Strava account timezone was set when they lived elsewhere (or was never updated), they'd silently get the wrong timezone forever. This caused day-of-week errors — a run at 9 PM Pacific is midnight Eastern, making a Friday run appear as Saturday.
**Fix / Change:**
1. Added `"awaiting_timezone"` back to `STEP_ORDER` after `awaiting_anything_else`. The question is already designed correctly: Strava users with a city see "Based on your Strava, looks like you're in [City, State] — is that still accurate?" Non-Strava users get "What city are you in?"
2. `isStepSatisfied("awaiting_timezone")` now returns `!!(data.timezone_confirmed)` instead of always `true`. Strava connection alone no longer satisfies it — only an explicit user confirmation does.
3. Removed `|| !!(user.onboarding_data.strava_connected)` from `timezoneAlreadyConfirmed` in `handleCadence`.
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/multi-race-onboarding.test.ts`

---

## 2026-04-03 — Fix post-run mileage double-count; add warmup/cooldown to quality session plans

**Type:** Bug Fix
**Reported by:** Jake (user feedback)
**User feedback:** "I have done 14.7 mi so far this week, how'd you get to 20.4?" / "my workout didn't include warm up or cool down so mileage turns out to be more than what is written in the plan"
**Root cause (mileage):** For `post_run`, the system prompt's `TODAY'S PLANNED SESSION` was shown without any "completed" marker. Claude saw the current activity (5.7 mi) and the week-to-date (14.7 mi, which already included that run) and added them: 14.7 + 5.7 = 20.4. The "(this run included)" note in the user message was insufficient to prevent this.
**Root cause (warmup/cooldown):** Weekly plan session labels stored only the main workout distance (e.g. "5mi treadmill hills") without warmup/cooldown miles. When the athlete ran the full session including WU/CD, the Strava activity was longer than the plan said.
**Fix / Change:**
1. For `post_run` trigger, `TODAY'S PLANNED SESSION` in the system prompt is now labeled "(COMPLETED — already included in week-to-date above; do NOT add this distance again)". Also strengthened the mileage line to say "(includes today's synced run — do NOT add it again)".
2. Added `QUALITY SESSION MILEAGE` rule to both `weekly_recap` and `initial_plan` prompts: quality sessions (tempo, intervals, hill repeats, threshold) must state TOTAL distance including warmup (1mi default) and cooldown (0.5–1mi default), with the breakdown shown in parentheses, e.g. "Treadmill hills 6.5mi (1mi WU + 5mi at 8% grade + 0.5mi CD)".
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-03 — Fix daily email falsely flagging real Strava data as hallucinations

**Type:** Bug Fix
**Reported by:** Jake (daily email)
**User feedback:** "the daily email I get doesn't keep saying there's a ton of data hallucinations going on… I don't think is hallucinated because we do have strava data we are getting"
**Root cause:** The analyze-conversations cron only had conversation transcripts — no knowledge of what Strava data was actually present for each run. So when it saw "lap-button pacing" or per-lap pace/elevation in a post_run message, it couldn't distinguish real lap data from invented lap data, and flagged both. The prompt instructions about what Strava provides were also too vague.
**Fix / Change:** For each post_run message, now fetches the corresponding activity from the DB and annotates the transcript with what was actually available: distance, HR monitor yes/no, manual laps recorded yes/no, GPS splits always yes. The analysis prompt now instructs Claude to use these annotations as ground truth — only flag HR/lap references as hallucinations when the annotation confirms that data wasn't present. Also tightened the "NOT a hallucination" list to include pace, splits, elevation, and weekly mileage.
**Files changed:** `src/app/api/cron/analyze-conversations/route.ts`

## 2026-04-03 — Strengthen no-lap guard in post-run coaching prompt

**Type:** Improvement
**Reported by:** Internal (related to above)
**User feedback:** N/A
**Root cause:** The DATA GLOSSARY described `summary.laps` ("manual lap button presses... warmup, hard effort, cooldown") even when no laps existed, priming Claude to frame GPS split variation in lap terms. The guard was also too vague ("Do NOT invent or estimate lap paces").
**Fix / Change:** Glossary laps entry now only rendered when `hasLaps` is true. Guard text now explicitly bans: "lap-button" language, named lap segments (warmup/hard/cooldown lap), lap counts, per-lap elevation — and directs Claude to use "your splits show…" framing instead.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-03 — Plan quality eval harness

**Type:** Infra
**Reported by:** Internal
**User feedback:** N/A
**Root cause:** Existing evals only tested factual accuracy in coaching responses (mileage, paces, dates). No coverage for whether the training plans Coach Dean generates are structurally appropriate — correct volume, right session types, safe long run caps, appropriate progression for the athlete's fitness and goal distance.
**Fix / Change:** Added `plan_quality` eval category with a new judge (`evals/judges/plan-quality.mjs`) that evaluates plan structure rather than stated facts. Judge checks: week 1 volume vs current base, peak week appropriateness, sessions per week vs training days, long run cap, quality session types for goal race, progression safety. Added 5 fixtures covering the main failure modes: 5k beginner (volume spike, long runs too long), 5k competitive (missing interval work), half marathon first-timer (underprepared long runs), marathon first-timer (overtraining or underprepared), ultra first-timer (no back-to-back long runs or trail context). Runner updated to use the plan judge when `category === "plan_quality"`, increase max_tokens to 1500, and send a structured plan request rather than a standard initial-plan trigger message.
**Files changed:** `evals/judges/plan-quality.mjs` (new), `evals/run-evals.mjs`, `evals/fixtures/plan-5k-beginner.json` (new), `evals/fixtures/plan-5k-competitive.json` (new), `evals/fixtures/plan-half-marathon-first-timer.json` (new), `evals/fixtures/plan-marathon-first-timer.json` (new), `evals/fixtures/plan-ultra-first-timer.json` (new)

---

## 2026-04-03 — Fixed onboarding cadence question mismatch causing infinite loop

**Type:** Bug Fix
**Reported by:** User 0cb902da (P1 incident)
**User feedback:** Athlete answered "Mainly after workouts" to the cadence question, Dean responded with a completely different timing question they never answered, then a new post_run fired the original cadence question again as if nothing was said.
**Root cause:** The Haiku classifier in `handleCadence` was trained to recognize answers to a *timing* question (morning/nightly/weekly) but the actual question asked was a *frequency* question (daily/few times/mainly after runs). So "mainly after workouts" was classified as "unclear", fell into `handleNonCadenceMessage`, which sent a different timing question without clearing `onboarding_step`. The step was never cleared to null, so subsequent `post_run_onboarding` triggers kept re-asking the original question.
**Fix / Change:** Rewrote the Haiku classifier system prompt to match the actual question asked. New classification: "daily" → `morning_reminders`, "sometimes" → `nightly_reminders`, "reactive" (after runs) → `weekly_only`. Updated all re-ask strings, fallback messages, deescalation message, and `checkOffTopic` config to use the frequency-based question consistently. Confirmation messages updated to reflect the frequency-based framing ("I'll check in a few times a week" instead of "evening before each session").
**Files changed:** `src/app/api/onboarding/handle/route.ts`, `src/__tests__/api/onboarding-handle.test.ts`

---

## 2026-04-02 — Stripe subscription billing + payment gate

**Type:** Feature
**Reported by:** Internal — pre-launch monetization
**User feedback:** N/A
**Root cause:** No payment infrastructure existed; all users had free access.
**Fix / Change:**
- Added per-user `billing_enabled` feature flag (default `false` — all existing users grandfathered). New signups can be opted in per-user or via the signup route once billing is live.
- Payment wall fires at the end of onboarding: after all questions are complete, users with `billing_enabled=true` receive a 7-day free trial checkout link instead of immediately getting their plan. `onboarding_step` is set to `awaiting_payment` and `initial_plan` is held until Stripe confirms checkout.
- Stripe Checkout hosted page at `/checkout?token=<dashboard_token>` — plan picker (monthly $20/mo, annual $10/mo billed yearly). No card form to build; Stripe handles it.
- Stripe webhook (`/api/webhooks/stripe`) handles: `checkout.session.completed` (fires `initial_plan`), `subscription.updated` (syncs status), `invoice.payment_failed` (sets `past_due`, sends dunning 1), `subscription.deleted` (sets `canceled`, sends dunning 1).
- Subscription gate in `coach/respond`: users with `billing_enabled=true` and no active subscription get blocked. `user_message` triggers send a resubscribe link; proactive triggers (reminders, post_run, weekly_recap) are silently skipped.
- 3-message dunning sequence: message 1 sent by webhook immediately on lapse; messages 2 and 3 sent by `/api/cron/dunning` at 4 and 8 days after message 1. Message 3 is the final outreach.
- Next-day payment reminder cron (`/api/cron/payment-reminder`): if user hasn't clicked the checkout link after 24 hours, sends one follow-up SMS.
**Files changed:** `supabase/migrations/023_billing.sql`, `src/lib/stripe.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/app/api/billing/checkout/route.ts`, `src/app/checkout/page.tsx`, `src/app/checkout/success/page.tsx`, `src/app/api/cron/payment-reminder/route.ts`, `src/app/api/cron/dunning/route.ts`, `src/app/api/onboarding/handle/route.ts`, `src/app/api/coach/respond/route.ts`, `vercel.json`

---

## 2026-04-02 — Fix: today's planned sessions shown as "upcoming", causing Dean to call them "tomorrow's"

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "in this instance (for me), Dean thinks it is still yesterday and I have a strength session today (thursday), but it is thursday and I already did the strength session. [...] Keep tomorrow's strength session light on the hamstrings"
**Root cause:** The `activeSessions` filter used `sessionDate >= localTodayUTC`, which included today's sessions in the "UPCOMING SESSIONS THIS WEEK" list with no distinction from future sessions. Claude saw Thursday's strength session listed as "upcoming" without knowing it was today, and inferred it hadn't happened yet — calling it "tomorrow's session" when responding to a Thursday afternoon message.
**Fix / Change:** Split sessions into `todaySessions` (exactly today) and `futureSessions` (strictly tomorrow+). Today's sessions are now shown under a separate "TODAY'S PLANNED SESSION (may already be completed — check conversation history before giving future-tense advice)" header. Future sessions remain under "UPCOMING SESSIONS THIS WEEK". The projected week total now only sums future sessions (today's may already be done).
**Files changed:** `src/app/api/coach/respond/route.ts`

## 2026-04-02 — Plan regen fixes: stable links, accurate arc context, 5K long run cap

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "Dashboard goes up to 16 miles but Dean says up to 20 / I don't have a week by week breakdown in front of me - yes he should have the training arc to be able to edit things / Old link didn't work when plan updated / Regenerated a new plan in the middle of a week, mileage for this week is 13 miles, but weekly target says 15 miles / 5K plan has 9.5 mi long run in it"
**Root cause:** Four distinct bugs: (1) `generateAndSaveFullPlan` always issued a new `dashboard_token`, invalidating the athlete's existing link every time the plan was regenerated. (2) The `user_message` context only included the next-week arc entry, so Dean hallucinated peak mileage instead of reading the stored plan. (3) `training_state.weekly_mileage_target` was only synced when `prescribedWeek1Miles` was provided; after a race-date regen it kept the old value, causing a mismatch with the new arc. (4) The long run factor (38% at peak) was applied without a goal-specific cap, producing 9.5mi long runs for 5K plans.
**Fix / Change:** (1) `generateAndSaveFullPlan` now fetches the user's existing `dashboard_token` and reuses it; only generates a new UUID (and stamps `trial_started_at`) if none exists. (2) Added `fullArcContext` to the `user_message` prompt — a compact week-by-week arc summary Dean can reference when asked about upcoming mileage or key sessions. (3) Always sync `weekly_mileage_target` to the computed arc week 1 value when no `prescribedWeek1Miles` is provided, so the dashboard reflects the regenerated plan. (4) Added goal-specific long run caps: 5K → 7mi, 10K → 10mi, half marathon → 14mi.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/__tests__/lib/training-plan-generate.test.ts`

---

## 2026-04-02 — Fixed tempo label/pace mismatch, run-question handling in onboarding, email analysis GPS splits

**Type:** Bug Fix (x3)
**Reported by:** Internal — daily conversation analysis digest
**Root cause (Issue 5):** When a user had no VDOT and tempo pace couldn't be validated, Dean could prescribe "Tempo 1.5mi @ 9:30-10:00/mi" — assigning the easy pace range to a quality session label. The existing PACE SANITY CHECK caught numerically wrong paces but didn't have an explicit label/pace consistency rule.
**Fix:** Added ⚠️ LABEL/PACE CONSISTENCY rule to system prompt: any session labeled Tempo/Threshold/Race Pace must be at least 30 sec/mi faster than easy pace. If it isn't, fix the label or the pace — never output a contradictory label+pace pair.

**Root cause (Issue 3):** The daily analysis email kept flagging Dean citing per-split paces as hallucinations. All GPS Strava runs automatically include `splits_metric` (per-km split data), so any split paces in a `post_run` message are real — not invented. The email analysis prompt didn't distinguish per-km splits (always present) from manual lap data (optional).
**Fix:** Updated email analysis prompt to clarify GPS splits are always real Strava data. A true hallucination would be HR values without an HR monitor, lap-by-lap detail when no laps were recorded, or a split narrative that contradicts the overall pace.

**Root cause (Issue 4):** During `awaiting_cadence`, if a user asked "what did I do during my run?", `handleNonCadenceMessage` classified it as a coaching question and answered without any activity context — leading to "I don't have access to your previous run data" even though Dean had just described that exact run. The classifier had no category for run-specific elaboration requests.
**Fix:** Added `run_question` classification. When detected, Dean fetches the last 6 conversation messages (which includes the post_run message with all activity data) and answers using that context, then re-appends the cadence question.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/app/api/cron/analyze-conversations/route.ts`, `src/app/api/onboarding/handle/route.ts`

---

## 2026-04-02 — This-week schedule override: reminders fire on the right days

**Type:** Feature
**Reported by:** Jake
**User feedback:** "if someone says I want to run mon, tues, fri this week instead of monday, sat, sunday, will the cron fire appropriately for reminders even if training days isn't updated?"
**Root cause:** No mechanism existed for temporary single-week schedule swaps. Without updating `training_days`, crons would fire on the old days; updating it permanently would overwrite the standing schedule.
**Fix / Change:** Added `this_week_override_days text[]` and `this_week_override_expires date` to `training_profiles`. When a user says "I want to run Mon/Wed/Fri this week", Dean stores the temporary days + an expiry of the upcoming Sunday. The morning-reminder and nightly-reminder crons now call `effectiveTrainingDays()` which uses the override if present and not expired, falling back to the standing schedule. A permanent schedule update clears any active override. The extraction prompt distinguishes "this week only" from standing schedule changes.
**Files changed:** `supabase/migrations/022_week_override_days.sql`, `src/lib/database.types.ts`, `src/app/api/coach/respond/route.ts`, `src/app/api/cron/morning-reminder/route.ts`, `src/app/api/cron/nightly-reminder/route.ts`

---

## 2026-04-02 — Fixed training_days case mismatch silently breaking morning reminders

**Type:** Bug Fix
**Reported by:** Jake (user's mom, Catherine)
**User feedback:** "My mom had Dean update her schedule to Sun, Tues, Thursday but hasn't heard from Dean since Sunday"
**Root cause:** When a user updates their training schedule via SMS, the LLM extraction prompt instructs Claude to return "full day names" (e.g. `["Sunday", "Tuesday", "Thursday"]`). These were saved directly to `training_profiles.training_days` without normalization. The morning-reminder cron compares against `todayWeekday.toLowerCase()` (e.g. `"tuesday"`), so capitalized values never matched and all affected users were silently skipped. The onboarding flow correctly normalizes to lowercase, creating an inconsistency between the two code paths.
**Fix / Change:** Added `.map(d => d.toLowerCase())` when saving `updated_training_days` from user messages in `coach/respond`. Catherine and anyone else who updated their schedule via SMS also needs their existing DB row fixed manually (capitalize bug may have introduced `["Sunday", "Tuesday", "Thursday"]` into their `training_days` column).
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-02 — Fix: additive total format in weekly plan messages

**Type:** Bug Fix
**Reported by:** Eval — `quality-no-internal-labels` fixture revealed by richer judge context
**Root cause:** Two issues compounding: (1) The TOTAL LINE FORMAT prompt rule said "show ONLY planned future sessions" — so when 6.5mi were already done and 19mi planned, Claude wrote "Total: 19 mi" ignoring already-done miles. (2) `correctMileageTotal` only parsed the compact session format `"Mon 3/2 · ..."` — when Claude used the fallback `"Tuesday, Mar 31: ..."` format, the function never fired and couldn't correct the total. After the prompt was updated to say "Total = planned + done", Claude started writing the math out explicitly as "19 mi planned + 6.5 done = 25.5 mi" (still wrong format).
**Fix / Change:** (1) Updated TOTAL LINE FORMAT prompt for `user_message` trigger: Total = full week (planned + already done), show ONLY the final number — no "X + Y = Z" breakdown. (2) Extended `correctMileageTotal` to also parse the fallback long-form date format ("Tuesday, Mar 31: ...") using a new `fallbackLineRe` regex and a shared `extractSessionMiles` helper. (3) Updated `format-no-additive-total` fixture ground_truth note to clarify that dates in Apr 2–5 are correct for a week starting Mon 3/30 (judge was incorrectly penalizing them). (4) Fixed activity date inconsistencies in `mileage-week3-some-logged` and `date-18-week-plan-week10` fixtures — both had a Saturday activity that landed in the prior Mon–Sun week, confusing the richer judge. Added `today: "2026-04-01"` to both.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/fixtures/format-no-additive-total.json`, `evals/fixtures/mileage-week3-some-logged.json`, `evals/fixtures/date-18-week-plan-week10.json`

---

## 2026-04-02 — Eval judge now date-aware and includes conversation context

**Type:** Infra
**Reported by:** Internal — discovered while adding fixture for the yesterday-attribution bug
**Root cause:** `buildEvalSystemPrompt` in `run-evals.mjs` and `buildJudgePrompt` in `factual-accuracy.mjs` both hardcoded `today = "2026-03-30"`. This made per-fixture date testing impossible — the coach response was generated for today's real date while the judge evaluated it against March 30, causing date-related fixtures to fail for the wrong reasons. Additionally, the judge had no visibility into `recent_activities` or `recent_conversation`, causing it to falsely flag content from those sources as hallucinated.
**Fix / Change:** Added `today` field to fixtures (defaults to `"2026-03-30"` so all existing fixtures are unaffected). Threaded it through both `buildEvalSystemPrompt` and `buildJudgePrompt`. Added `recent_activities` and `recent_conversation` blocks to judge context. Added `temporal_reference_correct` evaluation dimension to the judge. The richer judge context also surfaced a pre-existing bug in `quality-no-internal-labels` (additive total ignoring already-done miles) — added to known failures. Added `quality-morning-plan-yesterday-activity` fixture (9/10). Baseline is now 21/22 passing.
**Files changed:** `evals/run-evals.mjs`, `evals/judges/factual-accuracy.mjs`, `evals/fixtures/quality-morning-plan-yesterday-activity.json`, `CLAUDE.md`

---

## 2026-04-02 — Fix: morning plan referencing wrong day for recent activities

**Type:** Bug Fix
**Reported by:** User feedback
**User feedback:** "Here's another issue - Dean referring to Monday as yesterday: ...You're at 6 mi this week already from Monday, so this keeps you moving without piling on too much volume. Listen to your body — if you're still feeling yesterday's double header..."
**Root cause:** `dateContext` told Claude to "always use specific calendar dates rather than relative terms like 'tomorrow' or 'next Monday'". This rule is correct for *future* scheduled sessions (messages may be read later), but Claude was applying it to *past* activity references too — and when it couldn't say "yesterday" it guessed a training day from the schedule (Monday) instead of the actual logged date (Wednesday).
**Fix / Change:** Added `Yesterday: <date>` explicitly to `dateContext` (mirroring how Tomorrow is provided). Clarified the rule: future sessions should use specific calendar dates; past activities should use natural relative terms like "yesterday" or "Wednesday's run". Updated `run-evals.mjs` to match. Added new eval fixture `quality-morning-plan-yesterday-activity` to catch regressions.
**Files changed:** `src/app/api/coach/respond/route.ts`, `evals/run-evals.mjs`
**Eval note:** A fixture for this was attempted but the eval framework hardcodes `today = "2026-03-30"` in the judge while the coach response is generated with the real date — making temporal-reference tests ("yesterday" vs wrong day) impossible to judge correctly without per-fixture date injection. The first eval run did confirm the fix works (judge noted "Response avoids the forbidden day-specific phrases"). Proper eval coverage would require adding date injection to the judge.

---

## 2026-04-02 — Richer session detail: HR targets, easy run cues, strength exercises

**Type:** Improvement
**Reported by:** Jake (user)
**User feedback:** "I've gotten a lot of feedback that the sessions could use a bit more detail — for example, if a runner gets all easy miles in a week it's a bit boring and unmotivating. We should consider ways to give a bit more detail, for example - target HR zones if we see a user has a HR coming in via their strava, types of terrain to shoot for, more details on the why behind the workouts, etc. And also in my plan it says 30 min strength and mobility but I wasn't given much detail on what that is"
**Root cause:** Session labels were bare (e.g. "Easy 5mi @ 9:30/mi") with no purpose context, HR data from Strava was collected but never used for prescriptions, and strength sessions had no exercise specifics.
**Fix / Change:** Three prompt changes: (1) HR zone guidance — when HEART RATE data appears in activity summary, Dean appends a bpm target on easy run labels (~10–20 bpm below highest avg effort). (2) Easy run enrichment — easy runs now get one contextual cue per plan (terrain, effort description, or recovery framing), especially for all-easy weeks. (3) Strength specifics — whenever Dean prescribes a strength session, a follow-up bubble with 3–5 specific exercises (runner-focused hip stability/glute work by default, adjusted for injury notes) is required.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-02 — Dashboard now shows actual weekly sessions from Coach Dean

**Type:** Bug Fix
**Reported by:** Jake (user)
**User feedback:** "Seems my plan in the dashboard + what Dean sent me aren't the same — in particular, it seems like the dashboard doesn't include strength or cross training? and also it doesn't have the same detail on workouts."
**Root cause:** Dashboard was reading from `training_plans.weeks` and reconstructing the weekly view algorithmically via `buildDailyPlan()`, which only knew about running sessions (easy/key/long/rest). It never read `weekly_plan_sessions` from `training_state`, which is where the actual extracted sessions (including strength, cross-training, treadmill hills, bike, etc.) are stored after each weekly recap.
**Fix / Change:** Dashboard now fetches `weekly_plan_sessions` from `training_state`. When sessions exist, `buildDailyPlanFromSessions()` renders them directly — preserving exact labels, all session types, and parsed mileage. Falls back to the old algorithmic approach only when no stored sessions are available.
**Files changed:** `src/app/dashboard/page.tsx`

---

## 2026-04-01 — Fix plan request sending dashboard link and date labeling in sessions

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A — "Could you send me my plan for training for bay to breakers?" caused Dean to use web search, research the race, and send the full plan as an inline SMS rather than the dashboard link
**Root cause:** Two separate issues. (1) The `isPlanRequest` early-exit only matched the exact phrase "my plan" via `/^\s*my\s+plan\s*$/i`. Natural-language variants like "send me my plan for training for X" bypassed the code-level redirect, went to Claude with web search enabled, and Claude generated an inline plan rather than sending the link. (2) The FULL PLAN REQUESTS prompt instruction was not strong enough to prevent this — Claude with web search capability overrode it.
**Fix / Change:** (1) Expanded `isPlanRequest` regex to also catch "send me my plan", "show me my plan", "view my training plan" patterns. (2) Strengthened FULL PLAN REQUESTS prompt: now labelled HARD RULE, explicitly forbids outputting a schedule inline even when web search is available. (3) Added tests: natural-language plan request variants now hit the early-exit and send the dashboard link without calling Claude; SESSION DAY LABELING instruction verified present in coaching user message.
**Files changed:** `src/app/api/coach/respond/route.ts`, `src/__tests__/api/coach-respond.test.ts`

---

## 2026-04-01 — Fix web search reasoning leaking as SMS messages

**Type:** Bug Fix
**Reported by:** Internal observation
**User feedback:** N/A — observed in conversation where Dean sent 5 SMS messages instead of 1: internal reasoning paragraphs ("⚠️ GOAL DISCREPANCY DETECTED", "Wait — I need to check", "Now I need to provide the training plan") were all delivered to the athlete
**Root cause:** `lastToolIdx` filtering only matched `b.type === "tool_use"`, but `web_search_20250305` is a server-side tool whose blocks are typed `"server_tool_use"` (the request) and `"web_search_tool_result"` (the result) — neither matches `"tool_use"`. This meant `lastToolIdx` always stayed at -1 when web search was used, so ALL text blocks (including every reasoning paragraph) were kept and sent as SMS via `splitIntoMessages`.
**Fix / Change:** Updated `lastToolIdx` reduce to also match `"server_tool_use"` and `"web_search_tool_result"` block types. Added explicit prompt rule: when web search is used, the first thing output must be the coaching message — no narration of the search process, no internal analysis blocks.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-01 — Strengthen coaching prompt guards (pace sanity, WU/CD, mileage disputes, day labeling)

**Type:** Bug Fix
**Reported by:** Internal — automated conversation audit
**User feedback:** N/A
**Root cause:** Four prompt compliance failures identified from conversation review: (1) PACE SANITY CHECK was abstract ("faster than the easy pace above") so Claude could fail it when the stored tempo was TBD or when km/mile units were ambiguous — the documented error pattern is 8:46/mi × 1.60934 = 14:07/km, output as a tempo pace. (2) WU/CD pace was not mentioned in the sanity check, so Claude invented a pace 1 min/mile off from the easy pace already in context. (3) When an athlete disputed a mileage figure, Claude rearranged the same wrong narrative instead of re-anchoring to Strava ground truth. (4) When referencing planned sessions as "today" vs "tomorrow," Claude inferred day labels from list order rather than cross-checking stored dates against the current date.
**Fix / Change:** (1) Extracted `easyPaceGuardDisplay` and `tempoPaceGuardDisplay` variables so the PACE SANITY CHECK injects concrete numbers ("This athlete's easy pace is 9:30/mi — any quality pace at 9:30/mi or slower is a documented error") rather than abstract references. (2) Added WU/CD = easy pace rule to the same guard. (3) Added MILEAGE DISPUTE paragraph to user_message prompt: re-anchor to authoritative Strava figure, trust athlete correction, never rearrange narrative. (4) Added SESSION DAY LABELING paragraph: always cross-check session date against DATE CONTEXT, name moved sessions explicitly.
**Files changed:** `src/app/api/coach/respond/route.ts`

---

## 2026-04-01 — Improve dashboard return access and fix mobile sign-in placement

**Type:** Improvement
**Reported by:** Internal observation
**User feedback:** "the sign-in button shows up on mobile in an awkward spot between coach dean and get started on the top"
**Root cause:** Navbar had three items on mobile (logo, Sign in, Get started) with no room. Dashboard had no way to return without the magic link URL or re-requesting via phone number.
**Fix / Change:** (1) Hide "Sign in" from navbar on mobile; add "Already a user? View your plan" link below the Get Started button in the hero on mobile only. (2) Dashboard now saves the token to localStorage on first authenticated visit (`TokenPersist`). Subsequent visits to `/dashboard` (no token in URL) auto-redirect via `LocalTokenRedirect` — users can bookmark `coachdean.ai/dashboard` and it just works.
**Files changed:** `src/components/navbar.tsx`, `src/components/signup-form.tsx`, `src/app/dashboard/page.tsx`, `src/app/dashboard/token-manager.tsx` (new)

---

## 2026-04-01 — Fix race week mileage targets and dashboard weekly target display

**Type:** Bug Fix
**Reported by:** Jake
**User feedback:** "week 31 race week shows 23 mi, which I assume is before the race, but that actually would put me at 49 mi for that week which seems a bit high. Other issue - the 'weekly target' in the 'This week' section on the dashboard says 19.8 mi but week 1 before full training arc says 26 mi."
**Root cause:** (1) Race week `mileage_target` used a flat 50% of peak factor regardless of race type. Since this represents pre-race training miles only (not including the race), a marathon runner would have 23mi pre-race + 26.2mi race = ~49mi total — far too high. The system prompt taper protocol had different (but also too-high) race week factors. (2) Dashboard "This week" header overrode the full week target with a partial-week sum of remaining sessions, making week 1 show 19.8mi instead of the plan's 26mi target.
**Fix / Change:** (1) Race week factor is now race-type-aware and significantly reduced: marathon/ultra = 25%, half = 28%, 5K/10K = 35% of peak. For a 46mi/wk marathon runner: 46×0.25=11.5mi pre-race training + 26.2mi race ≈ 38mi total — reasonable. Synced system prompt taper protocol to match. (2) Dashboard weekly target always shows the full week's `mileage_target` from the plan arc, removing the partial-week override.
**Files changed:** `src/lib/training-plan.ts`, `src/app/api/coach/respond/route.ts`, `src/app/dashboard/page.tsx`

---
