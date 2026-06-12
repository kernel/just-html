import { agentError, jsonResponse } from "@/lib/auth/responses";
import { isEmailish } from "@/lib/auth/url";
import { clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { findByClaimToken, mintAttempt } from "@/lib/auth/claim";
import { query } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { MAX_REMINTS } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

// POST /agent/identity/claim (§3.2) — re-mint a user_code when the token
// endpoint returned expired_token but the 24h registration window is still
// open. Each call supersedes the prior attempt and mints a fresh one. A
// corrected email updates agent_registrations.email (registration is unclaimed).
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return agentError(400, "invalid_request", "Request body must be valid JSON.");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const claimToken = b.claim_token;
  const email = b.email;
  if (typeof claimToken !== "string" || !claimToken) {
    return agentError(400, "invalid_request", "claim_token: required string.");
  }
  if (email !== undefined && (typeof email !== "string" || !isEmailish(email))) {
    return agentError(400, "invalid_request", "email: must be an email address.");
  }

  const ip = clientIp(req);
  const tripped = await checkLimits([
    ip ? { key: `claim:ip:${ip}`, limit: 30, window: "hour" } : null,
  ]);
  if (tripped) {
    audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    return agentError(
      429,
      "rate_limited",
      `Too many re-mints. Retry after ${tripped.retryAfter} seconds.`,
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
  // Re-mint lifetime cap (§6 #4).
  if (reg.remint_count >= MAX_REMINTS) {
    return agentError(
      429,
      "rate_limited",
      "Too many re-mints for this registration. Restart registration."
    );
  }

  // Optional corrected email updates the registration binding (§3.2).
  if (typeof email === "string") {
    await query(`UPDATE agent_registrations SET email = $1 WHERE id = $2`, [
      email.toLowerCase(),
      reg.id,
    ]);
  }
  await query(
    `UPDATE agent_registrations SET remint_count = remint_count + 1 WHERE id = $1`,
    [reg.id]
  );

  const attempt = await mintAttempt(reg.id);

  audit(req, "claim.requested", {
    registrationId: reg.id,
    meta: { email: (typeof email === "string" ? email : reg.email).toLowerCase() },
  });
  audit(req, "user_code.minted", {
    registrationId: reg.id,
    meta: { claim_code_id: attempt.claimCodeId },
  });

  return jsonResponse({
    registration_id: reg.public_id,
    claim_attempt_id: attempt.attemptId,
    status: "initiated",
    expires_at: attempt.viewExpiresAt,
    claim_attempt: {
      user_code: attempt.userCode,
      expires_in: attempt.expiresIn,
      verification_uri: attempt.verificationUri,
      interval: attempt.interval,
    },
  });
}
