import { describe, it, expect } from "vitest";
import { buildDateContext } from "@/lib/coach-date-context";

// Sunday, July 12, 2026, 3pm UTC — the same date the day-of-week bug was found on.
const NOW = new Date("2026-07-12T15:00:00Z");

describe("buildDateContext", () => {
  it("produces correct today/yesterday/tomorrow/next-7-days for a timezone behind UTC", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: null,
      overrideDays: null,
      overrideExpires: null,
      recentMessages: [],
    });
    expect(result.todayStr).toBe("Sunday, July 12, 2026");
    expect(result.todayLocal).toBe("2026-07-12");
    expect(result.header).toContain("- Today: Sunday, July 12, 2026");
    expect(result.header).toContain("- Yesterday: Saturday, Jul 11");
    expect(result.header).toContain("- Tomorrow: Monday, Jul 13");
    expect(result.header).toContain("Monday, Jul 13 | Tuesday, Jul 14 | Wednesday, Jul 15");
  });

  it("computes rest days as the training days' complement", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: ["monday", "wednesday", "friday", "saturday"],
      overrideDays: null,
      overrideExpires: null,
      recentMessages: [],
    });
    expect(result.restDays).toEqual(["Tuesday", "Thursday", "Sunday"]);
  });

  it("returns no rest days when the athlete has no training-days data", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: null,
      overrideDays: null,
      overrideExpires: null,
      recentMessages: [],
    });
    expect(result.restDays).toEqual([]);
  });

  it("uses an active this-week override instead of the base training days", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: ["monday", "wednesday", "friday"],
      overrideDays: ["tuesday", "thursday"],
      overrideExpires: "2026-07-31", // still in the future relative to NOW
      recentMessages: [],
    });
    expect(result.restDays).toEqual(["Monday", "Wednesday", "Friday", "Saturday", "Sunday"]);
  });

  it("ignores an expired this-week override and falls back to base training days", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: ["monday", "wednesday", "friday"],
      overrideDays: ["tuesday", "thursday"],
      overrideExpires: "2026-07-01", // already expired relative to NOW
      recentMessages: [],
    });
    expect(result.restDays).toEqual(["Tuesday", "Thursday", "Saturday", "Sunday"]);
  });

  it("omits the conversation window note when there are no recent messages", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: null,
      overrideDays: null,
      overrideExpires: null,
      recentMessages: [],
    });
    expect(result.header).not.toContain("Conversation window");
    expect(result.header).not.toContain("GAP ALERT");
  });

  it("flags a gap when the most recent message is 3+ days old", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: null,
      overrideDays: null,
      overrideExpires: null,
      recentMessages: [
        { created_at: "2026-07-01T12:00:00Z" },
        { created_at: "2026-07-05T12:00:00Z" }, // 7 days before NOW
      ],
    });
    expect(result.header).toContain("Conversation window: 2 messages");
    expect(result.header).toContain("GAP ALERT");
    expect(result.header).toContain("7 days ago");
  });

  it("does not flag a gap for a message from within the last 2 days", () => {
    const result = buildDateContext({
      tz: "America/New_York",
      now: NOW,
      trainingDays: null,
      overrideDays: null,
      overrideExpires: null,
      recentMessages: [
        { created_at: "2026-07-11T12:00:00Z" }, // yesterday relative to NOW
      ],
    });
    expect(result.header).not.toContain("GAP ALERT");
  });

  it("stays correct for a timezone ahead of UTC too", () => {
    const result = buildDateContext({
      tz: "Australia/Sydney",
      now: NOW, // 3pm UTC is already the next calendar day in Sydney
      trainingDays: null,
      overrideDays: null,
      overrideExpires: null,
      recentMessages: [],
    });
    expect(result.header).toContain("- Today: Monday, July 13, 2026");
    expect(result.header).toContain("- Tomorrow: Tuesday, Jul 14");
  });
});
