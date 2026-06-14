import { apiError, json, notFoundDoc, parsePositiveIntParam, requireApiKey } from "@/lib/docs/api";
import { findBySlug, findVersion, versionView } from "@/lib/docs/store";
import { canRead, resolveAccess } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; n: string }> };

// GET /api/v1/docs/:slug/versions/:n — fetch a specific version's full html
// snapshot. Scope: docs.read. Readable by owner OR any grantee. A 404 covers
// both a missing/inaccessible doc and a version pruned past the retention cap.
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "read");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug, n } = await ctx.params;
  const versionResult = parsePositiveIntParam("Version", n);
  if ("response" in versionResult) return versionResult.response;
  const versionNum = versionResult.value;

  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();
  const access = await resolveAccess(doc, principal.email, principal.userId);
  if (!canRead(access)) return notFoundDoc();

  const version = await findVersion(doc.id, versionNum);
  if (!version) {
    return apiError(404, "not_found", "No such version (it may have been pruned past the retention cap).");
  }

  return json({ slug: doc.slug, ...versionView(version, true) });
}
