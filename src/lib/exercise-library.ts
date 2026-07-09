// Rehab exercises and injury-safe cross-training alternatives.
// These are deterministic lookups — no LLM needed.
// Consumed by the Injury & Rehab Agent and the rehab protocol tool.

export const BODY_PART_EXERCISES: Record<string, string[]> = {
  it_band:      ["Hip abductor clamshells 3×15", "Lateral band walks 2×20 steps each way", "Foam roll TFL and outer glute — NOT the IT band itself (rolling the IT band directly irritates it)", "Hip flexor stretch in lunge position 3×30s each side"],
  hamstring:    ["Eccentric Nordic hamstring curls 3×8 (use a towel under knees)", "Romanian single-leg deadlifts 3×10 each", "Prone hamstring raises 3×12", "Glute bridges with 2-second hold 3×15"],
  knee:         ["VMO quad sets 3×15 (sit, tighten quad isometrically, hold 5sec)", "Terminal knee extensions (TKEs) with band 3×15", "Step-downs from 6-inch step, slow 3-second descent 3×10 each", "Straight-leg raises 3×15"],
  shin:         ["Eccentric calf raises off a step (straight knee) 3×15", "Tibialis anterior raises: stand with back to wall, lift toes 3×15", "Calf stretching bent + straight knee 3×30s each", "Slow toe taps on a stair 2×20"],
  calf:         ["Eccentric heel drops off step — straight knee 3×15, bent knee 3×15", "Standing calf raises (single-leg) 3×20", "Soleus stretch (bent knee) 3×30s hold", "Ankle circles 2×10 each direction"],
  foot:         ["Frozen water bottle rolling under arch 2 min each foot", "Towel toe curls 3×15", "Eccentric calf raises 3×15", "Short-foot arch activation 3×10"],
  hip:          ["Hip flexor stretch in lunge position 3×30s each", "Glute bridges 3×15", "Lateral band walks 2×20 steps", "Pigeon pose 2×60s each side"],
  piriformis:   ["Figure-4 stretch lying down 3×60s each side", "Pigeon pose 2×60s each side", "Seated piriformis stretch 3×30s", "Clamshells with band 3×15"],
  glute:        ["Clamshells 3×15", "Single-leg glute bridges 3×12 each", "Hip thrusts (body weight or barbell) 3×15", "Side-lying hip abduction 3×15"],
  back:         ["Cat-cow 10 slow reps", "Bird-dog 3×10 each side", "Child's pose 2×60s", "Dead bug 3×8 each side"],
  ankle:        ["Eccentric calf raises off step 3×15", "Single-leg balance on unstable surface 3×30s", "Resistance band dorsiflexion 3×15", "Ankle alphabet (draw A–Z slowly with foot)"],
  groin:        ["Side-lying hip adduction 3×15 each side (inner thigh, low compression — pregnancy-safe)", "Seated adductor isometric squeeze with pillow/ball between knees 3×15, 10-sec holds (pregnancy-safe)", "Gentle seated butterfly stretch 3×30s — gravity only, no forcing (pregnancy-safe)", "Clamshells with band 3×15 (hip and pelvic stability — pregnancy-safe)"],
};

