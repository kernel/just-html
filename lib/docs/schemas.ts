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
import { MAX_TITLE_LEN } from "@/lib/docs/config";
import { apiError } from "@/lib/docs/api";
import { GRANT_ROLES, MAX_GRANTS_PER_DOC, type GrantRole } from "@/lib/docs/grants";
import { MAX_COMMENT_BODY_BYTES } from "@/lib/docs/comments";
import { ALLOWED_EMOJI } from "@/lib/docs/reactions";

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
      // email & domain are NULLISH (optional + nullable), collapsing null →
      // undefined. The old route only type-checked the field for the CHOSEN
      // branch and treated `null` as absent in its exactly-one computation
      // (`b.x !== undefined && b.x !== null`), so an explicit `null` on the
      // UNUSED field (e.g. {email:null, domain:"kernel.sh", role}) was never
      // type-checked and the grant succeeded. If email/domain were plain
      // strings here, that explicit null would fail the string check and 400
      // — an accept→reject drift. .nullish()+transform restores the old
      // accept-null-as-absent behavior: a null field becomes undefined, so the
      // route's exactly-one check (still `!== null`) and the per-branch usage
      // see it as absent exactly as before. A present non-null non-string
      // still fails with the old per-field "must be a string" message.
      email: z
        .string({ error: "Field 'email' must be a string." })
        .nullish()
        .transform((v) => v ?? undefined)
        .openapi({ format: "email", description: "Grantee email (provide exactly one of email or domain)." }),
      domain: z
        .string({ error: "Field 'domain' must be a string." })
        .nullish()
        .transform((v) => v ?? undefined)
        .openapi({ example: "kernel.sh", description: "Grantee email-domain (provide exactly one of email or domain)." }),
      role: roleSchema.openapi({ description: "Grant role." }),
      notify: z
        .boolean({ error: "Field 'notify' must be a boolean." })
        .optional()
        .openapi({
          default: true,
          description:
            "Email-grants only. Send the grantee a share-notification email (default true). Ignored for domain grants.",
        }),
    })
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

// =========================================================================
// Z3 — comments + reactions. Same contract as Z1/Z2: every 400 maps to the
// SAME apiError(400, "invalid_request", <message>) the hand-rolled checks
// emitted (messages copied verbatim from the routes + lib/docs/anchor.ts).
//
// What stays in the route (NOT plain type checks; ordering-sensitive and so
// kept exactly as-is — the schema documents them but does not own them):
//   - the comment-body 413 BYTE cap (Zod can't count UTF-8 bytes; the route
//     does the authoritative Buffer.byteLength check, exactly like html).
//   - the anchor's parse+NORMALIZE (parseAnchor slices prefix/suffix to 64
//     chars, floors offsets, stamps type:"text", and emits ordered per-field
//     messages). Those transforms + messages are load-bearing, so anchor
//     validation stays parseAnchor; the TextAnchor schema below is the spec
//     shape only (reused by comments AND reactions — the same W3C shape, ONE
//     definition).
//   - the reply-cannot-anchor 400 (cross-field: parent_id ⊕ anchor).
//   - reactions' comment_id⊕anchor mutual-exclusion 400 and the parseAnchor
//     branch: ordering is emoji → comment_id → exclusion → anchor, and the
//     exclusion message is specific, so it stays in the route.
//
// What MOVES to Zod (reproduces the exact 400 the route emits):
//   - comment body: required non-empty string (CreateCommentBody).
//   - parent_id / comment_id: optional positive-integer-or-null.
//   - the resolved flag + the "at least one of body/resolved" rule.
//   - the emoji ALLOWLIST: a z.enum over ALLOWED_EMOJI generates into the
//     spec; emojiBadRequest maps ANY emoji issue (missing/non-string/out-of-
//     set — the old check 400'd all three identically) to the exact
//     apiError(400, …, { allowed: [...ALLOWED_EMOJI] }) so allowed[] is
//     preserved byte-for-byte.
// =========================================================================

// --- the W3C text-quote anchor (ONE definition, reused by comments + reactions)

// TextAnchor — the W3C text-quote selector {type?, exact, prefix?, suffix?,
// start?, end?}. exact is required; prefix/suffix (~32–64 chars) disambiguate
// repeats; start/end are non-authoritative text-content offset hints. This is
// the SPEC shape (mirrors the hand-written TextAnchor + parseAnchor's accepted
// fields); the route runs parseAnchor for the authoritative parse+normalize.
export const TextAnchor = registry.register(
  "TextAnchor",
  z
    .object({
      type: z.enum(["text"]).optional(),
      exact: z.string().openapi({ example: "deterministic compaction" }),
      prefix: z.string().optional().openapi({ example: "record store with " }),
      suffix: z.string().optional().openapi({ example: "." }),
      start: z.number().int().optional(),
      end: z.number().int().optional(),
    })
    .openapi("TextAnchor", {
      description:
        "W3C text-quote selector (TextQuoteSelector + position hint). exact is the verbatim quoted passage; prefix/suffix (~32 chars) disambiguate repeated text and survive surrounding shifts; start/end are offsets into the document's text content (a fast-path hint, not authoritative).",
    })
);

