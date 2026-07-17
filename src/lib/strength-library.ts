/**
 * Strength & injury-prevention exercise library.
 *
 * This is the single source of truth for the prehab/strength routines Coach Dean
 * prescribes. It powers two things:
 *   1. `composeStrengthRoutine()` — picks the right routine for an athlete from their
 *      injury history and returns a stored-routine object (written to
 *      training_profiles.dashboard_insights.strength_recovery and surfaced over SMS).
 *   2. The per-exercise image set — each Exercise has a stable `id` that doubles as the
 *      image filename stem (e.g. "clamshells" → /strength-exercises/clamshells.png).
 *      Images are shared across every routine that references that exercise. Run
 *      `npm run strength:catalog` to print the full art spec (one entry per exercise).
 *
 * The universe is intentionally small and fixed (~53 movements, ~13 routines, 9-10
 * exercises each — a full 20-30 min session; hip_core runs to 13, closing with
 * running-specific drills that only belong in the no-injury general routine) so the
 * art is a build-once asset set, never generated at runtime. Keep specs identical to
 * what Dean has always prescribed; the `cue` is a one-line form reminder.
 *
 * Server-only module: `hasExerciseImage()` reads the filesystem (node:fs), so this file
 * must never be imported from a "use client" component — only from server components
 * (e.g. /plan/[token]/page.tsx) or API routes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

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

// Base URL for individual per-exercise illustrations — one image per EXERCISES entry,
// reused across every routine that references it (e.g. clamshells.png is shared by 6
// routines). Separate from POSTER_BASE/routine posters so each can be hosted/rolled out
// independently. Override with NEXT_PUBLIC_STRENGTH_EXERCISE_POSTER_BASE for a CDN.
const EXERCISE_POSTER_BASE =
  process.env.NEXT_PUBLIC_STRENGTH_EXERCISE_POSTER_BASE?.replace(/\/$/, "") ?? "/strength-exercises";

export function exercisePosterUrl(exerciseId: string): string {
  return `${EXERCISE_POSTER_BASE}/${exerciseId}.png`;
}

/**
 * Whether an illustration has actually been produced for this exercise yet. Art is
 * rolled out incrementally (53 exercises to commission), so callers must check this
 * before rendering/sending an image — a 404 breaks the SMS media attachment entirely
 * (Linq re-hosts the URL and fails the whole send on a missing file) and would show a
 * broken-image icon on the dashboard.
 */
export function hasExerciseImage(exerciseId: string): boolean {
  try {
    return existsSync(join(process.cwd(), "public", "strength-exercises", `${exerciseId}.png`));
  } catch {
    return false;
  }
}

/**
 * Catalog exercise IDs that currently have committed art. Used to enum-constrain the
 * `exercise_ids` argument on the coaching tool call, so Claude can only ever name an
 * exercise we can actually illustrate — never a hallucinated or not-yet-drawn one.
 */
export function illustratedExerciseIds(): string[] {
  return Object.keys(EXERCISES).filter(hasExerciseImage);
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
  monster_walk: { id: "monster_walk", name: "Banded monster walks", specs: "2×20 steps diagonal", cue: "band above the knees, wide low squat stance, small controlled diagonal steps" },
  wall_sit: { id: "wall_sit", name: "Wall sit", specs: "3×30–45s", cue: "thighs parallel to the floor, back flat against the wall, weight through the heels" },
  leg_swings: { id: "leg_swings", name: "Leg swings (front-back + side-side)", specs: "2×10 each direction, each leg", cue: "hold something for balance, swing from the hip with a soft knee, don't force the range" },
  worlds_greatest_stretch: { id: "worlds_greatest_stretch", name: "World's greatest stretch", specs: "5 each side", cue: "lunge forward, drop the back knee, rotate the same-side elbow toward the sky" },
  superman: { id: "superman", name: "Superman raises", specs: "3×12 (2-sec hold)", cue: "lie face down, lift chest and legs together, squeeze glutes and low back, don't overextend the neck" },
  copenhagen_plank: { id: "copenhagen_plank", name: "Copenhagen plank (adductor)", specs: "3×15–20s each side", cue: "top foot on a bench, lift the hips level, start with the knee-bent regression if it's too hard" },
  reverse_nordic: { id: "reverse_nordic", name: "Reverse Nordic (kneeling quad)", specs: "3×8", cue: "kneel tall, lean back slowly from the knees keeping hips extended, catch yourself with control" },
  fire_hydrant: { id: "fire_hydrant", name: "Fire hydrants", specs: "3×12 each side", cue: "on hands and knees, lift the bent knee out to the side without rotating the torso or dropping the hip" },
  a_skip: { id: "a_skip", name: "A-skips", specs: "3×20m", cue: "drive the knee up to hip height with a quick ground contact, pump the opposite arm" },
  high_knees: { id: "high_knees", name: "High knees", specs: "3×20m", cue: "quick cadence, drive the knees up, land under your hips rather than out in front" },
  bounding: { id: "bounding", name: "Bounding", specs: "3×20m", cue: "exaggerated running stride, drive off the ground and reach forward, land soft and absorb through the hip" },
};

