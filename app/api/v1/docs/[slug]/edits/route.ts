import {
  apiError,
  json,
  notFoundDoc,
  parseJsonObject,
  payloadTooLarge,
  quotaExceeded,
  requireApiKey,
  staleVersion,
  unprocessableEdit,
} from "@/lib/docs/api";
import { MAX_HTML_BYTES } from "@/lib/docs/config";
import { applyPatch, findBySlug, granteeView, ownerView } from "@/lib/docs/store";
import { EditApplyError, type Edit } from "@/lib/docs/edit-diff";
import { accessRoleLabel, canEdit, resolveAccess } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// Bound the edits array so a single request can't carry an absurd number of
// patches. Generous; the real protection is the per-doc size cap + rate limits.
const MAX_EDITS_PER_REQUEST = 200;

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

  // Validate edits.
  if (!Array.isArray(b.edits)) {
    return apiError(400, "invalid_request", "Field 'edits' is required and must be an array.");
  }
  if (b.edits.length === 0) {
    return apiError(400, "invalid_request", "Field 'edits' must contain at least one edit.");
  }
  if (b.edits.length > MAX_EDITS_PER_REQUEST) {
    return apiError(
      400,
      "invalid_request",
      `Field 'edits' must contain at most ${MAX_EDITS_PER_REQUEST} edits.`
    );
  }
  const edits: Edit[] = [];
  for (let i = 0; i < b.edits.length; i++) {
    const e = b.edits[i];
    if (typeof e !== "object" || e === null) {
      return apiError(400, "invalid_request", `edits[${i}] must be an object.`);
    }
    const ee = e as Record<string, unknown>;
    if (typeof ee.oldText !== "string") {
      return apiError(400, "invalid_request", `edits[${i}].oldText is required and must be a string.`);
    }
    if (typeof ee.newText !== "string") {
      return apiError(400, "invalid_request", `edits[${i}].newText is required and must be a string.`);
    }
    edits.push({ oldText: ee.oldText, newText: ee.newText });
  }

  // Validate base_version (optional — but agents should always send it).
  let baseVersion: number | undefined;
  if (b.base_version !== undefined && b.base_version !== null) {
    if (typeof b.base_version !== "number" || !Number.isInteger(b.base_version) || b.base_version < 1) {
      return apiError(400, "invalid_request", "Field 'base_version' must be a positive integer.");
    }
    baseVersion = b.base_version;
  }

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
