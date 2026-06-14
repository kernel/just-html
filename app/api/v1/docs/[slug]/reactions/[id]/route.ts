import { authenticate } from "@/lib/auth/bearer";
import { getSession } from "@/lib/auth/session";
import { apiError, json, parsePositiveIntParam, unauthorizedIdentity } from "@/lib/docs/api";
import { findBySlug } from "@/lib/docs/store";
import { resolveCommentPrincipal } from "@/lib/docs/comments";
import { deleteOwnReaction } from "@/lib/docs/reactions";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

// DELETE /api/v1/docs/:slug/reactions/:id — remove your OWN reaction (the
// re-click toggle on POST /reactions is the primary path; this is the explicit
// id-addressed removal). Author-scoped; you can only delete reactions you made.

function unauthorized(): Response {
  return unauthorizedIdentity("This action requires an API key or a signed-in session.");
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const { slug, id } = await ctx.params;
  const idResult = parsePositiveIntParam("Reaction id", id);
  if ("response" in idResult) return idResult.response;
  const reactionId = idResult.value;

  const apiPrincipal = await authenticate(req);
  const session = apiPrincipal ? null : await getSession(req);
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (!principal) return unauthorized();

  const doc = await findBySlug(slug);
  if (!doc) return apiError(404, "not_found", "No such document.");

  const removed = await deleteOwnReaction(doc.id, reactionId, principal.userId);
  // Idempotent-ish: deleting a reaction that isn't yours / doesn't exist → 404
  // (no leak of others' reaction ids).
  if (!removed) return apiError(404, "not_found", "No such reaction.");
  return json({ id: reactionId, deleted: true });
}
