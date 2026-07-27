import { parseDocument } from "htmlparser2";
import type { Document, Element, Node } from "domhandler";

// Source-position map for a stored document.
//
// Inline editing patches text by exact match (lib/docs/inline-edit.ts). That is
// enough to change a run of text but not to change MARKUP: bolding a phrase,
// turning a paragraph into a heading, or adding a block all need to know where
// an element BEGINS AND ENDS in the stored bytes. This module answers that.
//
// Every element gets a stable id (its index in document order) plus the byte
// ranges of its whole self and of its inner content, so an edit becomes a splice
// of one range — everything outside it stays byte-for-byte identical, which is
// the same guarantee the text-patch path gives and the reason /d/:slug/raw can
// serve the author's bytes.
//
// The ids reach the browser through annotateSource(), which writes them into the
// start tags of the OVERLAY-EMBEDDED copy only (app/d/[slug]/raw/route.ts already
// injects the overlay script into that variant; a direct /raw fetch stays
// pristine). The viewer then names an element by id and the server re-derives the
// same map from the stored html — same input, same ids. base_version makes that
// agreement safe: if the doc moved under the viewer, the write is rejected as
// stale before any id is dereferenced.
//
// WHY htmlparser2 AND NOT A DOM: we need byte offsets into the ORIGINAL source,
// which a re-serializing parser cannot give. htmlparser2 reports them directly
// and is already in the tree (via resend). It is not a spec-compliant tree
// builder — it does not synthesize <tbody>, and it nests differently from a
// browser on malformed input — but that costs us nothing here, because the
// browser learns an element's id from an ATTRIBUTE we spliced into its start tag,
// not from tree position. Tree shape only matters for addressing a text node by
// its index among its parent's children, and that is verified against the
// caller's expected text before anything is written.

/** Elements with no end tag; their content range is empty. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

export type SrcChild = {
  kind: "element" | "text" | "other";
  /** Set when kind === "element". */
  id?: number;
  start: number;
  /** Exclusive. */
  end: number;
};

export type SrcElement = {
  /** Index in document order — the id the browser sees as data-jh-src. */
  id: number;
  tag: string;
  /** Offset of the start tag's "<". */
  start: number;
  /** Exclusive end of the whole element. */
  end: number;
  /** Offset just past the start tag's ">". */
  innerStart: number;
  /** Offset of the end tag's "<" (=== innerStart for void/implied-close). */
  innerEnd: number;
  /** False when the element was closed implicitly (`<li>a<li>b`) or not at all. */
  hasEndTag: boolean;
  parent: number | null;
  children: SrcChild[];
};

export type SourceMap = {
  html: string;
  /** Indexed by id. */
  elements: SrcElement[];
};

function isElement(n: Node): n is Element {
  return n.type === "tag" || n.type === "script" || n.type === "style";
}

/**
 * Offset just past the ">" that closes the start tag beginning at `start`.
 * Quoted attribute values may contain ">" (`<p title="a>b">`), so this tracks
 * quoting rather than scanning for the first ">".
 */
function endOfStartTag(html: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return html.length;
}

/** Length of the end tag `</tag  >` at `pos`, or 0 if there isn't one. */
function endTagLength(html: string, pos: number, tag: string): number {
  if (html[pos] !== "<" || html[pos + 1] !== "/") return 0;
  let i = pos + 2;
  if (html.slice(i, i + tag.length).toLowerCase() !== tag) return 0;
  i += tag.length;
  while (i < html.length && /\s/.test(html[i])) i++;
  if (html[i] !== ">") return 0;
  return i + 1 - pos;
}

/**
 * Build the map. Element extents are derived here rather than taken from
 * htmlparser2's endIndex, which reports the CLOSING TRIGGER for implicitly
 * closed elements — for `<p>a<p>b` it hands back a range for the first <p> that
 * swallows the second one's start tag, so the two ranges overlap and splicing
 * either would corrupt the other.
 */
