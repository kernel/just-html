// Pure rendering for the /bookmarks list rows. Kept out of the route handler so
// the revoked / token-link / remove-button behavior is unit-testable without a
// DB. Matches the variant-C row look from /docs (bold title link + dimmed tail).
import { esc } from "@/lib/page";

/** YYYY-MM-DD — the terse one-line tail wants a date, not a timestamp. */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export type RowModel = {
  docId: number;
  slug: string;
  title: string | null;
  // Resolved access label: owner | editor | commenter | viewer | public | link
  // | revoked. "link" means reachable only through the stored view token.
  access: string;
  isPublic: boolean;
  bookmarkedAt: string;
  linkable: boolean;
  // View token to re-append to the link so a token-shared doc stays reachable.
  token: string | null;
};

/** The remove form: a zero-JS POST keyed by doc id, so a bookmark — revoked or
 *  not — can be dropped from the list. */
function removeForm(docId: number): string {
  return `<form method="POST" action="/bookmarks" class="rm"><input type="hidden" name="action" value="remove"><input type="hidden" name="doc_id" value="${docId}"><input type="hidden" name="next" value="/bookmarks"><button type="submit" class="remove" title="Remove bookmark">remove</button></form>`;
}

/**
 * One bookmark row. A revoked bookmark shows the title as it was when
 * bookmarked (the caller passes that snapshot, never the doc's current title —
 * which the viewer can no longer see), dimmed and unlinked with a "revoked"
 * tail. A live bookmark shows the current title linking to the doc, carrying
 * the stored view token when the doc is reachable only through it.
 */
export function bookmarkRow(m: RowModel): string {
  const revoked = m.access === "revoked" || !m.linkable;
  const label = m.title && m.title.trim() ? m.title : m.slug;

  if (revoked) {
    return `<div class="row revoked"><pre><span class="title">${esc(label)}</span>  <span class="tail">revoked · ${esc(fmtDate(m.bookmarkedAt))}</span></pre>${removeForm(m.docId)}</div>`;
  }

  const href = m.token
    ? `/d/${encodeURIComponent(m.slug)}?viewtoken=${encodeURIComponent(m.token)}`
    : `/d/${encodeURIComponent(m.slug)}`;
  const vis = m.isPublic ? "public" : "private";
  return `<div class="row"><pre><a class="title" href="${esc(href)}">${esc(label)}</a>  <span class="tail">${esc(m.access)} ${vis} · ${esc(fmtDate(m.bookmarkedAt))}</span></pre>${removeForm(m.docId)}</div>`;
}

// Inputs for re-resolving a bookmarked doc's access at read time, reduced to
// primitives so the mapping is pure (no DB, no session). The API list handler
// (GET /api/v1/bookmarks) derives these from resolveAccess + the doc row.
export type BookmarkAccessInput = {
  // The doc has been (soft-)deleted.
  deleted: boolean;
  // The caller owns the doc.
  isOwner: boolean;
  // The caller's resolved identity grant role, or null when there is no grant.
  grantRole: "editor" | "commenter" | "viewer" | null;
  // The doc is public.
  isPublic: boolean;
  // The view token the doc was bookmarked through still matches the doc.
  tokenValid: boolean;
};

export type BookmarkAccessView = {
  // owner | editor | commenter | viewer | public | link | revoked.
  access: string;
  revoked: boolean;
  // The row should link through the stored view token (access === "link").
  usesToken: boolean;
};

/**
 * Re-resolve a bookmarked doc's access, mirroring the web /bookmarks page:
 * a deleted doc or one the caller can no longer reach is "revoked"; otherwise
 * the live identity role, or "public"/"link" when reachable only through the
 * doc being public / the stored view token. Order matches the access ladder.
 */
export function resolveBookmarkView(i: BookmarkAccessInput): BookmarkAccessView {
  if (i.deleted) return { access: "revoked", revoked: true, usesToken: false };
  if (i.isOwner) return { access: "owner", revoked: false, usesToken: false };
  if (i.grantRole) return { access: i.grantRole, revoked: false, usesToken: false };
  if (i.isPublic) return { access: "public", revoked: false, usesToken: false };
  if (i.tokenValid) return { access: "link", revoked: false, usesToken: true };
  return { access: "revoked", revoked: true, usesToken: false };
}
