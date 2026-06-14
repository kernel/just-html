import { json, notFoundDoc, requireApiKey } from "@/lib/docs/api";
import { findBySlug, listVersions, versionView } from "@/lib/docs/store";
import { canRead, resolveAccess } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// GET /api/v1/docs/:slug/versions — list retained version history (newest first,
// metadata + byte size, no html). Scope: docs.read. Readable by owner OR any
// grantee (editor/commenter/viewer).
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "read");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();
  const access = await resolveAccess(doc, principal.email, principal.userId);
  if (!canRead(access)) return notFoundDoc();

  const versions = await listVersions(doc.id);
  return json({
    slug: doc.slug,
    current_version: doc.version,
    versions: versions.map((v) => versionView(v, false)),
  });
}
