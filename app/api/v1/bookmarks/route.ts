import { apiError, json, requireApiKey } from "@/lib/docs/api";
import { listBookmarks } from "@/lib/docs/store";
import { bookmarkApiItem, resolveBookmarkAccess } from "@/lib/docs/bookmarks";

export const dynamic = "force-dynamic";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

// GET /api/v1/bookmarks — list the caller's bookmarked docs. Scope: docs.read.
//
// ?scope=owned | shared | all (default all): the same split the web /bookmarks
// page shows — owned = docs the key's user owns, shared = docs bookmarked but
// owned by someone else. Access is re-resolved per item (owner|editor|commenter
// |viewer|public|link|revoked), so a revoked bookmark still lists (with its
// bookmark-time title and no url) rather than vanishing — DELETE it to drop it.
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

  const bookmarks = await listBookmarks(principal.email, limit);
  const items = [];
  for (const doc of bookmarks) {
    const owned = doc.owner_id === principal.userId;
    if (scope === "owned" && !owned) continue;
    if (scope === "shared" && owned) continue;
    const access = await resolveBookmarkAccess(doc, principal.email, principal.userId);
    items.push(bookmarkApiItem(doc, access));
  }
  return json({ bookmarks: items });
}
