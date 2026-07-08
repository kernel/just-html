import { describe, it, expect } from "vitest";
import { extractSections } from "@/lib/docs/sections";

describe("extractSections", () => {
  it("slugs heading text and records level", () => {
    expect(extractSections("<h1>Hello World</h1>")).toEqual([
      { id: "hello-world", level: 1, text: "Hello World" },
    ]);
    const levels = extractSections(
      "<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>"
    ).map((s) => s.level);
    expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses the text content of nested inline markup", () => {
    const [s] = extractSections("<h2>v0 API <code>shape</code></h2>");
    expect(s.id).toBe("v0-api-shape");
    expect(s.text).toBe("v0 API shape");
  });

  it("decodes entities and collapses punctuation to a single hyphen", () => {
    expect(extractSections("<h2>Tom &amp; Jerry</h2>")[0].id).toBe("tom-jerry");
    expect(extractSections("<h2>  Multiple   spaces  </h2>")[0]).toEqual({
      id: "multiple-spaces",
      level: 2,
      text: "Multiple spaces",
    });
  });

  it("de-dupes repeated slugs in document order", () => {
    expect(extractSections("<h2>Setup</h2><h3>Setup</h3><h2>Setup</h2>").map((s) => s.id)).toEqual([
      "setup",
      "setup-1",
      "setup-2",
    ]);
  });

  it("falls back to section-N for empty slugs (emoji / punctuation only)", () => {
    expect(extractSections("<h1>Intro</h1><h2>🎉</h2><h3>!!!</h3>").map((s) => s.id)).toEqual([
      "intro",
      "section-2",
      "section-3",
    ]);
  });

  it("prefers an author-provided id and ignores other *id attributes", () => {
    expect(extractSections('<h2 id="custom-anchor">Whatever</h2>')[0].id).toBe("custom-anchor");
    expect(extractSections('<h2 data-id="x" id="real">Title</h2>')[0].id).toBe("real");
    expect(extractSections("<h2>No id here</h2>")[0].id).toBe("no-id-here");
  });

  it("never mints an id in the reserved comment-<n> namespace", () => {
    expect(extractSections("<h2>Comment 12</h2>")[0].id).toBe("section-comment-12");
    // Author ids get the same guard, so a heading id can't hijack a #comment-<n>
    // permalink; a non-colliding author id is still used verbatim.
    expect(extractSections('<h2 id="comment-5">Title</h2>')[0].id).toBe("section-comment-5");
    expect(extractSections('<h2 id="intro">Title</h2>')[0].id).toBe("intro");
  });

  it("keeps non-Latin headings instead of emptying them", () => {
    const [s] = extractSections("<h2>日本語</h2>");
    expect(s.id).toBe("日本語");
    expect(s.level).toBe(2);
  });

  it("ignores headings inside comments, script, and style", () => {
    const html =
      "<!-- <h1>hidden</h1> --><style><h1>styled</h1></style>" +
      "<script><h1>scripted</h1></script><h1>Real</h1>";
    expect(extractSections(html).map((s) => s.id)).toEqual(["real"]);
  });

  it("ignores headings in template/noscript so ids don't shift vs the rendered DOM", () => {
    // Neither reaches the overlay's document.querySelectorAll (template is inert;
    // noscript is text while scripting is on), so counting them would misalign the
    // id assigned to every later heading. Both real headings keep their clean ids.
    const html =
      "<h1>First</h1><template><h2>tpl only</h2></template>" +
      "<noscript><h2>ns only</h2></noscript><h2>Second</h2>";
    expect(extractSections(html).map((s) => s.id)).toEqual(["first", "second"]);
  });

  it("returns an empty list when there are no headings", () => {
    expect(extractSections("<p>just a paragraph</p>")).toEqual([]);
  });
});
