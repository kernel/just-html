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
// full page). The root layout supplies <html>/<body> + the monospace brand;
// this matches manPage()'s markup (headline + <h2> + .body + footer).

const BODY: React.CSSProperties = {
  margin: "0 auto",
  padding: "2rem 1.5rem 3rem",
  maxWidth: 760,
  fontFamily: `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`,
  fontSize: 14,
  lineHeight: 1.55,
  color: "#111",
  background: "#fff",
};

function footerLine(date: string): string {
  const left = "justhtml.sh";
  const right = "JUSTHTML.SH(1)";
  const width = 78;
  const gaps = Math.max(2, width - left.length - right.length - date.length);
  const l = Math.ceil(gaps / 2);
  const r = gaps - l;
  return `${left}${" ".repeat(l)}${date}${" ".repeat(r)}${right}`;
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
  const next = slugMatch ? `/d/${slugMatch[1]}` : null;
  const signinHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  const date = new Date().toISOString().slice(0, 10);

  return (
    <main style={BODY}>
      <pre style={{ fontWeight: 700, margin: "0 0 1.5rem" }}>JUSTHTML.SH(1)</pre>
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          margin: "1.6rem 0 0.3rem",
          textTransform: "uppercase",
          letterSpacing: "0.03em",
        }}
      >
        PRIVATE OR NOT FOUND
      </h2>
      <div style={{ paddingLeft: "3.5ch" }}>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
          {`This document is private, or does not exist.

If you were given a link with a ?viewtoken=… on it, use that exact
link. The owner can rotate the token, which invalidates old links.

Was this shared with you? `}
          <a href={signinHref}>Sign in</a>
          {` with the email it was
shared to — if you have access, you'll land right back here.`}
        </pre>
      </div>
      <footer style={{ marginTop: "2.5rem", color: "#666" }}>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{footerLine(date)}</pre>
      </footer>
    </main>
  );
}
