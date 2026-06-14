import type { TextAnchor } from "@/lib/docs/anchor";
import { anchorSignature, anchorTextPos } from "@/lib/docs/anchor";
import { avatarUrl } from "@/lib/docs/avatar";
import type { ReactionRow as BaseReactionRow } from "@/lib/docs/reactions";

// Pure VIEW-SHAPING for the comments/reactions API (birthday.md "Comments &
// reactions API", "All-threads view", "Anchored reactions"). Extracted from
// comments.ts so the JSON contract for GET /comments lives in one readable place,
// separate from CRUD + permission glue. Everything here is pure (no DB / no IO):
// rows in → response-shaped objects out.

export type CommentRow = {
  id: number;
  doc_id: number;
  author_user_id: number | null;
  author_email: string | null;
  parent_id: number | null;
  anchor: TextAnchor | null;
  anchored_version: number | null;
  orphaned: boolean;
  body: string;
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by_user_id: number | null;
  deleted_at: string | null;
};

// The comments read path joins users to attach the author's email; the base
// ReactionRow (lib/docs/reactions.ts) is the write-path shape WITHOUT it. This is
// that base + the joined author_email (single-sourced — extends, never redeclares).
export type ReactionRow = BaseReactionRow & { author_email: string | null };

/** Aggregated reaction group as returned to clients. */
export type ReactionGroup = { emoji: string; count: number; authors: string[] };

/**
 * Anchored-reaction group as returned to clients (birthday.md "Anchored
 * reactions": GET /comments includes anchored reactions grouped by anchor
 * signature so clients stack/count without re-grouping). One entry per span:
 * the anchor, its signature, and the per-emoji aggregation for that span.
 */
export type AnchoredReactionGroup = {
  sig: string;
  anchor: TextAnchor;
  anchored_version: number | null;
  reactions: ReactionGroup[];
};

/** API/JSON view for a single comment (no internal db ids beyond the public id). */
export function commentView(c: CommentRow, reactions: ReactionRow[]) {
  return {
    id: c.id,
    parent_id: c.parent_id,
    author: c.author_email,
    author_avatar: c.author_email ? avatarUrl(c.author_email, 64) : null,
    body: c.body,
    anchor: c.anchor,
    anchored_version: c.anchored_version,
    orphaned: c.orphaned,
    resolved: c.resolved_at !== null,
    resolved_at: c.resolved_at,
    created_at: c.created_at,
    edited_at: c.edited_at,
    reactions: aggregateReactions(reactions),
  };
}

export function threadView(
  root: CommentRow,
  replies: CommentRow[],
  reactionsByComment: Map<number, ReactionRow[]>,
  group: "anchored" | "doc" | "orphaned"
) {
  return {
    ...commentView(root, reactionsByComment.get(root.id) ?? []),
    group,
    replies: replies
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((r) => commentView(r, reactionsByComment.get(r.id) ?? [])),
  };
}

/** Collapse reactions into { emoji, count, authors[] } groups. */
export function aggregateReactions(reactions: ReactionRow[]): ReactionGroup[] {
  const byEmoji = new Map<string, string[]>();
  for (const r of reactions) {
    const arr = byEmoji.get(r.emoji) ?? [];
    if (r.author_email) arr.push(r.author_email);
    byEmoji.set(r.emoji, arr);
  }
  return [...byEmoji.entries()].map(([emoji, authors]) => ({
    emoji,
    count: authors.length,
    authors,
  }));
}

/**
 * Group ANCHORED (non-orphaned) reactions by their anchor signature
 * (prefix|exact|suffix via lib/docs/anchor.ts anchorSignature — the one source
 * shared with the DB index + the overlay), then aggregate per emoji within each
 * span. Ordered by the resolved text position so the client paints/stacks in
 * document order.
 */
export function groupAnchoredReactions(
  reactions: ReactionRow[],
  docText: string
): AnchoredReactionGroup[] {
  const bySig = new Map<string, { anchor: TextAnchor; av: number | null; rows: ReactionRow[] }>();
  for (const r of reactions) {
    if (!r.anchor || r.orphaned) continue;
    const a = r.anchor;
    const sig = anchorSignature(a);
    const g = bySig.get(sig);
    if (g) g.rows.push(r);
    else bySig.set(sig, { anchor: a, av: r.anchored_version, rows: [r] });
  }
  const groups = [...bySig.entries()].map(([sig, g]) => ({
    sig,
    anchor: g.anchor,
    anchored_version: g.av,
    reactions: aggregateReactions(g.rows),
    _pos: anchorTextPos(docText, g.anchor),
  }));
  groups.sort((a, b) => a._pos - b._pos);
  return groups.map(({ _pos, ...rest }) => rest);
}
