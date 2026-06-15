import { describe, it, expect } from "vitest";
import { signingInPage, deadLinkPage } from "@/lib/auth/verify-pages";

// Pure-render unit tests for the /login/verify page shim. These call the render
// helpers directly — no server, no DB, no network — and lock the contract the
// GET handler depends on: an auto-submitting POST form for the JS path, a
// <noscript> button fallback, HTML-escaped inputs (no injection), and a distinct
// 410 dead-link page that never auto-submits.

describe("signingInPage (auto-submit shim)", () => {
  const html = signingInPage("tok123", "/d/abc");

  it("renders the POST <form> targeting /login/verify", () => {
    expect(html).toMatch(/<form[^>]*method="POST"[^>]*action="\/login\/verify"/);
  });

  it("includes the hidden token input with the given value", () => {
    expect(html).toContain('<input type="hidden" name="token" value="tok123">');
  });

  it("includes the hidden next input with the given value", () => {
    expect(html).toContain('<input type="hidden" name="next" value="/d/abc">');
  });

  it("auto-submits the form on load via an inline <script>", () => {
    expect(html).toContain("<script>");
    expect(html).toMatch(/getElementById\('verifyform'\)\.submit\(\)/);
  });

  it("has a <noscript> fallback containing a submit button", () => {
    const noscript = html.slice(html.indexOf("<noscript>"));
    expect(html).toContain("<noscript>");
    expect(noscript).toMatch(/<button type="submit">/);
  });

  it("HTML-escapes the next value — no injection", () => {
    const evil = '/d/abc"><script>alert(1)</script>';
    const out = signingInPage("t", evil);
    // The raw attack string must NOT appear verbatim…
    expect(out).not.toContain('value="/d/abc"><script>alert(1)</script>');
    // …its dangerous characters must be entity-escaped instead.
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // And the only real <script> in the page is our own auto-submit one.
    expect(out.match(/<script>/g)?.length ?? 0).toBe(1);
  });

  it("HTML-escapes the token value too", () => {
    const out = signingInPage('"><b>', "/x");
    expect(out).toContain('name="token" value="&quot;&gt;&lt;b&gt;">');
  });
});

describe("deadLinkPage (410 content)", () => {
  const html = deadLinkPage("/d/abc");

  it("renders the expected expired/used dead-link content", () => {
    expect(html).toContain("LINK EXPIRED OR USED");
    expect(html).toContain("This login link is expired or already used.");
  });

  it("carries next forward into the request-a-new-one link", () => {
    expect(html).toContain(`href="/login?next=${encodeURIComponent("/d/abc")}"`);
  });

  it("falls back to a bare /login link when next is absent", () => {
    const out = deadLinkPage();
    expect(out).toContain('href="/login"');
    expect(out).not.toContain("next=");
  });

  it("does NOT contain an auto-submit form or script", () => {
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(".submit()");
    expect(deadLinkPage()).not.toContain("<script>");
  });
});
