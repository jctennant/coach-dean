#!/usr/bin/env node
/**
 * Prints the strength exercise art spec as markdown.
 *
 *   node scripts/strength-catalog.mjs            # print to stdout
 *   node scripts/strength-catalog.mjs > docs/strength-routines.md
 *
 * Reads the catalog straight out of the TS source so it never drifts from the library.
 *
 * Art is one illustration PER EXERCISE (not per routine) — exercises are heavily reused
 * across routines (e.g. clamshells appears in 6 of them), so the primary output below is
 * a flat, deduped list: one entry per distinct exercise id, filename = `<id>.png`, dropped
 * in `/public/strength-exercises/` (or a CDN via NEXT_PUBLIC_STRENGTH_EXERCISE_POSTER_BASE).
 * A routine-grouped reference section follows for context on how exercises combine.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "../src/lib/strength-library.ts"), "utf8");

// Lightweight extraction — avoids a TS build step. Parses the EXERCISES and ROUTINES literals.
function parseExercises(text) {
  const block = text.split("export const EXERCISES")[1].split("export const ROUTINES")[0];
  const out = {};
  const re = /(\w+):\s*\{\s*id:\s*"[^"]+",\s*name:\s*"([^"]+)",\s*specs:\s*"([^"]+)",\s*cue:\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = { name: m[2], specs: m[3], cue: m[4] };
  return out;
}

function parseRoutines(text) {
  const block = text.split("export const ROUTINES")[1].split("const ROUTINE_BY_KEY")[0];
  const routines = [];
  const re = /\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*matches:\s*\[([^\]]*)\],\s*frequency:\s*([A-Z_]+|"[^"]*"),\s*\n?\s*note:\s*"([^"]+)",\s*\n?\s*exerciseIds:\s*\[([^\]]*)\]\s*\}/g;
  let m;
  while ((m = re.exec(block))) {
    routines.push({
      key: m[1],
      label: m[2],
      note: m[5],
      exerciseIds: m[6].split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean),
    });
  }
  return routines;
}

const EXERCISES = parseExercises(src);
const ROUTINES = parseRoutines(src);

// Which routines use each exercise, in catalog order — gives the artist context on how
// an exercise is used (e.g. "used in 6 routines" signals it's a foundational move).
const routinesByExercise = {};
for (const r of ROUTINES) {
  for (const id of r.exerciseIds) {
    (routinesByExercise[id] ??= []).push(r.label);
  }
}

const exerciseIds = Object.keys(EXERCISES);

const lines = [];
lines.push("# Strength exercise art spec");
lines.push("");
lines.push(`Generated from \`src/lib/strength-library.ts\`. One illustration per exercise below — filename = \`<id>.png\`, dropped in \`/public/strength-exercises/\` (or your CDN via \`NEXT_PUBLIC_STRENGTH_EXERCISE_POSTER_BASE\`).`);
lines.push("");
lines.push(`**${exerciseIds.length} distinct exercises · ${ROUTINES.length} routines that combine them.**`);
lines.push("");
lines.push("> Art guidance: simple line-art / diagram style with a movement-direction arrow reads clearer than photoreal and is far more reliable to generate. Each exercise gets its own full frame now (not sharing a quadrant with 3 others) — use the extra room for a form cue or common-mistake callout. Always review each for anatomical correctness before shipping — a wrong pose in an injury context is worse than none.");
lines.push("");
lines.push("## Exercises to produce");
lines.push("");

for (const id of exerciseIds) {
  const e = EXERCISES[id];
  const usedIn = routinesByExercise[id] ?? [];
  lines.push(`### ${e.name}  —  \`${id}.png\``);
  lines.push("");
  lines.push(`- Specs: ${e.specs}`);
  lines.push(`- Cue: _${e.cue}_`);
  lines.push(`- Used in: ${usedIn.length > 0 ? usedIn.join(", ") : "(unused)"}`);
  lines.push("");
}

lines.push("---");
lines.push("");
lines.push("## Routines (reference — how exercises combine)");
lines.push("");

for (const r of ROUTINES) {
  lines.push(`### ${r.label}  —  \`${r.key}\``);
  lines.push("");
  lines.push(`_${r.note}_`);
  lines.push("");
  for (const id of r.exerciseIds) {
    const e = EXERCISES[id];
    if (!e) { lines.push(`- **(missing exercise: ${id})**`); continue; }
    lines.push(`- ${e.name} (\`${id}.png\`)`);
  }
  lines.push("");
}

process.stdout.write(lines.join("\n") + "\n");
