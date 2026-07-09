import { describe, it, expect } from "vitest";
import { fragmentFor, parseHash } from "@/lib/docs/deeplink";

describe("deeplink codec", () => {
  it("routes comment / section / empty hashes", () => {
    expect(parseHash("#comment-42")).toEqual({ kind: "comment", id: 42 });
    expect(parseHash("comment-42")).toEqual({ kind: "comment", id: 42 }); // leading # optional
    expect(parseHash("#setup")).toEqual({ kind: "section", id: "setup" });
    expect(parseHash("#")).toEqual({ kind: "none" });
    expect(parseHash("")).toEqual({ kind: "none" });
  });

  it("builds comment fragments without encoding and section fragments with it", () => {
    expect(fragmentFor({ kind: "comment", id: 7 })).toBe("comment-7");
    expect(fragmentFor({ kind: "section", id: "setup" })).toBe("setup");
    expect(fragmentFor({ kind: "section", id: "my heading" })).toBe("my%20heading");
  });

  it("round-trips section ids with spaces, unicode, and reserved characters", () => {
    for (const id of ["setup", "my heading", "café", "日本語", "a/b?c#d", "100%", "section-comment-3"]) {
      const t = parseHash("#" + fragmentFor({ kind: "section", id }));
      expect(t).toEqual({ kind: "section", id });
    }
  });

  it("does not throw on malformed percent-encoding — treats it as a literal section id", () => {
    expect(parseHash("#foo%")).toEqual({ kind: "section", id: "foo%" });
    expect(parseHash("#%E0%A4%A")).toEqual({ kind: "section", id: "%E0%A4%A" });
  });

  it("a comment-<digits> hash is a comment, but comment-word is a section", () => {
    expect(parseHash("#comment-1")).toEqual({ kind: "comment", id: 1 });
    expect(parseHash("#comment-intro")).toEqual({ kind: "section", id: "comment-intro" });
  });
});
