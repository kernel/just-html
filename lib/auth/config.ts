// Auth config constants. Single source of truth for TTLs and caps
// (authmd-implementation.md §4, §6, §11). Tuning is a one-line change here.

export const CLAIM_WINDOW_S = 86_400; // outer registration window, 24h
export const USER_CODE_TTL_S = 600; // user_code, 10 min
export const ATTEMPT_TOKEN_TTL_S = 600; // claim_attempt_token (cvt_), 10 min
export const POLL_INTERVAL_S = 5; // token-endpoint poll interval
export const MAX_CODE_ATTEMPTS = 5; // wrong user_code guesses, then code dead
export const MAX_REMINTS = 10; // re-mints per registration, lifetime
export const LOGIN_TOKEN_TTL_S = 900; // magic link, 15 min
export const SHARE_TOKEN_TTL_S = 604_800; // share-notification login link, 7 days
                                          // (share emails get clicked tomorrow, not now)
export const SESSION_TTL_S = 2_592_000; // session lifetime, 30 days
export const SESSION_SLIDE_FLOOR_S = 3_600; // throttle sliding-expiry writes to 1/h
export const API_KEY_LAST_USED_THROTTLE_S = 60; // last_used_at bump throttle

export const ORIGIN = "https://justhtml.sh";
export const ISSUER = "https://justhtml.sh";
export const RESOURCE = "https://justhtml.sh/api/v1/";
export const SCOPES = ["docs.read", "docs.write"] as const;
export const SCOPE_STRING = "docs.read docs.write";

export const SESSION_COOKIE = "jh_sess";

export const RESEND_FROM = "justhtml.sh <login@notify.justhtml.sh>";
export const LOGIN_SUBJECT = "justhtml.sh login";
