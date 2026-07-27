import {
  apiError,
  forbiddenScope,
  hasScope,
  json,
  notFoundDoc,
  parsePositiveIntParam,
  quotaExceeded,
  rateLimit,
} from "@/lib/docs/api";
import { authenticate, authFail } from "@/lib/auth/bearer";
import { getSession } from "@/lib/auth/session";
import { resolveCommentPrincipal } from "@/lib/docs/comments";
import { checkLimits } from "@/lib/auth/ratelimit";
import { RL_WRITES_PER_MIN } from "@/lib/docs/config";
import { findBySlug, findVersion, granteeView, ownerView, rewriteDoc } from "@/lib/docs/store";
import { accessRoleLabel, canEdit, resolveAccess } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; n: string }> };

// POST /api/v1/docs/:slug/versions/:n/restore — put an earlier version's content
// back as the current one. Owner or editor grant; API key OR signed-in session,
// so the history page's Restore button works from the browser.
//
// Restoring is a normal forward write, not a rewind: it takes version n's html
// and stores it as a NEW version with edit_kind 'rewrite'. Nothing is deleted, so
// restoring the wrong version is itself undoable, and the intervening versions
// stay in the history (subject to the usual retention cap).
//
// This is the recovery path for inline editing. Every other route can only move
// a document forward, which meant undoing a bad write required operating on the
// database directly.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const apiPrincipal = await authenticate(req);
  if (apiPrincipal && !hasScope(apiPrincipal, "docs.write")) return forbiddenScope("docs.write");
  const session = apiPrincipal ? null : await getSession(req);
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (!principal) return authFail(req);

  if (apiPrincipal) {
    const limited = await rateLimit(req, apiPrincipal, "write");
    if (limited) return limited;
  } else {
    const tripped = await checkLimits([
      { key: `docs:write:sess:${session!.id}`, limit: RL_WRITES_PER_MIN, window: "minute" },
    ]);
    if (tripped) {
      return json(
        {
          error: "rate_limited",
          message: `Too many requests. Retry after ${tripped.retryAfter} seconds.`,
          retry_after: tripped.retryAfter,
        },
        429,
        { "Retry-After": String(tripped.retryAfter) }
      );
    }
  }

  const { slug, n } = await ctx.params;
  const versionResult = parsePositiveIntParam("Version", n);
  if ("response" in versionResult) return versionResult.response;

  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();
  const access = await resolveAccess(doc, principal.email, principal.userId);
  if (!canEdit(access)) return notFoundDoc();

  const version = await findVersion(doc.id, versionResult.value);
  if (!version) {
    return apiError(404, "not_found", "No such version (it may have been pruned past the retention cap).");
  }
  if (version.html === doc.html) {
    return apiError(422, "no_change", "That version's content is already what the document holds.");
  }

  const result = await rewriteDoc({ doc, html: version.html, authorUserId: principal.userId });
  if ("quota" in result) {
    return quotaExceeded(result.quota.kind, result.quota.limit, result.quota.current);
  }

  const view =
    access.kind === "owner"
      ? ownerView(result.doc, true)
      : granteeView(result.doc, true, accessRoleLabel(access));
  return json({ ...view, restored_from: version.version });
}
