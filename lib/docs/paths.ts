// Register the /api/v1/docs PATHS into the shared OpenAPIRegistry. Importing this
// module (side-effecting) wires the docs operations + their request/response
// schemas so scripts/gen-spec.ts can emit the served OpenAPI spec. The rich
// descriptions/summaries here are what make the generated spec the single,
// authoritative source for GET /api/spec.yaml (the hand-written literal is gone).

import { registry, z } from "@/lib/openapi/registry";
import {
  ApiError,
  CommentCreatedResponse,
  CommentDeletedResponse,
  CommentUpdatedResponse,
  CommentsListResponse,
  CreateCommentBody,
  CreateDocBody,
  CreateReactionBody,
  DeleteDocResponse,
  DocListResponse,
  DocWithHtml,
  EditsBody,
  GrantBody,
  GrantCreatedResponse,
  GrantDeletedResponse,
  GrantListResponse,
  GrantUnchangedResponse,
  OwnerDoc,
  ReactionCreatedResponse,
  ReactionDeletedResponse,
  ReactionToggledResponse,
  UpdateCommentBody,
  UpdateDocBody,
  VersionListResponse,
  VersionSnapshot,
} from "@/lib/docs/schemas";

const bearerApiKey = registry.registerComponent("securitySchemes", "bearerApiKey", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "jh_live_...",
  description:
    "Long-lived API key obtained via the auth.md service_auth flow. Carries scopes docs.read docs.write. 401s include a WWW-Authenticate header pointing at the protected-resource metadata.",
});

const slugParam = registry.registerParameter(
  "Slug",
  z.string().openapi({
    param: { name: "slug", in: "path" },
    example: "fierce-tiger-12345",
  })
);

const jsonError = { "application/json": { schema: ApiError } };
const security = [{ [bearerApiKey.name]: [] }];

