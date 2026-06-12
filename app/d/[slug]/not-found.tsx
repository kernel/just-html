import { headers } from "next/headers";

// 404 notice for /d/:slug — rendered when the page calls notFound() (missing
// slug or unauthorized private doc). Same wording + man-page style as the pre-B10
// notice and /raw; no existence oracle (private vs missing are indistinguishable).
// Carries a real 404 status. We recover the slug from the request path to keep
// the "Was this shared with you? Sign in" link pointing back at THIS doc
// (birthday.md "Stale-link fallback") — falling back to a bare /login if the
// path isn't derivable.

const NOTICE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "2.5rem 1.25rem",
  fontFamily: `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`,
  fontSize: 14,
  lineHeight: 1.55,
  maxWidth: 760,
  marginLeft: "auto",
  marginRight: "auto",
};

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

  return (
    <main style={NOTICE_STYLE}>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
        {`    This document is private, or does not exist.

    If you were given a link with a ?viewtoken=… on it, use that exact
    link. The owner can rotate the token, which invalidates old links.

    Was this shared with you? `}
        <a href={signinHref}>Sign in</a>
        {` with the email it was
    shared to — if you have access, you'll land right back here.`}
      </pre>
    </main>
  );
}
