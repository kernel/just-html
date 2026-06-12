import { query } from "@/lib/db";
import { clientIp, userAgent } from "@/lib/auth/request";

// Append-only audit log (§7). Never write secrets, codes, or magic links into
// meta — IDs only. Best-effort: a failed audit insert must never break the
// request path, so we swallow errors.

export type AuditEvent =
  | "registration.created"
  | "user_code.minted"
  | "claim.requested"
  | "claim.attempt_failed"
  | "claim.confirmed"
  | "token.issued"
  | "token.revoked"
  | "registration.expired"
  | "login_link.requested"
  | "session.created"
  | "share_notification.sent"
  | "rate_limit.tripped";

export async function audit(
  req: Request,
  event: AuditEvent,
  opts: {
    registrationId?: number | null;
    userId?: number | null;
    apiKeyId?: number | null;
    meta?: Record<string, unknown>;
  } = {}
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (event, registration_id, user_id, api_key_id, ip, user_agent, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event,
        opts.registrationId ?? null,
        opts.userId ?? null,
        opts.apiKeyId ?? null,
        clientIp(req),
        userAgent(req),
        JSON.stringify(opts.meta ?? {}),
      ]
    );
  } catch {
    // audit is best-effort; never fail the request because logging failed.
  }
}
