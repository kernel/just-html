import { query } from "@/lib/db";
import { mintLoginToken, sha256Hex } from "@/lib/auth/tokens";
import { sendShareEmail } from "@/lib/auth/email";
import { audit } from "@/lib/auth/audit";
import { checkLimits, EMAIL_SEND_LIMITS } from "@/lib/auth/ratelimit";
import { clientIp } from "@/lib/auth/request";
import { ORIGIN, SHARE_TOKEN_TTL_S } from "@/lib/auth/config";

// Share notification (birthday.md "Share notifications: the non-user grantee
// story (v1)"). When an EMAIL grant is created, the grantee gets a man-page email
// carrying ONE link: a single-use login token (kind='share', 7-day TTL) with
// next=/d/:slug. Clicking logs them in (email-keyed session, no account needed)
// and 303s to the doc.
//
//   - notify:false on the grant payload suppresses it.
//   - DOMAIN grants NEVER notify (we don't email a whole company) — the caller
//     only invokes this for email grants.
//   - Counts against the shared email-send caps (same caps as /login and B9
//     claim-email registration: per-email 5/h + 20/day, per-IP 30/h, global
//     500/h — recalibrated 2026-06-12; see ratelimit.ts EMAIL_SEND_LIMITS).

export type ShareNotifyResult =
  | { sent: true; resendId: string | null }
  | { sent: false; reason: "rate_limited" | "send_failed" };

/**
 * Mint a 7-day share login link for `granteeEmail` landing on /d/:slug, then
 * email it. Best-effort: the grant is already committed, so on any failure we
 * roll back only the just-minted token row and report — we never throw into the
 * grant request path (the stale-link fallback on /d/:slug always recovers).
 *
 * Rate caps mirror /login's per-email magic-link caps; a tripped cap simply
 * skips the send (the owner can resend by re-granting, or the grantee can use
 * the sign-in fallback). The link is built exactly like /login's verify URL so
 * /login/verify consumes it unchanged.
 */
export async function sendShareNotification(opts: {
  req: Request;
  docId: number;
  slug: string;
  title: string; // already resolved (title || slug) by the caller
  ownerEmail: string;
  granteeEmail: string; // normalized (lowercased) email grantee
}): Promise<ShareNotifyResult> {
  const to = opts.granteeEmail.toLowerCase();
  const ip = clientIp(opts.req);

  // Same email-send caps as /login and B9 claim-email registration (§6 #11–13,
  // recalibrated 2026-06-12: per-IP 30/h, per-email 5/h + 20/day, global 500/h),
  // shared via EMAIL_SEND_LIMITS and keyed by recipient.
  const tripped = await checkLimits(EMAIL_SEND_LIMITS(to, ip));
  if (tripped) {
    audit(opts.req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
    return { sent: false, reason: "rate_limited" };
  }

  // next=/d/:slug — the grantee lands directly on the doc after sign-in.
  const next = `/d/${encodeURIComponent(opts.slug)}`;

  // Mint a share-kind login token (7-day TTL). Roll back if the send fails.
  const token = mintLoginToken();
  const { rows } = await query<{ id: number }>(
    `INSERT INTO login_tokens (email, token_hash, kind, expires_at)
     VALUES ($1, $2, 'share', now() + ($3 || ' seconds')::interval)
     RETURNING id`,
    [to, sha256Hex(token), String(SHARE_TOKEN_TTL_S)]
  );
  const tokenId = rows[0].id;

  const link = `${ORIGIN}/login/verify?token=${token}&next=${encodeURIComponent(next)}`;
  // Bare doc URL so the email's stale-link recovery copy is self-contained: when
  // the 7-day token expires, the grantee opens this and uses the "was this shared
  // with you? sign in" link on /d/:slug (which carries next=/d/:slug).
  const docUrl = `${ORIGIN}${next}`;

  // QA escape hatch (REMOVABLE post-launch): mirror the plaintext link so
  // automated reviewers can complete the share flow. Only when QA_SECRET is set.
  if (process.env.QA_SECRET) {
    await query(
      `INSERT INTO qa_login_links (email, link, login_token_id) VALUES ($1, $2, $3)`,
      [to, link, tokenId]
    ).catch(() => {});
  }

  let resendId: string | null = null;
  try {
    resendId = await sendShareEmail({
      to,
      ownerEmail: opts.ownerEmail,
      title: opts.title,
      link,
      docUrl,
      idempotencyKey: `share-${tokenId}`,
    });
  } catch {
    await query(`DELETE FROM login_tokens WHERE id = $1`, [tokenId]).catch(() => {});
    if (process.env.QA_SECRET) {
      await query(`DELETE FROM qa_login_links WHERE login_token_id = $1`, [tokenId]).catch(
        () => {}
      );
    }
    return { sent: false, reason: "send_failed" };
  }

  audit(opts.req, "share_notification.sent", {
    userId: null,
    meta: { doc_id: opts.docId, grantee_email: to, resend_id: resendId },
  });
  return { sent: true, resendId };
}
