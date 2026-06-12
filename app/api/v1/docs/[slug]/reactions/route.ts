import { authenticate } from "@/lib/auth/bearer";
import { getSession } from "@/lib/auth/session";
import { apiError, json } from "@/lib/docs/api";
import { findBySlug } from "@/lib/docs/store";
import { canView } from "@/lib/docs/access";
import { checkLimits } from "@/lib/auth/ratelimit";
import {
  resolveCommentPrincipal,
  resolveCapability,
  COMMENT_WRITE_RL,
} from "@/lib/docs/comments";
import { addOrToggleReaction, isAllowedEmoji, ALLOWED_EMOJI } from "@/lib/docs/reactions";
import { parseAnchor, type TextAnchor } from "@/lib/docs/anchor";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// POST /api/v1/docs/:slug/reactions — { emoji, comment_id?, anchor? }.
// The target is 3-WAY and mutually exclusive (birthday.md "Anchored reactions"):
//   comment_id set -> on a comment; anchor set -> on a span; both null -> on doc.
// Supplying BOTH comment_id AND anchor is a 400. The anchor is the same W3C
// text-quote {exact, prefix?, suffix?, start?, end?} as comment anchors, with the
// same validation. React: anyone who can VIEW, with identity (birthday.md
// "Permission matrix"). Attributed-only; unique per (target, author, emoji);
// re-posting the same reaction toggles it off.

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Reacting requires an API key or a signed-in session." }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate":
          'Bearer resource_metadata="https://justhtml.sh/.well-known/oauth-protected-resource"',
      },
    }
  );
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const viewtoken = url.searchParams.get("viewtoken");

  const apiPrincipal = await authenticate(req);
  const session = apiPrincipal ? null : await getSession(req);
  const principal = await resolveCommentPrincipal(apiPrincipal, session);
  if (!principal) return unauthorized();

  const rlKey =
    principal.source === "api_key"
      ? `comments:write:key:${apiPrincipal!.apiKeyId}`
      : `comments:write:sess:${session!.id}`;
  const tripped = await checkLimits([{ key: rlKey, limit: COMMENT_WRITE_RL, window: "minute" }]);
  if (tripped) {
    return json(
      { error: "rate_limited", message: `Too many writes. Retry after ${tripped.retryAfter}s.`, retry_after: tripped.retryAfter },
      429,
      { "Retry-After": String(tripped.retryAfter) }
    );
  }

  const doc = await findBySlug(slug);
  if (!doc) return apiError(404, "not_found", "No such document.");

  const cap = await resolveCapability(doc, principal, canView(doc, viewtoken));
  if (!cap.canReact) {
    return apiError(404, "not_found", "No such document.");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError(400, "invalid_request", "Request body must be valid JSON.");
  }
  if (typeof raw !== "object" || raw === null) {
    return apiError(400, "invalid_request", "Request body must be a JSON object.");
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.emoji !== "string" || !isAllowedEmoji(b.emoji)) {
    return apiError(400, "invalid_request", "Field 'emoji' must be one of the supported emoji.", {
      allowed: [...ALLOWED_EMOJI],
    });
  }
  let commentId: number | null = null;
  if (b.comment_id !== undefined && b.comment_id !== null) {
    const n = Number(b.comment_id);
    if (!Number.isInteger(n) || n < 1) {
      return apiError(400, "invalid_request", "Field 'comment_id' must be a positive integer or null.");
    }
    commentId = n;
  }

  // Anchor: a span target (same W3C shape + validation as comment anchors). The
  // target is mutually exclusive — a comment-level reaction can't also be
  // span-anchored (400; the DB CHECK reactions_target_exclusive is the backstop).
  let anchor: TextAnchor | null = null;
  if (b.anchor !== undefined && b.anchor !== null) {
    if (commentId !== null) {
      return apiError(
        400,
        "invalid_request",
        "A reaction targets exactly one of: a comment (comment_id), a span (anchor), or the doc (neither). Supply at most one of comment_id and anchor."
      );
    }
    const parsed = parseAnchor(b.anchor);
    if ("error" in parsed) return apiError(400, "invalid_request", parsed.error);
    anchor = parsed.anchor;
  }

  const result = await addOrToggleReaction({
    doc,
    commentId,
    anchor,
    authorUserId: principal.userId,
    emoji: b.emoji,
  });
  if ("error" in result) {
    return apiError(422, "bad_comment", "comment_id must reference a live comment on this document.");
  }
  if (result.toggled) {
    return json({ toggled: true, removed: true });
  }
  return json(
    {
      reaction: {
        id: Number(result.reaction.id),
        comment_id: result.reaction.comment_id === null ? null : Number(result.reaction.comment_id),
        anchor: result.reaction.anchor,
        anchored_version: result.reaction.anchored_version,
        orphaned: result.reaction.orphaned,
        emoji: result.reaction.emoji,
        author: principal.email,
        created_at: result.reaction.created_at,
      },
    },
    201
  );
}
