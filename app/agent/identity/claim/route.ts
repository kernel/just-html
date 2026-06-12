import { agentError, jsonResponse } from "@/lib/auth/responses";
import { isEmailish } from "@/lib/auth/url";
import { clientIp } from "@/lib/auth/request";
import { checkLimits, EMAIL_SEND_LIMITS } from "@/lib/auth/ratelimit";
import { findByClaimToken, mintAttempt } from "@/lib/auth/claim";
import { sendClaimEmail } from "@/lib/auth/email";
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

  // A corrected email applies to the (still-unclaimed) registration binding,
  // and is the address we re-mint + (in email mode) re-email against.
  const effectiveEmail =
    typeof email === "string" ? email.toLowerCase() : reg.email.toLowerCase();

  const ip = clientIp(req);
  // Per-IP re-mint cap (§6 #5), plus — in email mode, since a re-mint re-sends
  // the claim email — the shared email-send caps (§6 #11–13).
  const emailSendCaps =
    reg.claim_delivery === "email" ? EMAIL_SEND_LIMITS(effectiveEmail, ip) : [];
  const tripped = await checkLimits([
    ip ? { key: `claim:ip:${ip}`, limit: 30, window: "hour" } : null,
    ...emailSendCaps,
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

  // Re-mint lifetime cap (§6 #4).
  if (reg.remint_count >= MAX_REMINTS) {
    return agentError(
      429,
      "rate_limited",
      "Too many re-mints for this registration. Restart registration."
    );
  }

  if (typeof email === "string") {
    await query(`UPDATE agent_registrations SET email = $1 WHERE id = $2`, [
      effectiveEmail,
      reg.id,
    ]);
  }
  await query(
    `UPDATE agent_registrations SET remint_count = remint_count + 1 WHERE id = $1`,
    [reg.id]
  );

  // Re-mint a fresh attempt in the registration's fixed delivery mode (this
  // supersedes the old code + approve link).
  const attempt = await mintAttempt(reg.id, reg.claim_delivery);

  audit(req, "claim.requested", {
    registrationId: reg.id,
    meta: { email: effectiveEmail, claim_delivery: reg.claim_delivery },
  });
  audit(req, "user_code.minted", {
    registrationId: reg.id,
    meta: { claim_code_id: attempt.claimCodeId },
  });

  // Email mode: re-send the claim email (fresh code + approve link). On send
  // failure, supersede the just-minted attempt and report — the agent can retry
  // the re-mint (the old attempt is already superseded, so it stays dead).
  if (reg.claim_delivery === "email") {
    let resendId: string | null = null;
    try {
      resendId = await sendClaimEmail({
        to: effectiveEmail,
        approveLink: attempt.approveUri!,
        code: attempt.userCode,
      });
    } catch {
      await query(`UPDATE claim_codes SET superseded_at = now() WHERE id = $1`, [
        attempt.claimCodeId,
      ]).catch(() => {});
      return agentError(
        503,
        "email_send_failed",
        "Could not send the confirmation email. Retry the re-mint in a moment."
      );
    }
    await query(`UPDATE claim_codes SET claim_email_sent_at = now() WHERE id = $1`, [
      attempt.claimCodeId,
    ]).catch(() => {});
    if (process.env.QA_SECRET) {
      await query(
        `INSERT INTO qa_claim_emails (email, code, approve_link, claim_code_id)
         VALUES ($1, $2, $3, $4)`,
        [effectiveEmail, attempt.userCode, attempt.approveUri, attempt.claimCodeId]
      ).catch(() => {});
    }
    audit(req, "claim_email.sent", {
      registrationId: reg.id,
      meta: { claim_code_id: attempt.claimCodeId, resend_id: resendId, remint: true },
    });

    return jsonResponse({
      registration_id: reg.public_id,
      claim_attempt_id: attempt.attemptId,
      status: "initiated",
      expires_at: attempt.viewExpiresAt,
      claim_attempt: {
        delivery: "email",
        code_delivery:
          "We re-emailed the 6-digit code and an approve link to the human. They can click approve OR read the code back to you for POST /agent/identity/claim/complete.",
        complete_url: "https://justhtml.sh/agent/identity/claim/complete",
        expires_in: attempt.expiresIn,
        interval: attempt.interval,
      },
    });
  }

  // Agent (spec-pure) mode: return the fresh code + verification_uri.
  return jsonResponse({
    registration_id: reg.public_id,
    claim_attempt_id: attempt.attemptId,
    status: "initiated",
    expires_at: attempt.viewExpiresAt,
    claim_attempt: {
      delivery: "agent",
      user_code: attempt.userCode,
      expires_in: attempt.expiresIn,
      verification_uri: attempt.verificationUri,
      interval: attempt.interval,
    },
  });
}
