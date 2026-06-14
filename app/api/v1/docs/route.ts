import {
  apiError,
  json,
  parseJsonObject,
  payloadTooLarge,
  quotaExceeded,
  requireApiKey,
} from "@/lib/docs/api";
import { CreateDocBody, zodBadRequest } from "@/lib/docs/schemas";
import { MAX_HTML_BYTES } from "@/lib/docs/config";
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
  const auth = await requireApiKey(req, "docs.write", "create");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

  // Size cap checked before parse (Content-Length precheck folded into
  // parseJsonObject), then again on the parsed html string (the authoritative
  // check).
  const parsed = await parseJsonObject(req, { maxBytes: MAX_HTML_BYTES });
  if ("response" in parsed) return parsed.response;
  const b = parsed.obj;

  // Preserve the old ordering exactly: the authoritative byte-length 413 runs
  // right after the html-is-a-string check and BEFORE title/public validation.
  // Zod's CreateDocBody validates html/title/public types + the title length cap;
  // the 2 MB byte cap stays here (Zod can't measure UTF-8 bytes), so a valid
  // (but oversized) html string still 413s before any title/public 400 — matching
  // the hand-parsed behavior.
  if (typeof b.html === "string") {
    const htmlBytes = byteLen(b.html);
    if (htmlBytes > MAX_HTML_BYTES) return payloadTooLarge(MAX_HTML_BYTES, htmlBytes);
  }

  const result0 = CreateDocBody.safeParse(b);
  if (!result0.success) return zodBadRequest(result0.error, ["html", "title", "public"]);
  const { html, title, public: isPublic } = result0.data;

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
  const auth = await requireApiKey(req, "docs.read", "read");
  if ("response" in auth) return auth.response;
  const { principal } = auth;

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
