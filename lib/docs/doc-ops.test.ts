import { describe, expect, it } from "vitest";
import { applyOps, OpApplyError, type Op } from "@/lib/docs/doc-ops";
import { parseSource } from "@/lib/docs/html-source";

/** Id of the nth element with this tag, as the browser would have been served it. */
function idOf(html: string, tag: string, nth = 0): number {
  const matches = parseSource(html).elements.filter((e) => e.tag === tag);
  return matches[nth].id;
}

function run(html: string, ops: Op[]): string {
  return applyOps(html, ops).html;
}

function reason(html: string, ops: Op[]): string {
  try {
    applyOps(html, ops);
  } catch (e) {
    if (e instanceof OpApplyError) return e.reason;
    throw e;
  }
  return "no error";
}

const DOC = `<!doctype html>
<html>
<head><title>T</title><style>p{color:red}</style></head>
<body>
<h1>The title</h1>
<p>First paragraph with R&amp;D in it.</p>
<p>Second <strong>bold</strong> paragraph.</p>
<ul>
<li>one</li>
<li>two</li>
</ul>
</body>
</html>`;

describe("setRuns", () => {
  it("rewrites only the characters that changed", () => {
    const src = idOf(DOC, "h1");
    const out = run(DOC, [
      { op: "setRuns", src, child: 0, before: "The title", runs: [{ kind: "text", text: "The headline" }] },
    ]);
    expect(out).toContain("<h1>The headline</h1>");
    expect(out.replace("The headline", "The title")).toBe(DOC);
  });

  it("leaves the author's entity spelling alone when editing around it", () => {
    const src = idOf(DOC, "p");
    const out = run(DOC, [
      {
        op: "setRuns",
        src,
        child: 0,
        before: "First paragraph with R&D in it.",
        runs: [{ kind: "text", text: "First para with R&D in it." }],
      },
    ]);
    expect(out).toContain("<p>First para with R&amp;D in it.</p>");
  });

  it("rewrites through an entity when the edit spans it", () => {
    const src = idOf(DOC, "p");
    const out = run(DOC, [
      {
        op: "setRuns",
        src,
        child: 0,
        before: "First paragraph with R&D in it.",
        runs: [{ kind: "text", text: "First paragraph with R&D and more." }],
      },
    ]);
    expect(out).toContain("R&amp;D and more.");
  });

  it("emits markup for marked runs and escapes the text inside it", () => {
    const src = idOf(DOC, "h1");
    const out = run(DOC, [
      {
        op: "setRuns",
        src,
        child: 0,
        before: "The title",
        runs: [
          { kind: "text", text: "The " },
          { kind: "text", text: "<b>", marks: ["strong"] },
        ],
      },
    ]);
    expect(out).toContain("<h1>The <strong>&lt;b&gt;</strong></h1>");
  });

  it("refuses when the text is not what the caller expected", () => {
    expect(
      reason(DOC, [
        { op: "setRuns", src: idOf(DOC, "h1"), child: 0, before: "Stale", runs: [{ kind: "text", text: "x" }] },
      ])
    ).toBe("anchor_mismatch");
  });

  it("refuses a child index that is not a text node", () => {
    expect(
      reason(DOC, [
        { op: "setRuns", src: idOf(DOC, "p", 1), child: 1, before: "bold", runs: [{ kind: "text", text: "x" }] },
      ])
    ).toBe("unknown_element");
  });
});

describe("inline markup", () => {
  it("unwraps an inline element, keeping its content byte-for-byte", () => {
    const out = run(DOC, [{ op: "unwrap", src: idOf(DOC, "strong") }]);
    expect(out).toContain("<p>Second bold paragraph.</p>");
  });

  it("replaces an element's whole inline content", () => {
    const out = run(DOC, [
      {
        op: "setInline",
        src: idOf(DOC, "p", 1),
        runs: [
          { kind: "text", text: "Second " },
          { kind: "text", text: "bold", marks: ["em"] },
          { kind: "text", text: " paragraph." },
        ],
      },
    ]);
    expect(out).toContain("<p>Second <em>bold</em> paragraph.</p>");
  });

  it("drops a dangerous href rather than emitting it", () => {
    const out = run(DOC, [
      {
        op: "setInline",
        src: idOf(DOC, "h1"),
        runs: [{ kind: "text", text: "click", href: "javascript:alert(1)" }],
      },
    ]);
    expect(out).toContain("<h1>click</h1>");
    expect(out).not.toContain("javascript");
  });
});

