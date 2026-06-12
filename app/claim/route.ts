import { manPage, htmlResponse, esc, redirect } from "@/lib/page";
import { getSession, type Session } from "@/lib/auth/session";
import { originOk, clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { sha256Hex, safeEqualHex } from "@/lib/auth/tokens";
import { query } from "@/lib/db";
import { confirmClaim } from "@/lib/auth/claim";
import { audit } from "@/lib/auth/audit";
import { MAX_CODE_ATTEMPTS } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

// Resolve the registration + live attempt behind a claim_attempt_token (cvt_).
type Resolved = {
  registrationId: number;
  regEmail: string;
  claimedAt: string | null;
  claimExpiresAt: string;
  claimCodeId: number;
  viewExpiresAt: string;
  codeConsumedAt: string | null;
  codeExpiresAt: string;
  attempts: number;
  codeHash: string;
};

async function resolve(attemptToken: string): Promise<Resolved | null> {
  const { rows } = await query<{
    registration_id: number;
    reg_email: string;
    claimed_at: string | null;
    claim_expires_at: string;
    claim_code_id: number;
    view_expires_at: string;
    code_consumed_at: string | null;
    code_expires_at: string;
    attempts: number;
    code_hash: string;
  }>(
    `SELECT r.id AS registration_id, r.email AS reg_email, r.claimed_at,
            r.claim_expires_at, c.id AS claim_code_id, c.view_expires_at,
            c.consumed_at AS code_consumed_at, c.expires_at AS code_expires_at,
            c.attempts, c.code_hash
     FROM claim_codes c
     JOIN agent_registrations r ON r.id = c.registration_id
     WHERE c.view_token_hash = $1 AND c.superseded_at IS NULL`,
    [sha256Hex(attemptToken)]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    registrationId: r.registration_id,
    regEmail: r.reg_email,
    claimedAt: r.claimed_at,
    claimExpiresAt: r.claim_expires_at,
    claimCodeId: r.claim_code_id,
    viewExpiresAt: r.view_expires_at,
    codeConsumedAt: r.code_consumed_at,
    codeExpiresAt: r.code_expires_at,
    attempts: r.attempts,
    codeHash: r.code_hash,
  };
}

function page(title: string, heading: string, body: string, status = 200): Response {
  return htmlResponse(
    manPage({
      title: `justhtml.sh — ${title}`,
      center: "CLAIM",
      bodyHtml: `<h1>${esc(heading)}</h1>\n<section><pre>${body}</pre></section>`,
    }),
    { status }
  );
}

function loginRedirect(attemptToken: string): Response {
  const next = `/claim?claim_attempt_token=${attemptToken}`;
  return redirect(`/login?next=${encodeURIComponent(next)}`);
}

async function isFirstAgent(email: string): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_registrations
     WHERE email = $1 AND claimed_at IS NOT NULL`,
    [email]
  );
  return (rows[0]?.n ?? "0") === "0";
}

async function formPage(
  session: Session,
  attemptToken: string,
  opts: { error?: string; remaining?: number } = {}
): Promise<Response> {
  const first = await isFirstAgent(session.email);
  const errBlock = opts.error
    ? `<section><pre style="color:#b00020">    ${esc(opts.error)}${
        opts.remaining != null ? `\n    ${opts.remaining} attempts remaining.` : ""
      }</pre></section>\n`
    : "";
  const firstBlock = first
    ? `<section><pre>    This is the first agent being linked to ${esc(session.email)}.</pre></section>\n`
    : "";
  return htmlResponse(
    manPage({
      title: "justhtml.sh — authorize agent",
      center: "CLAIM",
      bodyHtml: `
<h1>AUTHORIZE AGENT</h1>
<section><pre>    You're signed in as ${esc(session.email)}.

    Your agent is creating a justhtml.sh account for this email and
    asking for an API key to publish and edit HTML documents as you.
    The agent should have shown you a 6-digit code — enter it below
    to create the account and authorize the agent.</pre></section>
${firstBlock}${errBlock}
<section><form method="POST" action="/claim">
<input type="hidden" name="claim_attempt_token" value="${esc(attemptToken)}">
<pre>    code: <input name="user_code" inputmode="numeric" pattern="[0-9]{6}"
          autocomplete="one-time-code" required autofocus maxlength="6"
          style="font:inherit;padding:2px 4px;letter-spacing:0.3em"></pre>
<pre>    <button type="submit" style="font:inherit;padding:2px 10px">authorize</button></pre>
</form></section>
<section><pre>    Only enter a code from an agent you trust. Pasting a code from an
    untrusted source could let that agent act on your behalf.</pre></section>
`,
    })
  );
}

// GET /claim?claim_attempt_token=cvt_… (§9.3 table).
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const attemptToken = url.searchParams.get("claim_attempt_token") ?? "";
  const session = await getSession(req);
  if (!session) return loginRedirect(attemptToken);

  const r = await resolve(attemptToken);
  if (!r) {
    return page(
      "link invalid",
      "LINK INVALID",
      "    This link may have been superseded, used, or expired.\n    Ask the agent to start a new claim.",
      404
    );
  }
  if (r.claimedAt) {
    return page("already claimed", "ALREADY CLAIMED", "    You can close this tab.", 200);
  }
  if (new Date(r.viewExpiresAt).getTime() <= Date.now()) {
    return page(
      "link expired",
      "LINK EXPIRED",
      "    Ask the agent for a fresh code and link.",
      410
    );
  }
  if (session.email.toLowerCase() !== r.regEmail.toLowerCase()) {
    return wrongAccount(r.regEmail, session.email, attemptToken);
  }
  return formPage(session, attemptToken);
}

function wrongAccount(regEmail: string, sessionEmail: string, attemptToken: string): Response {
  const next = `/claim?claim_attempt_token=${attemptToken}`;
  return htmlResponse(
    manPage({
      title: "justhtml.sh — wrong account",
      center: "CLAIM",
      bodyHtml: `
<h1>WRONG ACCOUNT</h1>
<section><pre>    This claim was started for ${esc(regEmail)}.
    You're signed in as ${esc(sessionEmail)}.

    Sign in as that address to authorize the agent:
    <a href="/login?next=${esc(encodeURIComponent(next))}">sign in as ${esc(regEmail)}</a></pre></section>
`,
    }),
    { status: 403 }
  );
}

// POST /claim (form: claim_attempt_token, user_code) — verify + confirm (§9.3).
export async function POST(req: Request): Promise<Response> {
  if (!originOk(req)) {
    return page("rejected", "REJECTED", "    Request rejected (bad origin).", 403);
  }
  const session = await getSession(req);
  const form = await req.formData();
  const attemptToken = String(form.get("claim_attempt_token") ?? "");
  const userCode = String(form.get("user_code") ?? "").trim();

  if (!session) return loginRedirect(attemptToken);

  const ip = clientIp(req);
  const tripped = await checkLimits([
    ip ? { key: `claimform:ip:${ip}`, limit: 30, window: "hour" } : null,
  ]);
  if (tripped) {
    audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    const mins = Math.ceil(tripped.retryAfter / 60);
    return page(
      "slow down",
      "TOO MANY REQUESTS",
      `    Too many attempts. Try again in about ${mins} minute(s).`,
      429
    );
  }

  const r = await resolve(attemptToken);
  if (!r) {
    return page(
      "link invalid",
      "LINK INVALID",
      "    This link may have been superseded, used, or expired.\n    Ask the agent to start a new claim.",
      404
    );
  }
  if (r.claimedAt) {
    return page(
      "already claimed",
      "ALREADY CLAIMED",
      "    This registration has already been claimed.",
      409
    );
  }
  if (new Date(r.claimExpiresAt).getTime() <= Date.now()) {
    return page(
      "expired",
      "CLAIM EXPIRED",
      "    This claim has expired. Ask the agent to start a new one.",
      410
    );
  }
  if (session.email.toLowerCase() !== r.regEmail.toLowerCase()) {
    return wrongAccount(r.regEmail, session.email, attemptToken);
  }

  // Increment-then-compare in one statement; only touches a live, unexpired code.
  const { rows } = await query<{ attempts: number }>(
    `UPDATE claim_codes SET attempts = attempts + 1
     WHERE id = $1 AND consumed_at IS NULL
     RETURNING attempts`,
    [r.claimCodeId]
  );
  if (!rows[0]) {
    // Code already consumed (success or exhaustion) between resolve and now.
    return page(
      "code dead",
      "CODE DEAD",
      "    This code is no longer usable. Ask the agent for a fresh code.",
      410
    );
  }
  const attempts = rows[0].attempts;

  if (new Date(r.codeExpiresAt).getTime() <= Date.now()) {
    return page(
      "code expired",
      "CODE EXPIRED",
      "    That code has expired. Ask the agent for a fresh code.",
      410
    );
  }

  const matches = safeEqualHex(sha256Hex(userCode), r.codeHash);
  if (!matches) {
    audit(req, "claim.attempt_failed", {
      registrationId: r.registrationId,
      meta: { attempts },
    });
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await query(`UPDATE claim_codes SET consumed_at = now() WHERE id = $1`, [r.claimCodeId]);
      return page(
        "code dead",
        "CODE DEAD",
        "    Too many incorrect attempts — this code is dead.\n    Ask the agent for a fresh code.",
        410
      );
    }
    return formPage(session, attemptToken, {
      error: "That code doesn't match. Check the digits and try again.",
      remaining: MAX_CODE_ATTEMPTS - attempts,
    });
  }

  // Success: confirm in one transaction — consume code, find-or-create user,
  // bind registration, backfill the session's user_id.
  const userId = await confirmClaim({
    claimCodeId: r.claimCodeId,
    registrationId: r.registrationId,
    email: r.regEmail,
    sessionId: session.id,
  });

  audit(req, "claim.confirmed", {
    registrationId: r.registrationId,
    userId,
    meta: { claimed_by_user_id: userId, session_id: session.id, via: "form" },
  });

  return page(
    "all set",
    "ALL SET",
    "    The agent has been authorized to act on your behalf.\n    You can close this tab; the agent will pick up automatically.",
    200
  );
}
