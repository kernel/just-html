import { describe, it, expect } from "vitest";
import { readMinutesFor, readTimeLevel, readTimeTitle } from "@/lib/docs/reading-time";

describe("readMinutesFor", () => {
  it("counts words at 200 wpm, rounding up", () => {
    expect(readMinutesFor(200, 0)).toBe(1);
    expect(readMinutesFor(201, 0)).toBe(2);
    expect(readMinutesFor(1000, 0)).toBe(5);
  });

  it("never rounds a doc with prose down to zero", () => {
    expect(readMinutesFor(2, 0)).toBe(1);
  });

  it("charges CJK characters at a per-character rate", () => {
    expect(readMinutesFor(0, 500)).toBe(1);
    expect(readMinutesFor(0, 2000)).toBe(4);
  });

  it("adds the two rates for a mixed doc", () => {
    expect(readMinutesFor(200, 500)).toBe(2);
  });

  it("returns 0 when there is nothing to read", () => {
    expect(readMinutesFor(0, 0)).toBe(0);
  });
});

describe("readTimeLevel", () => {
  it("steps at 5 and 15 minutes", () => {
    expect([1, 4].map(readTimeLevel)).toEqual(["ok", "ok"]);
    expect([5, 15].map(readTimeLevel)).toEqual(["warn", "warn"]);
    expect([16, 90].map(readTimeLevel)).toEqual(["over", "over"]);
  });
});

describe("readTimeTitle", () => {
  it("spells out the estimate so the fill color isn't the only signal", () => {
    expect(readTimeTitle(1)).toBe("Estimated read time: 1 minute");
    expect(readTimeTitle(7)).toBe("Estimated read time: 7 minutes");
  });

  it("names the problem past 15 minutes", () => {
    expect(readTimeTitle(22)).toBe("Estimated read time: 22 minutes — long for a shared doc");
  });
});
