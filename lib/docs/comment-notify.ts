import { query } from "@/lib/db";
import { mintLoginToken, sha256Hex } from "@/lib/auth/tokens";
import { sendCommentEmail } from "@/lib/auth/email";
import { audit } from "@/lib/auth/audit";
import { checkLimits } from "@/lib/auth/ratelimit";
import { ORIGIN, SHARE_TOKEN_TTL_S } from "@/lib/auth/config";
import { resolveAccess } from "@/lib/docs/grants";
import type { DocRow } from "@/lib/docs/store";
import type { CommentRow } from "@/lib/docs/comments";

// Comment notification — the share-notify.ts companion. When a comment is
// posted, we email the people who should hear about it, each with their OWN
// 7-day share-kind login link to /d/:slug (same mechanics as the share email).
//
// RECIPIENTS (the agreed model):
//   - top-level comment (parent_id null) → the document OWNER only.
//   - reply (parent_id set) → the OWNER PLUS every other thread participant who
//     STILL has access. 1-level threads, so the thread root id = the reply's
//     parent_id; candidate participants = the distinct author_user_id across
//     {root, all its replies}, each then filtered through a live access check
//     (public, or an owner/email/domain grant) — a participant who has since
//     lost access is dropped so we don't email post-revocation thread activity
//     or leak other participants' emails to someone who can no longer view.
//   - ALWAYS exclude the new comment's author (no self-notification).
//   - De-dupe by user_id (the owner may also be a participant).
//
// SUPPRESSION. A DEDICATED rate-limit namespace (cmt-notify:*) — never
// EMAIL_SEND_LIMITS — so comment volume cannot burn the owner's login/claim/
// share email budget or inflate email:global. Per-recipient safety cap only:
// cmt-notify:addr:<email>, 30/day. No per-doc coalescing; notify on every
// comment; no digest.
//
// BEST-EFFORT. The comment is already committed, so we catch everything and
// never throw into the request path. On a send failure we roll back only that
// recipient's just-minted token row (the /d/:slug "was this shared with you?"
// fallback recovers a missed link).

// Per-recipient daily safety cap. NOT EMAIL_SEND_LIMITS — a doc's comment
// traffic must never consume the recipient's magic-link/claim/share budget.
const COMMENT_NOTIFY_PER_EMAIL_PER_DAY = 30;

// Body snippet length in the email (the reference truncates the preview).
const BODY_SNIPPET_MAX = 180;
// Parent-context snippet (reply) and anchored-passage (top-level) are tighter —
// they are one-line context, not the payload.
const CONTEXT_SNIPPET_MAX = 120;

export type CommentNotifyResult = { notified: number; recipients: number };

type Recipient = { userId: number; email: string; isOwner: boolean };

