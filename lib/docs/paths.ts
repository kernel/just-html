// Register the /api/v1/docs PATHS into the shared OpenAPIRegistry (Z1). Importing
// this module (side-effecting) wires the docs operations + their request/response
// schemas so scripts/gen-spec.ts can emit a generated spec to diff against the
// hand-written lib/openapi/spec-yaml.ts. Descriptions/summaries are carried over
// from that hand-written spec's docs section so the generated output is as rich.
//
// Only the docs resource is registered in Z1; the other resources (edits, grants,
// versions, comments, reactions, auth) stay hand-written until later phases.

import { registry, z } from "@/lib/openapi/registry";
import {
  ApiError,
  CreateDocBody,
  DeleteDocResponse,
  DocListResponse,
  DocWithHtml,
  OwnerDoc,
  UpdateDocBody,
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
