// Zod schemas for the /api/v1/docs resource — the FIRST resource migrated to
// code-first OpenAPI (Z1). These schemas are BOTH the runtime validators the
// route handlers use (via safeParse) AND the source the OpenAPIRegistry generates
// the spec from. They replace the hand-rolled parsers in lib/docs/api.ts
// (parseTitle / parseOptionalBool / the manual typeof checks).
//
// WIRE-FORMAT PARITY is the contract: every 400 these produce must map to the
// SAME apiError(400, "invalid_request", <message>) the old code emitted. The
// per-field messages below are copied verbatim from lib/docs/api.ts so the bytes
// are identical. The route still owns the byte-size 413 cap, the owner-only 403,
// and the "at least one field" 400 (ordering-sensitive), exactly as before — Zod
// only replaces the type/length checks.
//
// .openapi() metadata (descriptions/examples) is carried over from the
// hand-written spec's docs section so the generated spec is as rich.

import { z, registry } from "@/lib/openapi/registry";
import { MAX_HTML_BYTES, MAX_TITLE_LEN } from "@/lib/docs/config";
import { apiError } from "@/lib/docs/api";
import { GRANT_ROLES, MAX_GRANTS_PER_DOC, type GrantRole } from "@/lib/docs/grants";

// --- error helpers -------------------------------------------------------

/**
 * Map a failed safeParse to the EXISTING apiError(400, "invalid_request", <msg>).
 * `order` is the field precedence the old hand-parsing used (it returned the
 * FIRST failing field in a fixed order, e.g. html before title before public);
 * we pick the highest-priority issue's message so the wire bytes match. Falls
 * back to the first issue when a path isn't listed.
 */
