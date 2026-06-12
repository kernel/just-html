import { agentError, jsonResponse } from "@/lib/auth/responses";
import { clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { findByClaimToken, confirmClaim } from "@/lib/auth/claim";
import { sha256Hex, safeEqualHex } from "@/lib/auth/tokens";
import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { MAX_CODE_ATTEMPTS } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

// POST /agent/identity/claim/complete — the agent read-back completion (the
// ONE flow, founder directive 2026-06-12). The human reads the 6-digit code
// from the emailed claim message back to the agent, and the agent submits it
// here. This confirms the claim WITHOUT a browser session (there is none — the
// proof is the code, which only reached the human via the email to their
// inbox). On success the agent's /oauth2/token claim-grant poll returns the
// jh_live_ key.
//
// Constant-time code compare; 5 wrong attempts kill the code (410 code_dead),
// then re-mint via POST /agent/identity/claim sends a fresh email.
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return agentError(400, "invalid_request", "Request body must be valid JSON.");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const claimToken = b.claim_token;
  const userCode = b.user_code;
  if (typeof claimToken !== "string" || !claimToken) {
    return agentError(400, "invalid_request", "claim_token: required string.");
  }
  if (typeof userCode !== "string" || !/^[0-9]{6}$/.test(userCode.trim())) {
    return agentError(400, "invalid_request", "user_code: required 6-digit string.");
  }
  const code = userCode.trim();

  // Backstop against distributed code guessing across registrations from one IP
  // (mirrors the /claim form's per-IP cap; the per-code 5-attempt budget below
  // is the primary control).
  const ip = clientIp(req);
  const tripped = await checkLimits([
    ip ? { key: `claimcomplete:ip:${ip}`, limit: 30, window: "hour" } : null,
  ]);
  if (tripped) {
    audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    return agentError(
      429,
      "rate_limited",
      `Too many attempts. Retry after ${tripped.retryAfter} seconds.`,
      { "Retry-After": String(tripped.retryAfter) }
    );
  }

  const reg = await findByClaimToken(claimToken);
  if (!reg) {
    return agentError(401, "invalid_claim_token", "The claim token is invalid.");
  }
  if (reg.claimed_at) {
    return agentError(
      409,
      "claimed_or_in_flight",
      "This registration has already been claimed."
    );
  }
  if (new Date(reg.claim_expires_at).getTime() <= Date.now()) {
    audit(req, "registration.expired", { registrationId: reg.id });
    return agentError(410, "claim_expired", "Registration has expired.");
  }

  // Resolve the live attempt for this registration.
  const { rows: attemptRows } = await query<{
    id: number;
    code_hash: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT id, code_hash, expires_at, consumed_at
     FROM claim_codes
     WHERE registration_id = $1 AND superseded_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [reg.id]
  );
  const attempt = attemptRows[0];
  if (!attempt) {
    return agentError(410, "expired_token", "No live claim code. Re-initiate at the claim_endpoint.");
  }

  // Increment-then-compare in one statement; only touches a live, unconsumed code.
  const { rows: incRows } = await query<{ attempts: number }>(
    `UPDATE claim_codes SET attempts = attempts + 1
     WHERE id = $1 AND consumed_at IS NULL
     RETURNING attempts`,
    [attempt.id]
  );
  if (!incRows[0]) {
    // Already consumed (success or exhaustion) — dead either way.
    return agentError(
      410,
      "expired_token",
      "This code is no longer usable. Re-initiate at the claim_endpoint."
    );
  }
  const attempts = incRows[0].attempts;

  if (new Date(attempt.expires_at).getTime() <= Date.now()) {
    return agentError(
      410,
      "expired_token",
      "The user_code has expired. Re-initiate at the claim_endpoint."
    );
  }

  const matches = safeEqualHex(sha256Hex(code), attempt.code_hash);
  if (!matches) {
    audit(req, "claim.attempt_failed", {
      registrationId: reg.id,
      meta: { attempts, via: "complete" },
    });
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await query(`UPDATE claim_codes SET consumed_at = now() WHERE id = $1`, [attempt.id]);
      return agentError(
        410,
        "code_dead",
        "Too many incorrect attempts — this code is dead. Re-initiate at the claim_endpoint."
      );
    }
    return agentError(
      401,
      "invalid_user_code",
      `That code doesn't match. ${MAX_CODE_ATTEMPTS - attempts} attempt(s) remaining.`
    );
  }

  // Success: confirm in one transaction — consume code, find-or-create user,
  // bind registration. The ceremony does NOT mint a session (no browser here;
  // humans sign in at /login). The agent's /oauth2/token poll then returns the
  // key.
  const userId = await confirmClaim({
    claimCodeId: attempt.id,
    registrationId: reg.id,
    email: reg.email,
  });

  audit(req, "claim.confirmed", {
    registrationId: reg.id,
    userId,
    meta: { claimed_by_user_id: userId, via: "complete" },
  });

  return jsonResponse({
    registration_id: reg.public_id,
    status: "claimed",
    message: "Claim confirmed. Poll /oauth2/token for your API key.",
  });
}
