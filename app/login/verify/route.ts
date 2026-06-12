import { manPage, htmlResponse, esc, redirect } from "@/lib/page";
import { sanitizeNext } from "@/lib/auth/url";
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

function deadLinkPage(): string {
  return manPage({
    title: "justhtml.sh — link expired",
    center: "LOGIN",
    bodyHtml: `
<h1>LINK EXPIRED OR USED</h1>
<section><pre>    This login link is expired or already used.

    Request a new one at <a href="/login">justhtml.sh/login</a>.</pre></section>
`,
  });
}

// GET /login/verify?token=…&next=… — render the confirm page. Does NOT consume
// the token (scanners/prefetchers fetch GETs and would burn a single-use link).
export function GET(req: Request): Response {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const next = sanitizeNext(url.searchParams.get("next"));
  if (!token) return htmlResponse(deadLinkPage(), { status: 410 });
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
  const next = sanitizeNext(String(form.get("next") ?? "/"));
  if (!token) return htmlResponse(deadLinkPage(), { status: 410 });

  const { rows } = await query<{ email: string; id: number }>(
    `UPDATE login_tokens SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING email, id`,
    [sha256Hex(token)]
  );
  const row = rows[0];
  if (!row) return htmlResponse(deadLinkPage(), { status: 410 });

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
