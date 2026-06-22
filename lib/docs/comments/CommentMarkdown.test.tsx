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

  it("hardens links with target and rel", () => {
    const html = render("[k](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).toContain("noreferrer");
  });

  it("strips images", () => {
    const html = render("![x](https://evil.example/p.png)");
    expect(html).not.toContain("<img");
  });
});
