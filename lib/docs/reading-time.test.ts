import { describe, it, expect } from "vitest";
import { estimateReadMinutes } from "@/lib/docs/reading-time";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("estimateReadMinutes", () => {
  it("counts visible words at 200 wpm, rounding up", () => {
    expect(estimateReadMinutes(`<p>${words(200)}</p>`)).toBe(1);
    expect(estimateReadMinutes(`<p>${words(201)}</p>`)).toBe(2);
    expect(estimateReadMinutes(`<p>${words(1000)}</p>`)).toBe(5);
  });

  it("never rounds a doc with prose down to zero", () => {
    expect(estimateReadMinutes("<p>hello there</p>")).toBe(1);
  });

  it("returns 0 when there is nothing to read", () => {
    expect(estimateReadMinutes("")).toBe(0);
    expect(estimateReadMinutes('<img src="x.png"><hr><p>— • —</p>')).toBe(0);
  });

  it("ignores markup, comments, and non-prose blocks", () => {
    const html = `
      <!-- ${words(500)} -->
      <style>body { color: red }</style>
      <script>const x = "${words(500)}";</script>
      <svg viewBox="0 0 4 4"><path d="M1 1 L2 2 L3 3 L4 4 Z"/></svg>
      <p class="${words(500)}">${words(200)}</p>`;
    expect(estimateReadMinutes(html)).toBe(1);
  });

  it("decodes entities rather than counting them as words", () => {
    expect(estimateReadMinutes("<p>Tom &amp; Jerry</p>")).toBe(1);
  });

  it("counts CJK characters individually (no spaces to tokenize on)", () => {
    expect(estimateReadMinutes(`<p>${"字".repeat(500)}</p>`)).toBe(1);
    expect(estimateReadMinutes(`<p>${"字".repeat(2000)}</p>`)).toBe(4);
  });
});
