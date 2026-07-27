import {
  decodeMap,
  elementAt,
  parseSource,
  type SourceMap,
  type SrcElement,
} from "@/lib/docs/html-source";
import {
  isPlainRuns,
  renderBlocks,
  renderRuns,
  runsText,
  type BlockIntent,
  type Run,
  type RetagTag,
} from "@/lib/docs/block-render";
import { escapeHtmlText } from "@/lib/docs/inline-edit";

// Structural document operations.
//
// The text-patch engine (lib/docs/edit-diff.ts) changes text; these change
// MARKUP — bold a phrase, make a paragraph a heading, add a block, reorder,
// indent a list item. Each op names an element by the id it was served with
// (lib/docs/html-source.ts) and becomes ONE SPLICE of that element's byte range,
// so the rest of the document is untouched down to the byte, exactly as with a
// text patch.
//
// Two properties do the safety work:
//   - Ops describe INTENT, never markup. Every tag in the output comes from a
//     literal in lib/docs/block-render.ts and every character of author text is
//     escaped, so a viewer cannot inject markup through this route.
//   - Ids are only meaningful against the exact bytes they were derived from, so
//     the caller must send base_version and the store rejects a stale write
//     before applyOps is reached. Text ops additionally carry the text they
//     expect to be replacing, which catches the residual case where the browser's
//     tree and the parser's disagree about child order.

export type OpFailureReason =
  | "unknown_element"
  | "anchor_mismatch"
  | "not_editable"
  | "overlap"
  | "no_change";

/** A structured, actionable op failure (→ HTTP 422 with the failing op's index). */
export class OpApplyError extends Error {
  readonly reason: OpFailureReason;
  readonly opIndex: number;

  constructor(reason: OpFailureReason, opIndex: number, message: string) {
    super(message);
    this.name = "OpApplyError";
    this.reason = reason;
    this.opIndex = opIndex;
  }
}

export type Op =
  /** Replace one text child of an element. `before` is the text it must currently hold. */
  | { op: "setRuns"; src: number; child: number; before: string; runs: Run[] }
  /** Replace an element's entire inline content. */
  | { op: "setInline"; src: number; runs: Run[] }
  /** Replace an element's content with plain text (code blocks). */
  | { op: "setText"; src: number; text: string }
  /** Drop an element's tags, keeping its content verbatim (un-bold, un-link). */
  | { op: "unwrap"; src: number }
  /** Rename an element, keeping its attributes and content verbatim. */
  | { op: "retag"; src: number; tag: RetagTag }
  /** Replace an element outright with newly rendered blocks. */
  | { op: "replaceWith"; src: number; blocks: BlockIntent[] }
  /** Wrap an element in new container tags (paragraph → list item in a list). */
  | { op: "wrap"; src: number; tags: WrapTag[] }
  | { op: "insert"; src: number; where: "before" | "after" | "append"; blocks: BlockIntent[] }
  | { op: "delete"; src: number }
  /** Reposition an element within `parent`, after `after` (or first when null). */
  | { op: "move"; src: number; parent: number; after: number | null }
  /** Nest a list item under the preceding one. */
  | { op: "indent"; src: number }
  /** Lift a nested list item out to its grandparent list. */
  | { op: "outdent"; src: number }
  /** Append a row with the same cell count to the table holding this row. */
  | { op: "insertRow"; src: number }
  /**
   * Break a block in two at a caret. `container`/`child` name the text node the
   * caret is in and `before` is the text that node must currently hold; `tag` is
   * what the second half becomes.
   *
   * Two forms. With `offset`, the node is CUT at that character and both halves
   * keep their bytes exactly — which is what makes Enter work in a block holding
   * markup this editor could never re-render. With `head`/`tail`, the node is
   * replaced by the two halves' new content, which is how a split carries
   * uncommitted typing and resolves markdown in the same write.
   */
  | {
      op: "splitAt";
      src: number;
      container: number;
      child: number;
      before: string;
      tag: RetagTag;
      offset?: number;
      head?: Run[];
      tail?: Run[];
    };

