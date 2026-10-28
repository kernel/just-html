// 404 notice for /d/:slug/history — rendered when the page calls notFound()
// (missing slug or unauthorized private doc). Same wording + man-page chrome as
// the /d/:slug private notice; no existence oracle. Carries a real 404 status.
//
// Chrome: the LOCKED variant-A man-page chrome (birthday.md "Site-wide redesign
// decisions"). The root layout supplies <html>/<body> + the sans reading face;
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

export default function HistoryNotFound() {
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
        <p style={{ margin: 0 }}>
          If you were given a link with a ?viewtoken=… on it, use that exact link.
          The owner can rotate the token, which invalidates old links.
        </p>
      </div>
      <footer style={{ marginTop: "2.5rem", color: "#666" }}>
        <Footer date={date} />
      </footer>
    </main>
  );
}
