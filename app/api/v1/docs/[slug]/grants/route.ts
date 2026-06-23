import {
  apiError,
  consumerDomainRejected,
  json,
  notFoundDoc,
  parseJsonObject,
  quotaExceeded,
  requireApiKey,
} from "@/lib/docs/api";
import { GrantBody, zodBadRequest } from "@/lib/docs/schemas";
import { findBySlug } from "@/lib/docs/store";
import { sendShareNotification } from "@/lib/docs/share-notify";
import {
  createGrant,
  grantView,
  isConsumerDomain,
  isOwner,
  isValidDomain,
  isValidEmail,
  listGrants,
  MAX_GRANTS_PER_DOC,
  type GrantRole,
} from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

// GET /api/v1/docs/:slug/grants — list grants. Owner only. Scope: docs.read.
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireApiKey(req, "docs.read", "read");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  // No existence oracle: a non-owner gets 404 whether or not the slug exists.
  // (Grants are owner-only; a grantee who can edit still can't enumerate grants.)
  if (!doc || !isOwner(doc, principal.userId)) return notFoundDoc();

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
  const auth = await requireApiKey(req, "docs.write", "write");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  const { slug } = await ctx.params;
  const doc = await findBySlug(slug);
  // Owner-only: a non-owner (even an editor) gets a 404 — no existence oracle,
  // and managing grants is strictly an owner capability (birthday.md).
  if (!doc || !isOwner(doc, principal.userId)) return notFoundDoc();

  const parsed = await parseJsonObject(req);
  if ("response" in parsed) return parsed.response;
  const b = parsed.obj;

  // Exactly-one of email|domain stays in business logic (it's not a plain type
  // check, and its 400 precedes the field type checks below — old ordering).
  const hasEmail = b.email !== undefined && b.email !== null;
  const hasDomain = b.domain !== undefined && b.domain !== null;
  if (hasEmail === hasDomain) {
    return apiError(
      400,
      "invalid_request",
      "Provide exactly one of 'email' or 'domain' (a grant targets one or the other)."
    );
  }

  // Field-level type checks via Zod (role enum, notify bool, email/domain string).
  // Precedence order matches the old hand-rolled checks: role, then notify, then
  // email, then domain. The exactly-one rule (above), the trim/normalize, the
  // email/domain FORMAT validation, and the consumer-domain 422 stay here.
  const v = GrantBody.safeParse(b);
  if (!v.success) return zodBadRequest(v.error, ["role", "notify", "email", "domain"]);
  const role = v.data.role as GrantRole;
  // notify: suppress the share-notification email (default true). Only ever
  // relevant for EMAIL grants — domain grants never notify (we don't email a
  // whole company), so the flag is silently ignored for domains.
  const notify = v.data.notify ?? true;

  let granteeType: "email" | "domain";
  let grantee: string;

  if (hasEmail) {
    const email = (v.data.email as string).trim().toLowerCase();
    if (!isValidEmail(email)) {
      return apiError(400, "invalid_request", "Field 'email' is not a valid email address.");
    }
    granteeType = "email";
    grantee = email;
  } else {
    // Accept either 'co.com' or '@co.com'; normalize to the bare domain.
    let domain = (v.data.domain as string).trim().toLowerCase();
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
    // error === "exists": idempotent re-grant of the same target + role. No
    // re-notification — the grantee was already emailed on the first grant, and
    // a no-op re-grant shouldn't re-spam their inbox.
    return json({ slug: doc.slug, grant: grantView(result.grant), unchanged: true }, 200);
  }

  // Share notification (birthday.md "Share notifications"). Sent only for a
  // freshly created or role-changed EMAIL grant, only when notify !== false.
  // Domain grants never notify. Best-effort: the grant is already committed, so a
  // send failure or rate-limit never fails the request (the /d/:slug "was this
  // shared with you?" fallback always recovers a missed/expired link).
  if (granteeType === "email" && notify) {
    await sendShareNotification({
      req,
      docId: doc.id,
      slug: doc.slug,
      title: doc.title || doc.slug,
      ownerEmail: principal.email,
      granteeEmail: grantee,
    });
  }

  return json({ slug: doc.slug, grant: grantView(result.grant) }, 201);
}
