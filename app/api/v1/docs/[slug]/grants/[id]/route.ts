import { authenticate, unauthorized } from "@/lib/auth/bearer";
import { apiError, forbiddenScope, hasScope, json, notFoundDoc, rateLimit } from "@/lib/docs/api";
import { findBySlug } from "@/lib/docs/store";
import { deleteGrant } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

// DELETE /api/v1/docs/:slug/grants/:id — revoke a grant. Owner only.
// Scope: docs.write.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) {
    return unauthorized(
      req.headers.get("authorization")
        ? "Invalid, expired, or revoked credential."
        : "Missing Bearer credential."
    );
  }
  if (!hasScope(principal, "docs.write")) return forbiddenScope("docs.write");

  const limited = await rateLimit(req, principal, "write");
  if (limited) return limited;

  const { slug, id } = await ctx.params;
  const grantId = Number(id);
  if (!Number.isInteger(grantId) || grantId < 1) {
    return apiError(400, "invalid_request", "Grant id must be a positive integer.");
  }

  const doc = await findBySlug(slug);
  // Owner-only, no existence oracle.
  if (!doc || doc.owner_id !== principal.userId) return notFoundDoc();

  const removed = await deleteGrant(doc.id, grantId);
  if (!removed) {
    return apiError(404, "not_found", "No such grant on this document.");
  }
  return json({ slug: doc.slug, grant_id: grantId, deleted: true });
}