export const WRAP_TAGS = ["ul", "ol", "blockquote"] as const;
export type WrapTag = (typeof WRAP_TAGS)[number];

export const MAX_OPS_PER_REQUEST = 50;

/**
 * Subtrees an inline edit never reaches, whatever id it was given. Checked over
 * the whole ancestor chain: the content of a <script> or <head> is machinery, not
 * prose, and neither it nor anything nested in it is the author's text.
 */
const OFF_LIMITS = new Set(["script", "style", "head", "title", "template"]);

/** Elements that can hold new content but must never be renamed or removed. */
const STRUCTURAL = new Set(["body", "html", "head"]);

type Splice = {
  start: number;
  end: number;
  text: string;
  focus?: boolean;
  /** Where in `text` the new element starts, when it isn't the first tag there. */
  focusIn?: number;
};

function fail(reason: OpFailureReason, i: number, message: string): never {
  throw new OpApplyError(reason, i, message);
}

function need(map: SourceMap, id: number, i: number): SrcElement {
  const el = elementAt(map, id);
  if (!el) fail("unknown_element", i, `Op ${i} names element ${id}, which is not in this version.`);
  return el;
}

/** Reject ops aimed at the document's machinery rather than its content. */
function editable(map: SourceMap, el: SrcElement, i: number): SrcElement {
  for (let cur: SrcElement | null = el; cur; cur = cur.parent === null ? null : map.elements[cur.parent]) {
    if (OFF_LIMITS.has(cur.tag)) {
      fail("not_editable", i, `Op ${i} targets <${cur.tag}>, which inline editing does not modify.`);
    }
  }
  return el;
}

/** As `editable`, and also refuses the page scaffolding itself. */
function reshapeable(map: SourceMap, el: SrcElement, i: number): SrcElement {
  editable(map, el, i);
  if (STRUCTURAL.has(el.tag)) {
    fail("not_editable", i, `Op ${i} would restructure <${el.tag}>, which inline editing does not modify.`);
  }
  return el;
}

/** The element's start offset, plus any blank line that exists only to hold it. */
function startWithLeadingBlank(html: string, start: number): number {
  let p = start;
  while (p > 0 && (html[p - 1] === " " || html[p - 1] === "\t")) p--;
  return p > 0 && html[p - 1] === "\n" ? p - 1 : start;
}

/**
 * Replace a text node's source, keeping the parts the author did not touch. The
 * common prefix and suffix are matched in DECODED characters and mapped back
 * through the entity map, so editing the tail of `R&amp;D and more` rewrites
 * only the tail and leaves `&amp;` spelled the way it was written.
 */
function spliceTextChild(
  html: string,
  start: number,
  end: number,
  before: string,
  runs: Run[],
  i: number
): Splice {
  const dm = decodeMap(html.slice(start, end));
  if (dm.text !== before) {
    fail("anchor_mismatch", i, `Op ${i} expected different text at this position; reload and retry.`);
  }
  const rendered = renderRuns(runs);
  if (!isPlainRuns(runs)) return { start, end, text: rendered };

  const after = runsText(runs);
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) {
    s++;
  }
  // A split point is only usable if it sits on an entity boundary — decoded
  // characters that came from the same `&…;` all map to its start offset, and
  // slicing between them would drop it.
  const cleanCut = (k: number) => k === 0 || k === dm.text.length || dm.at[k] > dm.at[k - 1];
  const cut = before.length - s;
  if (!cleanCut(p) || !cleanCut(cut)) return { start, end, text: rendered };

  return {
    start: start + dm.at[p],
    end: start + dm.at[cut],
    text: escapeHtmlText(after.slice(p, after.length - s)),
  };
}

/**
 * A start tag with any id attribute removed. Splitting a block copies its start
 * tag so the second half keeps the class that styles it, but an id is unique by
 * definition and duplicating it would break every anchor and selector using it.
 */
