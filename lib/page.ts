// Shared man-page-style HTML shell. Monospace, zero JS, zero framework CSS.
// httpbingo.org / Unix man-page vibe. This is the brand.
//
// Chrome system: variant A, LOCKED 2026-06-13 (birthday.md "Site-wide redesign
// decisions"). A SINGLE uppercase `JUSTHTML.SH(1)` headline — no top bar, no
// `GENERAL` center label, no doubled title. Left-aligned uppercase <h2> section
// heads with hanging-indent (3.5ch) bodies, and ONE quiet justified footer line
// (`justhtml.sh … <date> … JUSTHTML.SH(1)`). Always light, monospace. Matches
// the shipped homepage chrome (app/route.ts, variant B) verbatim.

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 2rem 1.5rem 3rem;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace;
    font-size: 14px;
    line-height: 1.55;
    color: #111;
    background: #fff;
    max-width: 760px;
  }
  .headline { font-weight: 700; margin: 0 0 1.5rem; }
  h1, h2 {
    font-size: 14px; font-weight: 700; margin: 1.6rem 0 0.3rem;
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  pre { white-space: pre-wrap; margin: 0; }
  .body { padding-left: 3.5ch; }
  a { color: #0000ee; }
  .hint { color: #666; margin: 0 0 0.5rem; }
  .err { color: #b00020; margin: 0 0 0.5rem; }
  code { background: rgba(127,127,127,0.12); padding: 0.05rem 0.3rem; border-radius: 3px; }
  input, button { font: inherit; }
  input[type=email] { padding: 2px 6px; border: 1px solid #999; background: #fff; color: #111; }
  button { padding: 2px 12px; border: 1px solid #999; background: #f6f6f6; color: #111; cursor: pointer; border-radius: 3px; }
  button:hover { background: #ededed; }
  footer { margin-top: 2.5rem; color: #666; }
`;

// One quiet justified footer line: `justhtml.sh … <date> … JUSTHTML.SH(1)`.
// Spacing is in characters so it reads true in the monospace column. Mirrors the
// homepage footer (which hardcodes the same shape at the design's wrap width).
function footerLine(date: string): string {
  const left = "justhtml.sh";
  const right = "JUSTHTML.SH(1)";
  const width = 78;
  const gaps = Math.max(2, width - left.length - right.length - date.length);
  const l = Math.ceil(gaps / 2);
  const r = gaps - l;
  return `${left}${" ".repeat(l)}${date}${" ".repeat(r)}${right}`;
}

export function manPage(opts: {
  title: string;
  manTitle?: string; // retained for API-compat; the headline is always JUSTHTML.SH(1)
  center?: string; // retained for API-compat; no longer rendered (no center label)
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
<pre class="headline">JUSTHTML.SH(1)</pre>
${opts.bodyHtml}
<footer><pre>${footerLine(date)}</pre></footer>
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
