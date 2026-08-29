import { describe, expect, it } from "vitest";
import { OVERLAY_SCRIPT } from "./overlay";

describe("OVERLAY_SCRIPT", () => {
  it("keeps wide tables within their own horizontal scroll area", () => {
    expect(OVERLAY_SCRIPT).toContain(
      "table{display:block;max-width:100%;overflow-x:auto}"
    );
  });
});
