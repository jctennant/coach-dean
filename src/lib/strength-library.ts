/**
 * Strength & injury-prevention exercise library.
 *
 * This is the single source of truth for the prehab/strength routines Coach Dean
 * prescribes. It powers two things:
 *   1. `composeStrengthRoutine()` — picks the right routine for an athlete from their
 *      injury history and returns a stored-routine object (written to
 *      training_profiles.dashboard_insights.strength_recovery and surfaced over SMS).
 *   2. The poster image set — each Routine has a stable `key` that doubles as the
 *      poster filename stem (e.g. routine "it_band" → /strength-posters/it_band.png).
 *      Run `npm run strength:catalog` to print the full list of routines + exercises
 *      to produce images for.
 *
 * The universe is intentionally small and fixed (~40 movements, ~12 routines) so the
 * art is a build-once asset set, never generated at runtime. Keep specs identical to
 * what Dean has always prescribed; the `cue` is a one-line form reminder.
 */

export interface Exercise {
  id: string;
  name: string;
  specs: string; // sets×reps or duration
  cue: string; // one-line form cue
}

export interface Routine {
  /** Stable id — also the poster filename stem. Never rename without re-keying posters. */
  key: string;
  /** Human label, e.g. "IT band". */
  label: string;
  /** Injury keywords that route here (lowercased substring match, priority order below). */
  matches: string[];
  frequency: string;
  /** Why this routine, for the athlete. */
  note: string;
  exerciseIds: string[];
}

/** Stored on training_profiles.dashboard_insights.strength_recovery. Shape kept
 *  backwards-compatible with the existing reader in coach/respond (name/specs/reason). */
export interface StoredStrengthRoutine {
  exercises: Array<{ name: string; specs: string; reason?: string }>;
  frequency: string;
  routine_key: string;
  poster_url: string;
  note: string;
}

// Base URL for the poster images. Override with NEXT_PUBLIC_STRENGTH_POSTER_BASE once
// the assets are hosted on a CDN; defaults to a path served from /public.
const POSTER_BASE =
  process.env.NEXT_PUBLIC_STRENGTH_POSTER_BASE?.replace(/\/$/, "") ?? "/strength-posters";

export function posterUrl(routineKey: string): string {
  return `${POSTER_BASE}/${routineKey}.png`;
}

/* ── Exercise catalog ───────────────────────────────────────────────────────── */

