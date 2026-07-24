import { describe, it, expect } from "vitest";
import { bookmarkRow, fmtDate } from "@/lib/docs/bookmarks-view";

const base = {
  docId: 42,
  slug: "fierce-tiger-12345",
  title: "Launch plan",
  access: "owner",
  isPublic: false,
  bookmarkedAt: "2026-07-20T17:40:37Z",
  linkable: true,
  token: null as string | null,
};

describe("bookmarkRow", () => {
  it("links the live title to the doc", () => {
    const html = bookmarkRow(base);
    expect(html).toContain(`href="/d/fierce-tiger-12345"`);
    expect(html).toContain(">Launch plan</a>");
    expect(html).toContain("owner private · 2026-07-20");
    expect(html).not.toContain("revoked");
  });

  it("appends the stored view token to token-shared links", () => {
    const html = bookmarkRow({ ...base, access: "link", token: "k7Pq2xWmRb" });
    expect(html).toContain(`href="/d/fierce-tiger-12345?viewtoken=k7Pq2xWmRb"`);
    expect(html).toContain("link private");
  });

  it("shows the (snapshot) title unlinked for revoked bookmarks", () => {
    // The caller passes the title captured at bookmark time as `title`; the row
    // renders it dimmed with no link (the doc's live title is never passed here).
    const html = bookmarkRow({ ...base, title: "Old title", access: "revoked", linkable: false });
    expect(html).toContain("row revoked");
    expect(html).toContain(">Old title</span>");
    expect(html).toContain("revoked · 2026-07-20");
    expect(html).not.toContain("<a");
  });

  it("falls back to the slug for a revoked bookmark with no snapshot title", () => {
    const html = bookmarkRow({ ...base, title: null, access: "revoked", linkable: false });
    expect(html).toContain(">fierce-tiger-12345</span>");
    expect(html).not.toContain("<a");
  });

  it("treats a non-linkable row as revoked even if labeled otherwise", () => {
    const html = bookmarkRow({ ...base, access: "viewer", linkable: false });
    expect(html).toContain("row revoked");
    expect(html).not.toContain("<a");
  });

  it("carries a remove form keyed by doc id for every row", () => {
    for (const m of [base, { ...base, access: "revoked", linkable: false }]) {
      const html = bookmarkRow(m);
      expect(html).toContain(`name="action" value="remove"`);
      expect(html).toContain(`name="doc_id" value="42"`);
    }
  });

  it("escapes the title and falls back to the slug", () => {
    expect(bookmarkRow({ ...base, title: "<script>" })).toContain("&lt;script&gt;");
    expect(bookmarkRow({ ...base, title: "  " })).toContain(">fierce-tiger-12345</a>");
  });
});

describe("fmtDate", () => {
  it("renders YYYY-MM-DD, passing through unparseable input", () => {
    expect(fmtDate("2026-07-20T17:40:37Z")).toBe("2026-07-20");
    expect(fmtDate("not-a-date")).toBe("not-a-date");
  });
});
