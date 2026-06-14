import { json, notFoundDoc, requireApiKey } from "@/lib/docs/api";
import { findBySlug, ownerView, rotateViewToken } from "@/lib/docs/store";
import { isOwner } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// POST /api/v1/docs/:slug/rotate-token — mint a new view token (the "un-share"
// action: old token-bearing links stop working). Owner only. Scope: docs.write.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.write", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc || !isOwner(doc, principal.userId)) return notFoundDoc();

  const updated = await rotateViewToken(doc.id);
  return json(ownerView(updated, false));
}
