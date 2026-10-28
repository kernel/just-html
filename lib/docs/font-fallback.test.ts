import { describe, expect, it } from "vitest";
import { fontFallbackStyle } from "./font-fallback";

describe("fontFallbackStyle", () => {
  it("returns the sans fallback for a doc with no styling", () => {
    const tag = fontFallbackStyle("<h1>hi</h1><p>plain doc</p>");
    expect(tag).toContain("data-jh-default-font");
    expect(tag).toContain("-apple-system");
    expect(tag).toContain("ui-monospace");
  });

  it("returns nothing when the doc declares a font-family", () => {
    expect(
      fontFallbackStyle(`<style>body{font-family:'Inter',sans-serif}</style><p>x</p>`)
    ).toBe("");
  });

  it("returns nothing when the doc declares a font shorthand", () => {
    expect(fontFallbackStyle(`<style>p{font:16px serif}</style>`)).toBe("");
  });

  it("returns nothing when the doc loads a webfont", () => {
    expect(fontFallbackStyle(`<style>@font-face{font-family:X;src:url(x.woff2)}</style>`)).toBe("");
  });

  it("ignores unrelated CSS — a doc styled in every other way still gets the fallback", () => {
    expect(fontFallbackStyle(`<style>body{color:#111;background:#fff}</style>`)).not.toBe("");
  });

  it("is case-insensitive about author font rules", () => {
    expect(fontFallbackStyle(`<STYLE>BODY{FONT-FAMILY:Arial}</STYLE>`)).toBe("");
  });

  it("detects a font set in an inline style attribute", () => {
    expect(fontFallbackStyle(`<body style="font-family:Verdana">x</body>`)).toBe("");
    expect(fontFallbackStyle(`<p style='font: 14px serif'>x</p>`)).toBe("");
  });

  it("ignores font-family mentioned in prose or code samples", () => {
    expect(
      fontFallbackStyle(`<p>This doc sets no font-family at all.</p><pre>body { font-family: serif }</pre>`)
    ).not.toBe("");
  });

  it("ignores non-font rules in a style block", () => {
    expect(fontFallbackStyle(`<style>h1{color:red}</style><p>x</p>`)).not.toBe("");
  });
});
