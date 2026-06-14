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
