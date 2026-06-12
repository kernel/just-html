// Plain viewer shell — the cold path (zero comments AND a viewer who can't
// comment). Thin chrome (title + "made with justhtml.sh") wrapping the sandboxed
// iframe to /d/:slug/raw. No rail, no overlay, no client JS — behaviorally
// identical to the pre-B10 page. Server component; the root layout supplies
// <html>/<body> and the monospace brand.

const BAR: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  height: "2.4rem",
  padding: "0 0.9rem",
  fontFamily: `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`,
  fontSize: 13,
  borderBottom: "1px solid #ccc",
  color: "#111",
  background: "#fafafa",
};

export default function PlainShell({ title, rawSrc }: { title: string; rawSrc: string }) {
  return (
    <>
      <div style={BAR}>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: 700,
          }}
        >
          {title}
        </span>
        <span style={{ flexShrink: 0, paddingLeft: "0.9rem" }}>
          made with <a href="/">justhtml.sh</a>
        </span>
      </div>
      <iframe
        title={title}
        src={rawSrc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{
          border: "none",
          width: "100%",
          height: "calc(100vh - 2.4rem)",
          display: "block",
          background: "#fff",
        }}
      />
    </>
  );
}
