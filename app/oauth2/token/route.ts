import { oauthResponse, oauthError } from "@/lib/auth/responses";
import { clientIp } from "@/lib/auth/request";
import { enforceRateLimit } from "@/lib/auth/ratelimit";
import { resolveLiveRegistration, issueCredential } from "@/lib/auth/claim";
import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { POLL_INTERVAL_S, SCOPE_STRING } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";

// POST /oauth2/token (§3.3) — claim-grant polling + one-time credential
// issuance. All non-success responses are HTTP 400 with the OAuth envelope
// (RFC 8628 device-flow semantics over RFC 6749 transport).
export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  const tripped = await enforceRateLimit(req, [
    ip ? { key: `token:ip:${ip}`, limit: 300, window: "hour" } : null,
  ]);
  if (tripped) {
    return oauthError("rate_limited", `Retry after ${tripped.retryAfter} seconds.`, {
      status: 429,
      headers: { "Retry-After": String(tripped.retryAfter) },
    });
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return oauthError("invalid_request", "Malformed form body.");
  }

  const grantType = form.get("grant_type");
  if (!grantType) {
    return oauthError("unsupported_grant_type", "Missing grant_type.");
  }
  if (grantType !== CLAIM_GRANT) {
    return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}.`);
  }

  const claimToken = form.get("claim_token");
  if (!claimToken) {
    return oauthError("invalid_request", "claim_token: required.");
  }

  // Shared lookup (Theme T5). oauth2/token checks the registration window
  // BEFORE the claimed branch, so an expired-but-claimed reg is `expired`, not
  // issued — `expiredFirst` preserves that precedence.
  const resolved = await resolveLiveRegistration(claimToken, "expiredFirst");
  // 1. Unknown token — deliberately conflated with expired (no enumeration).
  if (resolved.kind === "notFound") {
    return oauthError("expired_token", "Unknown or expired claim_token.");
  }
  // 2. Registration window closed.
  if (resolved.kind === "expired") {
    audit(req, "registration.expired", { registrationId: resolved.reg.id });
    return oauthError("expired_token", "The claim ceremony window has closed.");
  }
  const reg = resolved.reg;

  // 4. Already claimed → issue key exactly once.
  if (resolved.kind === "claimed") {
    if (reg.credential_issued_at) {
      return oauthError("invalid_grant", "Credential already issued for this registration.");
    }
    return issueKey(req, reg.id);
  }

  // 3. Not yet claimed (live): check current attempt state, slow_down, then pending.
  const { rows: attemptRows } = await query<{
    consumed_at: string | null;
    expires_at: string;
  }>(
    `SELECT consumed_at, expires_at FROM claim_codes
     WHERE registration_id = $1 AND superseded_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [reg.id]
  );
  const attempt = attemptRows[0];
  const codeDead =
    !attempt ||
    attempt.consumed_at != null || // success-on-another-poll handled above; here = exhausted
    new Date(attempt.expires_at).getTime() <= Date.now();
  if (codeDead) {
    return oauthError(
      "expired_token",
      "The user_code window has closed. Re-initiate the claim ceremony at the claim_endpoint."
    );
  }

  // slow_down: polled < POLL_INTERVAL_S since the last poll. Record last_polled_at.
  const now = Date.now();
  const last = reg.last_polled_at ? new Date(reg.last_polled_at).getTime() : 0;
  await query(`UPDATE agent_registrations SET last_polled_at = now() WHERE id = $1`, [reg.id]);
  if (last && now - last < POLL_INTERVAL_S * 1000) {
    return oauthError("slow_down", "Polling too frequently; add at least 5 seconds.");
  }

  return oauthError("authorization_pending", "The user has not yet completed the ceremony.");
}

// Mint the long-lived API key (transaction guarded against double-issue lives
// in claim.ts/issueCredential) and map the plain result to the OAuth envelope.
async function issueKey(req: Request, regId: number): Promise<Response> {
  const result = await issueCredential(regId);
  if (result.kind === "notLive") {
    return oauthError("expired_token", "Unknown or expired claim_token.");
  }
  if (result.kind === "alreadyIssued") {
    return oauthError("invalid_grant", "Credential already issued for this registration.");
  }

  audit(req, "token.issued", {
    registrationId: regId,
    userId: result.userId,
    apiKeyId: result.apiKeyId,
    meta: { api_key_id: result.apiKeyId, scope: SCOPE_STRING },
  });

  return oauthResponse({
    access_token: result.apiKey,
    token_type: "Bearer",
    scope: SCOPE_STRING,
    credential_type: "api_key",
    registration_id: result.publicId,
  });
}