export const CROSS_TRAINING_ALTERNATIVES: Record<string, string[]> = {
  shin:      [
    "Pool running (deep-water belt) — gold standard; mimics running mechanics with zero bone impact",
    "Uphill treadmill walking or easy jogging — incline reduces ground reaction force on the tibia vs. flat running; start with a walk, progress to an easy jog if pain-free, stop if any shin discomfort",
    "Cycling or stationary bike — zero tibial loading, full aerobic stimulus",
    "Elliptical — low-impact if pain-free; stop immediately if shin discomfort starts",
    "Avoid rowing — plantar flexion under load stresses the anterior tibialis",
  ],
  knee:      [
    "Swimming (any stroke) — zero knee impact, full aerobic workout",
    "Pool running with deep-water belt — running-specific conditioning, no knee load",
    "Easy cycling at low resistance — check that it's pain-free through full pedal stroke before pushing effort",
    "Uphill treadmill walking at low incline — generally knee-friendly but test cautiously; avoid steep grades if quad or patellar pain flares",
  ],
  it_band:   [
    "Swimming — no lateral stress on the IT band at all",
    "Uphill treadmill walking — uphill is far safer than downhill for IT band; keeps aerobic work going without the lateral knee stress of flat road running",
    "Cycling (steady seated, avoid climbing out of the saddle) — minimal IT band engagement when seated",
    "Elliptical — only use if lateral knee is completely pain-free on the machine",
  ],
  hamstring: [
    "Cycling — avoids the eccentric hamstring loading that running creates; keep effort easy",
    "Swimming — safe for all hamstring issues, full aerobic stimulus",
    "Elliptical at low incline — check for any pulling sensation and back off if present",
  ],
  calf:      [
    "Pool running or swimming — no plantar flexion load from ground contact",
    "Cycling with clip shoes (minimizes calf push-off); flat pedals stress the calf more — avoid those",
    "Avoid uphill treadmill and rowing — both increase calf/Achilles load; test elliptical cautiously",
  ],
  foot:      [
    "Cycling — foot is mostly passive through the pedal stroke, zero ground contact",
    "Swimming — completely non-weight-bearing",
    "Pool running with float belt — maintains running conditioning with no foot strike",
  ],
  hip:       [
    "Swimming or aqua jogging — supported range of motion, no impact",
    "Uphill treadmill walking — hip flexor and glute engagement without impact; easy on the joint",
    "Cycling — hip-friendly in most cases; avoid if hip flexor tightness flares on the bike",
    "Elliptical — generally safe; stop if hip pain during",
  ],
  glute:     [
    "Swimming or pool running — low glute loading, full aerobic base maintenance",
    "Easy cycling (low resistance) — minimal glute activation at easy effort",
    "Uphill treadmill walking — activates glutes in a controlled way; can double as light rehab stimulus",
    "Elliptical at low incline",
  ],
  piriformis:[
    "Swimming (freestyle) — minimal piriformis activation in the flutter kick",
    "Easy cycling — avoids the hip external rotation that aggravates piriformis",
    "Elliptical at low resistance, flat setting",
  ],
  back:      [
    "Swimming — freestyle and backstroke decompress the spine; avoid breaststroke if it causes discomfort",
    "Easy walking or light cycling — keeps movement without spinal loading",
    "Avoid rowing — spinal flexion under load is the worst thing for most back injuries",
    "Avoid uphill treadmill at steep incline — forward lean can load the lumbar spine",
  ],
  groin:     [
    "Swimming with flutter kick (freestyle) — minimal adductor stress",
    "Cycling (seated, steady effort) — avoids the adductor loading from ground reaction force",
    "Pool running with deep-water belt — eliminates the lateral leg push-off that loads the groin",
    "Uphill treadmill walking — generally low adductor stress; test at easy pace and low grade first",
  ],
  ankle:     [
    "Pool running — zero ankle load, perfect running substitute",
    "Swimming — non-weight-bearing",
    "Cycling with clip shoes (reduces dorsiflexion stress vs. flat pedals)",
    "Avoid uphill treadmill — increased dorsiflexion range at higher grades can stress the ankle",
  ],
};

export const KNOWN_REHAB_PARTS = Object.keys(BODY_PART_EXERCISES);

// Realistic return-to-run timelines by body part and severity.
// Used on day 1 of injury hold to set honest expectations.
export const INJURY_TIMELINES: Record<string, Record<"mild" | "moderate" | "severe", string>> = {
  it_band:    { mild: "2–3 weeks",  moderate: "3–5 weeks",  severe: "6–8 weeks" },
  shin:       { mild: "2–3 weeks",  moderate: "4–6 weeks",  severe: "8–12 weeks (rule out stress fracture with a physio)" },
  knee:       { mild: "1–2 weeks",  moderate: "3–5 weeks",  severe: "6–10 weeks" },
  hamstring:  { mild: "1–2 weeks",  moderate: "3–6 weeks",  severe: "8–12 weeks" },
  calf:       { mild: "1–2 weeks",  moderate: "3–4 weeks",  severe: "6–8 weeks" },
  foot:       { mild: "2–3 weeks",  moderate: "4–6 weeks",  severe: "8–12 weeks (plantar fascia takes time)" },
  hip:        { mild: "1–2 weeks",  moderate: "3–4 weeks",  severe: "6–8 weeks" },
  glute:      { mild: "1–2 weeks",  moderate: "2–4 weeks",  severe: "4–6 weeks" },
  piriformis: { mild: "2–3 weeks",  moderate: "4–6 weeks",  severe: "6–10 weeks" },
  back:       { mild: "3–5 days",   moderate: "2–3 weeks",  severe: "4–6 weeks" },
  ankle:      { mild: "1–2 weeks",  moderate: "3–5 weeks",  severe: "6–10 weeks" },
  groin:      { mild: "1–2 weeks",  moderate: "3–5 weeks",  severe: "6–8 weeks" },
};

