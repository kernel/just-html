import { authenticate, unauthorized } from "@/lib/auth/bearer";
import { apiError, forbiddenScope, hasScope, json, notFoundDoc, rateLimit } from "@/lib/docs/api";
import { findBySlug, findVersion, versionView } from "@/lib/docs/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; n: string }> };

// GET /api/v1/docs/:slug/versions/:n — fetch a specific version's full html
// snapshot. Scope: docs.read. Owner only (grants in B5). A 404 covers both a
// missing doc and a version that was pruned past the retention cap.
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) {
    return unauthorized(
      req.headers.get("authorization")
        ? "Invalid, expired, or revoked credential."
        : "Missing Bearer credential."
    );
  }
  if (!hasScope(principal, "docs.read")) return forbiddenScope("docs.read");

  const limited = await rateLimit(req, principal, "read");
  if (limited) return limited;

  const { slug, n } = await ctx.params;
  const versionNum = Number(n);
  if (!Number.isInteger(versionNum) || versionNum < 1) {
    return apiError(400, "invalid_request", "Version must be a positive integer.");
  }

  const doc = await findBySlug(slug);
  if (!doc || doc.owner_id !== principal.userId) return notFoundDoc();

  const version = await findVersion(doc.id, versionNum);
  if (!version) {
    return apiError(404, "not_found", "No such version (it may have been pruned past the retention cap).");
  }

  return json({ slug: doc.slug, ...versionView(version, true) });
}