export function zodBadRequest(error: z.ZodError, order: string[] = []): Response {
  const issues = error.issues;
  const rank = (issue: z.core.$ZodIssue): number => {
    const key = String(issue.path[0] ?? "");
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  const chosen = [...issues].sort((a, b) => rank(a) - rank(b))[0];
  return apiError(400, "invalid_request", chosen.message);
}

// --- request bodies ------------------------------------------------------

// Title field. POST: undefined/null → null, else string ≤ cap (message "a
// string"). PATCH: null → null (clears), else string ≤ cap (message "a string or
// null"). Built per-call so the type-error message matches the old parseTitle.
function titleSchema(allowNull: boolean) {
  const expected = allowNull ? "a string or null" : "a string";
  return z
    .string({ error: `Field 'title' must be ${expected}.` })
    .max(MAX_TITLE_LEN, { error: `Field 'title' must be at most ${MAX_TITLE_LEN} characters.` });
}

// Optional boolean field (public). Present-but-not-a-boolean → the old message.
function optionalBoolSchema(field: string) {
  return z.boolean({ error: `Field '${field}' must be a boolean.` });
}

// POST /api/v1/docs body: { html, title?, public? }.
// - html: required string (old: "Field 'html' is required and must be a string.")
//   The 2 MB byte cap is NOT enforced here — the route does the authoritative
//   byte-length 413 check (Zod can't count UTF-8 bytes), matching old ordering.
// - title: optional; undefined/null → null; else string ≤ cap.
// - public: optional; undefined → false; else boolean.
export const CreateDocBody = registry.register(
  "CreateDocBody",
  z
    .object({
      html: z
        .string({ error: "Field 'html' is required and must be a string." })
        .openapi({ description: "The document HTML.", example: "<h1>Hello</h1>" }),
      // .nullish() = optional + nullable; both map to null (old parseTitle behavior).
      title: titleSchema(false)
        .nullish()
        .transform((v) => v ?? null)
        .openapi({ description: "Optional document title.", example: "My doc" }),
      public: optionalBoolSchema("public")
        .optional()
        .transform((v) => v ?? false)
        .openapi({ description: "Whether the document is public.", default: false }),
    })
    .openapi("CreateDocBody", {
      description: "Create a document. html is required; title and public are optional.",
    })
);

// PATCH /api/v1/docs/{slug} body: { html?, title?, public? }. The "at least one
// field" requirement and the owner-only restriction on title/public live in the
// route (ordering-sensitive: the owner-only 403 must precede field validation).
// This schema only type-checks the provided fields.
// - html: if present, must be a string (old: "Field 'html' must be a string.").
// - title: if present, null clears it; else string ≤ cap (allowNull message).
// - public: if present, must be a boolean.
export const UpdateDocBody = registry.register(
  "UpdateDocBody",
  z
    .object({
      html: z
        .string({ error: "Field 'html' must be a string." })
        .optional()
        .openapi({ description: "Replacement HTML (full rewrite, bumps version).", example: "<h1>Hi</h1>" }),
      title: titleSchema(true)
        .nullable()
        .optional()
        .openapi({ description: "New title, or null to clear it." }),
      public: optionalBoolSchema("public")
        .optional()
        .openapi({ description: "New visibility flag (owner only)." }),
    })
    .openapi("UpdateDocBody", {
      description:
        "Update html (full rewrite), title, or visibility. At least one field is required. Editors may rewrite html; only the owner may change title or public.",
    })
);

// --- response views ------------------------------------------------------

const slug = z.string().openapi({ example: "fierce-tiger-12345" });
const url = z.string().openapi({ format: "uri", example: "https://justhtml.sh/d/fierce-tiger-12345" });
const dateTime = z.string().openapi({ format: "date-time" });

// Owner's view of a doc (POST 201, and GET/PATCH for the owner). Includes
// view_token; html is present on single-doc fetches and after writes (omitted on
// create-with-includeHtml=false → optional here). Mirrors the spec's OwnerDoc.
export const OwnerDoc = registry.register(
  "OwnerDoc",
  z
    .object({
      slug,
      url,
      title: z.string().nullable(),
      version: z.number().int(),
      public: z.boolean(),
      view_token: z.string(),
      created_at: dateTime,
      updated_at: dateTime,
      html: z.string().optional(),
    })
    .openapi("OwnerDoc", { description: "Document as seen by its owner (includes view_token)." })
);

// Grantee's view (GET/PATCH for a non-owner): like OwnerDoc but with role instead
// of view_token. The spec collapses both into DocWithHtml (a union of the owner
// and grantee shapes); we register that combined shape too for the diff.
export const GranteeDoc = registry.register(
  "GranteeDoc",
  z
    .object({
      slug,
      url,
      title: z.string().nullable(),
      version: z.number().int(),
      public: z.boolean(),
      role: z.enum(["editor", "commenter", "viewer"]),
      created_at: dateTime,
      updated_at: dateTime,
      html: z.string().optional(),
    })
    .openapi("GranteeDoc", {
      description: "Document as seen by a non-owner grantee (role instead of view_token).",
    })
);

// DocWithHtml — the spec's combined owner|grantee response for GET/PATCH. Owner
// sees view_token; a grantee sees role. Optional on both so one schema covers
// both callers (matches the hand-written spec, which lists every property as
// optional and uses neither `required`).
export const DocWithHtml = registry.register(
  "DocWithHtml",
  z
    .object({
      slug,
      url,
      title: z.string().nullable(),
      version: z.number().int(),
      public: z.boolean(),
      view_token: z.string().optional(),
      role: z.enum(["editor", "commenter", "viewer"]).optional(),
      created_at: dateTime,
      updated_at: dateTime,
      html: z.string().optional(),
    })
    .openapi("DocWithHtml", {
      description:
        "Owner sees view_token; a grantee sees role (editor/commenter/viewer) instead. html is included on single-doc fetches and after writes.",
    })
);

// List item (GET /api/v1/docs, any scope). Carries access; owned items
// additionally carry view_token; every item carries comment_count. Mirrors the
// spec's DocListItem (required fields + descriptions carried over).
export const DocListItem = registry.register(
  "DocListItem",
  z
    .object({
      slug,
      url,
      title: z.string().nullable(),
      access: z.enum(["owner", "editor", "commenter", "viewer"]).openapi({
        description:
          "The caller's access to this doc. owner for docs you own; otherwise the resolved grant role (an explicit email grant beats a domain grant for the same email).",
      }),
      version: z.number().int(),
      public: z.boolean(),
      comment_count: z.number().int().openapi({
        description:
          "Live (non-deleted) comments + replies on the doc. 0 when there are none. The /docs dashboard surfaces the same count.",
      }),
      view_token: z.string().optional().openapi({ description: "Present only when access=owner." }),
      created_at: dateTime,
      updated_at: dateTime,
    })
    .openapi("DocListItem", {
      description:
        "A document as returned by GET /api/v1/docs (any scope). Carries access (owner|editor|commenter|viewer). Owned items (access=owner) additionally carry view_token; shared items omit it.",
    })
);

// GET /api/v1/docs response envelope: { docs: DocListItem[] }.
export const DocListResponse = registry.register(
  "DocListResponse",
  z
    .object({ docs: z.array(DocListItem) })
    .openapi("DocListResponse", { description: "The matched documents." })
);

// DELETE /api/v1/docs/{slug} response: { slug, deleted }.
export const DeleteDocResponse = registry.register(
  "DeleteDocResponse",
  z
    .object({ slug: z.string(), deleted: z.boolean() })
    .openapi("DeleteDocResponse", { description: "Soft-delete acknowledgement." })
);

// Shared error envelope, exactly as apiError emits: { error, message, ...extra }.
// .passthrough() captures the structured extras (limit_bytes, current_version,
// edit_index, …) that specific errors add on top of {error, message}.
export const ApiError = registry.register(
  "ApiError",
  z
    .looseObject({ error: z.string(), message: z.string() })
    .openapi("ApiError", { description: "Structured API error: { error, message, ...extra }." })
);

// =========================================================================
// Z2 — docs sub-resources: grants, versions, rotate-token, edits.
// Same contract as Z1: every 400 maps to the SAME apiError(400,
// "invalid_request", <message>) the old hand-rolled checks emitted (messages
// copied verbatim). Business-logic outcomes stay in the route, NOT the schema:
//   - grants: the exactly-one-of-email/domain 400, the email/domain FORMAT 400s
//     (isValidEmail/isValidDomain), and the consumer-domain 422 are kept in the
//     route (they were never plain type checks). The schema only type-checks
//     role (enum), notify (bool), and email/domain (string-if-present).
//   - edits: the array/min/max/item-shape/base_version checks ARE schema-shaped
//     and move to Zod. The 409 stale + 422 ambiguous/no-match/overlap come from
//     the edit engine (applyPatch / EditApplyError) and stay in the route.
// =========================================================================

// --- grants --------------------------------------------------------------

// role: required, one of editor|commenter|viewer. The old check emitted ONE
// message for both "missing/non-string" and "not in the enum", so we map any
// role issue to that single message via a custom error.
const roleSchema = z.enum(["editor", "commenter", "viewer"] as [GrantRole, ...GrantRole[]], {
  error: `Field 'role' is required and must be one of: ${GRANT_ROLES.join(", ")}.`,
});

// POST /api/v1/docs/{slug}/grants body: { email?, domain?, role, notify? }.
// The schema validates the FIELD-LEVEL types only:
//   - role: required enum (single unified message, matching the old check).
//   - notify: optional boolean (present-but-not-bool → old parseOptionalBool msg).
//   - email / domain: if present (and non-null), must be a string (old per-field
//     "must be a string" messages). The exactly-one rule, the trim/normalize, the
//     email/domain FORMAT validation, and the consumer-domain 422 all stay in the
//     route — they run AFTER these type checks and are not plain type checks.
// .openapi() carries the hand-written spec's grants POST body description.
export const GrantBody = registry.register(
  "GrantBody",
  z
    .object({
      email: z
        .string({ error: "Field 'email' must be a string." })
        .openapi({ format: "email", description: "Grantee email (provide exactly one of email or domain)." }),
      domain: z
        .string({ error: "Field 'domain' must be a string." })
        .openapi({ example: "kernel.sh", description: "Grantee email-domain (provide exactly one of email or domain)." }),
      role: roleSchema.openapi({ description: "Grant role." }),
      notify: z
        .boolean({ error: "Field 'notify' must be a boolean." })
        .openapi({
          default: true,
          description:
            "Email-grants only. Send the grantee a share-notification email (default true). Ignored for domain grants.",
        }),
    })
    // email & domain are optional+nullable at the type layer (the exactly-one
    // rule lives in the route); notify is optional. .partial() makes email,
    // domain, notify optional while role stays required.
    .partial({ email: true, domain: true, notify: true })
    .openapi("GrantBody", {
      description:
        "Share with an email or a domain. Provide exactly one of email or domain. role is editor, commenter, or viewer. notify (email grants only) defaults to true.",
    })
);

// Grant — a single grant row (matches lib/docs/grants.ts grantView + the
// hand-written Grant schema).
export const Grant = registry.register(
  "Grant",
  z
    .object({
      id: z.number().int(),
      grantee_type: z.enum(["email", "domain"]),
      grantee: z.string(),
      role: z.enum(["editor", "commenter", "viewer"]),
      created_at: dateTime,
    })
    .openapi("Grant", { description: "A single grant (email or domain) on a document." })
);

// GET /api/v1/docs/{slug}/grants response: { slug, grants[], count, max }.
export const GrantListResponse = registry.register(
  "GrantListResponse",
  z
    .object({
      slug: z.string(),
      grants: z.array(Grant),
      count: z.number().int(),
      max: z.number().int().openapi({ example: MAX_GRANTS_PER_DOC }),
    })
    .openapi("GrantListResponse", { description: "Grants on the document (owner only)." })
);

// POST /api/v1/docs/{slug}/grants 201: { slug, grant, notified? }.
export const GrantCreatedResponse = registry.register(
  "GrantCreatedResponse",
  z
    .object({
      slug: z.string(),
      grant: Grant,
      notified: z.boolean().optional().openapi({
        description:
          "Present only for email grants: true if the share-notification email was sent, false if suppressed (notify:false) or skipped (rate-limited / send failed).",
      }),
    })
    .openapi("GrantCreatedResponse", { description: "Grant created." })
);

// POST /api/v1/docs/{slug}/grants 200: { slug, grant, unchanged }.
export const GrantUnchangedResponse = registry.register(
  "GrantUnchangedResponse",
  z
    .object({
      slug: z.string(),
      grant: Grant,
      unchanged: z.boolean(),
    })
    .openapi("GrantUnchangedResponse", { description: "Idempotent re-grant (same target + role)." })
);

// DELETE /api/v1/docs/{slug}/grants/{id} 200: { slug, grant_id, deleted }.
export const GrantDeletedResponse = registry.register(
  "GrantDeletedResponse",
  z
    .object({
      slug: z.string(),
      grant_id: z.number().int(),
      deleted: z.boolean(),
    })
    .openapi("GrantDeletedResponse", { description: "Grant revoked." })
);

// --- versions ------------------------------------------------------------

// VersionMeta — one retained version's metadata (matches store.versionView with
// includeHtml=false). patch present only when edit_kind=patch.
export const VersionMeta = registry.register(
  "VersionMeta",
  z
    .object({
      version: z.number().int(),
      edit_kind: z.enum(["create", "patch", "rewrite"]),
      author_user_id: z.number().int().nullable().openapi({
        description: "User who authored this version (null for legacy/system writes).",
      }),
      patch: z
        .array(z.object({ oldText: z.string(), newText: z.string() }))
        .optional()
        .openapi({
          description:
            "The edits payload as requested, present only when edit_kind=patch (the list of {oldText,newText} applied). Omitted otherwise.",
        }),
      bytes: z.number().int(),
      created_at: dateTime,
    })
    .openapi("VersionMeta", { description: "Metadata for one retained version (no html)." })
);

// GET /api/v1/docs/{slug}/versions 200: { slug, current_version, versions[] }.
export const VersionListResponse = registry.register(
  "VersionListResponse",
  z
    .object({
      slug: z.string(),
      current_version: z.number().int(),
      versions: z.array(VersionMeta),
    })
    .openapi("VersionListResponse", { description: "Version metadata (no html), newest first." })
);

// GET /api/v1/docs/{slug}/versions/{n} 200: VersionMeta + { slug, html }.
// store returns { slug, ...versionView(v, true) } so the snapshot carries every
// VersionMeta field plus slug + html.
export const VersionSnapshot = registry.register(
  "VersionSnapshot",
  z
    .object({
      slug: z.string(),
      version: z.number().int(),
      edit_kind: z.enum(["create", "patch", "rewrite"]),
      author_user_id: z.number().int().nullable(),
      patch: z.array(z.object({ oldText: z.string(), newText: z.string() })).optional(),
      bytes: z.number().int(),
      created_at: dateTime,
      html: z.string(),
    })
    .openapi("VersionSnapshot", { description: "A version's metadata plus its full html snapshot." })
);

// --- edits ---------------------------------------------------------------

// MAX_EDITS_PER_REQUEST mirrors the route's bound. Kept in sync via the explicit
// constant export so the schema and the route agree.
export const MAX_EDITS_PER_REQUEST = 200;

// POST /api/v1/docs/{slug}/edits body: { edits: [{oldText, newText}], base_version? }.
// Every per-field message is copied verbatim from the route's hand-rolled checks
// so the wire bytes are identical. The PER-INDEX item messages (edits[i].oldText
// …) are reproduced by the route's editsBadRequest mapper using the issue path.
export const EditsBody = registry.register(
  "EditsBody",
  z
    .object({
      edits: z
        .array(
          z.object({
            oldText: z.string(),
            newText: z.string(),
          }),
          { error: "Field 'edits' is required and must be an array." }
        )
        .min(1, { error: "Field 'edits' must contain at least one edit." })
        .max(MAX_EDITS_PER_REQUEST, {
          error: `Field 'edits' must contain at most ${MAX_EDITS_PER_REQUEST} edits.`,
        })
        .openapi({ description: "The patches to apply, in order. 1–200 edits." }),
      // The old route treated BOTH undefined and null as "not provided"
      // (`!== undefined && !== null`), then required a positive integer. .nullish()
      // = optional + nullable; the transform collapses null → undefined so the
      // route sees `undefined` (absent) exactly as before. A present non-positive
      // -integer fails with the unified message below.
      base_version: z
        .number({ error: "Field 'base_version' must be a positive integer." })
        .int({ error: "Field 'base_version' must be a positive integer." })
        .min(1, { error: "Field 'base_version' must be a positive integer." })
        .nullish()
        .transform((v) => v ?? undefined)
        .openapi({ description: "The version the edits were derived against; a mismatch returns 409." }),
    })
    .openapi("EditsBody", {
      description:
        "Apply deterministic patches. edits is a non-empty list of {oldText,newText}. Always send base_version; a mismatch returns 409.",
    })
);

/**
 * Map a failed EditsBody safeParse to the EXACT apiError(400, "invalid_request",
 * <message>) the hand-rolled /edits route emitted, preserving its precedence:
 *   1. edits-array issues (not-array / empty / too-many) — top-level path "edits".
 *   2. per-INDEX item issues, in ascending index order, oldText before newText:
 *        edits[i] must be an object.
 *        edits[i].oldText is required and must be a string.
 *        edits[i].newText is required and must be a string.
 *   3. base_version — "Field 'base_version' must be a positive integer."
 * The per-index messages are rebuilt from the issue path here (Zod's default
 * item messages don't carry the index), so the wire bytes match byte-for-byte.
 */
export function editsBadRequest(error: z.ZodError): Response {
  const issues = error.issues;

  // 1. Top-level edits issues (path === ["edits"]) — array type / min / max. The
  // .array() custom error, .min(1), and .max() messages already match verbatim.
  const topEdits = issues.find((i) => i.path.length === 1 && i.path[0] === "edits");
  if (topEdits) return apiError(400, "invalid_request", topEdits.message);

  // 2. Per-index item issues. Path shape: ["edits", <index>, ("oldText"|"newText")?].
  //    Pick the lowest index; within an index, an object-type failure (path stops
  //    at the index) precedes a missing/typed oldText, which precedes newText.
  const itemIssues = issues.filter((i) => i.path[0] === "edits" && typeof i.path[1] === "number");
  if (itemIssues.length) {
    const fieldRank = (field: unknown): number =>
      field === undefined ? 0 : field === "oldText" ? 1 : 2;
    const sorted = [...itemIssues].sort((a, b) => {
      const ai = a.path[1] as number;
      const bi = b.path[1] as number;
      if (ai !== bi) return ai - bi;
      return fieldRank(a.path[2]) - fieldRank(b.path[2]);
    });
    const chosen = sorted[0];
    const i = chosen.path[1] as number;
    const field = chosen.path[2];
    const msg =
      field === "oldText"
        ? `edits[${i}].oldText is required and must be a string.`
        : field === "newText"
          ? `edits[${i}].newText is required and must be a string.`
          : `edits[${i}] must be an object.`;
    return apiError(400, "invalid_request", msg);
  }

  // 3. base_version (or any remaining issue) — its schema message already matches.
  const bv = issues.find((i) => i.path[0] === "base_version");
  return apiError(400, "invalid_request", (bv ?? issues[0]).message);
}
