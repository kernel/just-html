import { manPage, htmlResponse, esc, redirect } from "@/lib/page";
import { getSession } from "@/lib/auth/session";
import { sanitizeNext, loginLanding, isEmailish } from "@/lib/auth/url";
import { originOk, clientIp } from "@/lib/auth/request";
import { checkLimits, EMAIL_SEND_LIMITS } from "@/lib/auth/ratelimit";
import { mintLoginToken, sha256Hex } from "@/lib/auth/tokens";
import { sendLoginEmail } from "@/lib/auth/email";
import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { LOGIN_TOKEN_TTL_S, ORIGIN } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

const EXPIRY_MIN = Math.round(LOGIN_TOKEN_TTL_S / 60);

// The sign-in intro copy. Generic and honest: /login sends a single-use sign-in
// link. There is no longer a claim `next=` context — the claim ceremony is the
// emailed-code flow and never routes humans through /login (birthday.md "The
// claim ceremony — ONE flow"). We avoid the earlier "this never creates an
// account" phrasing the founder found confusing; we just say what it does.
function introCopy(): string {
  return `Enter your email and we'll send a single-use link that signs you
in on this device. No password.

Sign-up is agent-only: an account is created when your agent signs
you up via <a href="/auth.md">/auth.md</a>. Use this to get back to docs you own or
that were shared with you.`;
}

// Variant A chrome with the LOCKED /login spacing fix: a clear vertical gap
// between the email input and the "send login link" button (birthday.md:
// "add vertical space between the email input and the … button"). The blank
// <pre> line inside the form supplies that gap in the monospace column.
function loginForm(next: string, opts: { error?: string } = {}): string {
  const errBlock = opts.error
    ? `<p class="err">${esc(opts.error)}</p>\n`
    : "";
  return manPage({
    title: "justhtml.sh — login",
    bodyHtml: `
<h2>SIGN IN</h2>
<div class="body"><pre>${introCopy()}</pre></div>

<h2>EMAIL</h2>
<div class="body">
${errBlock}<form method="POST" action="/login">
<pre>email: <input type="email" name="email" required autofocus inputmode="email" autocomplete="email" placeholder="you@example.com"></pre>
<input type="hidden" name="next" value="${esc(next)}">
<pre>

       <button type="submit">send login link</button></pre>
</form>
</div>
`,
  });
}

// Dashboard-lite landing for a signed-in session with no onward destination.
// Account-less sessions (signed in, but no account yet — sign-up is agent-only)
// get the "tell your agent to sign up" message; sessions bound to an account get
// a short account summary. Man-page styled, zero JS.
function dashboardPage(email: string, hasAccount: boolean): string {
  const body = hasAccount
    ? `<h2>SIGNED IN</h2>
<div class="body"><pre>You're signed in as <code>${esc(email)}</code>, and you have a justhtml.sh
account. See <a href="/docs">your documents</a> — owned and shared with you.

Your agent publishes and manages docs with the key it received when
it signed you up. Private docs you own (and any shared with your
email) render right in the browser while you're signed in.

See <a href="/llms.txt">/llms.txt</a> and <a href="/api/spec.yaml">/api/spec.yaml</a> for the full API.</pre></div>`
    : `<h2>NO ACCOUNT YET</h2>
<div class="body"><pre>You're signed in as <code>${esc(email)}</code>, but you don't have a
justhtml.sh account yet.

Sign-up is agent-only — tell your agent to sign up at
<a href="/auth.md">justhtml.sh/auth.md</a>. It registers with this email; we email you a
6-digit code; you read the code back to your agent. You'll end up
with an account and your agent will hold the API key.

Anything shared with your email shows up under <a href="/docs">your documents</a>.</pre></div>`;
  return manPage({
    title: "justhtml.sh — account",
    bodyHtml: body,
  });
}

function checkEmailPage(): string {
  return manPage({
    title: "justhtml.sh — check your email",
    bodyHtml: `
<h2>CHECK YOUR EMAIL</h2>
<div class="body"><pre>If that address can sign in, a login link is on its way.

The link is single-use and expires in ${EXPIRY_MIN} minutes. Click it on
this device to sign in.

Didn't get it? It may be filtered, or the address may be one we
don't send to. You can <a href="/login">request another</a>.</pre></div>
`,
  });
}

// GET /login?next=… — render the form, or if already signed in: redirect to a
// real onward destination, else show the dashboard-lite account landing (which
// carries the "no account yet — tell your agent to sign up" message for
// account-less sessions).
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const next = sanitizeNext(url.searchParams.get("next"));
  const session = await getSession(req);
  if (session) {
    if (next !== "/") return redirect(next);
    return htmlResponse(dashboardPage(session.email, session.user_id != null));
  }
  // The form's hidden `next` defaults to /docs for a bare /login (no real
  // destination), so the emailed link itself carries next=/docs and post-verify
  // lands on the docs listing, not the homepage (birthday.md "post-verify (no
  // next) → /docs"). A real next (a /d/:slug share link) is preserved.
  return htmlResponse(loginForm(loginLanding(next)));
}

// POST /login (form: email, next) — mint + send a magic link. Never creates a
// user. Same "check your email" response regardless of whether an account
// exists (no enumeration).
export async function POST(req: Request): Promise<Response> {
  if (!originOk(req)) {
    return htmlResponse(loginForm("/", { error: "Request rejected (bad origin)." }), {
      status: 403,
    });
  }
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim();
  const next = sanitizeNext(String(form.get("next") ?? "/"));

  if (!isEmailish(email)) {
    return htmlResponse(
      loginForm(next, { error: "Enter a valid email address." }),
      { status: 400 }
    );
  }
  const lower = email.toLowerCase();

  const ip = clientIp(req);
  // Email-send caps (recalibrated 2026-06-12): per-IP 30/h, per-email 5/h +
  // 20/day, global 500/h. Shared with B9 claim-email registration so one
  // recipient/IP draws from a single send budget (see ratelimit.ts).
  const tripped = await checkLimits(EMAIL_SEND_LIMITS(lower, ip));
  if (tripped) {
    audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    const mins = Math.ceil(tripped.retryAfter / 60);
    return htmlResponse(
      manPage({
        title: "justhtml.sh — slow down",
        bodyHtml: `<h2>TOO MANY REQUESTS</h2>
<div class="body"><pre>Too many login links requested. Try again in about ${mins} minute(s).</pre></div>`,
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
    resendId = await sendLoginEmail(lower, verifyUrl, `login-${tokenId}`);
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
        bodyHtml: `<h2>COULDN'T SEND</h2>
<div class="body"><pre>We couldn't send the login email just now. Please <a href="/login">try again</a>.</pre></div>`,
      }),
      { status: 500 }
    );
  }

  audit(req, "login_link.requested", { meta: { email: lower, resend_id: resendId } });
  return htmlResponse(checkEmailPage());
}
