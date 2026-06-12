import { query } from "@/lib/db";
import type { DocRow } from "@/lib/docs/store";
import type { TextAnchor } from "@/lib/docs/anchor";
import { htmlToText, resolveQuote } from "@/lib/docs/anchor";

// Reactions (birthday.md "Permission matrix": attributed-only, unique per
// target+author+emoji, toggle by re-click). The target is 3-WAY and mutually
// exclusive (birthday.md "Anchored reactions"):
//   comment_id set  -> on a comment
//   anchor set      -> on a text span (same W3C text-quote shape as comments)
//   both null       -> on the doc
// The 0012/0013 unique index — (doc_id, COALESCE(comment_id,0), anchor_sig,
// author_user_id, emoji) — enforces one per target/author/emoji across all three
// kinds, so the re-click toggle still works for anchored reactions. A DB CHECK
// (reactions_target_exclusive) and an API 400 both reject comment_id + anchor
// together.

// A short allowlist keeps the column sane and blocks arbitrary text. These are
// the demo set plus common doc-review emoji; agents can react with any of them.
export const ALLOWED_EMOJI = new Set<string>([
  "👍",
  "👎",
  "🎉",
  "🤔",
  "❤️",
  "🚀",
  "👀",
  "😄",
  "🙏",
  "🔥",
  "✅",
  "💯",
]);

export function isAllowedEmoji(e: string): boolean {
  return ALLOWED_EMOJI.has(e);
}

/**
 * Normalized anchor signature for the dedup key — the SAME prefix|exact|suffix
 * triple the overlay/shared.js uses to GROUP reactions by span (anchorSig), so
 * the server's uniqueness, the client's grouping, and re-anchoring all agree on
 * "the same span". Non-anchored reactions get '' (doc/comment level), where
 * COALESCE(comment_id,0) already disambiguates. The signature is over the DECODED
 * text-quote fields (what a human/agent quoted), not the raw JSON, so two anchors
 * differing only in offsets collide as the same span — which is what toggle wants.
 */
export function anchorSignature(anchor: TextAnchor | null): string {
  if (!anchor) return "";
  return `${anchor.prefix ?? ""}|${anchor.exact}|${anchor.suffix ?? ""}`;
}

export type ReactionRow = {
  id: number;
  doc_id: number;
  comment_id: number | null;
  author_user_id: number | null;
  emoji: string;
  anchor: TextAnchor | null;
  anchored_version: number | null;
  orphaned: boolean;
  created_at: string;
};

export type AddReactionResult =
  | { reaction: ReactionRow; toggled: false }
  | { removed: true; toggled: true }
  | { error: "bad_comment" };

/**
 * Add a reaction — or TOGGLE it off if the same (target, author, emoji) already
 * exists (birthday.md "toggle by re-click"). The target is doc-level (both null),
 * a comment (commentId), or a span (anchor) — never both comment + anchor (the
 * caller rejects that with 400; the DB CHECK is the backstop).
 *
 * For an ANCHORED reaction we resolve the quote against the current doc text to
 * stamp initial start/end offsets + orphan state (mirrors createComment), so the
 * first paint + future re-anchoring have a position hint. If the quote doesn't
 * resolve server-side the reaction is born orphaned (the overlay may still paint
 * it against the live DOM); it un-orphans on a later restoring edit.
 */
export async function addOrToggleReaction(opts: {
  doc: DocRow;
  commentId: number | null;
  anchor: TextAnchor | null;
  authorUserId: number;
  emoji: string;
}): Promise<AddReactionResult> {
  if (opts.commentId !== null) {
    const { rows } = await query<{ id: number }>(
      `SELECT id FROM comments WHERE id = $1 AND doc_id = $2 AND deleted_at IS NULL`,
      [opts.commentId, opts.doc.id]
    );
    if (!rows[0]) return { error: "bad_comment" };
  }

  const sig = anchorSignature(opts.anchor);

  // Toggle: if it exists (same doc, target, author, emoji), delete + report off.
  const { rows: existing } = await query<{ id: number }>(
    `SELECT id FROM reactions
      WHERE doc_id = $1 AND COALESCE(comment_id, 0) = COALESCE($2::bigint, 0)
        AND anchor_sig = $3 AND author_user_id = $4 AND emoji = $5`,
    [opts.doc.id, opts.commentId, sig, opts.authorUserId, opts.emoji]
  );
  if (existing[0]) {
    await query(`DELETE FROM reactions WHERE id = $1`, [existing[0].id]);
    return { removed: true, toggled: true };
  }

  // Resolve anchored offsets + orphan state (anchored reactions only).
  let anchorJson: string | null = null;
  let anchoredVersion: number | null = null;
  let orphaned = false;
  if (opts.anchor) {
    anchoredVersion = opts.doc.version;
    const docText = htmlToText(opts.doc.html);
    const r = resolveQuote(docText, opts.anchor, opts.anchor.start);
    const resolved: TextAnchor = { ...opts.anchor, type: "text" };
    if (r.ok) {
      resolved.start = r.start;
      resolved.end = r.end;
    } else {
      orphaned = true;
    }
    anchorJson = JSON.stringify(resolved);
  }

  const { rows } = await query<ReactionRow>(
    `INSERT INTO reactions
       (doc_id, comment_id, author_user_id, emoji, anchor, anchor_sig, anchored_version, orphaned)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      opts.doc.id,
      opts.commentId,
      opts.authorUserId,
      opts.emoji,
      anchorJson,
      sig,
      anchoredVersion,
      orphaned,
    ]
  );
  return { reaction: rows[0], toggled: false };
}

/** Delete a reaction by id, scoped to the doc + author (own reactions only). */
export async function deleteOwnReaction(
  docId: number,
  reactionId: number,
  authorUserId: number
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM reactions WHERE id = $1 AND doc_id = $2 AND author_user_id = $3`,
    [reactionId, docId, authorUserId]
  );
  return rowCount > 0;
}
