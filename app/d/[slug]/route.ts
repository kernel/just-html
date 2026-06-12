import { findBySlug } from "@/lib/docs/store";
import { canView } from "@/lib/docs/access";
import { esc } from "@/lib/page";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// GET /d/:slug — the viewer shell: thin chrome ("made with justhtml.sh") wrapping
// a sandboxed iframe whose src is /d/:slug/raw (origin-less, CSP-sandboxed).
//
// Brand rule note: the plan ALLOWS React here (it's one of two designated React
// surfaces, for the phase-2 comment overlay). B3 needs no client JS — the shell
// is static chrome + an iframe — so we serve it as a plain route handler returning
// new Response(html), consistent with every other just-html surface and shipping
// zero React runtime. When the phase-2 overlay (selection capture, comment
// sidebar) lands, this converts to the React shell; the contract (chrome + iframe
// to /raw) is unchanged.
//
// Token rules are identical to /raw: public docs render; private docs require a
// matching ?viewtoken=, else a "this document is private" notice. No existence
// oracle: a missing slug and an unauthorized private doc render the same notice.

const SHELL_STYLE = `*{box-sizing:border-box}html,body{margin:0;height:100%}
.jh-bar{display:flex;justify-content:space-between;align-items:center;height:2.4rem;
  padding:0 0.9rem;font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;
  font-size:13px;border-bottom:1px solid #ccc;color:#111;background:#fafafa}
.jh-bar .jh-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
.jh-bar .jh-credit{flex-shrink:0;padding-left:0.9rem}
.jh-bar a{color:#0000ee}
iframe.jh-frame{border:none;width:100%;height:calc(100vh - 2.4rem);display:block;background:#fff}`;

const NOTICE_STYLE = `body{margin:0;padding:2.5rem 1.25rem;
  font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;
  font-size:14px;line-height:1.55;max-width:760px;margin-left:auto;margin-right:auto}
pre{white-space:pre-wrap;margin:0;color:#111;background:#fff}`;

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function privateNotice(): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>private — justhtml.sh</title>
<style>${NOTICE_STYLE}</style>
</head>
<body>
<pre>    This document is private, or does not exist.

    If you were given a link with a ?viewtoken=… on it, use that exact
    link. The owner can rotate the token, which invalidates old links.</pre>
</body>
</html>`;
  // 404 — no existence oracle (private/unknown look identical).
  return htmlResponse(body, 404);
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const viewtoken = url.searchParams.get("viewtoken");

  const doc = await findBySlug(slug);
  if (!doc || !canView(doc, viewtoken)) return privateNotice();

  const rawSrc =
    `/d/${encodeURIComponent(slug)}/raw` +
    (viewtoken ? `?viewtoken=${encodeURIComponent(viewtoken)}` : "");
  const title = doc.title || doc.slug;
  const titleEsc = esc(title);

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleEsc} — justhtml.sh</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<div class="jh-bar">
  <span class="jh-title">${titleEsc}</span>
  <span class="jh-credit">made with <a href="/">justhtml.sh</a></span>
</div>
<iframe class="jh-frame" title="${esc(title)}" src="${esc(rawSrc)}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
</body>
</html>`;
  return htmlResponse(body);
}
