import { authenticate } from "@/lib/auth/bearer";
import { getSession } from "@/lib/auth/session";
import { apiError, json, parseJsonObject, parsePositiveIntParam, unauthorizedIdentity } from "@/lib/docs/api";
import { findBySlug } from "@/lib/docs/store";
import { canView } from "@/lib/docs/access";
import { isOwner } from "@/lib/docs/grants";
import { checkLimits } from "@/lib/auth/ratelimit";
import {
  findComment,
  commentView,
  editCommentBody,
  setResolved,
  softDeleteComment,
  resolveCommentPrincipal,
  resolveCapability,
  MAX_COMMENT_BODY_BYTES,
  COMMENT_WRITE_RL,
} from "@/lib/docs/comments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> };

// /api/v1/docs/:slug/comments/:id
//   PATCH  — edit body (author only) and/or resolve|unresolve (anyone who can
//            comment). birthday.md "Permission matrix".
//   DELETE — soft-delete (author own, owner any).
//
// Auth: API key OR session, same as POST /comments.

function unauthorized(): Response {
  return unauthorizedIdentity("This action requires an API key or a signed-in session.");
}

async function rateLimited(source: "api_key" | "session", id: number): Promise<Response | null> {
  const key = source === "api_key" ? `comments:write:key:${id}` : `comments:write:sess:${id}`;
  const tripped = await checkLimits([{ key, limit: COMMENT_WRITE_RL, window: "minute" }]);
  if (!tripped) return null;
  return json(
    { error: "rate_limited", message: `Too many comment writes. Retry after ${tripped.retryAfter}s.`, retry_after: tripped.retryAfter },
    429,
    { "Retry-After": String(tripped.retryAfter) }
  );
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { slug, id } = await ctx.params;
  const idResult = parsePositiveIntParam("Comment id", id);
  if ("response" in idResult) return idResult.response;
  const commentId = idResult.value;
  const url = new URL(req.url);
  const viewtoken = url.searchParams.get("viewtoken");

  const apiPrincipal = await authenticate(req);
  const session = apiPrincipal ? null : await getSession(req);
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (!principal) return unauthorized();

  const rl = await rateLimited(principal.source, principal.source === "api_key" ? apiPrincipal!.apiKeyId : session!.id);
  if (rl) return rl;

  const doc = await findBySlug(slug);
  if (!doc) return apiError(404, "not_found", "No such document.");
  const comment = await findComment(doc.id, commentId);
  if (!comment) return apiError(404, "not_found", "No such comment.");

  const cap = await resolveCapability(doc, principal, canView(doc, viewtoken));
  const isAuthor = comment.author_user_id !== null && Number(comment.author_user_id) === Number(principal.userId);

  const parsed = await parseJsonObject(req);
  if ("response" in parsed) return parsed.response;
  const b = parsed.obj;

  const hasBody = b.body !== undefined;
  const hasResolved = b.resolved !== undefined;
  if (!hasBody && !hasResolved) {
    return apiError(400, "invalid_request", "Provide 'body' (edit) and/or 'resolved' (resolve/unresolve).");
  }

  // Edit body: AUTHOR ONLY.
  if (hasBody) {
    if (!isAuthor) {
      return apiError(403, "forbidden", "Only the comment's author can edit its body.");
    }
    if (typeof b.body !== "string" || b.body.trim().length === 0) {
      return apiError(400, "invalid_request", "Field 'body' must be a non-empty string.");
    }
    if (Buffer.byteLength(b.body, "utf8") > MAX_COMMENT_BODY_BYTES) {
      return apiError(413, "payload_too_large", `Comment body exceeds the ${MAX_COMMENT_BODY_BYTES}-byte limit.`, {
        limit_bytes: MAX_COMMENT_BODY_BYTES,
      });
    }
    await editCommentBody(doc.id, commentId, b.body);
  }

  // Resolve / unresolve: ANYONE WHO CAN COMMENT.
  if (hasResolved) {
    if (typeof b.resolved !== "boolean") {
      return apiError(400, "invalid_request", "Field 'resolved' must be a boolean.");
    }
    if (!cap.canComment) {
      return apiError(403, "forbidden", "You are not allowed to resolve comments on this document.");
    }
    await setResolved(doc.id, commentId, b.resolved, principal.userId);
  }

  const updated = await findComment(doc.id, commentId);
  return json({ comment: updated ? commentView(updated, []) : null });
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const { slug, id } = await ctx.params;
  const idResult = parsePositiveIntParam("Comment id", id);
  if ("response" in idResult) return idResult.response;
  const commentId = idResult.value;

  const apiPrincipal = await authenticate(req);
  const session = apiPrincipal ? null : await getSession(req);
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (!principal) return unauthorized();

  const rl = await rateLimited(principal.source, principal.source === "api_key" ? apiPrincipal!.apiKeyId : session!.id);
  if (rl) return rl;

  const doc = await findBySlug(slug);
  if (!doc) return apiError(404, "not_found", "No such document.");
  const comment = await findComment(doc.id, commentId);
  if (!comment) return apiError(404, "not_found", "No such comment.");

  const isAuthor = comment.author_user_id !== null && Number(comment.author_user_id) === Number(principal.userId);
  const owner = isOwner(doc, principal.userId);
  if (!isAuthor && !owner) {
    return apiError(403, "forbidden", "Only the comment's author or the document owner can delete it.");
  }

  await softDeleteComment(doc.id, commentId);
  return json({ id: commentId, deleted: true });
}
