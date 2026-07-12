import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inferTimezoneFromPhone, getDateFacts, formatDateAnchor } from "@/lib/timezone";

describe("inferTimezoneFromPhone", () => {
  it("maps US +1 numbers to America/New_York", () => {
    expect(inferTimezoneFromPhone("+12025551234")).toBe("America/New_York");
    expect(inferTimezoneFromPhone("+13105551234")).toBe("America/New_York");
  });

  it("maps UK +44 to Europe/London", () => {
    expect(inferTimezoneFromPhone("+441234567890")).toBe("Europe/London");
  });

  it("maps Ireland +353 to Europe/Dublin", () => {
    expect(inferTimezoneFromPhone("+353861234567")).toBe("Europe/Dublin");
  });

  it("maps Australia +61 to Australia/Sydney", () => {
    expect(inferTimezoneFromPhone("+61412345678")).toBe("Australia/Sydney");
  });

  it("maps Japan +81 to Asia/Tokyo", () => {
    expect(inferTimezoneFromPhone("+819012345678")).toBe("Asia/Tokyo");
  });

  it("maps Germany +49 to Europe/Berlin", () => {
    expect(inferTimezoneFromPhone("+491512345678")).toBe("Europe/Berlin");
  });

  it("falls back to America/New_York for unknown country codes", () => {
    expect(inferTimezoneFromPhone("+9991234567890")).toBe("America/New_York");
    expect(inferTimezoneFromPhone("+001234567890")).toBe("America/New_York");
  });

  it("handles longer country codes before shorter ones (e.g. +852 before +85)", () => {
    // Hong Kong +852 must match before any generic +8x prefix
    expect(inferTimezoneFromPhone("+85291234567")).toBe("Asia/Hong_Kong");
  });
});

describe("getDateFacts / formatDateAnchor", () => {
  beforeEach(() => {
    // Sunday, July 12, 2026, 3pm UTC — matches the real conversation this bug was found in.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T15:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes today/yesterday/tomorrow as consecutive calendar days", () => {
    const facts = getDateFacts("America/New_York");
    expect(facts.today).toBe("Sunday, Jul 12");
    expect(facts.yesterday).toBe("Saturday, Jul 11");
    expect(facts.tomorrow).toBe("Monday, Jul 13");
  });

  it("shifts correctly for a timezone on the other side of midnight UTC", () => {
    // 3pm UTC is already the next calendar day in most of Asia/Australia.
    const facts = getDateFacts("Australia/Sydney");
    expect(facts.today).toBe("Monday, Jul 13");
    expect(facts.tomorrow).toBe("Tuesday, Jul 14");
  });

  it("formatDateAnchor embeds the same today/tomorrow strings getDateFacts computes", () => {
    const facts = getDateFacts("America/New_York");
    const anchor = formatDateAnchor("America/New_York");
    expect(anchor).toContain(facts.today);
    expect(anchor).toContain(facts.tomorrow);
    expect(anchor).toContain("DATE ANCHOR");
  });
});
