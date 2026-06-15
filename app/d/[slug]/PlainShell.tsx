// Plain viewer shell — the cold path (zero comments AND a viewer who can't
// comment). Thin chrome (title + "made with justhtml.sh") wrapping the sandboxed
// iframe to /d/:slug/raw. No rail, no overlay, no client JS — behaviorally
// identical to the pre-B10 page. Server component; the root layout supplies
// <html>/<body> and the monospace brand.
//
// Adaptive chrome (variant D): there is NO JS here to sample the doc, so the
// server pre-derives a COARSE theme from the stored HTML's unconditional
// html/body background (lib/docs/theme.ts detectServerTheme/buildChromePalette)
// and themes the bar + iframe backdrop at SSR. Light docs (or any ambiguity) get
// `theme === null` → today's EXACT light chrome (#fff / #ccc), byte-identical.

import { buildChromePalette, type ThemeSample } from "@/lib/docs/theme";

const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`;

// Viewer chrome bar — variant A (LOCKED 2026-06-13): bold title left, quiet
// "made with justhtml.sh" right, same weights/colors as the page footer. Colors
// read from CSS vars with the literal light values as fallbacks, so an UNSET var
// set (light doc) resolves to today's exact bytes.
const BAR: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  height: "2.4rem",
  padding: "0 1.25rem",
  fontFamily: MONO,
  fontSize: 13,
  borderBottom: "1px solid var(--jh-bar-border, #ccc)",
  color: "var(--jh-bar-fg, #111)",
  background: "var(--jh-bar-bg, #fff)",
};

export default function PlainShell({
  title,
  rawSrc,
  theme,
}: {
  title: string;
  rawSrc: string;
  theme: ThemeSample | null;
}) {
  // Only DARK themes recolor the chrome; light/unknown keep the literal chrome.
  const dark = theme && theme.isDark ? theme : null;
  const p = dark ? buildChromePalette(dark) : null;
  const vars: React.CSSProperties | undefined = p
    ? {
        ["--jh-bar-bg" as string]: p.barBg,
        ["--jh-bar-border" as string]: p.barBorder,
        ["--jh-bar-fg" as string]: p.barFg,
        ["--jh-bar-muted" as string]: p.barMuted,
        ["--jh-stage-bg" as string]: p.stageBg,
      }
    : undefined;

  return (
    <div style={vars}>
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
        <span style={{ flexShrink: 0, paddingLeft: "1.25rem", color: "var(--jh-bar-muted, #666)" }}>
          made with{" "}
          <a href="/" style={{ color: "var(--jh-bar-muted, #666)" }}>
            justhtml.sh
          </a>
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
          background: "var(--jh-stage-bg, #fff)",
        }}
      />
    </div>
  );
}
