import { manPage, htmlResponse, esc, redirect } from "@/lib/page";
import { originOk, clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { sha256Hex } from "@/lib/auth/tokens";
import { query } from "@/lib/db";
import { confirmClaim } from "@/lib/auth/claim";
import { createSession, sessionCookieHeader } from "@/lib/auth/session";
import { audit } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

// B9 hybrid claim ceremony (claim_delivery=email): the scanner-safe approve
// link emailed to the login_hint. Inbox possession IS the binding proof, so
// this path needs no pre-existing session — approving mints one (the human
// walks away logged in on this device) and confirms the claim. Mirrors the
// GET-confirm / POST-consume pattern of /login/verify: the GET only renders a
// button (email scanners and link prefetchers fetch GETs and would otherwise
// burn the single-use token); the POST consumes.

// Resolve the registration + live attempt behind an approve token (cva_).
type Resolved = {
  registrationId: number;
  regEmail: string;
  claimedAt: string | null;
  claimExpiresAt: string;
  claimCodeId: number;
  viewExpiresAt: string;
  codeConsumedAt: string | null;
  approvedAt: string | null;
};

async function resolve(approveToken: string): Promise<Resolved | null> {
  const { rows } = await query<{
    registration_id: number;
    reg_email: string;
    claimed_at: string | null;
    claim_expires_at: string;
    claim_code_id: number;
    view_expires_at: string;
    code_consumed_at: string | null;
    approved_at: string | null;
  }>(
    `SELECT r.id AS registration_id, r.email AS reg_email, r.claimed_at,
            r.claim_expires_at, c.id AS claim_code_id, c.view_expires_at,
            c.consumed_at AS code_consumed_at, c.approved_at
     FROM claim_codes c
     JOIN agent_registrations r ON r.id = c.registration_id
     WHERE c.approve_token_hash = $1 AND c.superseded_at IS NULL`,
    [sha256Hex(approveToken)]
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
    approvedAt: r.approved_at,
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

function confirmPage(approveToken: string, email: string): Response {
  return htmlResponse(
    manPage({
      title: "justhtml.sh — approve API key",
      center: "CLAIM",
      bodyHtml: `
<h1>APPROVE API KEY</h1>
<section><pre>    An agent is registering a justhtml.sh account for
    ${esc(email)} and asking for a key that can publish and edit
    HTML documents as you.

    Approve the API key for ${esc(email)}?</pre></section>
<section><form method="POST" action="/claim/approve">
<input type="hidden" name="token" value="${esc(approveToken)}">
<pre>    <button type="submit" style="font:inherit;padding:2px 10px">approve</button></pre>
</form></section>
<section><pre>    Approving also signs you in on this device. Only approve if you
    started this — you (or an agent you trust) asked to sign up for
    justhtml.sh. If you didn't, close this tab; nothing happens
    without the click.</pre></section>
`,
    })
  );
}

// GET /claim/approve?token=cva_… — render the scanner-safe confirm page. Does
// NOT consume the token.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const approveToken = url.searchParams.get("token") ?? "";

  const r = await resolve(approveToken);
  if (!r) {
    return page(
      "link invalid",
      "LINK INVALID",
      "    This approve link may have been superseded, used, or expired.\n    Ask the agent to start a new claim.",
      404
    );
  }
  if (r.claimedAt || r.approvedAt) {
    return page(
      "already approved",
      "ALREADY APPROVED",
      "    This key has already been approved. You can close this tab;\n    the agent will pick up automatically.",
      200
    );
  }
  if (new Date(r.viewExpiresAt).getTime() <= Date.now()) {
    return page(
      "link expired",
      "LINK EXPIRED",
      "    Ask the agent for a fresh approve link (or code).",
      410
    );
  }
  return confirmPage(approveToken, r.regEmail);
}

// POST /claim/approve (form: token) — consume the approve token, confirm the
// claim, mint a logged-in session for the registration email, redirect to /docs.
export async function POST(req: Request): Promise<Response> {
  if (!originOk(req)) {
    return page("rejected", "REJECTED", "    Request rejected (bad origin).", 403);
  }
  const form = await req.formData();
  const approveToken = String(form.get("token") ?? "");

  const ip = clientIp(req);
  const tripped = await checkLimits([
    ip ? { key: `approve:ip:${ip}`, limit: 30, window: "hour" } : null,
  ]);
  if (tripped) {
    audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    const mins = Math.ceil(tripped.retryAfter / 60);
    return page(
      "slow down",
      "TOO MANY REQUESTS",
      `    Too many requests. Try again in about ${mins} minute(s).`,
      429
    );
  }

  const r = await resolve(approveToken);
  if (!r) {
    return page(
      "link invalid",
      "LINK INVALID",
      "    This approve link may have been superseded, used, or expired.\n    Ask the agent to start a new claim.",
      404
    );
  }
  if (r.claimedAt || r.approvedAt) {
    return page(
      "already approved",
      "ALREADY APPROVED",
      "    This key has already been approved. You can close this tab;\n    the agent will pick up automatically.",
      200
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
  if (new Date(r.viewExpiresAt).getTime() <= Date.now()) {
    return page(
      "link expired",
      "LINK EXPIRED",
      "    Ask the agent for a fresh approve link (or code).",
      410
    );
  }

  // Atomically consume the approve token: single-use guard on consumed_at. If
  // the row is already consumed (code read-back or a double-submit raced us),
  // bail out as already-approved rather than double-confirming.
  const { rows } = await query<{ id: number }>(
    `UPDATE claim_codes SET consumed_at = now(), approved_at = now()
     WHERE id = $1 AND consumed_at IS NULL
     RETURNING id`,
    [r.claimCodeId]
  );
  if (!rows[0]) {
    return page(
      "already approved",
      "ALREADY APPROVED",
      "    This key has already been approved. You can close this tab;\n    the agent will pick up automatically.",
      200
    );
  }

  // Mint a fresh session for the registration email (inbox possession is the
  // proof — the approver need not have been signed in). Then bind the claim and
  // backfill this session's user_id so the human lands logged in. The code is
  // already consumed above; confirmClaim only find-or-creates the user + binds.
  const sess = await createSession(r.regEmail);
  const userId = await confirmClaim({
    claimCodeId: r.claimCodeId,
    registrationId: r.registrationId,
    email: r.regEmail,
    sessionId: sess.sessionId,
    // consumed_at/approved_at already set above; confirmClaim re-stamps them
    // harmlessly (idempotent now()), so don't double-mark.
  });

  audit(req, "claim.approved_via_link", {
    registrationId: r.registrationId,
    userId,
    meta: { claimed_by_user_id: userId, session_id: sess.sessionId, via: "approve_link" },
  });

  return redirect("/docs", { "Set-Cookie": sessionCookieHeader(sess.token) });
}
