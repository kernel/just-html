// Response envelopes for the agent-facing endpoints (§3).
//
// - /agent/identity* speak JSON with { error, message } bodies.
// - /oauth2/* use the OAuth envelope { error, error_description } and carry
//   Cache-Control: no-store + Pragma: no-cache on EVERY response (§3 conventions).

const JSON_CT = "application/json; charset=utf-8";

/** /agent/identity* JSON response. */
export function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": JSON_CT, ...(init?.headers ?? {}) },
  });
}

/** /agent/identity* error: { error, message }. */
export function agentError(
  status: number,
  error: string,
  message: string,
  headers?: Record<string, string>
): Response {
  return jsonResponse({ error, message }, { status, headers });
}

const OAUTH_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

/** /oauth2/* success/response with no-store headers. */
export function oauthResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": JSON_CT, ...OAUTH_HEADERS, ...(init?.headers ?? {}) },
  });
}

/** /oauth2/* empty 200 (e.g. revoke) with no-store headers. */
export function oauthEmpty(): Response {
  return new Response(null, { status: 200, headers: { ...OAUTH_HEADERS } });
}

/** /oauth2/* error: { error, error_description }. Status defaults to 400. */
export function oauthError(
  error: string,
  description?: string,
  init?: { status?: number; headers?: Record<string, string> }
): Response {
  return oauthResponse(
    { error, ...(description ? { error_description: description } : {}) },
    { status: init?.status ?? 400, headers: init?.headers }
  );
}
