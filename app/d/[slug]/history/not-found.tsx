// 404 notice for /d/:slug/history — rendered when the page calls notFound()
// (missing slug or unauthorized private doc). Same wording + man-page chrome as
// the /d/:slug private notice; no existence oracle. Carries a real 404 status.
//
// Chrome: the LOCKED variant-A man-page chrome (birthday.md "Site-wide redesign
// decisions"). The root layout supplies <html>/<body> + the monospace brand;
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

export default function HistoryNotFound() {
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
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{`This document is private, or does not exist.

If you were given a link with a ?viewtoken=… on it, use that exact
link. The owner can rotate the token, which invalidates old links.`}</pre>
      </div>
      <footer style={{ marginTop: "2.5rem", color: "#666" }}>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{footerLine(date)}</pre>
      </footer>
    </main>
  );
}