// --- POST /comments body -------------------------------------------------

// CreateCommentBody: { body, anchor?, parent_id? }.
//   - body: required non-empty string. The route checks `typeof !== "string"
//     || trim().length === 0` → ONE message for both, so any body issue maps to
//     that single message (the byte-cap 413 stays in the route).
//   - parent_id: optional; null/absent → absent; else positive integer (the
//     route's `!== undefined && !== null` then Number.isInteger && >= 1).
//   - anchor: optional W3C shape (parsed/normalized by parseAnchor in the route;
//     the reply-cannot-anchor 400 is a cross-field route check).
export const CreateCommentBody = registry.register(
  "CreateCommentBody",
  z
    .object({
      // The route stores the ORIGINAL (untrimmed) body, so we validate
      // non-emptiness on the trimmed value WITHOUT transforming: a custom error
      // on a refine that mirrors `typeof !== "string" || trim().length === 0`.
      body: z
        .string({ error: "Field 'body' is required and must be a non-empty string." })
        .refine((s) => s.trim().length > 0, {
          error: "Field 'body' is required and must be a non-empty string.",
        })
        .openapi({ description: "Comment text (<= 10 KB).", example: "is this right?" }),
      // anchor stays PERMISSIVE at runtime: parseAnchor (lib/docs/anchor.ts) is
      // the authoritative parse+normalize (slices prefix/suffix to 64, floors
      // offsets, requires non-empty exact ≤ 8000, emits its own ordered
      // messages). The Zod TextAnchor shape is the SPEC representation only; the
      // route runs parseAnchor, so the schema must not second-guess it here.
      anchor: z
        .unknown()
        .optional()
        .openapi({ description: "W3C text-quote selector; null/omitted = doc-level." }),
      // parent_id stays PERMISSIVE at runtime: the route coerces it with
      // Number() (so "5" / [5] / true are accepted exactly as today) and then
      // checks Number.isInteger && >= 1 with the verbatim message. Reproducing
      // Number()'s coercion in Zod would drift (z.number() rejects "5"), so the
      // route keeps ownership; the schema documents it as an integer for the
      // spec via the .openapi type override on a permissive base.
      parent_id: z
        .unknown()
        .optional()
        .openapi({ type: "integer", description: "Root comment id to reply to (1-level threads only)." }),
    })
    .openapi("CreateCommentBody", {
      description:
        "Comment on a span by QUOTING it (anchor), at the doc level (omit anchor), or reply to a root comment (parent_id).",
    })
);

// --- PATCH /comments/{id} body -------------------------------------------

// UpdateCommentBody: { body?, resolved? }. At least one is required (the route's
// "Provide 'body' (edit) and/or 'resolved'…" 400 stays in the route — it is
// ordering-sensitive: it runs before the author/cap checks). body (author only)
// is a non-empty string ≤ cap (byte cap in route); resolved is a boolean.
export const UpdateCommentBody = registry.register(
  "UpdateCommentBody",
  z
    .object({
      body: z
        .string()
        .optional()
        .openapi({ description: "Author only. The new comment text (<= 10 KB)." }),
      resolved: z
        .boolean()
        .optional()
        .openapi({ description: "Resolve/unresolve. Anyone who can comment." }),
    })
    .openapi("UpdateCommentBody", {
      description:
        "Edit body (author) and/or resolve/unresolve (anyone who can comment). At least one field is required.",
    })
);

// Leaf field validators for PATCH /comments/{id}. The route validates body and
// resolved INDIVIDUALLY (not as one safeParse) because the author 403 sits
// between the "at least one field" 400 and the body type check — that ordering
// must be preserved. Messages are verbatim from the old hand-rolled checks.
//   - body: typeof !== "string" || trim empty → "Field 'body' must be a
//     non-empty string." (validated, not transformed: the route stores the
//     original untrimmed body via editCommentBody).
//   - resolved: typeof !== "boolean" → "Field 'resolved' must be a boolean."
export const PatchCommentBodyField = z
  .string({ error: "Field 'body' must be a non-empty string." })
  .refine((s) => s.trim().length > 0, { error: "Field 'body' must be a non-empty string." });

export const PatchResolvedField = z.boolean({ error: "Field 'resolved' must be a boolean." });

// --- POST /reactions body ------------------------------------------------

