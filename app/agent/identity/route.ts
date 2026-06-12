import { agentError, jsonResponse } from "@/lib/auth/responses";
import { isEmailish } from "@/lib/auth/url";
import { clientIp } from "@/lib/auth/request";
import { checkLimits } from "@/lib/auth/ratelimit";
import { createRegistration } from "@/lib/auth/claim";
import { audit } from "@/lib/auth/audit";
import { SCOPES } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

// POST /agent/identity (§3.1) — start a service_auth registration. No user row
// is created here; accounts are created only at claim confirm.
export async function POST(req: Request): Promise<Response> {
  // 1. Rate limits: per-IP, then per-email, then global (§6 #1–3).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return agentError(400, "invalid_request", "Request body must be valid JSON.");
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const type = b.type;

  // Capability negotiation for unsupported types (§3.1).
  if (type === "anonymous") {
    return agentError(
      400,
      "anonymous_not_enabled",
      "This service requires a user email. Re-register with type service_auth."
    );
  }
  if (type === "identity_assertion") {
    return agentError(
      400,
      "issuer_not_enabled",
      "identity_assertion is not supported. Re-register with type service_auth."
    );
  }
  if (type !== "service_auth") {
    return agentError(
      400,
      "invalid_request",
      "type: expected 'service_auth'."
    );
  }

  const loginHint = b.login_hint;
  if (typeof loginHint !== "string" || loginHint.length === 0) {
    return agentError(400, "invalid_request", "login_hint: required string.");
  }
  if (!isEmailish(loginHint)) {
    return agentError(
      400,
      "invalid_login_hint",
      "login_hint must be a recognizable identifier (e.g. an email address)."
    );
  }
  const email = loginHint.toLowerCase();

  const ip = clientIp(req);
  const tripped = await checkLimits([
    ip ? { key: `ident:ip:${ip}`, limit: 10, window: "hour" } : null,
    { key: `ident:email:${email}`, limit: 10, window: "hour" },
    { key: "ident:global", limit: 100, window: "hour" },
  ]);
  if (tripped) {
    audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    return agentError(
      429,
      "rate_limited",
      `Too many registrations. Retry after ${tripped.retryAfter} seconds.`,
      { "Retry-After": String(tripped.retryAfter) }
    );
  }

  const { reg, claimToken, attempt } = await createRegistration(email);

  audit(req, "registration.created", {
    registrationId: reg.id,
    meta: { registration_type: "service_auth", login_hint: email },
  });
  audit(req, "user_code.minted", {
    registrationId: reg.id,
    meta: { claim_code_id: attempt.claimCodeId },
  });

  return jsonResponse({
    registration_id: reg.publicId,
    registration_type: "service_auth",
    claim_url: "https://justhtml.sh/agent/identity/claim",
    claim_token: claimToken,
    claim_token_expires: reg.claimExpiresAt,
    post_claim_scopes: SCOPES,
    claim: {
      user_code: attempt.userCode,
      expires_in: attempt.expiresIn,
      verification_uri: attempt.verificationUri,
      interval: attempt.interval,
    },
  });
}
