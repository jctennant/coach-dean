import { describe, it, expect } from "vitest";
import { normalizeEmDashes } from "@/lib/text-format";

describe("normalizeEmDashes", () => {
  it("leaves text without em dashes untouched", () => {
    const text = "Nice run today. How did the calf feel?";
    expect(normalizeEmDashes(text)).toBe(text);
  });

  it("removes every em dash it is given", () => {
    const samples = [
      "A — B",
      "A — B — C",
      "A — B — C — D",
      "One — two. Three — four — five.",
      "— leading dash",
      "trailing dash —",
    ];
    for (const s of samples) expect(normalizeEmDashes(s)).not.toContain("—");
  });

  describe("terminal dash (one per sentence) — clause + payoff", () => {
    it("splits into two sentences and recapitalizes", () => {
      expect(normalizeEmDashes("Easy pace today — the legs need it.")).toBe(
        "Easy pace today. The legs need it."
      );
    });

    it("does not double up when the clause already ends in punctuation", () => {
      expect(normalizeEmDashes("Easy today, — the legs need it.")).toBe(
        "Easy today, The legs need it."
      );
    });
  });

  describe("paired dashes (two in one sentence) — parenthetical", () => {
    it("becomes commas, keeping the sentence intact", () => {
      // The production regression this covers: the athlete received
      // "If there's any soreness still hanging around. Even at rest. Cross-training
      // only this week." — a fragment plus two orphans — from a correct sentence.
      expect(
        normalizeEmDashes(
          "If there's any soreness still hanging around — even at rest — cross-training only this week."
        )
      ).toBe(
        "If there's any soreness still hanging around, even at rest, cross-training only this week."
      );
    });

    it("does not capitalize the interruption or the continuation", () => {
      const out = normalizeEmDashes("The tempo — your first since April — went well.");
      expect(out).toBe("The tempo, your first since April, went well.");
    });

    it("avoids doubling existing commas around the interruption", () => {
      expect(normalizeEmDashes("Easy today, — even at rest — no running.")).toBe(
        "Easy today, even at rest, no running."
      );
    });
  });

  describe("mixed shapes", () => {
    it("handles a paired dash followed by a trailing terminal dash", () => {
      expect(
        normalizeEmDashes("Your shin — still sore — needs rest — that's the whole plan.")
      ).toBe("Your shin, still sore, needs rest. That's the whole plan.");
    });

    it("judges pairing per sentence, not across the message", () => {
      // Two sentences, one terminal dash each — neither is a parenthetical.
      expect(normalizeEmDashes("Easy today — legs need it. Tempo Thursday — be ready.")).toBe(
        "Easy today. Legs need it. Tempo Thursday. Be ready."
      );
    });
  });

  describe("edge cases", () => {
    it("handles a dash with nothing after it", () => {
      expect(normalizeEmDashes("Solid week —")).toBe("Solid week");
    });

    it("handles a dash with nothing before it", () => {
      expect(normalizeEmDashes("— solid week")).toBe("Solid week");
    });

    it("preserves line structure in a session list", () => {
      const list = "Mon 3/9 · Easy 5mi — keep it truly easy\nTue 3/10 · Strength 20 min";
      const out = normalizeEmDashes(list);
      expect(out.split("\n")).toHaveLength(2);
      expect(out.split("\n")[0]).toBe("Mon 3/9 · Easy 5mi. Keep it truly easy");
      expect(out.split("\n")[1]).toBe("Tue 3/10 · Strength 20 min");
    });

    it("preserves blank-line paragraph breaks (they are bubble boundaries)", () => {
      const out = normalizeEmDashes("First — done.\n\nSecond — also done.");
      expect(out).toBe("First. Done.\n\nSecond. Also done.");
    });
  });
});
