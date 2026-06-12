// 404 notice for /d/:slug/history — rendered when the page calls notFound()
// (missing slug or unauthorized private doc). Same wording + man-page style as
// the /d/:slug and /d/:slug/raw private notices; no existence oracle. Carries a
// real 404 status (Next renders the nearest not-found boundary with 404).
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

export default function HistoryNotFound() {
  return (
    <main style={NOTICE_STYLE}>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{`    This document is private, or does not exist.

    If you were given a link with a ?viewtoken=… on it, use that exact
    link. The owner can rotate the token, which invalidates old links.`}</pre>
    </main>
  );
}
