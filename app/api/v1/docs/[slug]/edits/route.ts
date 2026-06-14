import {
  json,
  notFoundDoc,
  parseJsonObject,
  payloadTooLarge,
  quotaExceeded,
  requireApiKey,
  staleVersion,
  unprocessableEdit,
} from "@/lib/docs/api";
import { EditsBody, editsBadRequest } from "@/lib/docs/schemas";
import { MAX_HTML_BYTES } from "@/lib/docs/config";
import { applyPatch, findBySlug, granteeView, ownerView } from "@/lib/docs/store";
import { EditApplyError, type Edit } from "@/lib/docs/edit-diff";
import { accessRoleLabel, canEdit, resolveAccess } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// POST /api/v1/docs/:slug/edits — apply deterministic patches (birthday.md
// "Editing"). Body: { edits: [{ oldText, newText }, ...], base_version? }.
// Scope: docs.write. Owner OR editor grant (birthday.md "Permissions model").
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.write", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  // Size cap by Content-Length before parse (the produced html is re-checked
  // under the write lock inside applyPatch). This precheck runs before the doc
  // lookup, matching the original ordering; the JSON parse itself runs after the
  // access check below.
  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    return payloadTooLarge(MAX_HTML_BYTES, contentLength);
  }

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  if (!doc) return notFoundDoc();
  const access = await resolveAccess(doc, principal.email, principal.userId);
  // No existence oracle: a principal without edit access (no grant, or a
  // viewer/commenter grant) gets 404 whether or not the slug exists.
  if (!canEdit(access)) return notFoundDoc();

  const parsed = await parseJsonObject(req);
  if ("response" in parsed) return parsed.response;
  const b = parsed.obj;

  // Validate the edits payload via Zod (array shape, 1–200 items, {oldText,
  // newText} strings, optional positive-integer base_version). editsBadRequest
  // reproduces the old hand-rolled per-index / array messages byte-for-byte and
  // their precedence. The 409 stale + 422 ambiguous/no-match/overlap outcomes are
  // produced by the edit engine below (applyPatch / EditApplyError), not here.
  const v = EditsBody.safeParse(b);
  if (!v.success) return editsBadRequest(v.error);
  const edits: Edit[] = v.data.edits.map((e) => ({ oldText: e.oldText, newText: e.newText }));
  const baseVersion: number | undefined = v.data.base_version;

  let result;
  try {
    result = await applyPatch({
      doc,
      edits,
      baseVersion,
      authorUserId: principal.userId,
    });
  } catch (e) {
    if (e instanceof EditApplyError) {
      const extra: Record<string, unknown> = {};
      if (e.otherEditIndex !== undefined) extra.other_edit_index = e.otherEditIndex;
      if (e.occurrences !== undefined) extra.occurrences = e.occurrences;
      return unprocessableEdit(e.reason, e.editIndex, e.message, extra);
    }
    throw e;
  }

  if ("stale" in result) return staleVersion(result.stale.currentVersion);
  if ("tooLarge" in result) return payloadTooLarge(MAX_HTML_BYTES, result.tooLarge.gotBytes);
  if ("quota" in result) {
    return quotaExceeded(result.quota.kind, result.quota.limit, result.quota.current);
  }

  if (access.kind === "owner") return json(ownerView(result.doc, true));
  return json(granteeView(result.doc, true, accessRoleLabel(access)));
}
