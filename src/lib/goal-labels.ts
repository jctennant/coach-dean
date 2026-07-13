/**
 * Human-readable label for a stored goal bucket (e.g. "half_marathon" → "a half marathon").
 * Used throughout the coaching prompt wherever a goal needs to read as prose rather than
 * a raw enum value. Falls back to the raw string for any goal not in the table (e.g. a
 * custom/legacy value) rather than throwing or returning something empty.
 */
export function formatGoalLabel(goal: string): string {
  const labels: Record<string, string> = {
    "mile": "a mile time trial",
    "5k": "a 5K",
    "10k": "a 10K",
    half_marathon: "a half marathon",
    marathon: "a marathon",
    general_fitness: "general fitness",
    return_to_running: "returning to running",
    "30k": "a 30K trail race",
    "50k": "a 50K ultra",
    "50mi": "a 50-mile ultra",
    "100k": "a 100K ultra",
    "100mi": "a 100-mile ultra",
    sprint_tri: "a sprint triathlon",
    olympic_tri: "an Olympic-distance triathlon",
    "70.3": "a 70.3 Half Ironman",
    ironman: "a Full Ironman",
    cycling: "a cycling event",
    injury_recovery: "injury recovery and return to running",
  };
  return labels[goal] || goal;
}
