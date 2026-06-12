import { agentError, jsonResponse } from "@/lib/auth/responses";
import { isEmailish } from "@/lib/auth/url";
import { clientIp } from "@/lib/auth/request";
import { checkLimits, EMAIL_SEND_LIMITS } from "@/lib/auth/ratelimit";
import { createRegistration, type ClaimDelivery } from "@/lib/auth/claim";
import { sendClaimEmail } from "@/lib/auth/email";
import { audit } from "@/lib/auth/audit";
import { SCOPES } from "@/lib/auth/config";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /agent/identity (§3.1) — start a service_auth registration. No user row
// is created here; accounts are created only at claim confirm.
//
// B9 hybrid claim ceremony: claim_delivery selects how the user_code reaches
// the human. Default 'email' (we email both an approve link and the code; the
// code is OMITTED from the API response, binding proof = inbox possession);
// 'agent' is the spec-pure flow (response carries user_code + verification_uri).
// Mutually exclusive, fixed at registration time.
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

  // claim_delivery: 'email' (default) | 'agent'. Reject anything else.
  const rawDelivery = b.claim_delivery;
  if (
    rawDelivery !== undefined &&
    rawDelivery !== "email" &&
    rawDelivery !== "agent"
  ) {
    return agentError(
      400,
      "invalid_request",
      "claim_delivery: expected 'email' or 'agent'."
    );
  }
  const delivery: ClaimDelivery = rawDelivery === "agent" ? "agent" : "email";

  const ip = clientIp(req);
  // Registration rate limits (§6 #1–3). In email mode registration sends an
  // email, so the email-send caps (per-email 5/h + 20/day, per-IP 30/h, global
  // 500/h) ALSO apply, checked alongside the registration caps before we mint
  // anything (recalibrated 2026-06-12 — see authmd-implementation.md §6).
  const emailSendCaps =
    delivery === "email" ? EMAIL_SEND_LIMITS(email, ip) : [];
  const tripped = await checkLimits([
    ip ? { key: `ident:ip:${ip}`, limit: 10, window: "hour" } : null,
    { key: `ident:email:${email}`, limit: 10, window: "hour" },
    { key: "ident:global", limit: 100, window: "hour" },
    ...emailSendCaps,
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

  const { reg, claimToken, attempt } = await createRegistration(email, delivery);

  audit(req, "registration.created", {
    registrationId: reg.id,
    meta: { registration_type: "service_auth", login_hint: email, claim_delivery: delivery },
  });
  audit(req, "user_code.minted", {
    registrationId: reg.id,
    meta: { claim_code_id: attempt.claimCodeId },
  });

  // Email mode: send the claim email (approve link + code). A send failure
  // fails the registration cleanly so we never leave the agent polling a
  // registration whose human never got the email. Mark claim_email_sent_at and
  // audit claim_email.sent on success.
  if (delivery === "email") {
    let resendId: string | null = null;
    try {
      resendId = await sendClaimEmail({
        to: email,
        approveLink: attempt.approveUri!,
        code: attempt.userCode,
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
    await query(
      `UPDATE claim_codes SET claim_email_sent_at = now() WHERE id = $1`,
      [attempt.claimCodeId]
    ).catch(() => {});
    // QA escape hatch (REMOVABLE post-launch): mirror the plaintext code +
    // approve link so automated reviewers can complete the email-mode flow.
    if (process.env.QA_SECRET) {
      await query(
        `INSERT INTO qa_claim_emails (email, code, approve_link, claim_code_id)
         VALUES ($1, $2, $3, $4)`,
        [email, attempt.userCode, attempt.approveUri, attempt.claimCodeId]
      ).catch(() => {});
    }
    audit(req, "claim_email.sent", {
      registrationId: reg.id,
      meta: { claim_code_id: attempt.claimCodeId, resend_id: resendId },
    });
  }

  // The claim block: email mode OMITS user_code (binding proof = inbox
  // possession; returning it would break the proof) and signals it was emailed.
  // agent mode is the spec-pure shape (user_code + verification_uri).
  const claim =
    delivery === "email"
      ? {
          delivery: "email" as const,
          code_delivery: "We emailed the 6-digit code and an approve link to the human. They can click approve OR read the code back to you for POST /agent/identity/claim/complete.",
          complete_url: "https://justhtml.sh/agent/identity/claim/complete",
          expires_in: attempt.expiresIn,
          interval: attempt.interval,
        }
      : {
          delivery: "agent" as const,
          user_code: attempt.userCode,
          expires_in: attempt.expiresIn,
          verification_uri: attempt.verificationUri,
          interval: attempt.interval,
        };

  return jsonResponse({
    registration_id: reg.publicId,
    registration_type: "service_auth",
    claim_url: "https://justhtml.sh/agent/identity/claim",
    claim_token: claimToken,
    claim_token_expires: reg.claimExpiresAt,
    post_claim_scopes: SCOPES,
    claim,
  });
}
