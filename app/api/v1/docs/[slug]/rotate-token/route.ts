import { authenticate, unauthorized } from "@/lib/auth/bearer";
import { forbiddenScope, hasScope, json, notFoundDoc, rateLimit } from "@/lib/docs/api";
import { findBySlug, ownerView, rotateViewToken } from "@/lib/docs/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// POST /api/v1/docs/:slug/rotate-token — mint a new view token (the "un-share"
// action: old token-bearing links stop working). Owner only. Scope: docs.write.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
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

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc || doc.owner_id !== principal.userId) return notFoundDoc();

  const updated = await rotateViewToken(doc.id);
  return json(ownerView(updated, false));
}
