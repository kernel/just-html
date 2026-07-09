// Deeplink fragment contract — the ONE place the copy side and the read side agree
// on how a section/comment id maps to a URL #fragment. copyLink builds the fragment
// with fragmentFor(); the hash router reads it with parseHash(). Keeping both on one
// codec is what makes permalinks round-trip: encode-on-write must mirror
// decode-on-read, and the routing (comment vs section) must match how ids are
// minted (see lib/docs/sections.ts, which never mints a comment-<n> section id, so
// the comment branch here can never swallow a section link).

export type HashTarget =
  | { kind: "comment"; id: number }
  | { kind: "section"; id: string }
  | { kind: "none" };

// The #fragment for a copyable permalink. Comment permalinks are comment-<id>
// (ASCII, no encoding needed); a section id is author- or slug-derived and may hold
// Unicode, spaces, or reserved characters, so it's percent-encoded — parseHash
// decodes it back.
export function fragmentFor(target: { kind: "comment"; id: number } | { kind: "section"; id: string }): string {
  return target.kind === "comment" ? `comment-${target.id}` : encodeURIComponent(target.id);
}

// Parse a URL hash (with or without the leading '#') into a navigation target.
// Decodes percent-encoding; malformed encoding (a lone '%', a truncated escape in a
// pasted link) is treated as a literal section id rather than throwing. An empty
// fragment is "none" (no selection).
export function parseHash(hash: string): HashTarget {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  let h: string;
  try {
    h = decodeURIComponent(raw);
  } catch {
    h = raw;
  }
  if (!h) return { kind: "none" };
  const m = /^comment-(\d+)$/.exec(h);
  if (m) return { kind: "comment", id: Number(m[1]) };
  return { kind: "section", id: h };
}
