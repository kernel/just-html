import { escapeHtmlText } from "@/lib/docs/inline-edit";

// Rendering the editor's INTENT into html.
//
// The viewer never sends markup. Bolding a phrase, converting a paragraph to a
// heading, pasting markdown — all of it arrives as a description of what the
// author meant ("this run of text, marked strong"), and this module is the only
// place that turns such a description into tags. That keeps the set of markup
// inline editing can produce small, fixed, and testable, and means there is no
// html-sanitizing to get wrong: user text is always escaped, and every tag comes
// from a literal in this file.

/** Character-level marks the editor can apply. Rendered innermost-first. */
export const MARKS = ["strong", "em", "del", "code"] as const;
export type Mark = (typeof MARKS)[number];

export type Run =
  | { kind: "text"; text: string; marks?: Mark[]; href?: string }
  | { kind: "br" }
  | { kind: "img"; src: string; alt?: string };

/** Blocks with inline content. */
export const TEXT_BLOCKS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "li", "dt", "dd", "figcaption",
  "td", "th", "caption", "summary",
] as const;
export type TextBlockTag = (typeof TEXT_BLOCKS)[number];

export type BlockIntent =
  | { tag: TextBlockTag; runs: Run[] }
  | { tag: "ul" | "ol"; items: Run[][] }
  | { tag: "pre"; code: string }
  | { tag: "hr" }
  | { tag: "table"; rows: number; cols: number };

// Payload caps for one op. Generous for prose, small enough that a malformed or
// hostile request cannot make the server render an enormous string before the
// 2 MB per-doc check rejects the result.
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_COLS = 12;
export const MAX_RUN_TEXT = 20_000;
export const MAX_RUNS_PER_BLOCK = 400;
export const MAX_LIST_ITEMS = 200;
export const MAX_CODE_LEN = 100_000;
export const MAX_HREF_LEN = 2_048;
export const MAX_ALT_LEN = 500;
export const MAX_BLOCKS_PER_INSERT = 100;

const TEXT_BLOCK_SET: ReadonlySet<string> = new Set(TEXT_BLOCKS);
const MARK_SET: ReadonlySet<string> = new Set(MARKS);

export function isTextBlockTag(tag: string): tag is TextBlockTag {
  return TEXT_BLOCK_SET.has(tag);
}

export function isMark(m: string): m is Mark {
  return MARK_SET.has(m);
}

/**
 * Tags an element may be renamed to in place, keeping its children. The text
 * blocks (a paragraph becoming a heading) plus ul↔ol, whose child model is the
 * same. Anything else — a paragraph becoming a code block — changes what the
 * children have to be, so it goes through replaceWith, which renders the new
 * structure explicitly.
 */
export const RETAG_TAGS = [...TEXT_BLOCKS, "ul", "ol"] as const;
export type RetagTag = (typeof RETAG_TAGS)[number];

/**
 * Keep a link's scheme to ones that are inert when clicked. Rejects `javascript:`
 * and `data:` outright rather than trying to neutralize them. Relative URLs,
 * fragments and query-only links pass through.
 */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Strip control characters first: "java\nscript:x" is a scheme to a browser.
  const bare = trimmed.replace(/[\u0000-\u0020]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(bare);
  if (!scheme) return trimmed;
  const ok = ["http", "https", "mailto", "tel", "ftp"];
  return ok.includes(scheme[1].toLowerCase()) ? trimmed : null;
}

function escapeAttr(s: string): string {
  return escapeHtmlText(s).replace(/"/g, "&quot;");
}

/** Render one run. Marks nest in a fixed order so output is deterministic. */
function renderRun(run: Run): string {
  if (run.kind === "br") return "<br>";
  if (run.kind === "img") {
    const src = safeHref(run.src);
    if (!src) return run.alt ? escapeHtmlText(run.alt) : "";
    const alt = run.alt ? ` alt="${escapeAttr(run.alt)}"` : "";
    return `<img src="${escapeAttr(src)}"${alt}>`;
  }
  let out = escapeHtmlText(run.text);
  // Innermost first: MARKS is ordered so `code` hugs the text.
  for (let i = MARKS.length - 1; i >= 0; i--) {
    const mark = MARKS[i];
    if (run.marks?.includes(mark)) out = `<${mark}>${out}</${mark}>`;
  }
  if (run.href) {
    const href = safeHref(run.href);
    if (href) out = `<a href="${escapeAttr(href)}">${out}</a>`;
  }
  return out;
}

export function renderRuns(runs: Run[]): string {
  return runs.map(renderRun).join("");
}

/**
 * True when the runs carry no markup at all — a single unmarked, unlinked text
 * run. Callers use this to take the cheaper text-only write path, which leaves
 * the author's entity spellings alone.
 */
export function isPlainRuns(runs: Run[]): boolean {
  return runs.every(
    (r) => r.kind === "text" && !r.href && (!r.marks || r.marks.length === 0)
  );
}

/** The plain text of a run list, as it would read with all markup removed. */
export function runsText(runs: Run[]): string {
  return runs.map((r) => (r.kind === "text" ? r.text : r.kind === "img" ? "" : "\n")).join("");
}

export function renderBlock(block: BlockIntent): string {
  switch (block.tag) {
    case "hr":
      return "<hr>";
    case "pre":
      return `<pre><code>${escapeHtmlText(block.code)}</code></pre>`;
    case "ul":
    case "ol": {
      const items = block.items.map((runs) => `\n  <li>${renderRuns(runs)}</li>`).join("");
      return `<${block.tag}>${items}\n</${block.tag}>`;
    }
    case "table": {
      const rows = Math.max(1, Math.min(MAX_TABLE_ROWS, block.rows));
      const cols = Math.max(1, Math.min(MAX_TABLE_COLS, block.cols));
      const head = `\n  <tr>${"<th></th>".repeat(cols)}</tr>`;
      const body = Array.from({ length: rows - 1 }, () => `\n  <tr>${"<td></td>".repeat(cols)}</tr>`).join("");
      return `<table>${head}${body}\n</table>`;
    }
    default:
      return `<${block.tag}>${renderRuns(block.runs)}</${block.tag}>`;
  }
}

export function renderBlocks(blocks: BlockIntent[]): string {
  return blocks.map((b) => `\n${renderBlock(b)}`).join("");
}
