import { createHash } from "node:crypto";
import { getPool, query } from "@/lib/db";
import type { DocRow } from "@/lib/docs/store";
import type { Session } from "@/lib/auth/session";
import type { ApiPrincipal } from "@/lib/auth/bearer";
import { resolveAccess, type DocAccess } from "@/lib/docs/grants";
import { canViewSession } from "@/lib/docs/access";
import type { TextAnchor } from "@/lib/docs/anchor";
import { resolveQuote, htmlToText } from "@/lib/docs/anchor";

// Comments persistence + permission resolution (birthday.md "Comment anchoring",
// "Permission matrix", "All-threads view", "Comments & reactions API").
//
// IDENTITY. A comment/reaction author is always a verified identity:
//   - an API key (agent) → acts as its user_id, OR
//   - a browser session keyed by a verified email.
// Anonymous never writes. A session whose user_id is null (a grantee who never
// registered an agent) still has a VERIFIED email (magic-link), so when they
// first author a comment we find-or-create their users row — the email is proven,
// and authorship needs a stable user id for attribution + reaction dedup.

export const MAX_COMMENT_BODY_BYTES = 10 * 1024; // 10 KB (birthday.md "Limits")
export const MAX_COMMENTS_PER_DOC = 1000; // (birthday.md "Limits")
const RL_COMMENT_WRITES_PER_MIN = 60; // same as doc writes (per-key/per-session)

// ---------------------------------------------------------------------------
// Principal: the unified actor for comment/reaction writes (API key OR session).
// ---------------------------------------------------------------------------

export type CommentPrincipal = {
  userId: number;
  email: string;
  source: "api_key" | "session";
};

/**
 * Resolve a writing principal from a request: API key first (Authorization:
 * Bearer), else a browser session. Returns null if neither is present/valid
 * (anonymous → caller rejects). For a session without a user_id, find-or-create
 * the user row for its verified email (authorship needs a stable id).
 */
