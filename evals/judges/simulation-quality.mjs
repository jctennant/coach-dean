/**
 * Judge prompt builder for multi-turn onboarding simulation evals.
 * Evaluates a full conversation transcript end-to-end.
 */

export function buildSimulationJudgePrompt(fixture, transcript, finalCollected, deanTurns, readyFired) {
  const { persona, evaluation_criteria: ec } = fixture;
  const gt = persona.ground_truth;

  const collectedSummary = JSON.stringify(finalCollected, null, 2);
  const groundTruthSummary = JSON.stringify(gt, null, 2);

  const fieldChecks = (ec.required_fields || []).map((f) => {
    const actual = finalCollected[f];
    const expected = gt[f];
    const present = actual !== null && actual !== undefined;
    if (!present) return `  ✗ ${f}: MISSING (expected: ${JSON.stringify(expected)})`;
    if (expected && JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `  ⚠ ${f}: collected "${JSON.stringify(actual)}" — expected "${JSON.stringify(expected)}"`;
    }
    return `  ✓ ${f}: ${JSON.stringify(actual)}`;
  }).join("\n");

  return `You are evaluating a full onboarding simulation for "Coach Dean", an AI running coach that communicates via SMS.

A user persona was simulated across ${deanTurns} turns. Evaluate the transcript holistically.

═══════════════════════════════════
PERSONA GROUND TRUTH
═══════════════════════════════════
${groundTruthSummary}

═══════════════════════════════════
FIELD COLLECTION SUMMARY
═══════════════════════════════════
Required fields — what was actually collected vs expected:
${fieldChecks}

Goal should be: ${ec.goal_should_be ?? "any"}
${ec.race_date_should_be ? `Race date should be: ${ec.race_date_should_be} (check for first-of-month defaults like ${ec.race_date_should_be?.slice(0,7)}-01)` : ""}
${ec.secondary_race_should_include ? `Secondary race: should include "${ec.secondary_race_should_include}"` : ""}

[READY] fired: ${readyFired ? "YES" : "NO — conversation timed out"}
Dean turns taken: ${deanTurns} (target: ≤${ec.target_turns ?? 8})

Final collected data:
${collectedSummary}

═══════════════════════════════════
FULL CONVERSATION TRANSCRIPT
═══════════════════════════════════
${transcript}

═══════════════════════════════════
EVALUATION CRITERIA
═══════════════════════════════════
Evaluator notes: ${ec.notes ?? "None."}

Score each dimension, then give an overall score:

1. ready_fired (boolean): Did [READY] eventually fire? A timeout without [READY] is a major failure.

2. fields_complete (boolean): Are all required fields present in the final collected data?

3. fields_accurate (boolean): Are the collected field values accurate to the persona's ground truth?
   - Check race dates for first-of-month defaults (a date like 2026-07-01 when ground truth is 2026-07-11 is a failure)
   - Check goal bucket accuracy
   - Check that training_days match

4. strava_asked_early (boolean): Did Dean ask about Strava by turn 3 (i.e., within the first 2 Dean responses after learning name and goal)?
   - true = Strava link offered by Dean's 2nd or 3rd message
   - false = Strava never asked, or only asked at turn 4+

5. no_repetition (boolean): Did Dean avoid re-asking questions the user already answered?
   - Read the transcript carefully — if the user answered training days in turn 2 and Dean asked again in turn 4, that's a failure
   - Greeting phrase repetition ("Great to meet you" repeated) also counts

6. natural_flow (1–10): How natural and smooth did the conversation feel?
   - 10: Felt like a real coach — warm, specific, efficient
   - 7–9: Mostly natural, minor awkwardness
   - 4–6: Some robotic moments, awkward question ordering, or missed opportunities to acknowledge what was shared
   - 1–3: Stilted, interrogation-like, missed important context

7. efficiency (1–10): How efficiently did Dean collect the needed info?
   - 10: [READY] in ≤6 Dean turns
   - 8: 7–8 turns
   - 6: 9–10 turns
   - 4: 11–12 turns
   - 1: Timed out without [READY], or 13+ turns

8. scope_handled (boolean | null): Only score this for cycling or triathlon goals. Did Dean correctly explain its scope?
   - true = Dean honestly explained it specializes in running, and for triathlon clarified it handles the run leg
   - false = Dean proceeded as if it were a full cycling or triathlon coach without any scope clarification
   - null = not applicable (running-only goal)

9. conversion_likelihood (1–10): Based on the conversation, how likely is this user to start a free trial?
   - This measures how well Dean demonstrated VALUE during onboarding — not just data collection
   - 10: Dean showed specific intelligence (e.g. reflected back what their PR means for their goal), felt like a real coach, user seemed engaged and excited
   - 7–9: Warm, competent conversation — user seemed satisfied, no friction
   - 5–6: Functional but no "wow" moment — user got their questions answered but Dean felt like a signup form
   - 3–4: Some friction — Dean missed obvious opportunities to demonstrate value, or user seemed confused
   - 1–2: Dean felt robotic or unhelpful — user likely to drop off
   Key signals that raise conversion_likelihood: Dean reflected specific insight from their fitness data, Dean explained Strava's value proactively, Dean acknowledged their goal with coaching-specific knowledge
   Key signals that lower it: Dean only asked questions without giving anything back, Dean felt like a form, scope confusion (e.g. Dean acted as a cycling coach without acknowledging its running focus)

10. overall_score (1–10): Holistic quality — would a real user have had a good experience AND be likely to see value in the product?

SCORING RUBRIC:
- 10: All fields correct, [READY] fired efficiently, natural conversation, no repetition, strong conversion signals
- 7–9: [READY] fired, fields mostly correct (1 minor error), mostly natural, user likely to convert
- 4–6: [READY] fired but has 1 significant error (wrong date, wrong goal, re-asked something), or needed 11+ turns, or low conversion signals
- 1–3: Multiple errors, or [READY] never fired, or conversation was confusing/robotic
- 0: Complete failure

Return ONLY valid JSON:
{
  "ready_fired": true | false,
  "fields_complete": true | false,
  "fields_accurate": true | false,
  "field_errors": ["list any specific field errors with exact values"],
  "strava_asked_early": true | false,
  "no_repetition": true | false,
  "repetition_examples": ["quote any repeated questions or greeting phrases"],
  "natural_flow": 0,
  "efficiency": 0,
  "scope_handled": true | false | null,
  "conversion_likelihood": 0,
  "overall_score": 0,
  "score_rationale": "2-3 sentences on what went well and what didn't",
  "flags": ["any notable issues not captured above"]
}`;
}