describe("block shape", () => {
  it("retags a block, keeping its attributes and content", () => {
    const html = '<p class="lead" id="x">Body <em>text</em></p>';
    expect(run(html, [{ op: "retag", src: 0, tag: "h2" }])).toBe('<h2 class="lead" id="x">Body <em>text</em></h2>');
  });

  it("gives an implicitly closed block an explicit end tag when retagging it", () => {
    expect(run("<p>a<p>b", [{ op: "retag", src: 0, tag: "h3" }])).toBe("<h3>a</h3><p>b");
  });

  it("wraps a block into a list in one request with retag", () => {
    const html = "<p>an item</p>";
    expect(run(html, [{ op: "retag", src: 0, tag: "li" }, { op: "wrap", src: 0, tags: ["ul"] }])).toBe(
      "<ul><li>an item</li></ul>"
    );
  });

  it("applies the three ops a '- ' shortcut emits as one list item", () => {
    // retag + wrap + setInline all land on the same element: the wrap's tags have
    // to end up outside the retagged ones, and the content inside both.
    const html = '<p class="x">- an item</p>';
    expect(
      run(html, [
        { op: "retag", src: 0, tag: "li" },
        { op: "wrap", src: 0, tags: ["ul"] },
        { op: "setInline", src: 0, runs: [{ kind: "text", text: "an item" }] },
      ])
    ).toBe('<ul><li class="x">an item</li></ul>');
  });

  it("applies the two ops a '## ' shortcut emits", () => {
    expect(
      run("<p>## Heading</p>", [
        { op: "retag", src: 0, tag: "h2" },
        { op: "setInline", src: 0, runs: [{ kind: "text", text: "Heading" }] },
      ])
    ).toBe("<h2>Heading</h2>");
  });

  it("inserts a rendered block after another and reports the new element's id", () => {
    const src = idOf(DOC, "h1");
    const res = applyOps(DOC, [
      { op: "insert", src, where: "after", blocks: [{ tag: "p", runs: [{ kind: "text", text: "New." }] }] },
    ]);
    expect(res.html).toContain("<h1>The title</h1>\n<p>New.</p>");
    const newEl = parseSource(res.html).elements[res.focus!];
    expect(newEl.tag).toBe("p");
    expect(res.html.slice(newEl.start, newEl.end)).toBe("<p>New.</p>");
  });

  it("appends inside an element", () => {
    const out = run("<div><p>a</p></div>", [
      { op: "insert", src: 0, where: "append", blocks: [{ tag: "p", runs: [{ kind: "text", text: "b" }] }] },
    ]);
    expect(out).toBe("<div><p>a</p>\n<p>b</p></div>");
  });

  it("renders a code block with its content escaped", () => {
    const out = run("<p>a</p>", [
      { op: "insert", src: 0, where: "after", blocks: [{ tag: "pre", code: "if (a < b) {}" }] },
    ]);
    expect(out).toContain("<pre><code>if (a &lt; b) {}</code></pre>");
  });

  it("renders a table with a header row", () => {
    const out = run("<p>a</p>", [
      { op: "insert", src: 0, where: "after", blocks: [{ tag: "table", rows: 2, cols: 2 }] },
    ]);
    expect(out).toContain("<tr><th></th><th></th></tr>");
    expect(out).toContain("<tr><td></td><td></td></tr>");
  });

  it("deletes a block and the blank line it sat on", () => {
    const out = run(DOC, [{ op: "delete", src: idOf(DOC, "h1") }]);
    expect(out).not.toContain("The title");
    expect(out).toContain("<body>\n<p>First paragraph");
  });

  it("adds a table row with the same cell count", () => {
    const html = "<table>\n  <tr><th>a</th><th>b</th></tr>\n</table>";
    const out = run(html, [{ op: "insertRow", src: idOf(html, "tr") }]);
    expect(out).toContain("<tr><th>a</th><th>b</th></tr>\n  <tr><td></td><td></td></tr>");
  });
});

describe("moving blocks", () => {
  it("reorders a block within its parent", () => {
    const html = "<div>\n<p>one</p>\n<p>two</p>\n</div>";
    const out = run(html, [{ op: "move", src: idOf(html, "p"), parent: 0, after: idOf(html, "p", 1) }]);
    expect(out).toBe("<div>\n<p>two</p>\n<p>one</p>\n</div>");
  });

  it("moves a block to the start of its parent", () => {
    const html = "<div>\n<p>one</p>\n<p>two</p>\n</div>";
    const out = run(html, [{ op: "move", src: idOf(html, "p", 1), parent: 0, after: null }]);
    expect(out).toBe("<div>\n<p>two</p>\n<p>one</p>\n</div>");
  });

  it("refuses to move an element into itself", () => {
    const html = "<div>\n<p>one</p>\n</div>";
    expect(reason(html, [{ op: "move", src: 0, parent: 0, after: idOf(html, "p") }])).toBe("not_editable");
  });
});