export async function resolveCommentPrincipal(
  apiPrincipal: ApiPrincipal | null,
  session: Session | null
): Promise<CommentPrincipal | null> {
  if (apiPrincipal) {
    return { userId: apiPrincipal.userId, email: apiPrincipal.email, source: "api_key" };
  }
  if (session) {
    let userId = session.user_id;
    if (userId == null) {
      const { rows } = await query<{ id: number }>(
        `INSERT INTO users (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [session.email]
      );
      userId = rows[0].id;
      // Backfill the session so subsequent requests skip the upsert.
      query(`UPDATE sessions SET user_id = $1 WHERE id = $2 AND user_id IS NULL`, [
        userId,
        session.id,
      ]).catch(() => {});
    }
    return { userId, email: session.email, source: "session" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Permissions (birthday.md "Permission matrix").
// ---------------------------------------------------------------------------
//
// Comment: owner, editor grant, commenter grant, token-holder WITH identity, or
//          any identity on a PUBLIC doc. (Anonymous never writes.)
// React:   anyone who can VIEW, with identity (viewer grants included).
// Resolve/unresolve: anyone who can comment.
// Delete:  author (own) or owner (any).
//
// canComment needs the doc + the principal's identity + whether they presented a
// valid view token (token-holder-with-identity) — we accept a `hasViewToken`
// flag the caller computes from canViewSession/canView against the request.

export type CommentCapability = {
  canComment: boolean;
  canReact: boolean;
  isOwner: boolean;
  access: DocAccess;
};

/**
 * Resolve what `principal` can do on `doc`. `canViewByToken` is true when the
 * request carried a valid ?viewtoken= (or session-resolved view) — used for the
 * "token-holder with identity" and "any identity on a public doc" comment rules.
 */
export async function resolveCapability(
  doc: DocRow,
  principal: CommentPrincipal,
  canViewByToken: boolean
): Promise<CommentCapability> {
  const access = await resolveAccess(doc, principal.email, principal.userId);
  const isOwner = access.kind === "owner";
  const grantRole = access.role; // editor | commenter | viewer | null

  // Comment: owner | editor | commenter grant | (public doc + identity) |
  //          (valid view token + identity).
  const canComment =
    isOwner ||
    grantRole === "editor" ||
    grantRole === "commenter" ||
    doc.is_public ||
    canViewByToken;

  // React: anyone who can VIEW with identity. Viewer grants included, public,
  // token holders, and of course everyone who can comment.
  const canReact = canComment || grantRole === "viewer" || canViewByToken || doc.is_public;

  return { canComment, canReact, isOwner, access };
}

/**
 * Can this request even VIEW the doc (for the read side of GET /comments and to
 * gate reactions)? Mirrors viewer-route enforcement: owner/grant via session OR
 * API-key identity, valid view token, or public.
 */
export async function principalCanView(
  doc: DocRow,
  apiPrincipal: ApiPrincipal | null,
  session: Session | null,
  viewtoken: string | null
): Promise<boolean> {
  if (doc.is_public) return true;
  if (apiPrincipal) {
    const access = await resolveAccess(doc, apiPrincipal.email, apiPrincipal.userId);
    if (access.kind !== "none") return true;
  }
  return canViewSession(doc, session, viewtoken);
}

// ---------------------------------------------------------------------------
// Gravatar (birthday.md UI spec: "Gravatar by email hash, identicon fallback").
// ---------------------------------------------------------------------------

/** Gravatar profile hash = sha256 of the lowercased, trimmed email. */
export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export function avatarUrl(email: string, size = 64): string {
  return `https://gravatar.com/avatar/${gravatarHash(email)}?d=identicon&s=${size}`;
}

// ---------------------------------------------------------------------------
// Rows + views.
// ---------------------------------------------------------------------------

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

export type ReactionRow = {
  id: number;
  doc_id: number;
  comment_id: number | null;
  author_user_id: number | null;
  author_email: string | null;
  emoji: string;
  created_at: string;
};

/** API/JSON view for a single comment (no internal db ids beyond the public id). */
export function commentView(c: CommentRow, reactions: ReactionRow[]) {
  return {
    id: Number(c.id),
    parent_id: c.parent_id === null ? null : Number(c.parent_id),
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

/** Collapse reactions into { emoji, count, authors[] } groups. */
function aggregateReactions(reactions: ReactionRow[]) {
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

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** Fetch one live comment by id, scoped to a doc. */
export async function findComment(docId: number, commentId: number): Promise<CommentRow | null> {
  const { rows } = await query<CommentRow>(
    `SELECT c.*, u.email AS author_email
       FROM comments c LEFT JOIN users u ON u.id = c.author_user_id
      WHERE c.id = $1 AND c.doc_id = $2 AND c.deleted_at IS NULL`,
    [commentId, docId]
  );
  return rows[0] ?? null;
}

async function countLiveComments(docId: number): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM comments WHERE doc_id = $1 AND deleted_at IS NULL`,
    [docId]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * The complete all-threads picture (birthday.md "All-threads view"): every live
 * thread grouped into anchored (document order) → doc-level → orphaned, with
 * resolved flags and reactions. Returned by GET /comments so agents see exactly
 * what humans see. `docHtml` lets us order anchored threads by their resolved
 * text position (best-effort, matching what the overlay paints).
 */
export async function allThreads(doc: DocRow): Promise<{
  total: number;
  threads: ReturnType<typeof threadView>[];
}> {
  const { rows: commentRows } = await query<CommentRow>(
    `SELECT c.*, u.email AS author_email
       FROM comments c LEFT JOIN users u ON u.id = c.author_user_id
      WHERE c.doc_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC, c.id ASC`,
    [doc.id]
  );
  const { rows: reactionRows } = await query<ReactionRow>(
    `SELECT r.*, u.email AS author_email
       FROM reactions r LEFT JOIN users u ON u.id = r.author_user_id
      WHERE r.doc_id = $1
      ORDER BY r.created_at ASC`,
    [doc.id]
  );

  const reactionsByComment = new Map<number, ReactionRow[]>();
  const docLevelReactions: ReactionRow[] = [];
  for (const r of reactionRows) {
    if (r.comment_id === null) docLevelReactions.push(r);
    else {
      const arr = reactionsByComment.get(Number(r.comment_id)) ?? [];
      arr.push(r);
      reactionsByComment.set(Number(r.comment_id), arr);
    }
  }

  const roots = commentRows.filter((c) => c.parent_id === null);
  const repliesByParent = new Map<number, CommentRow[]>();
  for (const c of commentRows) {
    if (c.parent_id !== null) {
      const arr = repliesByParent.get(Number(c.parent_id)) ?? [];
      arr.push(c);
      repliesByParent.set(Number(c.parent_id), arr);
    }
  }

  // Resolve anchored roots to a text position for document-order sorting.
  const docText = htmlToText(doc.html);
  type Ordered = { root: CommentRow; group: "anchored" | "doc" | "orphaned"; pos: number };
  const ordered: Ordered[] = roots.map((root) => {
    if (root.orphaned) return { root, group: "orphaned" as const, pos: Number.MAX_SAFE_INTEGER };
    if (!root.anchor) return { root, group: "doc" as const, pos: Number.MAX_SAFE_INTEGER };
    // Prefer the stored offset; fall back to a fresh re-find for ordering only.
    let pos =
      typeof root.anchor.start === "number"
        ? root.anchor.start
        : (() => {
            const r = resolveQuote(docText, root.anchor!, undefined);
            return r.ok ? r.start : Number.MAX_SAFE_INTEGER;
          })();
    if (!Number.isFinite(pos)) pos = Number.MAX_SAFE_INTEGER;
    return { root, group: "anchored" as const, pos };
  });

  const groupRank = { anchored: 0, doc: 1, orphaned: 2 };
  ordered.sort((a, b) => {
    if (a.group !== b.group) return groupRank[a.group] - groupRank[b.group];
    if (a.group === "anchored") return a.pos - b.pos;
    // doc-level + orphaned keep creation order (already ASC from the query).
    return Number(a.root.id) - Number(b.root.id);
  });

  const threads = ordered.map(({ root, group }) =>
    threadView(root, repliesByParent.get(Number(root.id)) ?? [], reactionsByComment, group)
  );

  return {
    total: commentRows.length,
    threads,
    // doc-level reactions surfaced alongside (used by reactions UI / agents).
    ...(docLevelReactions.length
      ? { doc_reactions: aggregateReactions(docLevelReactions) }
      : {}),
  } as { total: number; threads: ReturnType<typeof threadView>[] };
}

function threadView(
  root: CommentRow,
  replies: CommentRow[],
  reactionsByComment: Map<number, ReactionRow[]>,
  group: "anchored" | "doc" | "orphaned"
) {
  return {
    ...commentView(root, reactionsByComment.get(Number(root.id)) ?? []),
    group,
    replies: replies
      .slice()
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .map((r) => commentView(r, reactionsByComment.get(Number(r.id)) ?? [])),
  };
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

export type CreateCommentResult =
  | { comment: CommentRow }
  | { error: "limit"; limit: number }
  | { error: "bad_parent" };

/**
 * Create a comment. Enforces the per-doc cap + 1-level threading (a reply's
 * parent must be a live ROOT comment of the same doc). Initial anchor offsets are
 * resolved against the current doc text so the first paint + future re-anchoring
 * have a position hint; if the quote doesn't resolve the comment is born
 * orphaned (an agent can still quote text that the server's text-extraction
 * doesn't see verbatim — the overlay will paint it if the live DOM has it).
 */
export async function createComment(opts: {
  doc: DocRow;
  authorUserId: number;
  parentId: number | null;
  anchor: TextAnchor | null;
  body: string;
}): Promise<CreateCommentResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Cap under the transaction.
    const { rows: cntRows } = await client.query(
      `SELECT count(*) AS n FROM comments WHERE doc_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [opts.doc.id]
    );
    if (Number((cntRows[0] as { n: string }).n) >= MAX_COMMENTS_PER_DOC) {
      await client.query("ROLLBACK");
      return { error: "limit", limit: MAX_COMMENTS_PER_DOC };
    }

    // 1-level threads: a parent must be a live root comment in this doc.
    if (opts.parentId !== null) {
      const { rows: pRows } = await client.query(
        `SELECT id, parent_id FROM comments
          WHERE id = $1 AND doc_id = $2 AND deleted_at IS NULL`,
        [opts.parentId, opts.doc.id]
      );
      const parent = pRows[0] as { id: number; parent_id: number | null } | undefined;
      if (!parent || parent.parent_id !== null) {
        await client.query("ROLLBACK");
        return { error: "bad_parent" };
      }
    }

    // Resolve initial anchor offsets + orphan state (replies are never anchored).
    let anchorJson: string | null = null;
    let orphaned = false;
    const anchoredVersion = opts.anchor ? opts.doc.version : null;
    if (opts.anchor && opts.parentId === null) {
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

    const { rows: insRows } = await client.query(
      `INSERT INTO comments
         (doc_id, author_user_id, parent_id, anchor, anchored_version, orphaned, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        opts.doc.id,
        opts.authorUserId,
        opts.parentId,
        anchorJson,
        anchoredVersion,
        orphaned,
        opts.body,
      ]
    );
    await client.query("COMMIT");
    const created = insRows[0] as CommentRow;
    // Attach the author email for the response (the insert RETURNING * has none).
    const full = await findComment(opts.doc.id, Number(created.id));
    return { comment: full ?? created };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Edit a comment's body (author only — enforced by caller). Sets edited_at. */
export async function editCommentBody(docId: number, commentId: number, body: string): Promise<CommentRow | null> {
  await query(
    `UPDATE comments SET body = $3, edited_at = now()
      WHERE id = $1 AND doc_id = $2 AND deleted_at IS NULL`,
    [commentId, docId, body]
  );
  return findComment(docId, commentId);
}

/** Resolve or unresolve a comment (anyone who can comment — enforced by caller). */
export async function setResolved(
  docId: number,
  commentId: number,
  resolved: boolean,
  byUserId: number
): Promise<CommentRow | null> {
  if (resolved) {
    await query(
      `UPDATE comments SET resolved_at = now(), resolved_by_user_id = $3
        WHERE id = $1 AND doc_id = $2 AND deleted_at IS NULL`,
      [commentId, docId, byUserId]
    );
  } else {
    await query(
      `UPDATE comments SET resolved_at = NULL, resolved_by_user_id = NULL
        WHERE id = $1 AND doc_id = $2 AND deleted_at IS NULL`,
      [commentId, docId]
    );
  }
  return findComment(docId, commentId);
}

/**
 * Soft-delete a comment (author own, owner any — enforced by caller). Replies are
 * orphaned-but-kept: a 1-level model means deleting a root leaves its replies
 * pointing at a deleted parent; we soft-delete the root only and the all-threads
 * read filters deleted rows (a deleted root's replies become parentless and are
 * dropped from the tree — acceptable for the simple model; Google Docs does the
 * same "comment deleted" collapse).
 */
export async function softDeleteComment(docId: number, commentId: number): Promise<void> {
  await query(
    `UPDATE comments SET deleted_at = now()
      WHERE id = $1 AND doc_id = $2 AND deleted_at IS NULL`,
    [commentId, docId]
  );
}

export const COMMENT_WRITE_RL = RL_COMMENT_WRITES_PER_MIN;
