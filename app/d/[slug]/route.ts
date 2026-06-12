import { findBySlug } from "@/lib/docs/store";
import { canViewSession } from "@/lib/docs/access";
import { mintViewCap } from "@/lib/docs/viewcap";
import { getSession } from "@/lib/auth/session";
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

function privateNotice(slug: string): Response {
  // Stale-link fallback (birthday.md "Share notifications"): always offer a
  // sign-in path back to this exact doc. A grantee whose share link expired (or
  // who never clicked it) signs in via /login?next=/d/:slug and, once their
  // email-keyed session resolves the grant, lands on the doc. So an expired or
  // consumed share link degrades to one extra email round-trip, never a dead
  // end. The link is shown to everyone (no existence oracle): a stranger who
  // signs in and has no grant simply sees this same notice again.
  const next = `/d/${encodeURIComponent(slug)}`;
  const signinHref = esc(`/login?next=${encodeURIComponent(next)}`);
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
    link. The owner can rotate the token, which invalidates old links.

    Was this shared with you? <a href="${signinHref}">Sign in</a> with the email it was
    shared to — if you have access, you'll land right back here.</pre>
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
  if (!doc) return privateNotice(slug);
  const session = await getSession(req);
  if (!(await canViewSession(doc, session, viewtoken))) return privateNotice(slug);

  // Build the iframe src. The iframe loads /d/:slug/raw, which is sandboxed
  // (allow-scripts, no allow-same-origin) → opaque origin. Two consequences:
  //   - The /raw subframe load is NOT a top-level navigation, so SameSite=Lax
  //     session cookies are NOT sent with it; /raw can only authorize via a
  //     token/capability in the URL, or public.
  //   - Therefore a session-authorized viewer (owner / email-grant / domain-
  //     grant, no ?viewtoken= in the URL) needs the shell to hand the iframe a
  //     URL-borne capability. We must NOT hand back doc.view_token: that is the
  //     owner's MASTER un-share token, and leaking it to a viewer/editor grantee
  //     lets them re-share the doc and survive grant revocation (only owner-only
  //     rotation kills it) — breaking birthday.md's "rotation is the un-share
  //     story" invariant. Instead, having already authorized this viewer above,
  //     the shell mints a short-lived (5 min), slug-scoped, HMAC-signed
  //     capability (lib/docs/viewcap.ts) that reveals nothing about the master
  //     token and cannot be replayed elsewhere or re-minted after revocation.
  // Precedence for the iframe src:
  //   - caller supplied a real ?viewtoken= → pass it through (it is already in
  //     the address bar; this is the deliberate capability-URL viewing path).
  //   - public doc → no token needed.
  //   - otherwise (session-authorized private viewer) → mint a grant-scoped cap.
  let rawQuery = "";
  if (viewtoken) {
    rawQuery = `?viewtoken=${encodeURIComponent(viewtoken)}`;
  } else if (!doc.is_public) {
    rawQuery = `?cap=${encodeURIComponent(mintViewCap(slug))}`;
  }
  const rawSrc = `/d/${encodeURIComponent(slug)}/raw` + rawQuery;
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
