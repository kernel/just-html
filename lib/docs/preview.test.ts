import { describe, expect, it } from "vitest";
import { documentPreview, extractPreviewDescription } from "@/lib/docs/preview";

describe("document link previews", () => {
  it("extracts a standard description regardless of attribute order or quoting", () => {
    expect(
      extractPreviewDescription(
        `<html><head><meta content='Daily sessions &amp; usage' data-x="1" NAME='description'></head></html>`
      )
    ).toBe("Daily sessions & usage");
  });

  it("keeps greater-than characters inside quoted descriptions", () => {
    expect(extractPreviewDescription(`<meta name="description" content="Growth > baseline">`)).toBe(
      "Growth > baseline"
    );
  });

  it("finds metadata after Unicode characters whose lowercase form changes length", () => {
    expect(extractPreviewDescription(`İ<META NAME="description" CONTENT="Unicode-safe">`)).toBe(
      "Unicode-safe"
    );
  });

  it("falls back through Open Graph and Twitter descriptions", () => {
    expect(extractPreviewDescription(`<meta property="og:description" content="Open Graph copy">`)).toBe(
      "Open Graph copy"
    );
    expect(extractPreviewDescription(`<meta name="twitter:description" content="Twitter copy">`)).toBe(
      "Twitter copy"
    );
  });

  it("ignores metadata inside comments and inert elements", () => {
    const html = `
      <!-- <meta name="description" content="comment"> -->
      <script>const example = '<meta name="description" content="script">';</script>
      <template><meta name="description" content="template"></template>
    `;
    expect(extractPreviewDescription(html)).toBeNull();
  });

  it("uses generic copy when the author supplied no description", () => {
    const preview = documentPreview({ slug: "quiet-moon-12345", title: "Design notes", html: "<h1>Hi</h1>" });
    expect(preview.title).toBe("Design notes");
    expect(preview.description).toBe("A document published on justhtml.sh.");
  });

  it("truncates long descriptions without splitting the final word when possible", () => {
    const description = Array.from({ length: 80 }, () => "sessions").join(" ");
    const preview = documentPreview({
      slug: "quiet-moon-12345",
      title: null,
      html: `<meta name="description" content="${description}">`,
    });
    expect(preview.title).toBe("quiet-moon-12345");
    expect(preview.description.length).toBeLessThanOrEqual(240);
    expect(preview.description.endsWith("sessions…")).toBe(true);
  });
});
