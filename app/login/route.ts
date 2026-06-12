import { manPage, htmlResponse, esc, redirect } from "@/lib/page";
import { getSession } from "@/lib/auth/session";
import { sanitizeNext, isEmailish } from "@/lib/auth/url";
import { originOk, clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { mintLoginToken, sha256Hex } from "@/lib/auth/tokens";
import { sendLoginEmail } from "@/lib/auth/email";
import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { LOGIN_TOKEN_TTL_S, ORIGIN } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

const EXPIRY_MIN = Math.round(LOGIN_TOKEN_TTL_S / 60);

function loginForm(next: string, error?: string): string {
  const errBlock = error
    ? `<section><pre style="color:#b00020">    ${esc(error)}</pre></section>\n`
    : "";
  return manPage({
    title: "justhtml.sh — login",
    center: "LOGIN",
    bodyHtml: `
<h1>SIGN IN</h1>
<section><pre>    Enter your email and we'll send a single-use login link.
    No password. This never creates an account — sign-up is
    agent-only (see <a href="/auth.md">/auth.md</a>).</pre></section>
${errBlock}
<section><form method="POST" action="/login">
<pre>    email: <input type="email" name="email" required autofocus
           inputmode="email" autocomplete="email"
           style="font:inherit;padding:2px 4px"></pre>
<input type="hidden" name="next" value="${esc(next)}">
<pre>    <button type="submit" style="font:inherit;padding:2px 10px">send login link</button></pre>
</form></section>
`,
  });
}

function checkEmailPage(): string {
  return manPage({
    title: "justhtml.sh — check your email",
    center: "LOGIN",
    bodyHtml: `
<h1>CHECK YOUR EMAIL</h1>
<section><pre>    If that address can sign in, a login link is on its way.

    The link is single-use and expires in ${EXPIRY_MIN} minutes. Click it on
    this device to sign in. If a claim ceremony is in progress you'll
    land on the 6-digit code form.

    Didn't get it? It may be filtered, or the address may be one we
    don't send to. You can <a href="/login">request another</a>.</pre></section>
`,
  });
}

// GET /login?next=… — render the form (or 303 if already signed in).
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = sanitizeNext(url.searchParams.get("next"));
  const session = await getSession(req);
  if (session) return redirect(next);
  return htmlResponse(loginForm(next));
}

// POST /login (form: email, next) — mint + send a magic link. Never creates a
// user. Same "check your email" response regardless of whether an account
// exists (no enumeration).
export async function POST(req: Request): Promise<Response> {
  if (!originOk(req)) {
    return htmlResponse(loginForm("/", "Request rejected (bad origin)."), { status: 403 });
  }
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim();
  const next = sanitizeNext(String(form.get("next") ?? "/"));

  if (!isEmailish(email)) {
    return htmlResponse(loginForm(next, "Enter a valid email address."), { status: 400 });
  }
  const lower = email.toLowerCase();

  const ip = clientIp(req);
  const tripped = await checkLimits([
    ip ? { key: `login:ip:${ip}`, limit: 10, window: "hour" } : null,
    { key: `login:email:${lower}`, limit: 5, window: "hour" },
    { key: `login:email:day:${lower}`, limit: 20, window: "day" },
    { key: "login:global", limit: 50, window: "hour" },
  ]);
  if (tripped) {
    audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    const mins = Math.ceil(tripped.retryAfter / 60);
    return htmlResponse(
      manPage({
        title: "justhtml.sh — slow down",
        center: "LOGIN",
        bodyHtml: `<h1>TOO MANY REQUESTS</h1>
<section><pre>    Too many login links requested. Try again in about ${mins} minute(s).</pre></section>`,
      }),
      { status: 429, headers: { "Retry-After": String(tripped.retryAfter) } }
    );
  }

  // Mint token row first; roll it back if the email send fails.
  const token = mintLoginToken();
  const { rows } = await query<{ id: number }>(
    `INSERT INTO login_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
     RETURNING id`,
    [lower, sha256Hex(token), String(LOGIN_TOKEN_TTL_S)]
  );
  const tokenId = rows[0].id;

  const verifyUrl = `${ORIGIN}/login/verify?token=${token}&next=${encodeURIComponent(next)}`;

  // QA escape hatch (REMOVABLE post-launch): when QA_SECRET is set, store the
  // plaintext link so automated reviewers can complete the flow. Never write
  // here when QA mode is off.
  if (process.env.QA_SECRET) {
    await query(
      `INSERT INTO qa_login_links (email, link, login_token_id) VALUES ($1, $2, $3)`,
      [lower, verifyUrl, tokenId]
    ).catch(() => {});
  }

  let resendId: string | null = null;
  try {
    resendId = await sendLoginEmail(lower, verifyUrl);
  } catch {
    // Roll back the token row so a failed send doesn't leave a live token.
    await query(`DELETE FROM login_tokens WHERE id = $1`, [tokenId]).catch(() => {});
    if (process.env.QA_SECRET) {
      await query(`DELETE FROM qa_login_links WHERE login_token_id = $1`, [tokenId]).catch(
        () => {}
      );
    }
    return htmlResponse(
      manPage({
        title: "justhtml.sh — email failed",
        center: "LOGIN",
        bodyHtml: `<h1>COULDN'T SEND</h1>
<section><pre>    We couldn't send the login email just now. Please <a href="/login">try again</a>.</pre></section>`,
      }),
      { status: 500 }
    );
  }

  audit(req, "login_link.requested", { meta: { email: lower, resend_id: resendId } });
  return htmlResponse(checkEmailPage());
}