// Specific workout prescriptions for each cross-training modality.
// Injury-agnostic — intensity/duration guidance that's safe and aerobically effective.
// Injury-specific exclusions are handled in CROSS_TRAINING_ALTERNATIVES.
export const CROSS_TRAINING_WORKOUTS: Record<string, string> = {
  pool_running:
    "Aqua jogging with a float belt: 5 min easy warm-up, then alternate 2 min at moderate effort (feels like your easy run pace effort) / 1 min easy, repeat 10–12× for 35–45 min total. No belt required in shallow water (waist deep) but belt gives better running mechanics. Effort translates: it will feel easy on HR — that's expected.",
  swimming:
    "Aerobic swim set: 200m easy warm-up, then 6×100m at moderate effort (not sprinting — you should be able to hold a sentence between lengths) with 15s rest, then 200m easy cool-down. Total ~1100m, ~30–40 min. Any stroke works; freestyle and backstroke are easiest on most running injuries.",
  bike:
    "Stationary bike or outdoor easy ride: 5 min spin to warm up, then 40–50 min at Z2 effort (HR 65–75% of max, or 'you can hold a conversation'). Cadence 85–95 rpm — higher cadence, lower resistance protects the legs. For Zwift: any Z2 route or free ride, avoid group rides where pace surges.",
  elliptical:
    "Elliptical forward stride: 5 min easy, then 35–45 min at moderate effort (RPE 5–6/10). Keep resistance moderate (not maxed), aim for cadence around 90–100 strides/min. For variety: alternate 5 min moderate / 2 min slightly harder effort, repeat. Reverse stride engages the glutes differently — add 10 min if IT band or glute is the issue.",
  stair_stepper:
    "StairMaster or step mill: start at a pace where you can hold a steady rhythm without gripping the rails (holding the rails cuts the aerobic demand significantly). 5 min easy, then 25–35 min at a steady moderate pace — RPE 6/10, HR in Z2. For tempo work: alternate 3 min steady / 1 min faster for 30 min total. Keep your chest up and step through the full range — partial steps reduce the benefit.",
  rowing:
    "Rowing machine: 5 min easy rowing to warm up, then 30–40 min at steady aerobic effort. Damper setting 4–5 (not max — lower resistance means more strokes, more aerobic work). Stroke rate 22–24 spm at easy effort, up to 26–28 spm for moderate. Drive with the legs first, then lean back, then pull arms — correct sequencing protects the back. NOTE: avoid if injury involves calves, Achilles, ankles, or lower back.",
  hiking:
    "Easy trail or treadmill hiking: 45–60 min at a comfortable pace where you can hold a conversation. Incline 4–8% on a treadmill. This is active recovery, not a workout — the benefit is staying on your feet and maintaining some aerobic base without impact. Downhill increases eccentric leg load — keep it gentle.",
  walking:
    "Brisk walking: 45–60 min at a pace where you feel like you're moving with purpose (RPE 4/10, slightly more than a stroll). Good for the first few days of injury hold when cross-training is too much. Flat or gentle incline. Stop if your injury-site pain goes above 2/10.",
};

/** Parse "N–M weeks" strings from INJURY_TIMELINES into { min, max } week counts. */
export function getRecoveryEstimate(
  bodyPart: string,
  severity: "mild" | "moderate" | "severe" | null,
): { minWeeks: number; maxWeeks: number } | null {
  const key = bodyPart.toLowerCase().replace(/[^a-z_]/g, "_");
  const sev = severity ?? "moderate";
  const timeline = INJURY_TIMELINES[key]?.[sev];
  if (!timeline) return null;
  const match = timeline.match(/(\d+)[–-](\d+)/);
  if (!match) return null;
  return { minWeeks: parseInt(match[1]), maxWeeks: parseInt(match[2]) };
}

export interface RehabData {
  exercises: string[];
  crossTraining: string[];
}

/**
 * Look up rehab exercises and cross-training alternatives for a body part.
 * Returns null if the body part is not in the library (caller should fall through to full flow).
 */
export function getRehabData(bodyPart: string): RehabData | null {
  const key = bodyPart.toLowerCase().replace(/[^a-z_]/g, "_");
  const exercises = BODY_PART_EXERCISES[key];
  if (!exercises) return null;
  return {
    exercises,
    crossTraining: CROSS_TRAINING_ALTERNATIVES[key] ?? [],
  };
}

/**
 * Normalize a raw body part string to a known rehab key.
 * Returns null if no match found.
 */
export function normalizeBodyPart(raw: string): string | null {
  const lower = raw.toLowerCase();
  // Direct key match
  if (BODY_PART_EXERCISES[lower]) return lower;
  // Substring match against known parts
  for (const part of KNOWN_REHAB_PARTS) {
    const readable = part.replace(/_/g, " ");
    if (lower.includes(readable) || lower.includes(part)) return part;
  }
  // Common aliases
  if (lower.includes("achilles") || lower.includes("achilles")) return "calf";
  if (lower.includes("plantar") || lower.includes("arch")) return "foot";
  if (lower.includes("iliotibial") || lower.includes("it band")) return "it_band";
  if (lower.includes("hammy")) return "hamstring";
  if (lower.includes("glut")) return "glute";
  return null;
}
