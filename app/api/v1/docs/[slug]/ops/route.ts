import {
  forbiddenScope,
  hasScope,
  json,
  notFoundDoc,
  parseJsonObject,
  payloadTooLarge,
  quotaExceeded,
  rateLimit,
  staleVersion,
  unprocessableEdit,
} from "@/lib/docs/api";
import { authenticate, authFail } from "@/lib/auth/bearer";
import { getSession } from "@/lib/auth/session";
import { resolveCommentPrincipal } from "@/lib/docs/comments";
import { checkLimits } from "@/lib/auth/ratelimit";
import { OpsBody, opsBadRequest } from "@/lib/docs/schemas";
import { MAX_HTML_BYTES, RL_WRITES_PER_MIN } from "@/lib/docs/config";
import { applyDocOps, findBySlug, granteeView, ownerView } from "@/lib/docs/store";
import { OpApplyError, type Op } from "@/lib/docs/doc-ops";
import { accessRoleLabel, canEdit, resolveAccess } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// POST /api/v1/docs/:slug/ops — apply structural edits (lib/docs/doc-ops.ts).
// Body: { ops: [{ op, src, … }, …], base_version }.
//
// The sibling of /edits. /edits changes TEXT by matching it; this changes MARKUP
// by naming an element, which is what the viewer's formatting, block-type,
// insert/delete/move and list commands need. Auth, rate limiting, quota, size
// caps and the 409/422 contract are deliberately identical to /edits — the only
// additions are the op-specific 422 reasons and `focus`, the id of content this
// request created, which the viewer uses to put the caret in the right place
// once it has reloaded against the new bytes.
//
// base_version is effectively mandatory here even though the schema allows it to
// be absent: an element id only means something against the bytes it was served
// with, so an id dereferenced against a document that has moved is a silent
// mis-edit. Sending it turns that into a 409.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const apiPrincipal = await authenticate(req);
  if (apiPrincipal && !hasScope(apiPrincipal, "docs.write")) return forbiddenScope("docs.write");
  const session = apiPrincipal ? null : await getSession(req);
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (!principal) return authFail(req);

  // Rate limit per credential: the existing per-key bucket for agents, a
  // per-session bucket at the same ceiling for the browser.
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

  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    return payloadTooLarge(MAX_HTML_BYTES, contentLength);
  }

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();
  const access = await resolveAccess(doc, principal.email, principal.userId);
  // No existence oracle: no edit access is the same 404 as no document.
  if (!canEdit(access)) return notFoundDoc();

  const parsed = await parseJsonObject(req);
  if ("response" in parsed) return parsed.response;

  const v = OpsBody.safeParse(parsed.obj);
  if (!v.success) return opsBadRequest(v.error);

  let result;
  try {
    result = await applyDocOps({
      doc,
      ops: v.data.ops as Op[],
      baseVersion: v.data.base_version,
      authorUserId: principal.userId,
    });
  } catch (e) {
    if (e instanceof OpApplyError) return unprocessableEdit(e.reason, e.opIndex, e.message);
    throw e;
  }

  if ("stale" in result) return staleVersion(result.stale.currentVersion);
  if ("tooLarge" in result) return payloadTooLarge(MAX_HTML_BYTES, result.tooLarge.gotBytes);
  if ("quota" in result) {
    return quotaExceeded(result.quota.kind, result.quota.limit, result.quota.current);
  }

  const view =
    access.kind === "owner"
      ? ownerView(result.doc, true)
      : granteeView(result.doc, true, accessRoleLabel(access));
  return json(result.focus === undefined ? view : { ...view, focus: result.focus });
}
