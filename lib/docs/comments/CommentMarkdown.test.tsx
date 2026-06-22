import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CommentMarkdown from "./CommentMarkdown";

// renderToStaticMarkup keeps this a pure string assertion (no DOM/jsdom needed),
// matching the repo's node-env vitest setup.
const render = (body: string) => renderToStaticMarkup(<CommentMarkdown body={body} />);

describe("CommentMarkdown", () => {
  it("renders GFM structure", () => {
    const html = render(
      "**bold** and `code`\n\n1. one\n2. two\n\n```sql\nSELECT 1\n```\n\n> quote"
    );
    expect(html).toContain("<strong>");
    expect(html).toContain("<code>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<pre>");
    expect(html).toContain("<blockquote>");
  });

  it("renders a GFM table", () => {
    const html = render("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain("<table>");
  });

  it("neutralizes raw HTML — no live script element", () => {
    const html = render("<script>alert(document.cookie)</script>");
    expect(html).not.toContain("<script");
  });

  it("strips javascript: link hrefs", () => {
    const html = render("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("hardens links with target, rel, and data-no-pin", () => {
    const html = render("[k](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
    // a link click must not bubble to the card's click-to-pin handler
    expect(html).toContain("data-no-pin");
  });

  it("strips images", () => {
    const html = render("![x](https://evil.example/p.png)");
    expect(html).not.toContain("<img");
  });

  it("keeps in-page (#fragment) links inline, not target=_blank", () => {
    const frag = render("[jump](#section)");
    expect(frag).toContain('href="#section"');
    expect(frag).not.toContain('target="_blank"');
    // external links still open a new tab
    expect(render("[x](https://example.com)")).toContain('target="_blank"');
  });

  it("namespaces footnote ids per card with working forward + back links", () => {
    const md = "needs a note[^1]\n\n[^1]: the note.";
    // two cards in one tree must get distinct footnote ids (no cross-card collision)
    const both = renderToStaticMarkup(
      <>
        <CommentMarkdown body={md} />
        <CommentMarkdown body={md} />
      </>
    );
    const defIds = [...both.matchAll(/id="([^"]*-fn-1)"/g)].map((m) => m[1]);
    expect(defIds).toHaveLength(2);
    expect(defIds[0]).not.toBe(defIds[1]);

    // within one card, every #fragment link (forward jump + ↩ back-ref) resolves to
    // an id in that card, and ids are ascii-safe (React 19 useId delimiters stripped)
    const one = render(md);
    const ids = new Set([...one.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...one.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets.every((t) => ids.has(t))).toBe(true);
    expect([...ids].every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
  });
});
