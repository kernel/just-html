import { manPage, htmlResponse, esc, redirect } from "@/lib/page";
import { loginLanding } from "@/lib/auth/url";
import { originOk } from "@/lib/auth/request";
import { sha256Hex } from "@/lib/auth/tokens";
import { createSession, sessionCookieHeader } from "@/lib/auth/session";
import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

function confirmPage(token: string, next: string): string {
  return manPage({
    title: "justhtml.sh — confirm sign in",
    center: "LOGIN",
    bodyHtml: `
<h1>CONFIRM SIGN IN</h1>
<section><pre>    Click the button to finish signing in on this device.</pre></section>
<section><form method="POST" action="/login/verify">
<input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="next" value="${esc(next)}">
<pre>    <button type="submit" style="font:inherit;padding:2px 10px">sign in</button></pre>
</form></section>
<section><pre>    This link is single-use. If it's expired or already used you'll
    be asked to <a href="/login">request a new one</a>.</pre></section>
`,
  });
}

// The dead-link page. CRITICAL: it must carry the sanitized `next` forward so an
// expired/consumed SHARE link degrades to one extra email round-trip, never a
// dead end (birthday.md "Stale-link fallback (always works)"). Without this, a
// grantee whose 7-day share link expired loses next=/d/:slug entirely and, being
// account-less, has no path back to the doc. We point "request a new one" at
// /login?next=<next> so re-sign-in lands them right back on the doc, where the
// session-grant check resolves their access.
function deadLinkPage(next?: string): string {
  const dest = next && next !== "/login" ? next : null;
  const requestHref = dest
    ? `/login?next=${encodeURIComponent(dest)}`
    : "/login";
  return manPage({
    title: "justhtml.sh — link expired",
    center: "LOGIN",
    bodyHtml: `
<h1>LINK EXPIRED OR USED</h1>
<section><pre>    This login link is expired or already used.

    Request a new one at <a href="${esc(requestHref)}">justhtml.sh/login</a>${
      dest
        ? ` — signing in again
    will take you straight to where this link was headed.`
        : "."
    }</pre></section>
`,
  });
}

// GET /login/verify?token=…&next=… — render the confirm page. Does NOT consume
// the token (scanners/prefetchers fetch GETs and would burn a single-use link).
export function GET(req: Request): Response {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  // Default landing is /docs (the docs listing). It lists owned + shared docs;
  // an account-less session (no account yet) sees its shared docs plus the
  // "no account yet — tell your agent to sign up" line. loginLanding() also maps
  // a bare next of "/" to /docs — the real human flow (bare /login → form hidden
  // next="/" → emailed link carries next=/) would otherwise land on the homepage,
  // exactly the landing the spec says to avoid (birthday.md "post-verify (no
  // next) → /docs").
  const next = loginLanding(url.searchParams.get("next"));
  if (!token) return htmlResponse(deadLinkPage(next), { status: 410 });
  return htmlResponse(confirmPage(token, next));
}

// POST /login/verify (form: token, next) — atomic single-use consume, mint
// session, set cookie, 303 to sanitized next.
export async function POST(req: Request): Promise<Response> {
  if (!originOk(req)) {
    return htmlResponse(deadLinkPage(), { status: 403 });
  }
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  // loginLanding maps a missing/"/" next to /docs (see GET above) so the bare
  // /login human flow lands on /docs, never the homepage.
  const next = loginLanding(form.get("next") as string | null);
  if (!token) return htmlResponse(deadLinkPage(next), { status: 410 });

  const { rows } = await query<{ email: string; id: number }>(
    `UPDATE login_tokens SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING email, id`,
    [sha256Hex(token)]
  );
  const row = rows[0];
  if (!row) return htmlResponse(deadLinkPage(next), { status: 410 });

  // Mirror consumption into the QA table when enabled (best-effort).
  if (process.env.QA_SECRET) {
    query(`UPDATE qa_login_links SET consumed_at = now() WHERE login_token_id = $1`, [
      row.id,
    ]).catch(() => {});
  }

  const { token: sessionToken, sessionId } = await createSession(row.email);
  audit(req, "session.created", { meta: { email: row.email, session_id: sessionId } });

  return redirect(next, { "Set-Cookie": sessionCookieHeader(sessionToken) });
}
