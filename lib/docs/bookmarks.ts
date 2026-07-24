// Shared bookmark logic used by both the web /bookmarks page and the agent API
// (/api/v1/bookmarks, /api/v1/docs/:slug/bookmark). Keeps the access
// re-resolution and token-persistence rules in one place so the two surfaces
// can't drift.
import { canView } from "@/lib/docs/access";
import { accessRoleLabel, resolveAccess } from "@/lib/docs/grants";
import { safeEqualStr } from "@/lib/auth/tokens";
import { docUrl, type BookmarkDocRow, type DocRow } from "@/lib/docs/store";

// The caller's current access to a bookmarked doc, re-resolved on every read so
// a bookmark never grants more than the live authorization:
//   owner | editor | commenter | viewer | public | link | revoked
// "link" = reachable only through the stored view token (kept so the row can
// re-link with it). "revoked" = no access path left (deleted, grant removed, or
// the stored token rotated away).
export type BookmarkAccess = { access: string; linkable: boolean; token: string | null };

export async function resolveBookmarkAccess(
  doc: BookmarkDocRow,
  email: string,
  userId: number | null
): Promise<BookmarkAccess> {
  if (doc.deleted_at) return { access: "revoked", linkable: false, token: null };

  // Owner → any grant (email beats domain). resolveAccess short-circuits on
  // ownership, so an owner costs no grant query.
  const resolved = await resolveAccess(doc, email, userId ?? -1);
  if (resolved.kind === "owner") return { access: "owner", linkable: true, token: null };
  if (resolved.kind !== "none") {
    return { access: accessRoleLabel(resolved), linkable: true, token: null };
  }

  // No grant: reachable via public, or only through the token it was bookmarked
  // with (still valid iff it matches the doc's current token).
  if (doc.is_public) return { access: "public", linkable: true, token: null };
  if (doc.bookmark_token && canView(doc, doc.bookmark_token)) {
    return { access: "link", linkable: true, token: doc.bookmark_token };
  }
  return { access: "revoked", linkable: false, token: null };
}

// Persist a bookmark's view token only when it actually matches the doc. Access
// may have come from ownership/grant/public, in which case the submitted token
// is irrelevant — storing it would gate the later re-check on a token that was
// never the basis for access.
export function bookmarkTokenToStore(doc: DocRow, viewtoken: string | null): string | null {
  return viewtoken && safeEqualStr(viewtoken, doc.view_token) ? viewtoken : null;
}

// The JSON shape GET /api/v1/bookmarks returns per item. Accessible rows carry a
// url (with ?viewtoken= appended for token-only access) and the doc's live
// title; a revoked row carries no url and the title snapshotted at bookmark time
// (the caller can no longer see the doc's current title).
export function bookmarkApiItem(doc: BookmarkDocRow, access: BookmarkAccess) {
  const url = !access.linkable
    ? null
    : access.token
      ? `${docUrl(doc.slug)}?viewtoken=${encodeURIComponent(access.token)}`
      : docUrl(doc.slug);
  return {
    slug: doc.slug,
    title: access.linkable ? doc.title : doc.bookmark_title,
    access: access.access,
    revoked: !access.linkable,
    url,
    bookmarked_at: doc.bookmarked_at,
  };
}
