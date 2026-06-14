import { authenticate } from "@/lib/auth/bearer";
import { getSession } from "@/lib/auth/session";
import { apiError, json, parseJsonObject, unauthorizedIdentity } from "@/lib/docs/api";
import { findBySlug } from "@/lib/docs/store";
import { canView } from "@/lib/docs/access";
import { checkLimits } from "@/lib/auth/ratelimit";
import { parseAnchor, type TextAnchor } from "@/lib/docs/anchor";
import {
  allThreads,
  commentView,
  createComment,
  resolveCommentPrincipal,
  resolveCapability,
  principalCanView,
  MAX_COMMENT_BODY_BYTES,
  COMMENT_WRITE_RL,
} from "@/lib/docs/comments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// /api/v1/docs/:slug/comments — POST a comment, GET the all-threads view.
//
// Auth: API key (agents) OR view-token-scoped browser session (humans), per the
// permission matrix (birthday.md). Anonymous never writes; reads require view
// access. The anchor payload is a W3C text-quote {exact, prefix?, suffix?,
// start?, end?}; null anchor = a doc-level comment. parent_id makes a 1-level
// reply.

// 401 with the API discovery hint (an agent hitting this cold can bootstrap).
function unauthorizedWrite(): Response {
  return unauthorizedIdentity(
    "Commenting requires identity: an API key (Authorization: Bearer jh_live_…) or a signed-in session. Anonymous viewers cannot comment."
  );
}

// POST /api/v1/docs/:slug/comments — { body, anchor?, parent_id? }
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const viewtoken = url.searchParams.get("viewtoken");

  const apiPrincipal = await authenticate(req);
  const session = apiPrincipal ? null : await getSession(req);
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (!principal) return unauthorizedWrite();

  // Per-principal write rate limit (minute bucket).
  const rlKey =
    principal.source === "api_key"
      ? `comments:write:key:${apiPrincipal!.apiKeyId}`
      : `comments:write:sess:${session!.id}`;
  const tripped = await checkLimits([{ key: rlKey, limit: COMMENT_WRITE_RL, window: "minute" }]);
  if (tripped) {
    return json(
      { error: "rate_limited", message: `Too many comment writes. Retry after ${tripped.retryAfter}s.`, retry_after: tripped.retryAfter },
      429,
      { "Retry-After": String(tripped.retryAfter) }
    );
  }

  const doc = await findBySlug(slug);
  if (!doc) return apiError(404, "not_found", "No such document.");

  // Token-holder-with-identity / public-doc gating: did this request present a
  // valid view token (or is the doc public)? canView is the token/public check.
  const canViewByToken = canView(doc, viewtoken);

  const cap = await resolveCapability(doc, principal, canViewByToken);
  if (!cap.canComment) {
    // No comment right AND can't even view → 404 (no existence oracle). Can view
    // but not comment (e.g. viewer grant) → 403.
    const viewable = await principalCanView(doc, apiPrincipal, session, viewtoken);
    if (!viewable) return apiError(404, "not_found", "No such document.");
    return apiError(403, "forbidden", "You can view this document but are not allowed to comment on it.");
  }

  const parsed = await parseJsonObject(req);
  if ("response" in parsed) return parsed.response;
  const b = parsed.obj;

  if (typeof b.body !== "string" || b.body.trim().length === 0) {
    return apiError(400, "invalid_request", "Field 'body' is required and must be a non-empty string.");
  }
  if (Buffer.byteLength(b.body, "utf8") > MAX_COMMENT_BODY_BYTES) {
    return apiError(413, "payload_too_large", `Comment body exceeds the ${MAX_COMMENT_BODY_BYTES}-byte limit.`, {
      limit_bytes: MAX_COMMENT_BODY_BYTES,
    });
  }

  let parentId: number | null = null;
  if (b.parent_id !== undefined && b.parent_id !== null) {
    const n = Number(b.parent_id);
    if (!Number.isInteger(n) || n < 1) {
      return apiError(400, "invalid_request", "Field 'parent_id' must be a positive integer.");
    }
    parentId = n;
  }

  // Anchor: null/absent = doc-level. A reply (parent_id set) is always doc-level
  // relative to the doc — its position is its parent's; reject an anchor on a reply.
  let anchor: TextAnchor | null = null;
  if (b.anchor !== undefined && b.anchor !== null) {
    if (parentId !== null) {
      return apiError(400, "invalid_request", "A reply cannot carry its own anchor; omit 'anchor' on replies.");
    }
    const parsed = parseAnchor(b.anchor);
    if ("error" in parsed) return apiError(400, "invalid_request", parsed.error);
    anchor = parsed.anchor;
  }

  const result = await createComment({
    doc,
    authorUserId: principal.userId,
    parentId,
    anchor,
    body: b.body,
  });
  if ("error" in result) {
    if (result.error === "limit") {
      return apiError(403, "quota_exceeded", `This document has reached the ${result.limit}-comment limit.`, {
        limit: "comments_per_doc",
        limit_value: result.limit,
      });
    }
    return apiError(422, "bad_parent", "parent_id must reference a live top-level comment on this document.");
  }

  return json({ comment: commentView(result.comment, []) }, 201);
}

// GET /api/v1/docs/:slug/comments — the complete all-threads picture.
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const viewtoken = url.searchParams.get("viewtoken");

  const apiPrincipal = await authenticate(req);
  const session = apiPrincipal ? null : await getSession(req);

  const doc = await findBySlug(slug);
  if (!doc) return apiError(404, "not_found", "No such document.");

  // Read requires view access (owner/grant via identity, valid token, or public).
  const canRead = await principalCanView(doc, apiPrincipal, session, viewtoken);
  if (!canRead) return apiError(404, "not_found", "No such document.");

  // Also report what the caller can do (drives the rail's read-only vs compose UI
  // and lets agents know whether they may write).
  let canComment = false;
  let canReact = false;
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (principal) {
    const cap = await resolveCapability(doc, principal, canView(doc, viewtoken));
    canComment = cap.canComment;
    canReact = cap.canReact;
  }

  const data = await allThreads(doc);
  return json({
    slug: doc.slug,
    version: doc.version,
    can_comment: canComment,
    can_react: canReact,
    ...data, // { total, threads, doc_reactions? }
  });
}
