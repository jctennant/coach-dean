import { describe, it, expect } from "vitest";
import { buildDeepStravaRead, type AnalysisRun } from "@/lib/onboarding-strava-analysis";

// Fixed "now": Fri Aug 8 2026, 12:00 UTC. Week starts Mon Aug 3.
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function run(daysAgo: number, miles: number, extra: Partial<AnalysisRun> = {}): AnalysisRun {
  return {
    start_date: new Date(NOW - daysAgo * DAY).toISOString(),
    distance_meters: miles * 1609.34,
    moving_time_seconds: miles * 9 * 60, // 9:00/mi
    elevation_gain: 0,
    average_heartrate: 145,
    activity_type: "Run",
    activity_name: null,
    workout_type: null,
    ...extra,
  };
}

describe("buildDeepStravaRead", () => {
  it("returns nothing when there isn't enough data to read", () => {
    const out = buildDeepStravaRead([run(2, 4), run(4, 5)], { lens: "race", nowMs: NOW });
    expect(out.text).toBe("");
    expect(out.groundTruthNumbers).toEqual([]);
  });

  it("ignores non-run activities and sub-quarter-mile entries", () => {
    const activities = [
      run(2, 6, { activity_type: "Ride", distance_meters: 30 * 1609.34 }),
      run(4, 0.1),
      run(6, 5),
      run(8, 5),
      run(10, 5),
    ];
    const out = buildDeepStravaRead(activities, { lens: "race", nowMs: NOW });
    // The 30mi ride must not appear anywhere in the read.
    expect(out.text).not.toContain("30");
  });

  it("shows a dated weekly build and the last 7 days run by run", () => {
    const activities = [
      run(1, 6, { activity_name: "Morning shakeout" }),
      run(3, 8),
      run(5, 4),
      run(9, 10),
      run(11, 5),
      run(16, 9),
      run(18, 5),
    ];
    const out = buildDeepStravaRead(activities, { lens: "race", nowMs: NOW });
    expect(out.text).toContain("WEEKLY BUILD (Mon–Sun, oldest→newest)");
    expect(out.text).toContain("LAST 7 DAYS");
    expect(out.text).toContain("(current, partial)");
    expect(out.text).toContain('"Morning shakeout"');
    expect(out.text).toMatch(/9:00\/mi/);
    expect(out.text).toMatch(/145 bpm avg/);
  });

  it("reports inactivity when nothing was logged in the last 7 days", () => {
    const activities = [run(12, 5), run(14, 6), run(16, 5), run(20, 7)];
    const out = buildDeepStravaRead(activities, { lens: "injury", nowMs: NOW });
    expect(out.text).toContain("LAST 7 DAYS: no runs logged");
    expect(out.text).toContain("12 days ago");
  });

  it("flags the biggest load jump with the week it happened", () => {
    // NOW is Sat Aug 8, so weeks run Mon Jul 20–Sun Jul 26 (20mi) and Mon Jul 27–Sun Aug 2 (32mi).
    const activities = [
      run(18, 10), run(16, 10), // week of Jul 20 → 20 mi
      run(11, 16), run(9, 16), // week of Jul 27 → 32 mi
      run(4, 8), // current partial week — excluded from jump math
    ];
    const out = buildDeepStravaRead(activities, { lens: "injury", nowMs: NOW });
    expect(out.text).toContain("Biggest load jump: 20 mi (wk of Jul 20) → 32 mi (wk of Jul 27), +60%");
    expect(out.groundTruthNumbers).toContain(60);
  });

  it("flags a big volume drop as an interruption to confirm, not a diagnosis", () => {
    const activities = [
      run(28, 15), run(26, 15), // 30mi
      run(21, 5), run(19, 3), // 8mi — big drop
      run(14, 4), run(12, 4),
    ];
    const out = buildDeepStravaRead(activities, { lens: "injury", nowMs: NOW });
    expect(out.text).toContain("Biggest volume drop");
    expect(out.text).toContain("confirm with the athlete");
  });

  it("flags consecutive build weeks with no down week", () => {
    const activities = [
      run(35, 10), run(33, 10),
      run(28, 13), run(26, 13),
      run(21, 16), run(19, 16),
      run(14, 19), run(12, 19),
    ];
    const out = buildDeepStravaRead(activities, { lens: "injury", nowMs: NOW });
    expect(out.text).toMatch(/straight weeks of increasing volume with no down week/);
  });

  it("surfaces run titles that mention pain, under the injury lens", () => {
    const activities = [
      run(20, 6, { activity_name: "Easy miles" }),
      run(18, 3, { activity_name: "Shin pain, cut short" }),
      run(16, 5, { activity_name: "Recovery jog" }),
      run(9, 4, { activity_name: "First run back" }),
    ];
    const out = buildDeepStravaRead(activities, { lens: "injury", nowMs: NOW });
    expect(out.text).toContain("RUN TITLES MENTIONING PAIN/INJURY");
    expect(out.text).toContain("Shin pain, cut short");
    expect(out.text).toContain("First run back");
    expect(out.text).not.toContain("Recovery jog");
    expect(out.text).toContain("not a diagnosis");
  });

  it("summarizes quality sessions from titles under the race lens", () => {
    const activities = [
      run(20, 6, { activity_name: "Easy" }),
      run(18, 7, { activity_name: "Tempo 4x1mi" }),
      run(12, 6, { activity_name: "Track intervals" }),
      run(5, 5, { activity_name: "Easy" }),
      run(3, 8, { activity_name: "Long run" }),
    ];
    const out = buildDeepStravaRead(activities, { lens: "race", nowMs: NOW });
    expect(out.text).toContain("QUALITY / HARD SESSIONS");
    expect(out.text).toContain("Tempo 4x1mi");
    expect(out.text).toContain("in the last 4 weeks");
  });

  it("says so when no quality work is identifiable, and hedges the claim", () => {
    const activities = [
      run(20, 6, { activity_name: "Easy" }),
      run(18, 6, { activity_name: "Morning miles" }),
      run(12, 6, { activity_name: "Easy" }),
      run(9, 6, { activity_name: "Lunch run" }),
      run(5, 6, { activity_name: "Evening jog" }),
      run(3, 8, { activity_name: "Long one" }),
    ];
    const out = buildDeepStravaRead(activities, { lens: "race", nowMs: NOW });
    expect(out.text).toContain("none identifiable from run titles");
    expect(out.text).toContain("not proof");
  });

  it("omits the quality/pace sections under the injury lens", () => {
    const activities = [
      run(20, 6, { activity_name: "Tempo 4x1mi" }),
      run(18, 6, { activity_name: "Easy" }),
      run(12, 6, { activity_name: "Track intervals" }),
      run(5, 6, { activity_name: "Easy" }),
    ];
    const out = buildDeepStravaRead(activities, { lens: "injury", nowMs: NOW });
    expect(out.text).not.toContain("QUALITY / HARD SESSIONS");
    expect(out.text).not.toContain("EASY-RUN PACE");
  });

  it("compares easy-run pace across halves of the window", () => {
    const slow = (daysAgo: number) => run(daysAgo, 6, { moving_time_seconds: 6 * 9.5 * 60 });
    const fast = (daysAgo: number) => run(daysAgo, 6, { moving_time_seconds: 6 * 8.75 * 60 });
    const activities = [slow(60), slow(56), slow(52), fast(12), fast(8), fast(4)];
    const out = buildDeepStravaRead(activities, { lens: "race", nowMs: NOW });
    expect(out.text).toContain("EASY-RUN PACE");
    expect(out.text).toMatch(/\d+s\/mi faster/);
  });

  it("states every figure it cites in groundTruthNumbers so the fact gate accepts them", () => {
    const activities = [run(18, 10), run(16, 10), run(11, 16), run(9, 16), run(3, 8)];
    const out = buildDeepStravaRead(activities, { lens: "race", nowMs: NOW });
    // Weekly totals from the build table must be citable.
    expect(out.groundTruthNumbers).toContain(20);
    expect(out.groundTruthNumbers).toContain(32);
    expect(out.groundTruthNumbers.length).toBeGreaterThan(5);
  });

  it("labels the lens in the header so the model knows what to look for", () => {
    const activities = [run(20, 6), run(14, 6), run(8, 6), run(3, 6)];
    expect(buildDeepStravaRead(activities, { lens: "injury", nowMs: NOW }).text).toContain("injury lens");
    expect(buildDeepStravaRead(activities, { lens: "race", nowMs: NOW }).text).toContain("race lens");
  });
});