/* ── Routines ───────────────────────────────────────────────────────────────── */

const REHAB_FREQ = "3–5× per week, 20–30 min per session — these are gentle; stop any rep that climbs past 2/10 pain";
const PREVENT_FREQ = "2× per week as its own 20–30 min session";

/** Routines in priority order — `composeStrengthRoutine` matches the FIRST routine whose
 *  `matches` keyword appears in the athlete's injury text. More specific terms come first. */
export const ROUTINES: Routine[] = [
  { key: "it_band", label: "IT band", matches: ["it band", "itb", "iliotibial"], frequency: REHAB_FREQ,
    note: "Builds the glute-med strength that stops the IT band overloading, and calms the lateral knee.",
    exerciseIds: ["leg_swings", "clamshells", "lateral_band_walks", "monster_walk", "side_lying_hip_abduction", "single_leg_glute_bridge", "foam_roll_tfl", "hip_flexor_stretch", "single_leg_balance"] },
  { key: "shin", label: "Shin splints", matches: ["shin", "tibia", "medial tibial", "mtss"], frequency: REHAB_FREQ,
    note: "Loads the tibialis and calf so the shin can handle ground impact without flaring.",
    exerciseIds: ["toe_taps", "tib_anterior_raise", "band_dorsiflexion", "ecc_calf_raise_straight", "single_leg_calf_raise", "calf_stretch", "soleus_stretch", "ankle_alphabet", "single_leg_balance"] },
  { key: "calf", label: "Calf / Achilles", matches: ["calf", "achilles", "soleus", "gastroc"], frequency: REHAB_FREQ,
    note: "Eccentric calf loading is the best-evidenced rehab for Achilles and calf strain.",
    exerciseIds: ["ankle_circles", "ecc_heel_drop", "single_leg_calf_raise", "soleus_stretch", "calf_stretch", "toe_taps", "tib_anterior_raise", "single_leg_balance", "ankle_alphabet"] },
  { key: "knee", label: "Runner's knee", matches: ["knee", "patella", "patellar", "pf ", "kneecap", "pfps"], frequency: REHAB_FREQ,
    note: "Quad and glute strength to track the kneecap properly and offload the joint.",
    exerciseIds: ["leg_swings", "vmo_quad_set", "tke", "step_down", "straight_leg_raise", "single_leg_squat", "wall_sit", "glute_bridge", "single_leg_balance", "reverse_nordic"] },
  { key: "hamstring", label: "Hamstring", matches: ["hamstring", "ham ", "biceps femoris"], frequency: REHAB_FREQ,
    note: "Eccentric hamstring loading to build strain resilience through full range.",
    exerciseIds: ["leg_swings", "nordic_curls", "single_leg_rdl", "prone_hamstring_raise", "glute_bridge", "single_leg_glute_bridge", "hip_thrust", "bird_dog", "single_leg_balance"] },
  { key: "foot", label: "Foot / plantar fascia", matches: ["plantar", "foot", "arch", "fascia", "heel"], frequency: REHAB_FREQ,
    note: "Calms the plantar fascia and rebuilds the intrinsic foot strength that supports the arch.",
    exerciseIds: ["ankle_circles", "frozen_bottle_roll", "towel_toe_curl", "short_foot", "ecc_calf_raise_straight", "single_leg_calf_raise", "calf_stretch", "single_leg_balance", "toe_taps"] },
  { key: "piriformis", label: "Piriformis", matches: ["piriformis", "sciatic"], frequency: REHAB_FREQ,
    note: "Releases the piriformis and builds hip rotator control to stop it gripping.",
    exerciseIds: ["cat_cow", "figure_4_stretch", "pigeon_pose", "seated_piriformis_stretch", "clamshells", "fire_hydrant", "lateral_band_walks", "glute_bridge", "bird_dog", "single_leg_balance"] },
  { key: "groin", label: "Groin / adductor", matches: ["groin", "adductor", "inner thigh", "pubic"], frequency: REHAB_FREQ,
    note: "Low-load adductor strengthening — gentle and pregnancy-safe.",
    exerciseIds: ["leg_swings", "side_lying_hip_adduction", "seated_adductor_isometric", "butterfly_stretch", "clamshells", "copenhagen_plank", "glute_bridge", "single_leg_balance", "bird_dog"] },
  { key: "glute", label: "Glute", matches: ["glute", "gluteal", "buttock"], frequency: REHAB_FREQ,
    note: "Glute strength is the foundation for hip and knee stability when you run.",
    exerciseIds: ["leg_swings", "clamshells", "single_leg_glute_bridge", "hip_thrust", "side_lying_hip_abduction", "lateral_band_walks", "monster_walk", "single_leg_squat", "front_plank", "single_leg_balance"] },
  { key: "hip", label: "Hip", matches: ["hip flexor", "hip"], frequency: REHAB_FREQ,
    note: "Mobilizes tight hip flexors and strengthens the glutes that share the load.",
    exerciseIds: ["worlds_greatest_stretch", "hip_flexor_stretch", "glute_bridge", "lateral_band_walks", "pigeon_pose", "clamshells", "single_leg_glute_bridge", "hip_thrust", "single_leg_balance"] },
  { key: "pelvis", label: "Pelvic girdle", matches: ["pelvis", "pelvic"], frequency: REHAB_FREQ,
    note: "Pelvis pain can come from the SI joint, pubic symphysis, or general girdle instability — this builds the deep core and glute stabilizers that support the whole pelvic girdle regardless of the exact source. If pain is sharp, one-sided at the pubic bone, or worsens with single-leg hopping, flag it for a sports physio rather than pushing through.",
    exerciseIds: ["cat_cow", "dead_bug", "bird_dog", "glute_bridge", "single_leg_glute_bridge", "clamshells", "hip_thrust", "front_plank", "side_plank"] },
  { key: "ankle", label: "Ankle", matches: ["ankle", "sprain", "rolled"], frequency: REHAB_FREQ,
    note: "Rebuilds ankle strength, range, and the balance that prevents re-spraining.",
    exerciseIds: ["ankle_circles", "ecc_calf_raise_straight", "single_leg_balance", "band_dorsiflexion", "ankle_alphabet", "single_leg_calf_raise", "toe_taps", "soleus_stretch", "calf_stretch"] },
  { key: "back", label: "Lower back", matches: ["back", "lumbar", "si joint", "sacroiliac"], frequency: REHAB_FREQ,
    note: "Gentle mobility plus core control to settle the low back and support running posture.",
    exerciseIds: ["cat_cow", "bird_dog", "childs_pose", "dead_bug", "glute_bridge", "front_plank", "side_plank", "superman", "pigeon_pose"] },
  // Default / universal base — strongest general evidence (Run RCT). Used when there's an
  // injury history but no recognizable body part, or as the everyone-benefits routine.
  { key: "hip_core", label: "Hip & core base", matches: [], frequency: PREVENT_FREQ,
    note: "The strongest general injury-prevention evidence we have (Run RCT, Leppänen 2024): hip + core strength twice a week cut overuse injuries roughly in half. Closes with running-specific drills — skip these if returning from injury.",
    exerciseIds: ["worlds_greatest_stretch", "side_plank", "single_leg_squat", "single_leg_glute_bridge", "lateral_band_walks", "front_plank", "clamshells", "dead_bug", "bird_dog", "hip_thrust", "a_skip", "high_knees", "bounding"] },
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
