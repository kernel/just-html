// Shared man-page-style HTML shell. Zero JS, zero framework CSS.
// httpbingo.org / Unix man-page vibe. This is the brand.
//
// Chrome system: variant A, LOCKED 2026-06-13 (birthday.md "Site-wide redesign
// decisions"; typography updated 2026-10-28). A SINGLE uppercase
// `JUSTHTML.SH(1)` headline — no top bar, no `GENERAL` center label, no
// doubled title. Left-aligned uppercase <h2> section heads with hanging-indent
// (3.5ch) bodies, and ONE quiet justified footer line
// (`justhtml.sh … <date> … JUSTHTML.SH(1)`). Always light.
//
// Typography: the default reading font is the tried-and-tested system UI stack
// (the GitHub/Bootstrap lineage) — native SF on macOS/iOS, Segoe UI on Windows,
// Roboto on Android — nothing to download, and the most readable option on
// both desktop and mobile. Monospace stays where it means something: prompt
// boxes, inline code, diffs. Prose lives in <p>; <pre> is code.

// The site-wide default reading face.
export const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
// Code only: prompts, inline code, diffs.
export const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace`;

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 2rem 1.5rem 3rem;
    font-family: ${SANS};
    font-size: 16px;
    line-height: 1.6;
    color: #111;
    background: #fff;
    max-width: 760px;
  }
  .headline { font-weight: 700; margin: 0 0 1.5rem; }
  h1, h2 {
    font-size: 14px; font-weight: 700; margin: 1.6rem 0 0.4rem;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  p { margin: 0 0 0.4rem; }
  pre { white-space: pre-wrap; margin: 0; font-family: ${MONO}; font-size: 14px; }
  .body { padding-left: 3.5ch; }
  a { color: #0000ee; }
  .hint { color: #666; margin: 0 0 0.5rem; }
  .err { color: #b00020; margin: 0 0 0.5rem; }
  code { font-family: ${MONO}; font-size: 0.9em; background: rgba(127,127,127,0.12); padding: 0.05rem 0.3rem; border-radius: 3px; }
  input, button { font: inherit; }
  input[type=email] { padding: 2px 6px; border: 1px solid #999; background: #fff; color: #111; }
  button { padding: 2px 12px; border: 1px solid #999; background: #f6f6f6; color: #111; cursor: pointer; border-radius: 3px; }
  button:hover { background: #ededed; }
  footer { margin-top: 2.5rem; color: #666; }
  footer .foot { display: flex; justify-content: space-between; gap: 1rem; }
`;

// One quiet justified footer line: `justhtml.sh … <date> … JUSTHTML.SH(1)`,
// laid out with flexbox space-between so it stays flush at any wrap width.
// Mirrors the homepage footer.
function footerRow(date: string): string {
  return `<div class="foot"><span>justhtml.sh</span><span>${date}</span><span>JUSTHTML.SH(1)</span></div>`;
}

export function manPage(opts: {
  title: string;
  date?: string;
  bodyHtml: string;
}): string {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="headline">JUSTHTML.SH(1)</div>
${opts.bodyHtml}
<footer>${footerRow(date)}</footer>
</body>
</html>`;
}

export function htmlResponse(html: string, init?: ResponseInit): Response {
  return new Response(html, {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

/** HTML-escape for safe interpolation into man-page bodies / attributes. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 303 redirect, optionally setting a cookie. */
export function redirect(location: string, headers?: Record<string, string>): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, ...(headers ?? {}) },
  });
}
