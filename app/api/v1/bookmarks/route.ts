import { apiError, json, requireApiKey } from "@/lib/docs/api";
import { docUrl, listBookmarks, type BookmarkDocRow } from "@/lib/docs/store";
import { resolveAccess } from "@/lib/docs/grants";
import { safeEqualStr } from "@/lib/auth/tokens";
import { resolveBookmarkView } from "@/lib/docs/bookmarks-view";

export const dynamic = "force-dynamic";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

// One bookmark's API view: re-resolve the caller's access (no session — the key
// acts as its authenticated email), then shape the item. A revoked bookmark
// carries no url and the bookmark-time title snapshot (the caller can no longer
// see the doc's current title).
async function itemView(doc: BookmarkDocRow, principalEmail: string, principalUserId: number) {
  const access = await resolveAccess(doc, principalEmail, principalUserId);
  const grantRole =
    access.kind === "email_grant" || access.kind === "domain_grant" ? access.role : null;
  const view = resolveBookmarkView({
    deleted: doc.deleted_at != null,
    isOwner: access.kind === "owner",
    grantRole,
    isPublic: doc.is_public,
    tokenValid: doc.bookmark_token != null && safeEqualStr(doc.bookmark_token, doc.view_token),
  });

  const url = view.revoked
    ? null
    : view.usesToken && doc.bookmark_token
      ? `${docUrl(doc.slug)}?viewtoken=${encodeURIComponent(doc.bookmark_token)}`
      : docUrl(doc.slug);

  return {
    slug: doc.slug,
    url,
    title: view.revoked ? doc.bookmark_title : doc.title,
    access: view.access,
    revoked: view.revoked,
    public: doc.is_public,
    bookmarked_at: doc.bookmarked_at,
  };
}

// GET /api/v1/bookmarks — list the caller's bookmarks, newest first. Scope:
// docs.read.
//
// ?scope=all (default) | owned | shared:
//   - owned : bookmarked docs the key's user owns.
//   - shared: bookmarked docs shared with (not owned by) the caller.
//   - all   : both. The web equivalent for a signed-in human is /bookmarks.
export async function GET(req: Request): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "read");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const url = new URL(req.url);
  let limit = DEFAULT_LIST_LIMIT;
  const limitParam = url.searchParams.get("limit");
  if (limitParam != null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1) {
      return apiError(400, "invalid_request", "Query 'limit' must be a positive integer.");
    }
    limit = Math.min(n, MAX_LIST_LIMIT);
  }

  const scope = url.searchParams.get("scope") ?? "all";
  if (scope !== "owned" && scope !== "shared" && scope !== "all") {
    return apiError(400, "invalid_request", "Query 'scope' must be one of: owned, shared, all.");
  }

  const rows = await listBookmarks(principal.email, limit);
  const bookmarks = [];
  for (const doc of rows) {
    const owned = doc.owner_id === principal.userId;
    if (scope === "owned" && !owned) continue;
    if (scope === "shared" && owned) continue;
    bookmarks.push(await itemView(doc, principal.email, principal.userId));
  }
  return json({ bookmarks });
}