// The curated emoji allowlist as a z.enum so it generates into the spec. The
// tuple cast satisfies z.enum's non-empty requirement; ALLOWED_EMOJI is the SET
// source of truth (one place), iterated here for the enum + the allowed[] extra.
const EMOJI_VALUES = [...ALLOWED_EMOJI] as [string, ...string[]];

export const CreateReactionBody = registry.register(
  "CreateReactionBody",
  z
    .object({
      emoji: z.enum(EMOJI_VALUES).openapi({
        description: `One of the curated set: ${EMOJI_VALUES.join(" ")}. Anything else → 400 invalid_request with an "allowed" array listing the full set.`,
        example: "🚀",
      }),
      // comment_id stays PERMISSIVE at runtime for the same reason as
      // parent_id above: the route coerces with Number() ("5"/[5]/true accepted)
      // and checks Number.isInteger && >= 1 with the verbatim message. Documented
      // as integer for the spec via the .openapi type override.
      comment_id: z
        .unknown()
        .optional()
        .openapi({
          type: "integer",
          description: "Target comment; omit/null = not a comment reaction. Mutually exclusive with anchor.",
        }),
      // anchor stays PERMISSIVE at runtime (parseAnchor owns it, exactly as in
      // comments). The mutual-exclusion 400 (comment_id ⊕ anchor) also stays in
      // the route — it is ordering-sensitive (emoji → comment_id → exclusion →
      // anchor). The Zod shape is the spec representation only.
      anchor: z
        .unknown()
        .optional()
        .openapi({
          description:
            "Target span (W3C text-quote selector). Mutually exclusive with comment_id; omit/null = react on the doc (or comment).",
        }),
    })
    .openapi("CreateReactionBody", {
      description:
        "Add an emoji reaction. The target is 3-way and mutually exclusive: comment_id (a comment), anchor (a span), or neither (the whole doc). Supplying both comment_id and anchor → 400.",
    })
);

/**
 * Map a failed CreateCommentBody safeParse to the EXACT apiError(400,
 * "invalid_request", <message>) the POST /comments route emitted. At runtime only
 * `body` is strictly validated (anchor/parent_id are route-owned and permissive
 * here), and a body failure (missing/non-string/empty-after-trim) carries the one
 * verbatim message, so we surface the first issue's message directly.
 */
export function commentBodyBadRequest(error: z.ZodError): Response {
  return apiError(400, "invalid_request", error.issues[0].message);
}

/**
 * Map a failed CreateReactionBody emoji check to the EXACT 400 the route emits:
 * apiError(400, "invalid_request", "Field 'emoji' must be one of the supported
 * emoji.", { allowed: [...ALLOWED_EMOJI] }). The old route 400'd both a
 * non-string emoji AND an out-of-set emoji with this same body, which a z.enum
 * issue (path === ["emoji"]) covers identically.
 */
export function emojiBadRequest(): Response {
  return apiError(400, "invalid_request", "Field 'emoji' must be one of the supported emoji.", {
    allowed: [...ALLOWED_EMOJI],
  });
}

// --- response views ------------------------------------------------------

// ReactionGroup — reactions collapsed by emoji with attributed authors.
export const ReactionGroup = registry.register(
  "ReactionGroup",
  z
    .object({
      emoji: z.string(),
      count: z.number().int(),
      authors: z.array(z.string().openapi({ description: "Author email." })),
    })
    .openapi("ReactionGroup", { description: "Reactions collapsed by emoji, with the attributed authors." })
);

// AnchoredReactionGroup — all reactions on one span, grouped by anchor signature.
export const AnchoredReactionGroup = registry.register(
  "AnchoredReactionGroup",
  z
    .object({
      sig: z.string().openapi({ description: "Anchor signature (prefix|exact|suffix) — the grouping key." }),
      anchor: TextAnchor,
      anchored_version: z.number().int().nullable(),
      reactions: z.array(ReactionGroup),
    })
    .openapi("AnchoredReactionGroup", {
      description:
        "All reactions on one text span, grouped by anchor signature, then collapsed per emoji. The viewer paints one highlight on the span and a chip per emoji at the span's end.",
    })
);

// Comment — one comment's JSON view (matches commentView in comments/views.ts).
export const Comment = registry.register(
  "Comment",
  z
    .object({
      id: z.number().int(),
      parent_id: z.number().int().nullable(),
      author: z.string().nullable().openapi({ description: "Author email." }),
      author_avatar: z.string().nullable().openapi({ format: "uri", description: "Gravatar URL." }),
      body: z.string(),
      anchor: TextAnchor.nullable(),
      anchored_version: z.number().int().nullable(),
      orphaned: z.boolean().openapi({ description: "Anchor no longer resolves; kept, shown unanchored." }),
      resolved: z.boolean(),
      resolved_at: z.string().nullable().openapi({ format: "date-time" }),
      created_at: dateTime,
      edited_at: z.string().nullable().openapi({ format: "date-time" }),
      reactions: z.array(ReactionGroup),
    })
    .openapi("Comment", { description: "A single comment (with its aggregated reactions)." })
);