export function parseSource(html: string): SourceMap {
  const doc: Document = parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
  });
  const elements: SrcElement[] = [];

  const walk = (node: Node, parent: number | null): SrcChild => {
    if (!isElement(node)) {
      const start = node.startIndex ?? 0;
      return { kind: node.type === "text" ? "text" : "other", start, end: (node.endIndex ?? start) + 1 };
    }
    const start = node.startIndex ?? 0;
    const tag = node.name.toLowerCase();
    const innerStart = endOfStartTag(html, start);
    const id = elements.length;
    // Reserve the slot before recursing so child ids follow document order.
    const rec: SrcElement = {
      id, tag, start, end: innerStart, innerStart, innerEnd: innerStart,
      hasEndTag: false, parent, children: [],
    };
    elements.push(rec);

    if (VOID_TAGS.has(tag) || html[innerStart - 2] === "/") return { kind: "element", id, start, end: innerStart };

    for (const child of node.children) rec.children.push(walk(child, id));
    const lastEnd = rec.children.length ? rec.children[rec.children.length - 1].end : innerStart;
    const closeLen = endTagLength(html, lastEnd, tag);
    rec.innerEnd = lastEnd;
    rec.hasEndTag = closeLen > 0;
    rec.end = lastEnd + closeLen;
    return { kind: "element", id, start, end: rec.end };
  };

  for (const child of doc.children) walk(child, null);
  // Element extents are finalized on the way back up, so patch the child records
  // that were written with the provisional end (only elements can be affected).
  for (const el of elements) {
    for (const c of el.children) {
      if (c.kind === "element" && c.id !== undefined) c.end = elements[c.id].end;
    }
  }
  return { html, elements };
}

export function elementAt(map: SourceMap, id: number): SrcElement | null {
  return Number.isInteger(id) && id >= 0 && id < map.elements.length ? map.elements[id] : null;
}

/** The attribute carrying an element's id in the overlay-embedded copy. */
export const SRC_ATTR = "data-jh-src";

/**
 * Splice `data-jh-src="<id>"` into every start tag. Applied only to the
 * ?overlay=1 variant of /d/:slug/raw, which is already the non-pristine copy
 * (it carries the overlay script); the stored bytes and a direct /raw fetch are
 * untouched. Written immediately after the tag name so it wins over an
 * identically-named attribute an author may have authored themselves.
 */
export function annotateSource(html: string, map?: SourceMap): string {
  const m = map ?? parseSource(html);
  const out: string[] = [];
  let cursor = 0;
  // Ascending by start: element order in `elements` is document order, and a
  // parent's start always precedes its children's.
  for (const el of m.elements) {
    const nameEnd = el.start + 1 + el.tag.length;
    out.push(html.slice(cursor, nameEnd), ` ${SRC_ATTR}="${el.id}"`);
    cursor = nameEnd;
  }
  out.push(html.slice(cursor));
  return out.join("");
}

// --- entities -------------------------------------------------------------

// The parser hands back DECODED text ("&amp;" → "&"), but an edit has to splice
// SOURCE offsets. decodeMap walks a source slice and records, for each decoded
// character, where it came from — so an edit that changes the middle of a text
// node can leave the author's entity spellings on either side untouched.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·",
  times: "×", divide: "÷", deg: "°", plusmn: "±",
  laquo: "«", raquo: "»", dagger: "†", sect: "§",
  para: "¶", euro: "€", pound: "£", yen: "¥",
  cent: "¢", frac12: "½", frac14: "¼", ldots: "…",
  larr: "←", rarr: "→", harr: "↔", minus: "−",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", shy: "\u00ad",
};

export type DecodeMap = {
  /** The decoded text. */
  text: string;
  /** at[i] is the source offset (relative to the slice) of decoded char i; at[text.length] is the slice length. */
  at: number[];
};

/** Decode a source slice, recording where each decoded character came from. */
export function decodeMap(source: string): DecodeMap {
  let text = "";
  const at: number[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "&") {
      const semi = source.indexOf(";", i + 1);
      if (semi > i && semi - i <= 12) {
        const body = source.slice(i + 1, semi);
        let decoded: string | undefined;
        if (body[0] === "#") {
          const code = body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
          if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
            decoded = String.fromCodePoint(code);
          }
        } else if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(body)) {
          decoded = NAMED_ENTITIES[body];
        }
        if (decoded !== undefined) {
          for (const ch of decoded) {
            text += ch;
            at.push(i);
          }
          i = semi + 1;
          continue;
        }
      }
    }
    text += source[i];
    at.push(i);
    i++;
  }
  at.push(source.length);
  return { text, at };
}
