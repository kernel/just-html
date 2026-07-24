import { json, notFoundDoc, requireApiKey } from "@/lib/docs/api";
import { canView } from "@/lib/docs/access";
import { resolveAccess } from "@/lib/docs/grants";
import { bookmarkTokenToStore } from "@/lib/docs/bookmarks";
import { findBySlug, removeBookmarkBySlug, saveBookmark } from "@/lib/docs/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// /api/v1/docs/:slug/bookmark — an agent's per-key bookmark for a doc, keyed by
// the key's email (so it shows up alongside the human's web bookmarks for the
// same account). Bookmarking needs only view access, so this is a docs.read
// operation; it's rate-limited as a write. Bookmarks re-check access on read
// (GET /api/v1/bookmarks), so a bookmark never grants more than the live grant.

// PUT /api/v1/docs/:slug/bookmark — add (idempotent). ?viewtoken= lets a
// token-shared doc be bookmarked; the token is stored only if it matches, so a
// later re-check can keep the doc reachable after a grant is removed.
export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const viewtoken = new URL(req.url).searchParams.get("viewtoken");

  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();

  // View gate: owner/grant via the key's identity, or a valid view token /
  // public. Not viewable → 404 (no existence oracle for non-viewers).
  const access = await resolveAccess(doc, principal.email, principal.userId);
  const viewable = access.kind !== "none" || canView(doc, viewtoken);
  if (!viewable) return notFoundDoc();

  await saveBookmark(principal.email, doc.id, bookmarkTokenToStore(doc, viewtoken), doc.title);
  return json({ slug: doc.slug, bookmarked: true });
}

// DELETE /api/v1/docs/:slug/bookmark — remove (idempotent). No view check: you
// can only ever remove your own bookmark, and a revoked/deleted doc must stay
// removable.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  await removeBookmarkBySlug(principal.email, slug);
  return json({ slug, bookmarked: false });
}