export const EXERCISES: Record<string, Exercise> = {
  clamshells: { id: "clamshells", name: "Hip abductor clamshells", specs: "3×15 (add a band above the knees once easy)", cue: "lie on your side, stack hips, open the top knee without rolling your pelvis back" },
  lateral_band_walks: { id: "lateral_band_walks", name: "Lateral band walks", specs: "2×20 steps each way", cue: "band above the knees, stay in a half-squat, small controlled steps, keep tension" },
  foam_roll_tfl: { id: "foam_roll_tfl", name: "Foam roll TFL & outer glute", specs: "1–2 min", cue: "roll the muscle just below the hip bone — never the IT band itself, that irritates it" },
  hip_flexor_stretch: { id: "hip_flexor_stretch", name: "Hip flexor lunge stretch", specs: "3×30s each side", cue: "half-kneel, tuck your pelvis under, press the hips forward — don't arch the low back" },
  nordic_curls: { id: "nordic_curls", name: "Eccentric Nordic hamstring curls", specs: "3×8 (towel under knees)", cue: "anchor your ankles, lower as slowly as you can, hands ready to catch you" },
  single_leg_rdl: { id: "single_leg_rdl", name: "Single-leg Romanian deadlift", specs: "3×10 each", cue: "hinge at the hip with a flat back, feel the standing-leg hamstring load" },
  prone_hamstring_raise: { id: "prone_hamstring_raise", name: "Prone hamstring raises", specs: "3×12", cue: "lie face down, bend the knee to lift your heel toward your glute, slow" },
  glute_bridge: { id: "glute_bridge", name: "Glute bridges", specs: "3×15 (2-sec hold at top)", cue: "drive through your heels, squeeze the glutes, ribs down — don't arch the back" },
  single_leg_glute_bridge: { id: "single_leg_glute_bridge", name: "Single-leg glute bridges", specs: "3×12 each", cue: "one foot planted, other leg extended, keep your hips level the whole time" },
  hip_thrust: { id: "hip_thrust", name: "Hip thrusts", specs: "3×15", cue: "shoulders on a bench/couch, drive the hips up, chin tucked" },
  side_lying_hip_abduction: { id: "side_lying_hip_abduction", name: "Side-lying hip abduction", specs: "3×15 each", cue: "lift the top leg straight up leading with the heel, don't roll the hip back" },
  vmo_quad_set: { id: "vmo_quad_set", name: "VMO quad sets", specs: "3×15", cue: "sit with the leg straight, tighten the thigh, hold 5s, relax" },
  tke: { id: "tke", name: "Terminal knee extensions (band)", specs: "3×15", cue: "loop a band behind the knee, straighten the leg fully against it" },
  step_down: { id: "step_down", name: "Step-downs", specs: "3×10 each", cue: "from a 6-inch step, lower slowly over 3s, keep the knee tracking over your toes" },
  straight_leg_raise: { id: "straight_leg_raise", name: "Straight-leg raises", specs: "3×15", cue: "lie back, lock the leg straight, lift to ~45° and lower slowly" },
  ecc_calf_raise_straight: { id: "ecc_calf_raise_straight", name: "Eccentric calf raises (straight knee)", specs: "3×15", cue: "off a step, rise on both feet, lower slowly on the working leg" },
  tib_anterior_raise: { id: "tib_anterior_raise", name: "Tibialis anterior raises", specs: "3×15", cue: "stand with your back to a wall, heels down, lift your toes toward your shins" },
  calf_stretch: { id: "calf_stretch", name: "Calf stretch (straight + bent knee)", specs: "3×30s each", cue: "back heel down against a wall, hold both the straight- and bent-knee positions" },
  toe_taps: { id: "toe_taps", name: "Toe taps on a stair", specs: "2×20", cue: "controlled light taps — you should feel the front of the shin working" },
  ecc_heel_drop: { id: "ecc_heel_drop", name: "Eccentric heel drops", specs: "3×15 straight + 3×15 bent knee", cue: "rise on two feet, lower slowly on the affected leg off a step edge" },
  single_leg_calf_raise: { id: "single_leg_calf_raise", name: "Single-leg calf raises", specs: "3×20", cue: "full range, pause at the top, controlled down" },
  soleus_stretch: { id: "soleus_stretch", name: "Soleus stretch (bent knee)", specs: "3×30s", cue: "back knee slightly bent, heel stays down" },
  ankle_circles: { id: "ankle_circles", name: "Ankle circles", specs: "2×10 each direction", cue: "slow, full range of motion" },
  frozen_bottle_roll: { id: "frozen_bottle_roll", name: "Frozen bottle arch roll", specs: "2 min each foot", cue: "roll the arch back and forth over a frozen water bottle" },
  towel_toe_curl: { id: "towel_toe_curl", name: "Towel toe curls", specs: "3×15", cue: "scrunch a towel toward you using only your toes" },
  short_foot: { id: "short_foot", name: "Short-foot arch activation", specs: "3×10 (5s holds)", cue: "lift the arch without curling the toes, hold, release" },
  pigeon_pose: { id: "pigeon_pose", name: "Pigeon pose", specs: "2×60s each side", cue: "front shin angled, hips square, sink slowly — never force it" },
  figure_4_stretch: { id: "figure_4_stretch", name: "Figure-4 stretch (lying)", specs: "3×60s each side", cue: "ankle over the opposite knee, pull the thigh toward your chest" },
  seated_piriformis_stretch: { id: "seated_piriformis_stretch", name: "Seated piriformis stretch", specs: "3×30s", cue: "cross the ankle over the knee, hinge forward with a flat back" },
  cat_cow: { id: "cat_cow", name: "Cat-cow", specs: "10 slow reps", cue: "move slowly between rounding and arching, breathe with it" },
  bird_dog: { id: "bird_dog", name: "Bird-dog", specs: "3×10 each side", cue: "extend opposite arm + leg, keep your hips level, no rotation" },
  childs_pose: { id: "childs_pose", name: "Child's pose", specs: "2×60s", cue: "hips back to heels, arms long, breathe into the low back" },
  dead_bug: { id: "dead_bug", name: "Dead bug", specs: "3×8 each side", cue: "low back pinned to the floor, extend opposite arm + leg slowly" },
  single_leg_balance: { id: "single_leg_balance", name: "Single-leg balance", specs: "3×30s each", cue: "soft knee, use an unstable surface (pillow) once steady" },
  band_dorsiflexion: { id: "band_dorsiflexion", name: "Resistance-band dorsiflexion", specs: "3×15", cue: "band around the foot, pull your toes toward you against it" },
  ankle_alphabet: { id: "ankle_alphabet", name: "Ankle alphabet", specs: "draw A–Z, each foot", cue: "slowly trace each letter with your foot, full range" },
  side_lying_hip_adduction: { id: "side_lying_hip_adduction", name: "Side-lying hip adduction", specs: "3×15 each side", cue: "lift the bottom (inner-thigh) leg toward the ceiling, low and controlled" },
  seated_adductor_isometric: { id: "seated_adductor_isometric", name: "Seated adductor squeeze", specs: "3×15 (10s holds)", cue: "squeeze a ball or pillow between your knees, hold, release" },
  butterfly_stretch: { id: "butterfly_stretch", name: "Seated butterfly stretch", specs: "3×30s", cue: "soles together, let gravity open the knees — gravity only, no forcing" },
  single_leg_squat: { id: "single_leg_squat", name: "Single-leg squat (to a chair)", specs: "3×8 each", cue: "sit back to a chair on one leg, knee tracks over the toes, control the lower" },
  front_plank: { id: "front_plank", name: "Front plank", specs: "3×30–45s", cue: "straight line head to heels, brace the core, don't let the hips sag" },
  side_plank: { id: "side_plank", name: "Side plank (hip lifts)", specs: "3×20–30s each", cue: "elbow under the shoulder, lift the hips, add small dips once steady" },
};

