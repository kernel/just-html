import { htmlResponse, redirect } from "@/lib/page";
import { signingInPage, deadLinkPage } from "@/lib/auth/verify-pages";
import { loginLanding } from "@/lib/auth/url";
import { originOk } from "@/lib/auth/request";
import { sha256Hex } from "@/lib/auth/tokens";
import { createSession, sessionCookieHeader } from "@/lib/auth/session";
import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

// GET /login/verify?token=…&next=… — render the invisible auto-submit shim.
// Does NOT consume the token (scanners/prefetchers fetch GETs and would burn a
// single-use link); only the POST consumes. A token-less hit gets the dead-link
// page (410) with no form/script, so we never auto-submit into an error.
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
  return htmlResponse(signingInPage(token, next));
}

// POST /login/verify (form: token, next) — atomic single-use consume, mint
// session, set cookie, 303 to sanitized next.
export async function POST(req: Request): Promise<Response> {
  if (!originOk(req)) {
    return htmlResponse(deadLinkPage(), { status: 403 });
  }
  // An empty or unparseable body makes req.formData() throw; treat that as a
  // missing token (a 4xx dead-link page) rather than letting it surface as a 500.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return htmlResponse(deadLinkPage(), { status: 400 });
  }
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

  const { token: sessionToken, sessionId } = await createSession(row.email);
  audit(req, "session.created", { meta: { email: row.email, session_id: sessionId } });

  return redirect(next, { "Set-Cookie": sessionCookieHeader(sessionToken) });
}
