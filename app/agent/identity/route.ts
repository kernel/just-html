import { agentError, jsonResponse } from "@/lib/auth/responses";
import { isEmailish } from "@/lib/auth/url";
import { clientIp } from "@/lib/auth/request";
import { checkLimits, EMAIL_SEND_LIMITS } from "@/lib/auth/ratelimit";
import { createRegistration } from "@/lib/auth/claim";
import { sendClaimEmail } from "@/lib/auth/email";
import { audit } from "@/lib/auth/audit";
import { SCOPES, ORIGIN } from "@/lib/auth/config";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /agent/identity (§3.1) — start a service_auth registration. No user row
// is created here; accounts are created only at claim confirm.
//
// ONE flow (founder directive 2026-06-12): we always email the human a 6-digit
// code (the code and nothing else — no links). The user_code is NEVER returned
// in the API response (binding proof = inbox possession). The human reads the
// code back to the agent, which submits it to /agent/identity/claim/complete.
// There is no claim_delivery parameter, no approve link, no hosted claim form,
// and no spec-pure variant.
export async function POST(req: Request): Promise<Response> {
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

  // claim_delivery is gone (one flow only). Reject it explicitly rather than
  // silently ignoring, so an agent built against the old hybrid flow gets a
  // clear signal instead of unexpectedly-emailed behavior (birthday.md:
  // "registration accepts and ignores unknown params or 400s on it — pick one,
  // document it"; we 400).
  if (b.claim_delivery !== undefined) {
    return agentError(
      400,
      "invalid_request",
      "claim_delivery is no longer supported. There is one flow: we email the human a 6-digit code; they read it back to you for POST /agent/identity/claim/complete."
    );
  }

  const ip = clientIp(req);
  // Registration rate limits (§6 #1–3). Registration always sends an email, so
  // the email-send caps (per-email 5/h + 20/day, per-IP 30/h, global 500/h)
  // ALSO apply, checked alongside the registration caps before we mint anything
  // (authmd-implementation.md §6).
  const tripped = await checkLimits([
    ip ? { key: `ident:ip:${ip}`, limit: 10, window: "hour" } : null,
    { key: `ident:email:${email}`, limit: 10, window: "hour" },
    { key: "ident:global", limit: 100, window: "hour" },
    ...EMAIL_SEND_LIMITS(email, ip),
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

  // Send the claim email (the 6-digit code, nothing else). A send failure fails
  // the registration cleanly so we never leave the agent polling a registration
  // whose human never got the code.
  let resendId: string | null = null;
  try {
    resendId = await sendClaimEmail({
      to: email,
      code: attempt.userCode,
      idempotencyKey: `claim-${attempt.claimCodeId}`,
    });
  } catch {
    await query(
      `UPDATE claim_codes SET superseded_at = now() WHERE id = $1`,
      [attempt.claimCodeId]
    ).catch(() => {});
    await query(
      `UPDATE agent_registrations SET claim_expires_at = now() WHERE id = $1`,
      [reg.id]
    ).catch(() => {});
    return agentError(
      503,
      "email_send_failed",
      "Could not send the confirmation email. Retry registration in a moment."
    );
  }
  // QA escape hatch (REMOVABLE post-launch): mirror the plaintext code so
  // automated reviewers can complete the flow (the code is hashed everywhere
  // else). Only when QA_SECRET is set.
  if (process.env.QA_SECRET) {
    await query(
      `INSERT INTO qa_claim_emails (email, code, claim_code_id)
       VALUES ($1, $2, $3)`,
      [email, attempt.userCode, attempt.claimCodeId]
    ).catch(() => {});
  }
  audit(req, "claim_email.sent", {
    registrationId: reg.id,
    meta: { claim_code_id: attempt.claimCodeId, resend_id: resendId },
  });

  // The claim block: the user_code is NEVER returned (it was emailed; returning
  // it would break the inbox-possession binding proof). We hand the agent the
  // complete_url, the code TTL, and the poll interval.
  return jsonResponse({
    registration_id: reg.publicId,
    registration_type: "service_auth",
    claim_url: `${ORIGIN}/agent/identity/claim`,
    claim_token: claimToken,
    claim_token_expires: reg.claimExpiresAt,
    post_claim_scopes: SCOPES,
    claim: {
      complete_url: `${ORIGIN}/agent/identity/claim/complete`,
      expires_in: attempt.expiresIn,
      interval: attempt.interval,
    },
  });
}
