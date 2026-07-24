import { json, notFoundDoc, requireApiKey } from "@/lib/docs/api";
import { findBySlug, removeBookmarkBySlug, saveBookmark } from "@/lib/docs/store";
import { resolveAccess } from "@/lib/docs/grants";
import { canView } from "@/lib/docs/access";
import { safeEqualStr } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// PUT /api/v1/docs/:slug/bookmark — idempotently bookmark a doc the caller can
// view. Keyed by the key's email, so it unifies with the account's signed-in
// web bookmarks. Requires view access (owner / grant via identity, a public
// doc, or a matching ?viewtoken=); an inaccessible doc 404s (no existence
// oracle). Scope: docs.read — bookmarking only needs to read the doc, and it
// writes the caller's own personal state, not the document.
export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const viewtoken = new URL(req.url).searchParams.get("viewtoken");

  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();

  // Owner / email / domain grant via the authenticated email, or public / a
  // matching view token (the viewer-route path an API key may still present).
  const access = await resolveAccess(doc, principal.email, principal.userId);
  if (access.kind === "none" && !canView(doc, viewtoken)) return notFoundDoc();

  // Persist the token only when it is the actual basis for access — a matching
  // token on an otherwise private doc reached with no grant. Access via
  // ownership / a grant / public makes the submitted token irrelevant, and
  // storing a non-matching token would gate the later re-check on a token that
  // was never the basis for access. Mirrors the web bookmark POST.
  const tokenToStore =
    access.kind === "none" &&
    !doc.is_public &&
    viewtoken &&
    safeEqualStr(viewtoken, doc.view_token)
      ? viewtoken
      : null;
  await saveBookmark(principal.email, doc.id, tokenToStore, doc.title);
  return json({ bookmarked: true });
}

// DELETE /api/v1/docs/:slug/bookmark — idempotently remove the caller's
// bookmark. Keyed by slug through the doc row so it still drops a bookmark for
// a revoked/deleted doc; a no-op when nothing was bookmarked. Scope: docs.read.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  await removeBookmarkBySlug(principal.email, slug);
  return json({ removed: true });
}