describe("list nesting", () => {
  const LIST = "<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>";

  it("indents an item under the one before it", () => {
    const out = run(LIST, [{ op: "indent", src: idOf(LIST, "li", 1) }]);
    expect(out).toBe("<ul>\n<li>one\n<ul>\n<li>two</li>\n</ul></li>\n<li>three</li>\n</ul>");
  });

  it("joins an existing sublist instead of starting a second one", () => {
    const nested = "<ul>\n<li>one<ul><li>a</li></ul></li>\n<li>two</li>\n</ul>";
    const out = run(nested, [{ op: "indent", src: idOf(nested, "li", 2) }]);
    expect(out).toBe("<ul>\n<li>one<ul><li>a</li>\n<li>two</li></ul></li>\n</ul>");
  });

  it("refuses to indent the first item", () => {
    expect(reason(LIST, [{ op: "indent", src: idOf(LIST, "li") }])).toBe("not_editable");
  });

  it("outdents a nested item to the outer list", () => {
    const nested = "<ul>\n<li>one<ul><li>a</li><li>b</li></ul></li>\n</ul>";
    const out = run(nested, [{ op: "outdent", src: idOf(nested, "li", 1) }]);
    expect(out).toBe("<ul>\n<li>one<ul><li>b</li></ul></li>\n<li>a</li>\n</ul>");
  });

  it("removes the sublist when its last item is outdented", () => {
    const nested = "<ul>\n<li>one<ul><li>a</li></ul></li>\n</ul>";
    const out = run(nested, [{ op: "outdent", src: idOf(nested, "li", 1) }]);
    expect(out).toBe("<ul>\n<li>one</li>\n<li>a</li>\n</ul>");
  });

  it("refuses to outdent a top-level item", () => {
    expect(reason(LIST, [{ op: "outdent", src: idOf(LIST, "li", 1) }])).toBe("not_editable");
  });
});

describe("refusals", () => {
  it("will not touch a script, a style or the head", () => {
    expect(reason(DOC, [{ op: "setText", src: idOf(DOC, "style"), text: "p{color:blue}" }])).toBe("not_editable");
    expect(reason(DOC, [{ op: "setInline", src: idOf(DOC, "title"), runs: [] }])).toBe("not_editable");
  });

  it("will not restructure the page scaffolding", () => {
    expect(reason(DOC, [{ op: "delete", src: idOf(DOC, "body") }])).toBe("not_editable");
    expect(reason(DOC, [{ op: "retag", src: idOf(DOC, "body"), tag: "p" }])).toBe("not_editable");
  });

  it("allows appending into the body", () => {
    const out = run(DOC, [
      {
        op: "insert",
        src: idOf(DOC, "body"),
        where: "append",
        blocks: [{ tag: "p", runs: [{ kind: "text", text: "tail" }] }],
      },
    ]);
    expect(out).toContain("</ul>\n<p>tail</p>\n</body>");
  });

  it("rejects an unknown element id", () => {
    expect(reason(DOC, [{ op: "delete", src: 999 }])).toBe("unknown_element");
  });

  it("rejects two ops that rewrite the same bytes", () => {
    const src = idOf(DOC, "h1");
    expect(
      reason(DOC, [
        { op: "setInline", src, runs: [{ kind: "text", text: "a" }] },
        { op: "setInline", src, runs: [{ kind: "text", text: "b" }] },
      ])
    ).toBe("overlap");
  });

  it("rejects a request that changes nothing", () => {
    expect(
      reason(DOC, [
        {
          op: "setRuns",
          src: idOf(DOC, "h1"),
          child: 0,
          before: "The title",
          runs: [{ kind: "text", text: "The title" }],
        },
      ])
    ).toBe("no_change");
  });
});

describe("everything outside the edit stays byte-identical", () => {
  it("holds for a document with a doctype, a style block and entities", () => {
    const out = run(DOC, [{ op: "retag", src: idOf(DOC, "p", 1), tag: "h2" }]);
    const [before, after] = [DOC, out].map((s) => s.split("\n"));
    const changed = before.filter((line, i) => line !== after[i]);
    expect(changed).toEqual(["<p>Second <strong>bold</strong> paragraph.</p>"]);
    expect(out).toContain("<h2>Second <strong>bold</strong> paragraph.</h2>");
    expect(out).toContain("R&amp;D");
    expect(out).toContain("<style>p{color:red}</style>");
  });
});