function startTagWithoutId(tag: string): string {
  return tag.replace(/\s+id\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "");
}

/** Whether `el` is `ancestor`, or sits inside it. */
function within(map: SourceMap, el: SrcElement, ancestor: SrcElement): boolean {
  for (let c: SrcElement | null = el; c; c = c.parent === null ? null : map.elements[c.parent]) {
    if (c.id === ancestor.id) return true;
  }
  return false;
}

/** The element children of an element, in source order. */
function elementChildren(map: SourceMap, el: SrcElement): SrcElement[] {
  const out: SrcElement[] = [];
  for (const c of el.children) if (c.kind === "element" && c.id !== undefined) out.push(map.elements[c.id]);
  return out;
}

function opSplices(map: SourceMap, op: Op, i: number): Splice[] {
  const html = map.html;
  switch (op.op) {
    case "setRuns": {
      const el = editable(map, need(map, op.src, i), i);
      const child = el.children[op.child];
      if (!child || child.kind !== "text") {
        fail("unknown_element", i, `Op ${i} names child ${op.child} of element ${op.src}, which is not text.`);
      }
      return [spliceTextChild(html, child.start, child.end, op.before, op.runs, i)];
    }
    case "setInline": {
      const el = editable(map, need(map, op.src, i), i);
      return [{ start: el.innerStart, end: el.innerEnd, text: renderRuns(op.runs) }];
    }
    case "setText": {
      const el = editable(map, need(map, op.src, i), i);
      return [{ start: el.innerStart, end: el.innerEnd, text: escapeHtmlText(op.text) }];
    }
    case "unwrap": {
      const el = reshapeable(map, need(map, op.src, i), i);
      if (el.innerEnd === el.innerStart && el.end === el.innerStart) {
        fail("not_editable", i, `Op ${i} cannot unwrap <${el.tag}>, which has no content.`);
      }
      return [{ start: el.start, end: el.end, text: html.slice(el.innerStart, el.innerEnd) }];
    }
    case "retag": {
      const el = reshapeable(map, need(map, op.src, i), i);
      const splices: Splice[] = [
        { start: el.start, end: el.start + 1 + el.tag.length, text: `<${op.tag}` },
      ];
      // An implicitly closed element (`<li>a<li>b`) has no end tag to rename, so
      // give the renamed one an explicit close rather than leaving `<p>` inside a
      // list to be re-nested by the next parser that sees it.
      splices.push(
        el.hasEndTag
          ? { start: el.innerEnd, end: el.end, text: `</${op.tag}>` }
          : { start: el.innerEnd, end: el.innerEnd, text: `</${op.tag}>` }
      );
      return splices;
    }
    case "replaceWith": {
      const el = reshapeable(map, need(map, op.src, i), i);
      return [{ start: el.start, end: el.end, text: renderBlocks(op.blocks).slice(1), focus: true }];
    }
    case "wrap": {
      const el = reshapeable(map, need(map, op.src, i), i);
      const open = op.tags.map((t) => `<${t}>`).join("");
      const close = [...op.tags].reverse().map((t) => `</${t}>`).join("");
      return [
        { start: el.start, end: el.start, text: open },
        { start: el.end, end: el.end, text: close },
      ];
    }
    case "insert": {
      const el = editable(map, need(map, op.src, i), i);
      const at = op.where === "before" ? el.start : op.where === "after" ? el.end : el.innerEnd;
      // renderBlocks opens with a newline. Landing right after one — appending at
      // the end of a body written across lines — would leave a blank line, so
      // move that newline to the far side and keep the document's line structure.
      const rendered = renderBlocks(op.blocks);
      const text = html[at - 1] === "\n" ? `${rendered.slice(1)}\n` : rendered;
      return [{ start: at, end: at, text, focus: true }];
    }
    case "delete": {
      const el = reshapeable(map, need(map, op.src, i), i);
      return [{ start: startWithLeadingBlank(html, el.start), end: el.end, text: "" }];
    }
    case "move": {
      const el = reshapeable(map, need(map, op.src, i), i);
      const parent = editable(map, need(map, op.parent, i), i);
      const at = op.after === null ? parent.innerStart : editable(map, need(map, op.after, i), i).end;
      if (at > el.start && at < el.end) {
        fail("not_editable", i, `Op ${i} would move element ${op.src} inside itself.`);
      }
      const moved = html.slice(el.start, el.end);
      return [
        { start: startWithLeadingBlank(html, el.start), end: el.end, text: "" },
        { start: at, end: at, text: `\n${moved}`, focus: true },
      ];
    }
    case "indent": {
      const el = reshapeable(map, need(map, op.src, i), i);
      const parent = el.parent === null ? null : map.elements[el.parent];
      if (el.tag !== "li" || !parent || (parent.tag !== "ul" && parent.tag !== "ol")) {
        fail("not_editable", i, `Op ${i} can only indent a list item.`);
      }
      const siblings = elementChildren(map, parent);
      const pos = siblings.findIndex((s) => s.id === el.id);
      const prev = pos > 0 ? siblings[pos - 1] : null;
      if (!prev) fail("not_editable", i, `Op ${i} cannot indent the first item in a list.`);
      // Join an existing sublist rather than starting a second one next to it.
      const prevKids = elementChildren(map, prev);
      const sublist = prevKids.length ? prevKids[prevKids.length - 1] : null;
      const nest = sublist && (sublist.tag === "ul" || sublist.tag === "ol") ? sublist : null;
      const moved = html.slice(el.start, el.end);
      const insert = nest
        ? { start: nest.innerEnd, end: nest.innerEnd, text: `\n${moved}`, focus: true }
        : {
            start: prev.innerEnd,
            end: prev.innerEnd,
            text: `\n<${parent.tag}>\n${moved}\n</${parent.tag}>`,
            focus: true,
          };
      return [{ start: startWithLeadingBlank(html, el.start), end: el.end, text: "" }, insert];
    }
    case "outdent": {
      const el = reshapeable(map, need(map, op.src, i), i);
      const list = el.parent === null ? null : map.elements[el.parent];
      const outerItem = list && list.parent !== null ? map.elements[list.parent] : null;
      if (el.tag !== "li" || !list || (list.tag !== "ul" && list.tag !== "ol") || outerItem?.tag !== "li") {
        fail("not_editable", i, `Op ${i} can only outdent a nested list item.`);
      }
      const moved = html.slice(el.start, el.end);
      const siblings = elementChildren(map, list);
      // Taking the last item out leaves an empty list; remove the list with it.
      const removal =
        siblings.length === 1
          ? { start: startWithLeadingBlank(html, list.start), end: list.end, text: "" }
          : { start: startWithLeadingBlank(html, el.start), end: el.end, text: "" };
      return [removal, { start: outerItem.end, end: outerItem.end, text: `\n${moved}`, focus: true }];
    }
    case "splitAt": {
      const block = reshapeable(map, need(map, op.src, i), i);
      const container = editable(map, need(map, op.container, i), i);
      if (!within(map, container, block)) {
        fail("not_editable", i, `Op ${i} splits at a position outside the block it names.`);
      }
      const child = container.children[op.child];
      if (!child || child.kind !== "text") {
        fail("unknown_element", i, `Op ${i} names child ${op.child} of element ${op.container}, which is not text.`);
      }
      const dm = decodeMap(html.slice(child.start, child.end));
      if (dm.text !== op.before) {
        fail("anchor_mismatch", i, `Op ${i} expected different text at the split point; reload and retry.`);
      }

      // Inline elements the caret sits inside have to be closed before the block
      // ends and reopened inside the new one, or both halves are unbalanced.
      const chain: SrcElement[] = [];
      for (
        let c: SrcElement | null = container;
        c && c.id !== block.id;
        c = c.parent === null ? null : map.elements[c.parent]
      ) {
        chain.push(c);
      }
      const close = chain.map((e) => `</${e.tag}>`).join("");
      const reopen = [...chain].reverse().map((e) => html.slice(e.start, e.innerStart)).join("");
      const startTag =
        op.tag === block.tag
          ? startTagWithoutId(html.slice(block.start, block.innerStart))
          : `<${op.tag}>`;
      const boundary = `${close}</${block.tag}>\n${startTag}${reopen}`;
      const focusIn = close.length + `</${block.tag}>\n`.length;

      let splice: Splice;
      if (op.head || op.tail) {
        const head = renderRuns(op.head ?? []);
        splice = {
          start: child.start,
          end: child.end,
          text: `${head}${boundary}${renderRuns(op.tail ?? [])}`,
          focus: true,
          focusIn: head.length + focusIn,
        };
      } else {
        const at = op.offset ?? 0;
        const clean =
          at >= 0 && at <= dm.text.length && (at === 0 || at === dm.text.length || dm.at[at] > dm.at[at - 1]);
        if (!clean) fail("anchor_mismatch", i, `Op ${i} splits inside a character reference; reload and retry.`);
        const cut = child.start + dm.at[at];
        splice = { start: cut, end: cut, text: boundary, focus: true, focusIn };
      }

      const splices: Splice[] = [splice];
      // The block's own end tag now closes the SECOND half, so it has to be
      // renamed too — otherwise splitting an <h2> into a <p> leaves `</h2>`
      // closing it.
      if (op.tag !== block.tag) {
        splices.push({
          start: block.innerEnd,
          end: block.hasEndTag ? block.end : block.innerEnd,
          text: `</${op.tag}>`,
        });
      }
      return splices;
    }
    case "insertRow": {
      const el = reshapeable(map, need(map, op.src, i), i);
      if (el.tag !== "tr") fail("not_editable", i, `Op ${i} can only add a row after a table row.`);
      const cells = elementChildren(map, el).filter((c) => c.tag === "td" || c.tag === "th").length;
      const row = `\n  <tr>${"<td></td>".repeat(Math.max(1, cells))}</tr>`;
      return [{ start: el.end, end: el.end, text: row, focus: true }];
    }
  }
}

