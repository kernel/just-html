import type { BlockIntent, Mark, Run } from "@/lib/docs/block-render";

// Markdown as an INPUT METHOD.
//
// justhtml documents are html; markdown is only how a person types. Writing
// `**done**` in the viewer stores `<strong>done</strong>` and from then on the
// document knows nothing about asterisks — there is no round trip back, and
// re-editing that phrase shows bold text, not markup. That is the whole design:
// markdown here is a keyboard shortcut, not a storage format.
//
// These parsers are deliberately small and self-contained. They run in two
// places: on the server for tests, and inside the sandboxed iframe, where the
// overlay is a stringified script that cannot import anything. MARKDOWN_INPUT_SOURCE
// ships their source into the overlay, which is why mdBlocks takes the inline
// parser as an argument rather than referring to it by name — a minified build
// renames the declaration, and a named function expression assigned to our own
// variable is the form that survives that.

/** Parse inline markdown into runs. Code spans win; nothing nests inside them. */
export function mdInline(text: string): Run[] {
  const runs: Run[] = [];
  let plain = "";
  const flush = () => {
    if (plain) runs.push({ kind: "text", text: plain });
    plain = "";
  };
  const token =
    /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\n]+?)\*|(?<![a-zA-Z0-9])_([^_\n]+?)_(?![a-zA-Z0-9])|\[([^\]\n]*)\]\(([^)\s]+)\)|(?<![\w@/.-])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/;

  let rest = text;
  while (rest) {
    const m = token.exec(rest);
    if (!m || m.index === undefined) break;
    plain += rest.slice(0, m.index);
    const marked = (body: string, marks: Mark[]) => {
      flush();
      runs.push({ kind: "text", text: body, marks });
    };
    if (m[2] !== undefined) marked(m[2], ["code"]);
    else if (m[3] !== undefined) marked(m[3], ["strong"]);
    else if (m[4] !== undefined) marked(m[4], ["strong"]);
    else if (m[5] !== undefined) marked(m[5], ["del"]);
    else if (m[6] !== undefined) marked(m[6], ["em"]);
    else if (m[7] !== undefined) marked(m[7], ["em"]);
    else if (m[9] !== undefined) {
      flush();
      runs.push({ kind: "text", text: m[8] || m[9], href: m[9] });
    } else if (m[10] !== undefined) {
      flush();
      runs.push({ kind: "text", text: m[10], href: m[10] });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  plain += rest;
  flush();
  return runs;
}

/**
 * Parse a block of markdown text — a paste, typically — into blocks. `inline` is
 * mdInline; it is passed in so this survives being stringified into the overlay.
 */
export function mdBlocks(text: string, inline: (s: string) => Run[]): BlockIntent[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockIntent[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ tag: "p", runs: inline(para.join(" ")) });
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ tag: "blockquote", runs: inline(quote.join(" ")) });
    quote = [];
  };
  const flush = () => {
    flushPara();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !new RegExp("^\\s*" + fence[1]).test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ tag: "pre", code: code.join("\n") });
      continue;
    }
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ tag: "hr" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const tag = `h${heading[1].length}` as "h1";
      blocks.push({ tag, runs: inline(heading[2].trim()) });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const tag = bullet ? "ul" : "ol";
      const items: Run[][] = [];
      for (; i < lines.length; i++) {
        const item = (bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/).exec(lines[i]);
        if (!item) break;
        items.push(inline(item[1]));
      }
      i--;
      blocks.push({ tag, items });
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushPara();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/**
 * Block-level shortcuts recognised WHILE TYPING at the start of a block: the
 * prefix the author typed, and what the block should become. Returns null when
 * the text isn't a shortcut. `hr` and `pre` replace the block; the rest retag it.
 */
export function mdBlockShortcut(
  text: string
): { kind: "heading"; level: number; rest: string } | { kind: "ul" | "ol" | "quote" | "pre" | "hr"; rest: string } | null {
  const heading = /^(#{1,6})\s(.*)$/.exec(text);
  if (heading) return { kind: "heading", level: heading[1].length, rest: heading[2] };
  const bullet = /^[-*+]\s(.*)$/.exec(text);
  if (bullet) return { kind: "ul", rest: bullet[1] };
  const numbered = /^\d+[.)]\s(.*)$/.exec(text);
  if (numbered) return { kind: "ol", rest: numbered[1] };
  const quoted = /^>\s(.*)$/.exec(text);
  if (quoted) return { kind: "quote", rest: quoted[1] };
  if (/^```$/.test(text)) return { kind: "pre", rest: "" };
  if (/^(---|\*\*\*)$/.test(text)) return { kind: "hr", rest: "" };
  return null;
}

/**
 * The parsers' own source, for injection into the sandboxed overlay. Assigned to
 * overlay-local variables so a minified build's renamed declarations still bind.
 */
export const MARKDOWN_INPUT_SOURCE = [
  `var mdInline = ${mdInline.toString()};`,
  `var mdBlocksRaw = ${mdBlocks.toString()};`,
  `var mdBlocks = function(t){ return mdBlocksRaw(t, mdInline); };`,
  `var mdBlockShortcut = ${mdBlockShortcut.toString()};`,
].join("\n");
