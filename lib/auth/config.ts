// Auth config constants. Single source of truth for TTLs and caps
// (authmd-implementation.md §4, §6, §11). Tuning is a one-line change here.

export const CLAIM_WINDOW_S = 86_400; // outer registration window, 24h
export const USER_CODE_TTL_S = 600; // user_code, 10 min
export const USER_CODE_TTL_MIN = Math.round(USER_CODE_TTL_S / 60); // for "expires in N minutes" copy
export const POLL_INTERVAL_S = 5; // token-endpoint poll interval
export const MAX_CODE_ATTEMPTS = 5; // wrong user_code guesses, then code dead
export const MAX_REMINTS = 10; // re-mints per registration, lifetime
export const LOGIN_TOKEN_TTL_S = 900; // magic link, 15 min
export const LOGIN_TOKEN_TTL_MIN = Math.round(LOGIN_TOKEN_TTL_S / 60); // for "expires in N minutes" copy
export const SHARE_TOKEN_TTL_S = 604_800; // share-notification login link, 7 days
                                          // (share emails get clicked tomorrow, not now)
export const SESSION_TTL_S = 2_592_000; // session lifetime, 30 days
export const SESSION_SLIDE_FLOOR_S = 3_600; // throttle sliding-expiry writes to 1/h
export const API_KEY_LAST_USED_THROTTLE_S = 60; // last_used_at bump throttle

export const ORIGIN = "https://justhtml.sh";
export const ISSUER = "https://justhtml.sh";
export const RESOURCE = "https://justhtml.sh/api/v1/";
export const SCOPES = ["docs.read", "docs.write"] as const;
// Derived from SCOPES so there is no second place to edit. SCOPE_STRING is the
// space-delimited OAuth scope value; SCOPE_PG_ARRAY is the Postgres array literal
// ('{docs.read,docs.write}') used in the api_keys.scopes INSERT.
export const SCOPE_STRING = SCOPES.join(" ");
export const SCOPE_PG_ARRAY = `{${SCOPES.join(",")}}`;

// OAuth protected-resource metadata discovery URL + the exact WWW-Authenticate
// challenge value carried on every API 401 (§3.5). Derived from ORIGIN so the
// host has one source. The challenge string is reused verbatim by bearer.ts and
// the comment/reaction 401 helpers — keep the value byte-identical to what
// clients/scanners expect.
export const PROTECTED_RESOURCE_METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource`;
export const WWW_AUTHENTICATE_CHALLENGE = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`;

export const SESSION_COOKIE = "jh_sess";

export const RESEND_FROM = "justhtml.sh <login@notify.justhtml.sh>";
export const LOGIN_SUBJECT = "justhtml.sh login";
// The claim email carries the 6-digit code and nothing else actionable (no
// links, no buttons) — the human reads it back to the agent (one flow).
export const CLAIM_SUBJECT = "your justhtml.sh code";
