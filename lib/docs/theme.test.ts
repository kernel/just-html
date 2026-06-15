import { describe, it, expect } from "vitest";
import {
  parseColor,
  normHex,
  relLum,
  isDarkColor,
  contrast,
  lift,
  rgba,
  ensure,
  buildChromePalette,
  detectServerTheme,
} from "@/lib/docs/theme";

describe("color parsing", () => {
  it("parses hex, short hex, rgb, rgba, keywords", () => {
    expect(parseColor("#0d1117")).toEqual([13, 17, 23]);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("rgb(30, 30, 46)")).toEqual([30, 30, 46]);
    expect(parseColor("rgba(0,0,0,0.5)")).toEqual([0, 0, 0]);
    expect(parseColor("white")).toEqual([255, 255, 255]);
    expect(parseColor("black")).toEqual([0, 0, 0]);
  });
  it("treats transparent / zero-alpha as null", () => {
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("rgba(0,0,0,0)")).toBeNull();
    expect(parseColor("rgba(255,255,255,0%)")).toBeNull();
    expect(parseColor(null)).toBeNull();
    expect(parseColor("not-a-color")).toBeNull();
  });
  it("normHex falls back when unparseable", () => {
    expect(normHex("#1e1e2e", "#000")).toBe("#1e1e2e");
    expect(normHex("garbage", "#abcabc")).toBe("#abcabc");
  });
});

describe("luminance + dark decision", () => {
  it("classifies near-black and tinted dark as dark, white as light", () => {
    expect(isDarkColor("#0d1117")).toBe(true);
    expect(isDarkColor("#1e1e2e")).toBe(true);
    expect(isDarkColor("#ffffff")).toBe(false);
    expect(isDarkColor("#fbfbfb")).toBe(false);
  });
  it("relLum monotonic", () => {
    expect(relLum("#000000")).toBeLessThan(relLum("#808080"));
    expect(relLum("#808080")).toBeLessThan(relLum("#ffffff"));
  });
});

describe("lift / ensure / contrast guards", () => {
  it("lift moves dark colors toward white", () => {
    const lifted = lift("#0d1117", 0.5);
    expect(relLum(lifted)).toBeGreaterThan(relLum("#0d1117"));
  });
  it("ensure raises fg until it clears AA on the bg", () => {
    // a low-contrast gray on near-black, nudged to AA
    const fixed = ensure("#444444", "#0d1117", 4.5);
    expect(contrast(fixed, "#0d1117")).toBeGreaterThanOrEqual(4.5);
  });
  it("rgba emits the parsed channels", () => {
    expect(rgba("#f1c40f", 0.2)).toBe("rgba(241,196,15,0.2)");
  });
});

describe("variant D palette", () => {
  const sample = { bg: "#0d1117", fg: "#c9d1d9", accent: "#58a6ff", isDark: true };
  const p = buildChromePalette(sample);

  it("bar/rail/stage are the doc bg (seamless)", () => {
    expect(p.barBg).toBe("#0d1117");
    expect(p.railBg).toBe("#0d1117");
    expect(p.stageBg).toBe("#0d1117");
  });
  it("cards are lifted one elevation step above the doc bg", () => {
    expect(relLum(p.cardBg)).toBeGreaterThan(relLum("#0d1117"));
  });
  it("card text clears AA against the card bg", () => {
    expect(contrast(p.cardFg, p.cardBg)).toBeGreaterThanOrEqual(4.5);
  });
  it("bar text clears AA against the bar bg", () => {
    expect(contrast(p.barFg, p.barBg)).toBeGreaterThanOrEqual(4.5);
  });
  it("accent is AA-guarded and drives toggle-on / pin / mine chip", () => {
    expect(contrast(p.togOnBg, p.barBg)).toBeGreaterThanOrEqual(4.5);
    expect(p.cardPinBorder).toBe(p.togOnBg);
    expect(p.chipMineFg).toBe(p.togOnBg);
  });
  it("highlight wash is the warm translucent yellow + ring", () => {
    expect(p.hlBg).toBe("rgba(241,196,15,0.2)");
    expect(p.hlRing).toBe("rgba(241,196,15,0.55)");
    expect(p.hlFg).toBe("inherit");
  });
  it("scrim is darker on dark docs", () => {
    expect(p.scrimBg).toBe("rgba(0,0,0,.55)");
  });
  it("falls back to fg when there is no usable accent", () => {
    const noAccent = buildChromePalette({ bg: "#0d1117", fg: "#c9d1d9", isDark: true });
    expect(contrast(noAccent.togOnBg, "#0d1117")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("server-side coarse detection", () => {
  it("detects an inline dark body background", () => {
    const t = detectServerTheme(`<html><body style="background:#0d1117;color:#c9d1d9"><p>hi</p></body></html>`);
    expect(t).not.toBeNull();
    expect(t!.isDark).toBe(true);
    expect(normHex(t!.bg, "")).toBe("#0d1117");
    expect(normHex(t!.fg, "")).toBe("#c9d1d9");
  });
  it("detects a dark background from a CSS rule and samples the link accent", () => {
    const t = detectServerTheme(
      `<html><head><style>body{background-color:#1e1e2e;color:#cdd6f4} a{color:#89b4fa}</style></head><body><a href="#">x</a></body></html>`
    );
    expect(t).not.toBeNull();
    expect(t!.isDark).toBe(true);
    expect(normHex(t!.accent ?? "", "")).toBe("#89b4fa");
  });
  it("a light bg yields null (today's light chrome)", () => {
    expect(detectServerTheme(`<html><body style="background:#ffffff"><p>x</p></body></html>`)).toBeNull();
    expect(detectServerTheme(`<html><body><p>no bg at all</p></body></html>`)).toBeNull();
  });
  it("a bg dark ONLY under prefers-color-scheme is unknown → null", () => {
    const t = detectServerTheme(
      `<html><head><style>body{background:#ffffff} @media (prefers-color-scheme: dark){body{background:#0d1117}}</style></head><body></body></html>`
    );
    expect(t).toBeNull();
  });
  it("ignores gradient/image backgrounds as a flat color", () => {
    const t = detectServerTheme(
      `<html><body style="background:linear-gradient(#000,#0d1117)"><p>x</p></body></html>`
    );
    expect(t).toBeNull();
  });
});