// POST /api/v1/docs — create
registry.registerPath({
  method: "post",
  path: "/api/v1/docs",
  tags: ["docs"],
  summary: "Create a document",
  operationId: "createDoc",
  security,
  request: {
    body: { required: true, content: { "application/json": { schema: CreateDocBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: OwnerDoc } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    403: { description: "A resource quota was exceeded", content: jsonError },
    413: { description: "HTML exceeds the 2 MB per-document size limit", content: jsonError },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// GET /api/v1/docs — list (owned, shared, or both)
registry.registerPath({
  method: "get",
  path: "/api/v1/docs",
  tags: ["docs"],
  summary: "List documents (owned, shared, or both)",
  description:
    "Lists documents by scope. Every item carries an access role (owner|editor|commenter|viewer). For a doc matched by both an email grant and a domain grant, the email grant wins (precedence ladder). Owned items additionally carry view_token; shared items do not (the view token is an owner-only capability). The web equivalent for a signed-in human is https://justhtml.sh/docs.",
  operationId: "listDocs",
  security,
  request: {
    query: z.object({
      scope: z
        .enum(["owned", "shared", "all"])
        .default("owned")
        .openapi({
          param: { name: "scope", in: "query" },
          description:
            "owned (default): docs the caller owns. shared: docs granted to the caller's email or email-domain, excluding docs the caller owns. all: owned then shared.",
        }),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .openapi({ param: { name: "limit", in: "query" } }),
    }),
  },
  responses: {
    200: {
      description: "The matched documents",
      content: { "application/json": { schema: DocListResponse } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// GET /api/v1/docs/{slug} — fetch metadata + html
registry.registerPath({
  method: "get",
  path: "/api/v1/docs/{slug}",
  tags: ["docs"],
  summary: "Fetch a document (metadata + html)",
  operationId: "getDoc",
  security,
  request: { params: z.object({ slug: slugParam }) },
  responses: {
    200: {
      description: "Owner sees view_token; a grantee sees role instead of view_token.",
      content: { "application/json": { schema: DocWithHtml } },
    },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// PATCH /api/v1/docs/{slug} — update html (rewrite), title, or visibility
registry.registerPath({
  method: "patch",
  path: "/api/v1/docs/{slug}",
  tags: ["docs"],
  summary: "Update html (full rewrite), title, or visibility",
  description:
    "Owner or editor grant may rewrite html. Only the owner may change title or public (visibility).",
  operationId: "updateDoc",
  security,
  request: {
    params: z.object({ slug: slugParam }),
    body: { required: true, content: { "application/json": { schema: UpdateDocBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: DocWithHtml } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    403: { description: "Editor tried to change title/visibility", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    413: { description: "HTML exceeds the 2 MB per-document size limit", content: jsonError },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// DELETE /api/v1/docs/{slug} — soft-delete (owner only)
registry.registerPath({
  method: "delete",
  path: "/api/v1/docs/{slug}",
  tags: ["docs"],
  summary: "Soft-delete a document (owner only)",
  operationId: "deleteDoc",
  security,
  request: { params: z.object({ slug: slugParam }) },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: DeleteDocResponse } },
    },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// =========================================================================
// Docs sub-resources: edits, rotate-token, versions, grants.
// =========================================================================

const versionNumParam = registry.registerParameter(
  "VersionNum",
  z.number().int().min(1).openapi({
    param: { name: "n", in: "path" },
    example: 3,
  })
);

const grantIdParam = registry.registerParameter(
  "GrantId",
  z.number().int().min(1).openapi({
    param: { name: "id", in: "path" },
    example: 1,
  })
);

// POST /api/v1/docs/{slug}/edits — apply deterministic patches
registry.registerPath({
  method: "post",
  path: "/api/v1/docs/{slug}/edits",
  tags: ["docs"],
  summary: "Apply deterministic patches",
  description:
    "exact-match-then-fuzzy edit application. Owner or editor grant. Always send base_version; a mismatch returns 409. Ambiguous, no-match, or overlapping edits return 422 naming the failing edit index.",
  operationId: "editDoc",
  security,
  request: {
    params: z.object({ slug: slugParam }),
    body: { required: true, content: { "application/json": { schema: EditsBody } } },
  },
  responses: {
    200: {
      description: "Patched",
      content: { "application/json": { schema: DocWithHtml } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    409: { description: "base_version conflict", content: jsonError },
    413: { description: "HTML exceeds the 2 MB per-document size limit", content: jsonError },
    422: { description: "An edit could not be applied deterministically", content: jsonError },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// POST /api/v1/docs/{slug}/rotate-token — rotate the view token (owner only)
registry.registerPath({
  method: "post",
  path: "/api/v1/docs/{slug}/rotate-token",
  tags: ["docs"],
  summary: "Rotate the view token (un-share; owner only)",
  operationId: "rotateViewToken",
  security,
  request: { params: z.object({ slug: slugParam }) },
  responses: {
    200: {
      description: "New view token issued",
      content: { "application/json": { schema: OwnerDoc } },
    },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// GET /api/v1/docs/{slug}/versions — list retained version history (newest first)
registry.registerPath({
  method: "get",
  path: "/api/v1/docs/{slug}/versions",
  tags: ["docs"],
  summary: "List retained version history (newest first)",
  operationId: "listVersions",
  security,
  request: { params: z.object({ slug: slugParam }) },
  responses: {
    200: {
      description: "Version metadata (no html)",
      content: { "application/json": { schema: VersionListResponse } },
    },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// GET /api/v1/docs/{slug}/versions/{n} — fetch a specific version's full html
registry.registerPath({
  method: "get",
  path: "/api/v1/docs/{slug}/versions/{n}",
  tags: ["docs"],
  summary: "Fetch a specific version's full html",
  operationId: "getVersion",
  security,
  request: { params: z.object({ slug: slugParam, n: versionNumParam }) },
  responses: {
    200: {
      description: "Version snapshot with html",
      content: { "application/json": { schema: VersionSnapshot } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// GET /api/v1/docs/{slug}/grants — list grants (owner only)
registry.registerPath({
  method: "get",
  path: "/api/v1/docs/{slug}/grants",
  tags: ["sharing"],
  summary: "List grants (owner only)",
  operationId: "listGrants",
  security,
  request: { params: z.object({ slug: slugParam }) },
  responses: {
    200: {
      description: "Grants on the document",
      content: { "application/json": { schema: GrantListResponse } },
    },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// POST /api/v1/docs/{slug}/grants — share with an email or a domain (owner only)
registry.registerPath({
  method: "post",
  path: "/api/v1/docs/{slug}/grants",
  tags: ["sharing"],
  summary: "Share with an email or a domain (owner only)",
  description:
    "Provide exactly one of email or domain. role is editor, commenter, or viewer. Consumer email providers (gmail.com, ...) are rejected with 422. Re-granting the same target+role is idempotent (200 with unchanged:true). Email grants send the grantee a share-notification email containing ONE single-use, 7-day login link with next=/d/:slug; set notify:false to suppress it. DOMAIN grants NEVER notify (notify is ignored for them).",
  operationId: "createGrant",
  security,
  request: {
    params: z.object({ slug: slugParam }),
    body: { required: true, content: { "application/json": { schema: GrantBody } } },
  },
  responses: {
    201: {
      description: "Grant created",
      content: { "application/json": { schema: GrantCreatedResponse } },
    },
    200: {
      description: "Idempotent re-grant (same target + role)",
      content: { "application/json": { schema: GrantUnchangedResponse } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    403: { description: "A resource quota was exceeded", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    422: { description: "Consumer email domain rejected", content: jsonError },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// DELETE /api/v1/docs/{slug}/grants/{id} — revoke a grant (owner only)
registry.registerPath({
  method: "delete",
  path: "/api/v1/docs/{slug}/grants/{id}",
  tags: ["sharing"],
  summary: "Revoke a grant (owner only)",
  operationId: "deleteGrant",
  security,
  request: { params: z.object({ slug: slugParam, id: grantIdParam }) },
  responses: {
    200: {
      description: "Grant revoked",
      content: { "application/json": { schema: GrantDeletedResponse } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// =========================================================================
// Comments + reactions. Both surfaces accept an API key OR a signed-in session,
// so the security list adds the anonymous/{} option (a session is presented via
// cookie, not the Bearer scheme), yielding `security: [{ bearerApiKey: [] }, {}]`.
// =========================================================================

const commentOrSessionSecurity = [{ [bearerApiKey.name]: [] }, {}];

const commentIdParam = registry.registerParameter(
  "CommentId",
  z.number().int().min(1).openapi({
    param: { name: "id", in: "path" },
    example: 42,
  })
);

const reactionIdParam = registry.registerParameter(
  "ReactionId",
  z.number().int().min(1).openapi({
    param: { name: "id", in: "path" },
    example: 7,
  })
);

const viewtokenQuery = z.object({
  viewtoken: z
    .string()
    .optional()
    .openapi({
      param: { name: "viewtoken", in: "query" },
      description:
        "Present a doc's view token to comment/read as a token-holder (with identity). Not needed for owner/grantee sessions or API keys.",
    }),
});

// GET /api/v1/docs/{slug}/comments — the complete all-threads view
registry.registerPath({
  method: "get",
  path: "/api/v1/docs/{slug}/comments",
  tags: ["collaboration"],
  summary: "List all comment threads (the complete all-threads view)",
  description:
    "Returns every live thread the caller can see, exactly as the viewer shell shows humans: anchored threads in document order, then doc-level threads, then orphaned threads, each carrying resolved/orphaned flags, 1-level replies, and reactions. Read access required (owner/grant via identity, a valid view token, or a public doc).",
  operationId: "listComments",
  security: commentOrSessionSecurity,
  request: { params: z.object({ slug: slugParam }), query: viewtokenQuery },
  responses: {
    200: {
      description: "All threads",
      content: { "application/json": { schema: CommentsListResponse } },
    },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
  },
});

// POST /api/v1/docs/{slug}/comments — post a comment (anchored / doc-level / reply)
registry.registerPath({
  method: "post",
  path: "/api/v1/docs/{slug}/comments",
  tags: ["collaboration"],
  summary: "Post a comment (anchored to a quote, doc-level, or a reply)",
  description:
    "Comment on a span by QUOTING it (anchor), at the doc level (omit anchor), or reply to a root comment (parent_id). Identity required: API key OR signed-in session — anonymous never writes. Permission to comment: owner, editor or commenter grant, view-token holder with identity, or any identity on a public doc.",
  operationId: "createComment",
  security: commentOrSessionSecurity,
  request: {
    params: z.object({ slug: slugParam }),
    query: viewtokenQuery,
    body: { required: true, content: { "application/json": { schema: CreateCommentBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: CommentCreatedResponse } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    403: { description: "Can view but not comment (e.g. a viewer-only grant)", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    413: { description: "Comment body exceeds 10 KB", content: jsonError },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// PATCH /api/v1/docs/{slug}/comments/{id} — edit body / resolve toggle
registry.registerPath({
  method: "patch",
  path: "/api/v1/docs/{slug}/comments/{id}",
  tags: ["collaboration"],
  summary: "Edit body (author) and/or resolve/unresolve (anyone who can comment)",
  operationId: "updateComment",
  security: commentOrSessionSecurity,
  request: {
    params: z.object({ slug: slugParam, id: commentIdParam }),
    body: { required: true, content: { "application/json": { schema: UpdateCommentBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: CommentUpdatedResponse } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    403: {
      description: "Editing another author's body, or resolving without comment rights",
      content: jsonError,
    },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// DELETE /api/v1/docs/{slug}/comments/{id} — soft-delete (author own, owner any)
registry.registerPath({
  method: "delete",
  path: "/api/v1/docs/{slug}/comments/{id}",
  tags: ["collaboration"],
  summary: "Soft-delete a comment (author own, owner any)",
  operationId: "deleteComment",
  security: commentOrSessionSecurity,
  request: { params: z.object({ slug: slugParam, id: commentIdParam }) },
  responses: {
    200: {
      description: "Deleted",
      content: { "application/json": { schema: CommentDeletedResponse } },
    },
    401: { description: "Missing/invalid credential", content: jsonError },
    403: { description: "Not the author and not the owner", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
  },
});

// POST /api/v1/docs/{slug}/reactions — react to a doc, comment, or span
registry.registerPath({
  method: "post",
  path: "/api/v1/docs/{slug}/reactions",
  tags: ["collaboration"],
  summary: "React to a doc, a comment, or a quoted span (attributed; re-post toggles off)",
  description:
    "Add an emoji reaction. The target is 3-way and MUTUALLY EXCLUSIVE: comment_id set → react on that comment; anchor set → react on a text span (W3C text-quote, same shape + validation as a comment anchor; an agent \"highlights\" by quoting); neither set → react on the whole document. Supplying BOTH comment_id and anchor → 400. Attributed-only (identity required); unique per (target, author, emoji) — for span reactions the \"target\" is the anchor signature, so the same emoji on two different spans are two distinct reactions. Re-posting the same reaction removes it (toggle). Anchored reactions re-anchor on every doc edit exactly like comments (move, or orphan + later un-orphan); an orphaned anchored reaction degrades to doc-level display. React permission: anyone who can view, with identity.",
  operationId: "addReaction",
  security: commentOrSessionSecurity,
  request: {
    params: z.object({ slug: slugParam }),
    body: { required: true, content: { "application/json": { schema: CreateReactionBody } } },
  },
  responses: {
    201: {
      description: "Reaction added",
      content: { "application/json": { schema: ReactionCreatedResponse } },
    },
    200: {
      description: "Reaction toggled off (the same reaction already existed)",
      content: { "application/json": { schema: ReactionToggledResponse } },
    },
    400: { description: "Invalid request body or parameters", content: jsonError },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
    422: { description: "comment_id does not reference a live comment on this document", content: jsonError },
    429: { description: "Rate limit exceeded", content: jsonError },
  },
});

// DELETE /api/v1/docs/{slug}/reactions/{id} — remove your own reaction
registry.registerPath({
  method: "delete",
  path: "/api/v1/docs/{slug}/reactions/{id}",
  tags: ["collaboration"],
  summary: "Remove your own reaction",
  operationId: "deleteReaction",
  security: commentOrSessionSecurity,
  request: { params: z.object({ slug: slugParam, id: reactionIdParam }) },
  responses: {
    200: {
      description: "Removed",
      content: { "application/json": { schema: ReactionDeletedResponse } },
    },
    401: { description: "Missing/invalid credential", content: jsonError },
    404: {
      description: "No such document (also returned for inaccessible docs; no existence oracle)",
      content: jsonError,
    },
  },
});
