// `next` redirect-target sanitization (§9.2). Same-origin paths only: must
// start with a single '/', must not start with '//' (protocol-relative). Any
// other value falls back to '/'.
export function sanitizeNext(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  return next;
}

/** Loose email shape, matching the reference's classifyLoginHint regex. */
export function isEmailish(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