/** Truncate to roughly `max` chars, appending an ellipsis when cut. */
function snippet(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

/**
 * Build the deduped recipient list for a comment, excluding its author. For a
 * top-level comment that's the owner alone; for a reply it's the owner plus the
 * distinct thread participants. Each recipient carries their resolved email and
 * whether they own the doc (drives the footer flavor).
 */
async function resolveRecipients(
  doc: DocRow,
  comment: CommentRow
): Promise<Recipient[]> {
  const authorId = comment.author_user_id;

  // Owner email.
  const { rows: ownerRows } = await query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`,
    [doc.owner_id]
  );
  const ownerEmail = ownerRows[0]?.email ?? null;

  // user_id -> recipient, deduped. Owner first so its isOwner flag wins over a
  // participant row for the same id.
  const byUser = new Map<number, Recipient>();
  if (ownerEmail && doc.owner_id !== authorId) {
    byUser.set(doc.owner_id, { userId: doc.owner_id, email: ownerEmail, isOwner: true });
  }

  if (comment.parent_id !== null) {
    // Thread participants: the distinct authors across the root + all its
    // replies (1-level model, so rootId = parent_id), resolved to emails.
    const rootId = comment.parent_id;
    const { rows: partRows } = await query<{ id: number; email: string }>(
      `SELECT DISTINCT u.id, u.email
         FROM comments c
         JOIN users u ON u.id = c.author_user_id
        WHERE c.doc_id = $1
          AND (c.id = $2 OR c.parent_id = $2)
          AND c.deleted_at IS NULL
          AND c.author_user_id IS NOT NULL`,
      [doc.id, rootId]
    );
    for (const p of partRows) {
      if (p.id === authorId) continue; // never self-notify
      if (byUser.has(p.id)) continue; // already in (owner)
      // Only notify participants who CURRENTLY retain access. Authorship history
      // outlives a grant — a participant whose grant was revoked, or who
      // commented while the doc was public before it went private, must not keep
      // receiving thread activity (or other participants' emails). Public, or a
      // live owner/email/domain grant, qualifies; anything else is dropped.
      if (!doc.is_public) {
        const access = await resolveAccess(doc, p.email, p.id);
        if (access.kind === "none") continue;
      }
      byUser.set(p.id, { userId: p.id, email: p.email, isOwner: p.id === doc.owner_id });
    }
  }

  return [...byUser.values()];
}

/**
 * Notify the right people that `comment` was posted on `doc`. Best-effort:
 * resolves recipients, and for each one checks the per-recipient cap, mints a
 * 7-day share login link, sends the email, audits, and rolls back the token on
 * a send failure. Never throws into the caller; returns how many emails were
 * actually sent.
 */
export async function sendCommentNotification(opts: {
  req: Request;
  doc: DocRow;
  comment: CommentRow;
}): Promise<CommentNotifyResult> {
  try {
    const { req, doc, comment } = opts;
    const recipients = await resolveRecipients(doc, comment);
    if (recipients.length === 0) return { notified: 0, recipients: 0 };

    const isReply = comment.parent_id !== null;
    const title = doc.title || doc.slug;
    const authorEmail = comment.author_email || "someone";
    const bodySnippet = snippet(comment.body, BODY_SNIPPET_MAX);

    // Top-level anchored passage: only when the comment is anchored AND still
    // resolves (not orphaned). anchor.exact is the W3C text-quote selector's
    // verbatim span.
    const anchoredQuote =
      !isReply && comment.anchor && !comment.orphaned && comment.anchor.exact
        ? snippet(comment.anchor.exact, CONTEXT_SNIPPET_MAX)
        : null;

    // Reply parent context: the parent comment's author email + a body snippet.
    let parentAuthorEmail: string | null = null;
    let parentSnippet: string | null = null;
    if (isReply && comment.parent_id !== null) {
      const { rows: parentRows } = await query<{ email: string | null; body: string }>(
        `SELECT u.email, c.body
           FROM comments c
           LEFT JOIN users u ON u.id = c.author_user_id
          WHERE c.id = $1 AND c.doc_id = $2 AND c.deleted_at IS NULL`,
        [comment.parent_id, doc.id]
      );
      const parent = parentRows[0];
      if (parent) {
        parentAuthorEmail = parent.email;
        parentSnippet = snippet(parent.body, CONTEXT_SNIPPET_MAX);
      }
    }

    const next = `/d/${encodeURIComponent(doc.slug)}`;
    const docUrl = `${ORIGIN}${next}`;

    let notified = 0;
    for (const r of recipients) {
      const to = r.email.toLowerCase();

      // Per-recipient daily safety cap, dedicated namespace. A tripped cap skips
      // this recipient (the rest still go out).
      const tripped = await checkLimits([
        { key: `cmt-notify:addr:${to}`, limit: COMMENT_NOTIFY_PER_EMAIL_PER_DAY, window: "day" },
      ]);
      if (tripped) {
        audit(req, "rate_limit.tripped", { meta: { key: tripped.key, limit: tripped.limit } });
        continue;
      }

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

      let resendId: string | null = null;
      try {
        resendId = await sendCommentEmail({
          to,
          authorEmail,
          title,
          isReply,
          isOwnerRecipient: r.isOwner,
          bodySnippet,
          anchoredQuote,
          parentAuthorEmail,
          parentSnippet,
          link,
          docUrl,
          idempotencyKey: `comment-notify-${comment.id}-${r.userId}`,
        });
      } catch {
        await query(`DELETE FROM login_tokens WHERE id = $1`, [tokenId]).catch(() => {});
        continue;
      }

      audit(req, "comment_notification.sent", {
        userId: r.userId,
        meta: { doc_id: doc.id, comment_id: comment.id, recipient_email: to, resend_id: resendId },
      });
      notified += 1;
    }

    return { notified, recipients: recipients.length };
  } catch {
    // Best-effort: a comment notification must never fail the comment write.
    return { notified: 0, recipients: 0 };
  }
}
