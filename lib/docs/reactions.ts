import { query } from "@/lib/db";
import type { DocRow } from "@/lib/docs/store";

// Reactions (birthday.md "Permission matrix": attributed-only, unique per
// target+author+emoji, toggle by re-click). Emoji on a doc (comment_id null) or
// a comment. The 0004 unique index — (doc_id, COALESCE(comment_id,0),
// author_user_id, emoji) — enforces one per target/author/emoji.

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

export type ReactionRow = {
  id: number;
  doc_id: number;
  comment_id: number | null;
  author_user_id: number | null;
  emoji: string;
  created_at: string;
};

export type AddReactionResult =
  | { reaction: ReactionRow; toggled: false }
  | { removed: true; toggled: true }
  | { error: "bad_comment" };

/**
 * Add a reaction — or TOGGLE it off if the same (target, author, emoji) already
 * exists (birthday.md "toggle by re-click"). Verifies the target comment (when
 * given) is a live comment of this doc.
 */
export async function addOrToggleReaction(opts: {
  doc: DocRow;
  commentId: number | null;
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

  // Toggle: if it exists, delete and report toggled-off.
  const { rows: existing } = await query<{ id: number }>(
    `SELECT id FROM reactions
      WHERE doc_id = $1 AND COALESCE(comment_id, 0) = COALESCE($2::bigint, 0)
        AND author_user_id = $3 AND emoji = $4`,
    [opts.doc.id, opts.commentId, opts.authorUserId, opts.emoji]
  );
  if (existing[0]) {
    await query(`DELETE FROM reactions WHERE id = $1`, [existing[0].id]);
    return { removed: true, toggled: true };
  }

  const { rows } = await query<ReactionRow>(
    `INSERT INTO reactions (doc_id, comment_id, author_user_id, emoji)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [opts.doc.id, opts.commentId, opts.authorUserId, opts.emoji]
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
