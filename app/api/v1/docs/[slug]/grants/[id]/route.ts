import { apiError, json, notFoundDoc, parsePositiveIntParam, requireApiKey } from "@/lib/docs/api";
import { findBySlug } from "@/lib/docs/store";
import { deleteGrant, isOwner } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

// DELETE /api/v1/docs/:slug/grants/:id — revoke a grant. Owner only.
// Scope: docs.write.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.write", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug, id } = await ctx.params;
  const idResult = parsePositiveIntParam("Grant id", id);
  if ("response" in idResult) return idResult.response;
  const grantId = idResult.value;

  const doc = await findBySlug(slug);
  // Owner-only, no existence oracle.
  if (!doc || !isOwner(doc, principal.userId)) return notFoundDoc();

  const removed = await deleteGrant(doc.id, grantId);
  if (!removed) {
    return apiError(404, "not_found", "No such grant on this document.");
  }
  return json({ slug: doc.slug, grant_id: grantId, deleted: true });
}
