// `next` redirect-target sanitization (§9.2). Same-origin paths only: must
// start with a single '/', must not start with '//' (protocol-relative). Any
// other value falls back to '/'.
export function sanitizeNext(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  return next;
}

// The post-sign-in landing when there is no real onward destination. A bare
// /login (no `next`) sanitizes to "/", but the spec wants a freshly signed-in
// human to land on /docs (their owned + shared listing), NOT the homepage
// (birthday.md "the /login post-verify landing (no next) should go to /docs").
// Treat "/" (and empty) as "no next" → /docs; any real same-origin path (a
// claim form, a /d/:slug share link) is preserved.
export const POST_LOGIN_LANDING = "/docs";

/** Sanitize `next`, but map the "no real destination" case ("/" or empty) to
 *  POST_LOGIN_LANDING so post-verify lands on /docs instead of the homepage. */
export function loginLanding(next: string | null | undefined): string {
  const sanitized = sanitizeNext(next);
  return sanitized === "/" ? POST_LOGIN_LANDING : sanitized;
}

/** Loose email shape, matching the reference's classifyLoginHint regex. */
export function isEmailish(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
