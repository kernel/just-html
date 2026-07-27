import { describe, expect, it } from "vitest";
import { OVERLAY_SCRIPT } from "@/lib/docs/overlay";

// The overlay ships as a STRING, so nothing in the normal build catches a syntax
// error in it — a stray backtick closing the String.raw literal early, or a
// mangled interpolation, would only surface as a dead overlay in the browser.
describe("OVERLAY_SCRIPT", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(OVERLAY_SCRIPT)).not.toThrow();
  });

  it("carries the markdown-input parsers it calls", () => {
    for (const name of ["mdInline", "mdBlocks", "mdBlockShortcut"]) {
      expect(OVERLAY_SCRIPT).toContain(`var ${name} =`);
      expect(OVERLAY_SCRIPT).toContain(`${name}(`);
    }
  });

  it("emits the whole script, including the parts spliced in last", () => {
    // A stray backtick would close the String.raw literal early and truncate the
    // tail; these are the last things in it and the vocabulary the shell expects.
    expect(OVERLAY_SCRIPT.trimEnd().endsWith("})();")).toBe(true);
    for (const msg of ["jh:ops", "jh:focusBlock", "jh:editSel", "jh:linkPrompt", "jh:cmd"]) {
      expect(OVERLAY_SCRIPT).toContain(msg);
    }
  });
});