// CommentThread — a root comment plus its group tag and 1-level replies (matches
// threadView). The hand-written spec models this as allOf(Comment, {group,
// replies}); we register the merged object so the generated success-response
// property-set equals the hand-written one (group + replies + every Comment field).
export const CommentThread = registry.register(
  "CommentThread",
  z
    .object({
      id: z.number().int(),
      parent_id: z.number().int().nullable(),
      author: z.string().nullable(),
      author_avatar: z.string().nullable(),
      body: z.string(),
      anchor: TextAnchor.nullable(),
      anchored_version: z.number().int().nullable(),
      orphaned: z.boolean(),
      resolved: z.boolean(),
      resolved_at: z.string().nullable(),
      created_at: dateTime,
      edited_at: z.string().nullable(),
      reactions: z.array(ReactionGroup),
      group: z
        .enum(["anchored", "doc", "orphaned"])
        .openapi({ description: "Which group this thread sorts into in the all-threads view." }),
      replies: z.array(Comment),
    })
    .openapi("CommentThread", { description: "A root comment with its group tag and 1-level replies." })
);

// GET /api/v1/docs/{slug}/comments 200 — the complete all-threads view.
// doc_reactions / anchored_reactions are present only when any exist (the route
// spreads allThreads()'s optional keys), so they are optional here.
export const CommentsListResponse = registry.register(
  "CommentsListResponse",
  z
    .object({
      slug: z.string(),
      version: z.number().int(),
      total: z.number().int().openapi({ description: "Live comment + reply count." }),
      can_comment: z.boolean(),
      can_react: z.boolean(),
      threads: z.array(CommentThread),
      doc_reactions: z
        .array(ReactionGroup)
        .optional()
        .openapi({
          description:
            "Doc-level reactions (present only when any exist). Includes orphaned anchored reactions degraded to doc-level.",
        }),
      anchored_reactions: z
        .array(AnchoredReactionGroup)
        .optional()
        .openapi({
          description:
            "Span reactions grouped by anchor signature, in document order, so clients stack/count without re-grouping (present only when any exist).",
        }),
    })
    .openapi("CommentsListResponse", { description: "The complete all-threads view." })
);

// POST /comments 201 — { comment, notified }.
export const CommentCreatedResponse = registry.register(
  "CommentCreatedResponse",
  z
    .object({
      comment: Comment,
      notified: z.number().int().openapi({
        description:
          "How many notification emails were sent for this comment (the owner on a top-level comment; the owner plus thread participants on a reply, minus the author). 0 when there is no one to notify or sends were suppressed.",
      }),
    })
    .openapi("CommentCreatedResponse", { description: "Comment created." })
);

// PATCH /comments/{id} 200 — { comment }.
export const CommentUpdatedResponse = registry.register(
  "CommentUpdatedResponse",
  z.object({ comment: Comment }).openapi("CommentUpdatedResponse", { description: "Comment updated." })
);

// DELETE /comments/{id} 200 — { id, deleted }.
export const CommentDeletedResponse = registry.register(
  "CommentDeletedResponse",
  z
    .object({ id: z.number().int(), deleted: z.boolean() })
    .openapi("CommentDeletedResponse", { description: "Comment soft-deleted." })
);

// POST /reactions 201 — { reaction }. Mirrors the route's reaction object.
export const ReactionCreatedResponse = registry.register(
  "ReactionCreatedResponse",
  z
    .object({
      reaction: z.object({
        id: z.number().int(),
        comment_id: z.number().int().nullable(),
        anchor: TextAnchor.nullable(),
        anchored_version: z.number().int().nullable(),
        orphaned: z.boolean(),
        emoji: z.string(),
        author: z.string().nullable(),
        created_at: dateTime,
      }),
    })
    .openapi("ReactionCreatedResponse", { description: "Reaction added." })
);

// POST /reactions 200 — { toggled, removed } (the same reaction already existed).
export const ReactionToggledResponse = registry.register(
  "ReactionToggledResponse",
  z
    .object({ toggled: z.boolean(), removed: z.boolean() })
    .openapi("ReactionToggledResponse", { description: "Reaction toggled off (the same reaction already existed)." })
);

// DELETE /reactions/{id} 200 — { id, deleted }.
export const ReactionDeletedResponse = registry.register(
  "ReactionDeletedResponse",
  z
    .object({ id: z.number().int(), deleted: z.boolean() })
    .openapi("ReactionDeletedResponse", { description: "Reaction removed." })
);
