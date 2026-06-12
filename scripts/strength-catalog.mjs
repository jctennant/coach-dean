#!/usr/bin/env node
/**
 * Prints the full strength routine catalog as markdown — one section per routine, which is
 * exactly the set of poster images to produce (one poster per routine `key`).
 *
 *   node scripts/strength-catalog.mjs            # print to stdout
 *   node scripts/strength-catalog.mjs > docs/strength-routines.md
 *
 * Reads the catalog straight out of the TS source so it never drifts from the library.
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

const lines = [];
lines.push("# Strength routine catalog — posters to produce");
lines.push("");
lines.push(`Generated from \`src/lib/strength-library.ts\`. One poster per routine below — filename = \`<key>.png\`, dropped in \`/public/strength-posters/\` (or your CDN via \`NEXT_PUBLIC_STRENGTH_POSTER_BASE\`).`);
lines.push("");
lines.push(`**${ROUTINES.length} routines · ${Object.keys(EXERCISES).length} distinct exercises.**`);
lines.push("");
lines.push("> Art guidance: simple line-art / diagram style with a movement-direction arrow per exercise reads clearer than photoreal and is far more reliable to generate. Always review each for anatomical correctness before shipping — a wrong pose in an injury context is worse than none.");
lines.push("");

for (const r of ROUTINES) {
  lines.push(`## ${r.label}  —  \`${r.key}.png\``);
  lines.push("");
  lines.push(`_${r.note}_`);
  lines.push("");
  for (const id of r.exerciseIds) {
    const e = EXERCISES[id];
    if (!e) { lines.push(`- **(missing exercise: ${id})**`); continue; }
    lines.push(`- **${e.name}** — ${e.specs}  \n  _${e.cue}_`);
  }
  lines.push("");
}

process.stdout.write(lines.join("\n") + "\n");
