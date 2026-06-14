import { createHash } from "node:crypto";

// Gravatar / avatar helpers (birthday.md UI spec: "Gravatar by email hash,
// identicon fallback"). Pulled out of comments.ts so the view-shaping layer
// (lib/docs/comments/views.ts) and any future surface share ONE definition.

/** Gravatar profile hash = sha256 of the lowercased, trimmed email. */
export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export function avatarUrl(email: string, size = 64): string {
  return `https://gravatar.com/avatar/${gravatarHash(email)}?d=identicon&s=${size}`;
}
