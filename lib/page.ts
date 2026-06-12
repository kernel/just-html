// Shared man-page-style HTML shell. Monospace, zero JS, zero framework CSS.
// httpbingo.org / Unix man-page vibe. This is the brand.

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2.5rem 1.25rem 4rem;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace;
    font-size: 14px;
    line-height: 1.55;
    color: #111;
    background: #fff;
    max-width: 760px;
    margin-left: auto;
    margin-right: auto;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #d8d8d8; background: #0d0d0d; }
    a { color: #6cb6ff; }
    hr { border-color: #333; }
  }
  h1, h2 { font-size: 14px; font-weight: 700; margin: 1.6rem 0 0.4rem; text-transform: uppercase; letter-spacing: 0.04em; }
  h1 { margin-top: 0; }
  pre { white-space: pre-wrap; margin: 0; }
  a { color: #0000ee; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.5rem 0; }
  .topbar, .botbar { display: flex; justify-content: space-between; font-weight: 700; letter-spacing: 0.04em; }
  code { background: rgba(127,127,127,0.15); padding: 0.05rem 0.3rem; border-radius: 3px; }
  section { margin-bottom: 0.4rem; }
`;

export function manPage(opts: {
  title: string;
  manTitle?: string; // e.g. "JUSTHTML.SH(1)"
  center?: string; // e.g. "GENERAL"
  date?: string;
  bodyHtml: string;
}): string {
  const man = opts.manTitle ?? "JUSTHTML.SH(1)";
  const center = opts.center ?? "JUSTHTML";
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
<div class="topbar"><span>${man}</span><span>${center}</span><span>${man}</span></div>
<hr>
${opts.bodyHtml}
<hr>
<div class="botbar"><span>JUSTHTML.SH</span><span>${date}</span><span>JUSTHTML.SH</span></div>
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