/**
 * Apply ops to a document. Returns the new html and, when an op created content,
 * the id of the new element in the RESULT — the caller hands that back to the
 * viewer so it can put the caret there once it has reloaded against the new
 * bytes (every id shifts when the document's length changes).
 */
export function applyOps(html: string, ops: Op[]): { html: string; focus?: number } {
  const map = parseSource(html);
  const splices: Splice[] = [];
  for (let i = 0; i < ops.length; i++) splices.push(...opSplices(map, ops[i], i));

  // Two ops rewriting the same bytes would silently drop one of them.
  const ordered = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (prev.end > cur.start && prev.start < cur.end) {
      throw new OpApplyError("overlap", 0, "Two edits in this request change the same content.");
    }
  }

  // Apply back-to-front so earlier offsets stay valid. Ties put the wider splice
  // first, which lets `wrap` add its opening tag in front of a `retag` at the
  // same position.
  const applied = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = html;
  for (const s of applied) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  if (out === html) throw new OpApplyError("no_change", 0, "The edits produced no change.");

  const focusSplice = splices.find((s) => s.focus);
  let focus: number | undefined;
  if (focusSplice) {
    // Everything spliced before the new content shifts it; nothing after it does.
    const shift = splices
      .filter((s) => s !== focusSplice && s.start < focusSplice.start)
      .reduce((sum, s) => sum + (s.text.length - (s.end - s.start)), 0);
    const at =
      focusSplice.start +
      shift +
      (focusSplice.focusIn ?? Math.max(0, focusSplice.text.indexOf("<")));
    focus = parseSource(out).elements.find((e) => e.start === at)?.id;
  }
  return { html: out, focus };
}
