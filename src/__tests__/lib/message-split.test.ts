import { describe, it, expect } from "vitest";
import { splitIntoMessages, MAX_MSG_CHARS } from "@/lib/message-split";

describe("splitIntoMessages", () => {
  it("returns a single bubble for a short single-paragraph message", () => {
    expect(splitIntoMessages("Nice run today.")).toEqual(["Nice run today."]);
  });

  it("returns no bubbles for empty or whitespace-only input", () => {
    expect(splitIntoMessages("")).toEqual([]);
    expect(splitIntoMessages("   \n\n  ")).toEqual([]);
  });

  it("splits on blank lines even when the whole message is under the limit", () => {
    // The regression this file exists for: the prompt tells Dean a blank line makes a new
    // bubble, and before 2026-08-16 any message under the char limit collapsed to one.
    const short = "Hey, that tempo looked strong.\n\nHow did the calf hold up?";
    expect(short.length).toBeLessThan(MAX_MSG_CHARS);
    expect(splitIntoMessages(short)).toEqual([
      "Hey, that tempo looked strong.",
      "How did the calf hold up?",
    ]);
  });

  it("never merges two short paragraphs that would fit in one bubble", () => {
    expect(splitIntoMessages("One.\n\nTwo.\n\nThree.")).toEqual(["One.", "Two.", "Three."]);
  });

  it("treats runs of 3+ newlines as a single boundary and trims each bubble", () => {
    expect(splitIntoMessages("  First.  \n\n\n\n  Second.  ")).toEqual(["First.", "Second."]);
  });

  it("keeps single-newline content together in one bubble", () => {
    // Session lists use one-per-line with no blank lines — must stay one text.
    const list = "Mon 3/9 · Easy 5mi @ 9:30/mi\nTue 3/10 · Strength 20 min\nSat 3/14 · Long run 8mi";
    expect(splitIntoMessages(list)).toEqual([list]);
  });

  it("splits an overlong paragraph at sentence boundaries", () => {
    const sentence = "This is a sentence about pacing that runs on for a while. ";
    const long = sentence.repeat(12).trim();
    const parts = splitIntoMessages(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_MSG_CHARS);
    // No content lost.
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
  });

  it("does not sentence-split a multi-line block even when it exceeds the limit", () => {
    // A long schedule fragmented mid-list is worse than one long bubble.
    const bigList = Array.from(
      { length: 12 },
      (_, i) => `Day ${i + 1} · Easy 6mi @ 9:30/mi with some extra framing text here`
    ).join("\n");
    expect(bigList.length).toBeGreaterThan(MAX_MSG_CHARS);
    expect(splitIntoMessages(bigList)).toEqual([bigList]);
  });

  it("applies the sentence fallback per-paragraph, preserving other boundaries", () => {
    const long = "A sentence that goes on and on about aerobic base development. ".repeat(8).trim();
    const parts = splitIntoMessages(`Short opener.\n\n${long}\n\nShort closer.`);
    expect(parts[0]).toBe("Short opener.");
    expect(parts[parts.length - 1]).toBe("Short closer.");
    expect(parts.length).toBeGreaterThan(3);
  });
});
