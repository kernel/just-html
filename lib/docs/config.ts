// Document limits + quotas (birthday.md "Limits (v1)"). Single source of truth
// so tuning is a one-line change. Enforced with Postgres counters / row counts;
// no Redis.

// Resource quotas (per user).
export const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB per doc, checked before parse
export const MAX_DOCS_PER_USER = 500; // soft-deleted docs don't count
export const MAX_VERSIONS_PER_DOC = 100; // oldest snapshots pruned beyond this
export const MAX_STORAGE_BYTES_PER_USER = 100 * 1024 * 1024; // 100 MB: current html + retained snapshots

// API rate limits (per API key).
export const RL_CREATES_PER_HOUR = 60; // doc creates
export const RL_WRITES_PER_MIN = 60; // PATCH, /edits, grants, rotate-token
export const RL_READS_PER_MIN = 300; // GET

// Unauthenticated viewer routes (per IP). The sandbox + token model is the real
// protection; this just caps scraping.
export const RL_VIEWER_PER_MIN = 300;

export const ORIGIN = "https://justhtml.sh";

// Title cap — generous, keeps the metadata column sane. Not in the plan's table
// (which only caps html/docs/storage), but a title is metadata we render into a
// man-page <title>; an unbounded title is a footgun. OUR CHOICE.
export const MAX_TITLE_LEN = 300;
