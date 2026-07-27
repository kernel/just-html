import { describe, it, expect } from "vitest";
import { buildInlineEdits, escapeHtmlText, escapeHtmlSource } from "@/lib/docs/inline-edit";
import { applyEdits, EditApplyError } from "@/lib/docs/edit-diff";

// The load-bearing claim of inline editing is that a TEXT NODE's content appears
// verbatim in the stored HTML, so the deterministic engine can patch it without
// re-serializing anything. These tests run the overlay's output through the real
// engine (no DOM needed — the `changes` arrays are exactly what a browser reports
// for the HTML above them) and assert the untouched bytes stay untouched.

/** Apply the literal payload, falling back to the escaped one on a not-found — the shell's retry. */
function save(html: string, changes: { before: string; after: string }[]): string {
  const p = buildInlineEdits(changes);
  if (!p) throw new Error("no edits");
  try {
    return applyEdits(html, p.edits);
  } catch (e) {
    if (e instanceof EditApplyError && e.reason === "not_found") return applyEdits(html, p.escaped);
    throw e;
  }
}

describe("buildInlineEdits", () => {
  it("drops unchanged and unanchorable changes, and returns null when nothing is left", () => {
    expect(buildInlineEdits([])).toBeNull();
    expect(buildInlineEdits([{ before: "same", after: "same" }])).toBeNull();
    // An empty `before` has nothing to match on; the engine rejects it outright.
    expect(buildInlineEdits([{ before: "", after: "typed" }])).toBeNull();
    const p = buildInlineEdits([
      { before: "keep", after: "keep" },
      { before: "old", after: "new" },
    ]);
    expect(p?.edits).toEqual([{ oldText: "old", newText: "new" }]);
  });

  it("escapes the replacement text in both payloads", () => {
    expect(escapeHtmlText("a & b <c>")).toBe("a &amp; b &lt;c&gt;");
    expect(escapeHtmlSource("a\u00a0b")).toBe("a&nbsp;b");
    const p = buildInlineEdits([{ before: "hi", after: "<b>hi</b>" }]);
    expect(p?.edits[0].newText).toBe("&lt;b&gt;hi&lt;/b&gt;");
    expect(p?.escaped[0].newText).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });
});

describe("inline edits against the real engine", () => {
  it("changes only the edited run and leaves the rest byte-identical", () => {
    const html = `<!doctype html>
<html><head><style>p{color:#333}</style></head>
<body><h1>My blog</h1><p>Ther are two typos here.</p><p>Second para.</p></body></html>`;
    const out = save(html, [{ before: "Ther are two typos here.", after: "There are no typos here." }]);
    expect(out).toBe(html.replace("Ther are two typos here.", "There are no typos here."));
    // Everything structural survives verbatim — this is the whole point.
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("<style>p{color:#333}</style>");
    expect(out).toContain("<p>Second para.</p>");
  });

  it("edits around inline markup without touching the tags", () => {
    // The browser reports one text node per run, so <strong> is never in a payload.
    const html = `<p>Kernel runs <strong>cloud browsers</strong> for agents.</p>`;
    const out = save(html, [
      { before: "Kernel runs ", after: "Kernel provides " },
      { before: " for agents.", after: " for web agents." },
    ]);
    expect(out).toBe(`<p>Kernel provides <strong>cloud browsers</strong> for web agents.</p>`);
  });

  it("writes typed markup as text, not markup", () => {
    const html = `<p>Use the tag.</p>`;
    const out = save(html, [{ before: "Use the tag.", after: "Use the <script> tag & go." }]);
    expect(out).toBe(`<p>Use the &lt;script&gt; tag &amp; go.</p>`);
    expect(out).not.toContain("<script>");
  });

  it("falls back to the escaped payload when the source spells entities", () => {
    // The parser hands the overlay "R&D" and "two words"; neither is in the source.
    const amp = `<p>R&amp;D notes</p>`;
    expect(save(amp, [{ before: "R&D notes", after: "R&D log" }])).toBe(`<p>R&amp;D log</p>`);

    const nbsp = `<p>two&nbsp;words here</p>`;
    expect(save(nbsp, [{ before: "two\u00a0words here", after: "two\u00a0words there" }])).toBe(
      `<p>two&nbsp;words there</p>`
    );
  });

  it("refuses an ambiguous edit rather than patching the wrong one", () => {
    const html = `<ul><li>Yes</li><li>Yes</li></ul>`;
    expect(() => save(html, [{ before: "Yes", after: "No" }])).toThrow(EditApplyError);
    try {
      save(html, [{ before: "Yes", after: "No" }]);
    } catch (e) {
      expect((e as EditApplyError).reason).toBe("multiple_matches");
    }
  });

  it("applies several changed nodes from one block in a single patch", () => {
    const html = `<p>One <em>two</em> three</p>`;
    const out = save(html, [
      { before: "One ", after: "1 " },
      { before: "two", after: "2" },
      { before: " three", after: " 3" },
    ]);
    expect(out).toBe(`<p>1 <em>2</em> 3</p>`);
  });
});
