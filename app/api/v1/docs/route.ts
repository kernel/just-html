import { authenticate, unauthorized } from "@/lib/auth/bearer";
import {
  apiError,
  forbiddenScope,
  hasScope,
  json,
  payloadTooLarge,
  quotaExceeded,
  rateLimit,
} from "@/lib/docs/api";
import { MAX_HTML_BYTES, MAX_TITLE_LEN } from "@/lib/docs/config";
import {
  byteLen,
  createDoc,
  listDocs,
  listItemView,
  listSharedDocs,
  ownerView,
} from "@/lib/docs/store";
import { emailDomain } from "@/lib/docs/grants";

export const dynamic = "force-dynamic";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

// POST /api/v1/docs — create a document. Body: { html, title?, public? }.
// Returns { slug, url, view_token, ... }. Scope: docs.write.
export async function POST(req: Request): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) {
    return unauthorized(
      req.headers.get("authorization")
        ? "Invalid, expired, or revoked credential."
        : "Missing Bearer credential."
    );
  }
  if (!hasScope(principal, "docs.write")) return forbiddenScope("docs.write");

  const limited = await rateLimit(req, principal, "create");
  if (limited) return limited;

  // Size cap checked before parse: reject oversized bodies by Content-Length when
  // present, then again on the parsed html string (the authoritative check).
  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
    return payloadTooLarge(MAX_HTML_BYTES, contentLength);
  }

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

  if (typeof b.html !== "string") {
    return apiError(400, "invalid_request", "Field 'html' is required and must be a string.");
  }
  const html = b.html;
  const htmlBytes = byteLen(html);
  if (htmlBytes > MAX_HTML_BYTES) {
    return payloadTooLarge(MAX_HTML_BYTES, htmlBytes);
  }

  let title: string | null = null;
  if (b.title !== undefined && b.title !== null) {
    if (typeof b.title !== "string") {
      return apiError(400, "invalid_request", "Field 'title' must be a string.");
    }
    if (b.title.length > MAX_TITLE_LEN) {
      return apiError(400, "invalid_request", `Field 'title' must be at most ${MAX_TITLE_LEN} characters.`);
    }
    title = b.title;
  }

  let isPublic = false;
  if (b.public !== undefined) {
    if (typeof b.public !== "boolean") {
      return apiError(400, "invalid_request", "Field 'public' must be a boolean.");
    }
    isPublic = b.public;
  }

  const result = await createDoc({ ownerId: principal.userId, html, title, isPublic });
  if ("quota" in result) {
    return quotaExceeded(result.quota.kind, result.quota.limit, result.quota.current);
  }
  return json(ownerView(result.doc, false), 201);
}

// GET /api/v1/docs — list documents. Scope: docs.read.
//
// ?scope=owned (default) | shared | all (birthday.md "GET /api/v1/docs" row):
//   - owned : docs the key's user owns. Backwards-consistent shape: every field
//             ownerView returned (slug,url,title,version,public,view_token,
//             created_at,updated_at) is still present; we add access:"owner"
//             (the plan requires every item carry access — additive, not a break).
//   - shared: docs granted to the key's email (email grant) or its email-domain
//             (domain grant), EXCLUDING docs you own. access is the resolved role
//             (email grant beats domain grant). No view_token (owner-only).
//   - all   : owned ++ shared, owned first.
export async function GET(req: Request): Promise<Response> {
  const principal = await authenticate(req);
  if (!principal) {
    return unauthorized(
      req.headers.get("authorization")
        ? "Invalid, expired, or revoked credential."
        : "Missing Bearer credential."
    );
  }
  if (!hasScope(principal, "docs.read")) return forbiddenScope("docs.read");

  const limited = await rateLimit(req, principal, "read");
  if (limited) return limited;

  const url = new URL(req.url);
  let limit = DEFAULT_LIST_LIMIT;
  const limitParam = url.searchParams.get("limit");
  if (limitParam != null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1) {
      return apiError(400, "invalid_request", "Query 'limit' must be a positive integer.");
    }
    limit = Math.min(n, MAX_LIST_LIMIT);
  }

  const scope = url.searchParams.get("scope") ?? "owned";
  if (scope !== "owned" && scope !== "shared" && scope !== "all") {
    return apiError(
      400,
      "invalid_request",
      "Query 'scope' must be one of: owned, shared, all."
    );
  }

  const items: ReturnType<typeof listItemView>[] = [];
  if (scope === "owned" || scope === "all") {
    const owned = await listDocs(principal.userId, limit);
    for (const d of owned) items.push(listItemView(d, "owner"));
  }
  if (scope === "shared" || scope === "all") {
    const domain = emailDomain(principal.email);
    const shared = await listSharedDocs(principal.email, domain, principal.userId, limit);
    for (const d of shared) items.push(listItemView(d, d.access));
  }
  return json({ docs: items });
}
