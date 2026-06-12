import { authenticate, unauthorized } from "@/lib/auth/bearer";
import {
  apiError,
  forbiddenScope,
  hasScope,
  json,
  notFoundDoc,
  payloadTooLarge,
  quotaExceeded,
  rateLimit,
} from "@/lib/docs/api";
import { MAX_HTML_BYTES, MAX_TITLE_LEN } from "@/lib/docs/config";
import {
  byteLen,
  findBySlug,
  ownerView,
  rewriteDoc,
  softDelete,
  updateMeta,
} from "@/lib/docs/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

function authFail(req: Request): Response {
  return unauthorized(
    req.headers.get("authorization")
      ? "Invalid, expired, or revoked credential."
      : "Missing Bearer credential."
  );
}

// GET /api/v1/docs/:slug — fetch metadata + html. Owner only (B3); grant-based
// access lands in B5. Scope: docs.read.
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) return authFail(req);
  if (!hasScope(principal, "docs.read")) return forbiddenScope("docs.read");

  const limited = await rateLimit(req, principal, "read");
  if (limited) return limited;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  // No existence oracle: a non-owner gets 404 whether or not the slug exists.
  if (!doc || doc.owner_id !== principal.userId) return notFoundDoc();

  return json(ownerView(doc, true));
}

// PATCH /api/v1/docs/:slug — update html (full rewrite, version bump + snapshot)
// and/or title / public flag (metadata, no bump). Scope: docs.write. Owner only.
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) return authFail(req);
  if (!hasScope(principal, "docs.write")) return forbiddenScope("docs.write");

  const limited = await rateLimit(req, principal, "write");
  if (limited) return limited;

  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    return payloadTooLarge(MAX_HTML_BYTES, contentLength);
  }

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc || doc.owner_id !== principal.userId) return notFoundDoc();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "invalid_request", "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null) {
    return apiError(400, "invalid_request", "Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  const hasHtml = b.html !== undefined;
  const hasTitle = b.title !== undefined;
  const hasPublic = b.public !== undefined;
  if (!hasHtml && !hasTitle && !hasPublic) {
    return apiError(400, "invalid_request", "Provide at least one of: html, title, public.");
  }

  // Validate html (if present).
  if (hasHtml && typeof b.html !== "string") {
    return apiError(400, "invalid_request", "Field 'html' must be a string.");
  }
  if (hasHtml) {
    const htmlBytes = byteLen(b.html as string);
    if (htmlBytes > MAX_HTML_BYTES) return payloadTooLarge(MAX_HTML_BYTES, htmlBytes);
  }

  // Validate title (if present; null clears it).
  let title: string | null | undefined;
  if (hasTitle) {
    if (b.title === null) {
      title = null;
    } else if (typeof b.title !== "string") {
      return apiError(400, "invalid_request", "Field 'title' must be a string or null.");
    } else if ((b.title as string).length > MAX_TITLE_LEN) {
      return apiError(400, "invalid_request", `Field 'title' must be at most ${MAX_TITLE_LEN} characters.`);
    } else {
      title = b.title as string;
    }
  }

  // Validate public (if present).
  let isPublic: boolean | undefined;
  if (hasPublic) {
    if (typeof b.public !== "boolean") {
      return apiError(400, "invalid_request", "Field 'public' must be a boolean.");
    }
    isPublic = b.public as boolean;
  }

  // Apply metadata changes first (no version bump), then the html rewrite (bump +
  // snapshot) so the returned row reflects both.
  let current = doc;
  if (hasTitle || hasPublic) {
    current = await updateMeta({ docId: doc.id, title, isPublic });
  }
  if (hasHtml) {
    const result = await rewriteDoc({
      doc: current,
      html: b.html as string,
      authorUserId: principal.userId,
    });
    if ("quota" in result) {
      return quotaExceeded(result.quota.kind, result.quota.limit, result.quota.current);
    }
    current = result.doc;
  }

  return json(ownerView(current, true));
}

// DELETE /api/v1/docs/:slug — soft-delete. Scope: docs.write. Owner only.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) return authFail(req);
  if (!hasScope(principal, "docs.write")) return forbiddenScope("docs.write");

  const limited = await rateLimit(req, principal, "write");
  if (limited) return limited;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc || doc.owner_id !== principal.userId) return notFoundDoc();

  await softDelete(doc.id);
  return json({ slug: doc.slug, deleted: true });
}
