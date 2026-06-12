import { authenticate, unauthorized } from "@/lib/auth/bearer";
import {
  apiError,
  consumerDomainRejected,
  forbiddenScope,
  hasScope,
  json,
  notFoundDoc,
  ownerOnly,
  quotaExceeded,
  rateLimit,
} from "@/lib/docs/api";
import { findBySlug } from "@/lib/docs/store";
import {
  createGrant,
  GRANT_ROLES,
  grantView,
  isConsumerDomain,
  isValidDomain,
  isValidEmail,
  listGrants,
  MAX_GRANTS_PER_DOC,
  type GrantRole,
} from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

function authFail(req: Request): Response {
  return unauthorized(
    req.headers.get("authorization")
      ? "Invalid, expired, or revoked credential."
      : "Missing Bearer credential."
  );
}

// GET /api/v1/docs/:slug/grants — list grants. Owner only. Scope: docs.read.
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) return authFail(req);
  if (!hasScope(principal, "docs.read")) return forbiddenScope("docs.read");

  const limited = await rateLimit(req, principal, "read");
  if (limited) return limited;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  // No existence oracle: a non-owner gets 404 whether or not the slug exists.
  // (Grants are owner-only; a grantee who can edit still can't enumerate grants.)
  if (!doc || doc.owner_id !== principal.userId) return notFoundDoc();

  const grants = await listGrants(doc.id);
  return json({
    slug: doc.slug,
    grants: grants.map(grantView),
    count: grants.length,
    max: MAX_GRANTS_PER_DOC,
  });
}

// POST /api/v1/docs/:slug/grants — share a doc. Owner only. Scope: docs.write.
// Body: { email, role } OR { domain, role }; role ∈ editor|commenter|viewer.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) return authFail(req);
  if (!hasScope(principal, "docs.write")) return forbiddenScope("docs.write");

  const limited = await rateLimit(req, principal, "write");
  if (limited) return limited;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  // Owner-only: a non-owner (even an editor) gets a 404 — no existence oracle,
  // and managing grants is strictly an owner capability (birthday.md).
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

  const hasEmail = b.email !== undefined && b.email !== null;
  const hasDomain = b.domain !== undefined && b.domain !== null;
  if (hasEmail === hasDomain) {
    return apiError(
      400,
      "invalid_request",
      "Provide exactly one of 'email' or 'domain' (a grant targets one or the other)."
    );
  }

  // Validate role.
  if (typeof b.role !== "string" || !GRANT_ROLES.includes(b.role as GrantRole)) {
    return apiError(
      400,
      "invalid_request",
      `Field 'role' is required and must be one of: ${GRANT_ROLES.join(", ")}.`
    );
  }
  const role = b.role as GrantRole;

  let granteeType: "email" | "domain";
  let grantee: string;

  if (hasEmail) {
    if (typeof b.email !== "string") {
      return apiError(400, "invalid_request", "Field 'email' must be a string.");
    }
    const email = b.email.trim().toLowerCase();
    if (!isValidEmail(email)) {
      return apiError(400, "invalid_request", "Field 'email' is not a valid email address.");
    }
    granteeType = "email";
    grantee = email;
  } else {
    if (typeof b.domain !== "string") {
      return apiError(400, "invalid_request", "Field 'domain' must be a string.");
    }
    // Accept either 'co.com' or '@co.com'; normalize to the bare domain.
    let domain = b.domain.trim().toLowerCase();
    if (domain.startsWith("@")) domain = domain.slice(1);
    if (!isValidDomain(domain)) {
      return apiError(
        400,
        "invalid_request",
        "Field 'domain' is not a valid domain (e.g. 'kernel.sh')."
      );
    }
    // Reject consumer providers — granting @gmail.com is granting the world.
    if (isConsumerDomain(domain)) {
      return consumerDomainRejected(domain);
    }
    granteeType = "domain";
    grantee = domain;
  }

  const result = await createGrant({
    docId: doc.id,
    granteeType,
    grantee,
    role,
    createdBy: principal.userId,
  });

  if ("error" in result) {
    if (result.error === "limit") {
      return quotaExceeded("grants", MAX_GRANTS_PER_DOC, MAX_GRANTS_PER_DOC);
    }
    // error === "exists": idempotent re-grant of the same target + role.
    return json({ slug: doc.slug, grant: grantView(result.grant), unchanged: true }, 200);
  }

  return json({ slug: doc.slug, grant: grantView(result.grant) }, 201);
}
