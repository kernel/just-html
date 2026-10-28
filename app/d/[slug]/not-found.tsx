import { headers } from "next/headers";

// 404 notice for /d/:slug — rendered when the page calls notFound() (missing
// slug or unauthorized private doc). No existence oracle (private vs missing are
// indistinguishable); carries a real 404 status. We recover the slug from the
// request path to keep the "Was this shared with you? Sign in" link pointing
// back at THIS doc (birthday.md "Stale-link fallback"), falling back to a bare
// /login if the path isn't derivable.
//
// Chrome: the LOCKED variant-A man-page chrome (birthday.md "Site-wide redesign
// decisions" — the private-doc notice, previously chrome-less, now reads as a
// full page). The root layout supplies <html>/<body> + the sans reading face;
// this matches manPage()'s markup (headline + <h2> + .body + footer).

const BODY: React.CSSProperties = {
  margin: "0 auto",
  padding: "2rem 1.5rem 3rem",
  maxWidth: 760,
  fontFamily: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  fontSize: 16,
  lineHeight: 1.6,
  color: "#111",
  background: "#fff",
};

// One quiet justified footer line, flex space-between so it stays flush at any
// wrap width. Mirrors manPage()'s footer.
function Footer({ date }: { date: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
      <span>justhtml.sh</span>
      <span>{date}</span>
      <span>JUSTHTML.SH(1)</span>
    </div>
  );
}

export default async function ViewerNotFound() {
  const h = await headers();
  // Next sets x-matched-path / the original URL on the referer for navigations;
  // try a few sources, then degrade to /login.
  const path =
    h.get("x-invoke-path") ||
    h.get("x-matched-path") ||
    (() => {
      const ref = h.get("referer");
      if (!ref) return null;
      try {
        return new URL(ref).pathname;
      } catch {
        return null;
      }
    })();
  const slugMatch = path && /^\/d\/([^/?]+)/.exec(path);
  // Guard the route-pattern placeholder: x-matched-path resolves to the literal
  // "/d/[slug]" when there's no concrete URL to recover from (e.g. a no-referer
  // request rendered via notFound()). "next=/d/[slug]" would be a broken link,
  // so drop to a bare /login rather than promising "right back here".
  const recovered =
    slugMatch && !slugMatch[1].includes("[") && !slugMatch[1].includes("%5B")
      ? slugMatch[1]
      : null;
  const next = recovered ? `/d/${recovered}` : null;
  const signinHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  const date = new Date().toISOString().slice(0, 10);

  return (
    <main style={BODY}>
      <div style={{ fontWeight: 700, margin: "0 0 1.5rem" }}>JUSTHTML.SH(1)</div>
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          margin: "1.6rem 0 0.4rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        PRIVATE OR NOT FOUND
      </h2>
      <div style={{ paddingLeft: "3.5ch" }}>
        <p style={{ margin: "0 0 0.4rem" }}>This document is private, or does not exist.</p>
        <p style={{ margin: "0 0 0.4rem" }}>
          If you were given a link with a ?viewtoken=… on it, use that exact link.
          The owner can rotate the token, which invalidates old links.
        </p>
        <p style={{ margin: 0 }}>
          Was this shared with you? <a href={signinHref}>Sign in</a> with the
          email it was shared to — if you have access, you'll land right back
          here.
        </p>
      </div>
      <footer style={{ marginTop: "2.5rem", color: "#666" }}>
        <Footer date={date} />
      </footer>
    </main>
  );
}
