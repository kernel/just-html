import { describe, expect, it } from "vitest";
import { MARKDOWN_INPUT_SOURCE, mdBlocks, mdBlockShortcut, mdInline } from "@/lib/docs/markdown-input";
import { renderBlocks, renderRuns } from "@/lib/docs/block-render";

/** What the runs turn into once the server renders them — the observable result. */
function html(text: string): string {
  return renderRuns(mdInline(text));
}

describe("mdInline", () => {
  it("leaves plain text alone", () => {
    expect(html("just words")).toBe("just words");
  });

  it("handles the marks", () => {
    expect(html("a **bold** b")).toBe("a <strong>bold</strong> b");
    expect(html("a __bold__ b")).toBe("a <strong>bold</strong> b");
    expect(html("a *em* b")).toBe("a <em>em</em> b");
    expect(html("a _em_ b")).toBe("a <em>em</em> b");
    expect(html("a ~~gone~~ b")).toBe("a <del>gone</del> b");
    expect(html("a `code()` b")).toBe("a <code>code()</code> b");
  });

  it("does not treat an underscore inside a word as emphasis", () => {
    expect(html("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("does not read markup inside a code span", () => {
    expect(html("`a **b** c`")).toBe("<code>a **b** c</code>");
  });

  it("escapes the text it marks up", () => {
    expect(html("**<script>**")).toBe("<strong>&lt;script&gt;</strong>");
  });

  it("builds links and autolinks", () => {
    expect(html("see [the docs](https://x.dev/a)")).toBe('see <a href="https://x.dev/a">the docs</a>');
    expect(html("see https://x.dev/a now")).toBe('see <a href="https://x.dev/a">https://x.dev/a</a> now');
  });

  it("does not autolink a trailing sentence period", () => {
    expect(html("go to https://x.dev.")).toBe('go to <a href="https://x.dev">https://x.dev</a>.');
  });

  it("refuses a dangerous link target", () => {
    expect(html("[x](javascript:alert)")).toBe("x");
  });

  it("handles several marks in one line", () => {
    expect(html("**a** and *b* and `c`")).toBe("<strong>a</strong> and <em>b</em> and <code>c</code>");
  });
});

describe("mdBlocks", () => {
  const blocks = (text: string) => renderBlocks(mdBlocks(text, mdInline));

  it("splits paragraphs on blank lines and joins wrapped lines", () => {
    expect(blocks("one\nstill one\n\ntwo")).toBe("\n<p>one still one</p>\n<p>two</p>");
  });

  it("reads headings", () => {
    expect(blocks("# Title\n## Sub")).toBe("\n<h1>Title</h1>\n<h2>Sub</h2>");
  });

  it("reads bullet and numbered lists", () => {
    expect(blocks("- a\n- b")).toBe("\n<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>");
    expect(blocks("1. a\n2. b")).toBe("\n<ol>\n  <li>a</li>\n  <li>b</li>\n</ol>");
  });

  it("reads a blockquote and a rule", () => {
    expect(blocks("> quoted\n\n---")).toBe("\n<blockquote>quoted</blockquote>\n<hr>");
  });

  it("reads a fenced code block without interpreting its contents", () => {
    expect(blocks("```\n# not a heading\n```")).toBe("\n<pre><code># not a heading</code></pre>");
  });

  it("applies inline markup inside blocks", () => {
    expect(blocks("- **a** item")).toBe("\n<ul>\n  <li><strong>a</strong> item</li>\n</ul>");
  });

  it("returns nothing for empty input", () => {
    expect(mdBlocks("   \n\n", mdInline)).toEqual([]);
  });
});

describe("mdBlockShortcut", () => {
  it("recognises the prefixes typed at the start of a block", () => {
    expect(mdBlockShortcut("## Heading")).toEqual({ kind: "heading", level: 2, rest: "Heading" });
    expect(mdBlockShortcut("- item")).toEqual({ kind: "ul", rest: "item" });
    expect(mdBlockShortcut("1. item")).toEqual({ kind: "ol", rest: "item" });
    expect(mdBlockShortcut("> quote")).toEqual({ kind: "quote", rest: "quote" });
    expect(mdBlockShortcut("```")).toEqual({ kind: "pre", rest: "" });
    expect(mdBlockShortcut("---")).toEqual({ kind: "hr", rest: "" });
  });

  it("ignores text that only looks like a prefix", () => {
    expect(mdBlockShortcut("#nohash")).toBeNull();
    expect(mdBlockShortcut("-nospace")).toBeNull();
    expect(mdBlockShortcut("plain text")).toBeNull();
  });
});

describe("MARKDOWN_INPUT_SOURCE", () => {
  it("evaluates to working parsers inside a bare scope, as the overlay uses it", () => {
    const scope = new Function(`${MARKDOWN_INPUT_SOURCE}\nreturn { mdInline, mdBlocks, mdBlockShortcut };`)();
    expect(scope.mdInline("a **b**")).toEqual(mdInline("a **b**"));
    expect(scope.mdBlocks("# T\n\n- x")).toEqual(mdBlocks("# T\n\n- x", mdInline));
    expect(scope.mdBlockShortcut("## h")).toEqual(mdBlockShortcut("## h"));
  });
});