/* ── Routines ───────────────────────────────────────────────────────────────── */

const REHAB_FREQ = "3–5× per week — these are gentle; stop any rep that climbs past 2/10 pain";
const PREVENT_FREQ = "2× per week, ideally as a 15-min warm-up before an easy run";

/** Routines in priority order — `composeStrengthRoutine` matches the FIRST routine whose
 *  `matches` keyword appears in the athlete's injury text. More specific terms come first. */
export const ROUTINES: Routine[] = [
  { key: "it_band", label: "IT band", matches: ["it band", "itb", "iliotibial"], frequency: REHAB_FREQ,
    note: "Builds the glute-med strength that stops the IT band overloading, and calms the lateral knee.",
    exerciseIds: ["clamshells", "lateral_band_walks", "foam_roll_tfl", "hip_flexor_stretch"] },
  { key: "shin", label: "Shin splints", matches: ["shin", "tibia", "medial tibial", "mtss"], frequency: REHAB_FREQ,
    note: "Loads the tibialis and calf so the shin can handle ground impact without flaring.",
    exerciseIds: ["ecc_calf_raise_straight", "tib_anterior_raise", "calf_stretch", "toe_taps"] },
  { key: "calf", label: "Calf / Achilles", matches: ["calf", "achilles", "soleus", "gastroc"], frequency: REHAB_FREQ,
    note: "Eccentric calf loading is the best-evidenced rehab for Achilles and calf strain.",
    exerciseIds: ["ecc_heel_drop", "single_leg_calf_raise", "soleus_stretch", "ankle_circles"] },
  { key: "knee", label: "Runner's knee", matches: ["knee", "patella", "patellar", "pf ", "kneecap", "pfps"], frequency: REHAB_FREQ,
    note: "Quad and glute strength to track the kneecap properly and offload the joint.",
    exerciseIds: ["vmo_quad_set", "tke", "step_down", "straight_leg_raise"] },
  { key: "hamstring", label: "Hamstring", matches: ["hamstring", "ham ", "biceps femoris"], frequency: REHAB_FREQ,
    note: "Eccentric hamstring loading to build strain resilience through full range.",
    exerciseIds: ["nordic_curls", "single_leg_rdl", "prone_hamstring_raise", "glute_bridge"] },
  { key: "foot", label: "Foot / plantar fascia", matches: ["plantar", "foot", "arch", "fascia", "heel"], frequency: REHAB_FREQ,
    note: "Calms the plantar fascia and rebuilds the intrinsic foot strength that supports the arch.",
    exerciseIds: ["frozen_bottle_roll", "towel_toe_curl", "ecc_calf_raise_straight", "short_foot"] },
  { key: "piriformis", label: "Piriformis", matches: ["piriformis", "sciatic"], frequency: REHAB_FREQ,
    note: "Releases the piriformis and builds hip rotator control to stop it gripping.",
    exerciseIds: ["figure_4_stretch", "pigeon_pose", "seated_piriformis_stretch", "clamshells"] },
  { key: "groin", label: "Groin / adductor", matches: ["groin", "adductor", "inner thigh", "pubic"], frequency: REHAB_FREQ,
    note: "Low-load adductor strengthening — gentle and pregnancy-safe.",
    exerciseIds: ["side_lying_hip_adduction", "seated_adductor_isometric", "butterfly_stretch", "clamshells"] },
  { key: "glute", label: "Glute", matches: ["glute", "gluteal", "buttock"], frequency: REHAB_FREQ,
    note: "Glute strength is the foundation for hip and knee stability when you run.",
    exerciseIds: ["clamshells", "single_leg_glute_bridge", "hip_thrust", "side_lying_hip_abduction"] },
  { key: "hip", label: "Hip", matches: ["hip flexor", "hip"], frequency: REHAB_FREQ,
    note: "Mobilizes tight hip flexors and strengthens the glutes that share the load.",
    exerciseIds: ["hip_flexor_stretch", "glute_bridge", "lateral_band_walks", "pigeon_pose"] },
  { key: "ankle", label: "Ankle", matches: ["ankle", "sprain", "rolled"], frequency: REHAB_FREQ,
    note: "Rebuilds ankle strength, range, and the balance that prevents re-spraining.",
    exerciseIds: ["ecc_calf_raise_straight", "single_leg_balance", "band_dorsiflexion", "ankle_alphabet"] },
  { key: "back", label: "Lower back", matches: ["back", "lumbar", "si joint", "sacroiliac"], frequency: REHAB_FREQ,
    note: "Gentle mobility plus core control to settle the low back and support running posture.",
    exerciseIds: ["cat_cow", "bird_dog", "childs_pose", "dead_bug"] },
  // Default / universal base — strongest general evidence (Run RCT). Used when there's an
  // injury history but no recognizable body part, or as the everyone-benefits routine.
  { key: "hip_core", label: "Hip & core base", matches: [], frequency: PREVENT_FREQ,
    note: "The strongest general injury-prevention evidence we have (Run RCT, Leppänen 2024): hip + core strength twice a week cut overuse injuries roughly in half.",
    exerciseIds: ["side_plank", "single_leg_squat", "single_leg_glute_bridge", "lateral_band_walks", "front_plank"] },
];

