import {
  apiError,
  json,
  notFoundDoc,
  parseJsonObject,
  parseOptionalBool,
  parseTitle,
  payloadTooLarge,
  quotaExceeded,
  requireApiKey,
} from "@/lib/docs/api";
import { MAX_HTML_BYTES } from "@/lib/docs/config";
import {
  byteLen,
  findBySlug,
  granteeView,
  ownerView,
  rewriteDoc,
  softDelete,
  updateMeta,
} from "@/lib/docs/store";
import { accessRoleLabel, canEdit, canRead, isOwner, resolveAccess } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// GET /api/v1/docs/:slug — fetch metadata + html. Readable by the owner OR any
// grantee (editor/commenter/viewer), per the permissions ladder. Scope: docs.read.
// Non-owners get granteeView (no view_token — that's an owner-only capability).
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "read");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();
  const access = await resolveAccess(doc, principal.email, principal.userId);
  // No existence oracle: anyone without access gets 404, like a missing slug.
  if (!canRead(access)) return notFoundDoc();

  if (access.kind === "owner") return json(ownerView(doc, true));
  return json(granteeView(doc, true, accessRoleLabel(access)));
}

// PATCH /api/v1/docs/:slug — update html (full rewrite, version bump + snapshot)
// and/or title / public flag (metadata, no bump). Scope: docs.write.
//   - html rewrite: owner OR editor grant.
//   - title / public (visibility): OWNER ONLY — editors cannot change visibility
//     (birthday.md "Permissions model": editors "cannot ... change visibility").
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.write", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  // Content-Length 413 precheck runs BEFORE the doc lookup (preserving the
  // original ordering: an oversized body is rejected before any 404). The JSON
  // parse itself happens after the access check below.
  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    return payloadTooLarge(MAX_HTML_BYTES, contentLength);
  }

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();
  const access = await resolveAccess(doc, principal.email, principal.userId);
  // A principal who can't even edit gets 404 (no existence oracle). A non-editor
  // grantee (viewer/commenter) likewise can't write — treated as no edit access.
  if (!canEdit(access)) return notFoundDoc();
  const isOwner = access.kind === "owner";

  const parsed = await parseJsonObject(req);
  if ("response" in parsed) return parsed.response;
  const b = parsed.obj;

  const hasHtml = b.html !== undefined;
  const hasTitle = b.title !== undefined;
  const hasPublic = b.public !== undefined;
  if (!hasHtml && !hasTitle && !hasPublic) {
    return apiError(400, "invalid_request", "Provide at least one of: html, title, public.");
  }

  // Editors may rewrite html but NOT change visibility/metadata. title + public
  // are owner-only (changing visibility is an owner capability). Reject the whole
  // request rather than silently dropping the fields, so the editor's agent knows.
  if (!isOwner && (hasTitle || hasPublic)) {
    return apiError(
      403,
      "owner_only",
      "Editors can update the document's html but cannot change its title or visibility. Only the owner can change those."
    );
  }

  // Validate html (if present).
  if (hasHtml && typeof b.html !== "string") {
    return apiError(400, "invalid_request", "Field 'html' must be a string.");
  }
  if (hasHtml) {
    const htmlBytes = byteLen(b.html as string);
    if (htmlBytes > MAX_HTML_BYTES) return payloadTooLarge(MAX_HTML_BYTES, htmlBytes);
  }

  // Validate title (if present; null clears it). Left undefined when absent so
  // updateMeta only touches provided fields.
  let title: string | null | undefined;
  if (hasTitle) {
    const titleResult = parseTitle(b.title, { allowNull: true });
    if ("response" in titleResult) return titleResult.response;
    title = titleResult.title;
  }

  // Validate public (if present). Left undefined when absent.
  let isPublic: boolean | undefined;
  if (hasPublic) {
    const publicResult = parseOptionalBool(b.public, "public", false);
    if ("response" in publicResult) return publicResult.response;
    isPublic = publicResult.value;
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

  if (isOwner) return json(ownerView(current, true));
  return json(granteeView(current, true, accessRoleLabel(access)));
}

// DELETE /api/v1/docs/:slug — soft-delete. Scope: docs.write. Owner only.
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.write", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc || !isOwner(doc, principal.userId)) return notFoundDoc();

  await softDelete(doc.id);
  return json({ slug: doc.slug, deleted: true });
}