const ROUTINE_BY_KEY: Record<string, Routine> = Object.fromEntries(ROUTINES.map((r) => [r.key, r]));

export function getRoutine(key: string): Routine | null {
  return ROUTINE_BY_KEY[key] ?? null;
}

/** Map a free-text injury description to a routine key, or null if nothing matches.
 *  Scans ROUTINES in priority order (specific terms first). */
export function routineKeyForInjuryText(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const r of ROUTINES) {
    if (r.matches.some((m) => t.includes(m))) return r.key;
  }
  return null;
}

export interface ComposeInput {
  /** Body-part fields from the profile (injury_body_part, injury_body_parts[]). */
  bodyParts?: Array<string | null | undefined>;
  /** Free-text injury history / notes (injury_notes). */
  injuryText?: string | null;
}

/**
 * Pick the right routine for an athlete and return the stored-routine object.
 *
 * Returns null only when there is no injury signal at all (no body part, no history) —
 * in that case the caller should fall back to recommending the hip & core base directly
 * rather than implying a personalized routine exists.
 */
export function composeStrengthRoutine(input: ComposeInput): StoredStrengthRoutine | null {
  const haystack = [...(input.bodyParts ?? []), input.injuryText]
    .filter(Boolean)
    .join(" | ");
  if (!haystack.trim()) return null;

  const key = routineKeyForInjuryText(haystack) ?? "hip_core";
  return buildStoredRoutine(key);
}

/** Build the stored-routine object for a known routine key. */
export function buildStoredRoutine(key: string): StoredStrengthRoutine | null {
  const routine = getRoutine(key);
  if (!routine) return null;
  return {
    exercises: routine.exerciseIds.map((id) => {
      const e = EXERCISES[id];
      return { name: e.name, specs: e.specs, reason: e.cue };
    }),
    frequency: routine.frequency,
    routine_key: routine.key,
    poster_url: posterUrl(routine.key),
    note: routine.note,
  };
}
