// B14 Overlap-semantics QA.
// Usage: node --env-file=.env scripts/qa-b14.mjs
//
// Two layers:
//
//  A) UNIT — the segment-splitting + depth-shading algorithm is the load-bearing
//     B14 logic and lives in the (sandbox-only) overlay JS. We extract the
//     boundary-split + covering-set + depth math here and assert it on the three
//     founder cases: exact-equal, subset, partial intersection. (The overlay can't
//     be reached over HTTP — it runs inside the origin-less iframe — so this is the
//     deterministic check that the geometry is correct.)
//
//  B) END-TO-END — overlap is purely a rendering concern, so the API must keep
//     returning EXACT, un-merged anchors for overlapping comments + reactions on a
//     live production doc. We seed all three overlap cases and assert GET /comments
//     hands the shell everything it needs to paint segments (distinct anchors, not
//     coalesced), plus the optimistic-toggle path on an overlapping span.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = "https://justhtml.sh";
const TS = Date.now().toString(36);
const log = (...a) => console.log(...a);
let PASS = 0, FAIL = 0;
function ok(cond, label, extra) {
  if (cond) { PASS++; log(`  PASS ${label}`); }
  else { FAIL++; log(`  FAIL ${label}${extra !== undefined ? " :: " + JSON.stringify(extra) : ""}`); }
}

// ---------------------------------------------------------------------------
// A) UNIT: re-derive the overlay's segment math (must match lib/docs/overlay.ts).
//    Given items with [start,end), produce painted segments {start,end,cover,depth}.
// ---------------------------------------------------------------------------
function segmentize(items) {
  const bset = {};
  items.forEach((it) => { bset[it.start] = 1; bset[it.end] = 1; });
  const bounds = Object.keys(bset).map(Number).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = bounds[i], e = bounds[i + 1];
    if (e <= s) continue;
    const cover = items.filter((it) => it.start <= s && it.end >= e).map((it) => it.key);
    if (cover.length) out.push({ start: s, end: e, cover, depth: Math.min(3, cover.length) });
  }
  return out;
}

log(`\n==== B14 QA (ts=${TS}) ====`);
log("\n-- A) segment + depth-shading unit tests --");

// exact-equal: two anchors on the SAME span → one region, depth 2 (one segment).
{
  const segs = segmentize([{ key: "a", start: 10, end: 20 }, { key: "b", start: 10, end: 20 }]);
  ok(segs.length === 1 && segs[0].depth === 2 && segs[0].cover.length === 2,
    "exact-equal: single region, depth 2 (multiple attachments, one paint)", segs);
}

// subset: inner anchor inside outer → 3 segments, inner darker (depth 2), ends depth 1.
{
  const segs = segmentize([{ key: "out", start: 0, end: 30 }, { key: "in", start: 10, end: 20 }]);
  const inner = segs.find((s) => s.start === 10 && s.end === 20);
  const left = segs.find((s) => s.start === 0 && s.end === 10);
  const right = segs.find((s) => s.start === 20 && s.end === 30);
  ok(segs.length === 3 && inner && inner.depth === 2 && left.depth === 1 && right.depth === 1,
    "subset: inner darker (depth 2), outer ends lighter (depth 1)", segs);
  ok(inner.cover.includes("in") && inner.cover.includes("out"),
    "subset: inner segment covered by BOTH anchors", inner);
}

// partial intersection: shared middle darker, ends lighter.
{
  const segs = segmentize([{ key: "x", start: 0, end: 20 }, { key: "y", start: 10, end: 30 }]);
  const mid = segs.find((s) => s.start === 10 && s.end === 20);
  ok(segs.length === 3 && mid && mid.depth === 2 && mid.cover.length === 2,
    "partial intersection: shared middle depth 2, ends depth 1", segs);
}

// depth cap at 3: four anchors on one span → depth capped at 3.
{
  const segs = segmentize([
    { key: "a", start: 0, end: 10 }, { key: "b", start: 0, end: 10 },
    { key: "c", start: 0, end: 10 }, { key: "d", start: 0, end: 10 },
  ]);
  ok(segs.length === 1 && segs[0].cover.length === 4 && segs[0].depth === 3,
    "depth cap: 4 covering anchors → depth clamped to 3 (darkest)", segs);
}

// smallest-covering ordering (the focus model picks the smallest span first).
{
  const items = { out: { start: 0, end: 30 }, in: { start: 10, end: 20 } };
  const order = ["out", "in"].sort((ka, kb) => (items[ka].end - items[ka].start) - (items[kb].end - items[kb].start));
  ok(order[0] === "in", "focus order: smallest covering anchor first (subset before superset)", order);
}

// Sanity: the production overlay file actually contains the segment-painting core
// (guards against a regression to nested-wrapper logic).
{
  const src = readFileSync(new URL("../lib/docs/overlay.ts", import.meta.url), "utf8");
  ok(/data-jh-seg/.test(src) && /data-cover/.test(src) && /Math\.min\(3, ?cover\.length\)|Math\.min\(3, ?seg\.cover\.length\)/.test(src),
    "overlay.ts uses segment painting (data-jh-seg + data-cover + depth cap 3)",
    { hasSeg: /data-jh-seg/.test(src), hasCover: /data-cover/.test(src) });
  ok(/jh:focus/.test(src) && /showPickPop/.test(src) && /Escape/.test(src),
    "overlay.ts implements focus model (jh:focus, 3+ picker popover, Esc clear)");
  ok(!/data-jh-hl/.test(src), "overlay.ts no longer uses the old nested-wrapper data-jh-hl logic");
}

// ---------------------------------------------------------------------------
// B) END-TO-END against production: overlapping anchors round-trip via the API.
// ---------------------------------------------------------------------------
log("\n-- B) production API: overlapping anchors round-trip --");

async function jreq(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const auth = (k) => ({ Authorization: `Bearer ${k}` });

const ownerEmail = `raf+qa-b14-owner-${TS}@kernel.sh`;
const otherEmail = `raf+qa-b14-other-${TS}@kernel.sh`;
const seeded = JSON.parse(
  execFileSync("node", ["--env-file=.env", "scripts/qa-b10-seed.mjs", ownerEmail, otherEmail], { encoding: "utf8" }).trim()
);
const OWNER = seeded[ownerEmail];
const OTHER = seeded[otherEmail];

// A doc whose body has a sentence we can carve overlapping spans out of.
const sentence = "The quick brown fox jumps over the lazy dog near the riverbank.";
const html = `<h1>overlap</h1><p>${sentence}</p>`;
const created = await jreq("POST", "/api/v1/docs", { html, title: "B14 overlap", public: true }, auth(OWNER));
ok(created.status === 201, "create public doc", created);
const slug = created.json?.slug;

// Three founder cases carved from the sentence:
//   exact-equal : a comment AND a reaction on "brown fox"
//   subset      : comment on "quick brown fox jumps" (outer), reaction on "brown fox" (inner)
//   partial     : comment on "fox jumps over" overlaps reaction on "over the lazy"
const eqSpan   = { exact: "brown fox", prefix: "The quick ", suffix: " jumps over" };
const outerSpan = { exact: "quick brown fox jumps", prefix: "The ", suffix: " over the" };
const innerSpan = { exact: "brown fox", prefix: "The quick ", suffix: " jumps over" }; // == eqSpan quote
const partialC = { exact: "fox jumps over", prefix: "brown ", suffix: " the lazy" };
const partialR = { exact: "over the lazy", prefix: "jumps ", suffix: " dog near" };

// exact-equal: comment + reaction on identical span.
const cEq = await jreq("POST", `/api/v1/docs/${slug}/comments`, { body: "equal-span comment", anchor: eqSpan }, auth(OWNER));
ok(cEq.status === 201, "exact-equal: comment on 'brown fox'", cEq);
const rEq = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🎉", anchor: eqSpan }, auth(OWNER));
ok(rEq.status === 201, "exact-equal: reaction 🎉 on same 'brown fox' span", rEq);

// subset: outer comment, inner reaction (inner already exists as rEq — add a comment outer).
const cOuter = await jreq("POST", `/api/v1/docs/${slug}/comments`, { body: "outer span comment", anchor: outerSpan }, auth(OTHER));
ok(cOuter.status === 201, "subset: outer comment on 'quick brown fox jumps'", cOuter);

// partial intersection: comment + reaction whose spans overlap but neither contains the other.
const cPart = await jreq("POST", `/api/v1/docs/${slug}/comments`, { body: "partial comment", anchor: partialC }, auth(OWNER));
ok(cPart.status === 201, "partial: comment on 'fox jumps over'", cPart);
const rPart = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "👀", anchor: partialR }, auth(OTHER));
ok(rPart.status === 201, "partial: reaction 👀 on 'over the lazy'", rPart);

// GET /comments must return EXACT anchors for ALL of them, un-merged — this is the
// payload the overlay segment-splits. Overlap is rendering-only; the API stays flat.
const g = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
ok(g.status === 200, "GET /comments ok", g.status);
const threads = g.json?.threads || [];
const anchoredComments = threads.filter((t) => t.group === "anchored" && t.anchor);
ok(anchoredComments.length === 3, "3 distinct anchored comments returned (equal, outer, partial) — not merged",
  anchoredComments.map((t) => t.anchor?.exact));

// Each comment carries its exact quote + numeric offsets the overlay uses as hints.
const exacts = anchoredComments.map((t) => t.anchor.exact).sort();
ok(exacts.includes("brown fox") && exacts.includes("quick brown fox jumps") && exacts.includes("fox jumps over"),
  "all three comment quotes present verbatim", exacts);
ok(anchoredComments.every((t) => typeof t.anchor.start === "number" && typeof t.anchor.end === "number"),
  "every anchored comment carries resolved start/end offset hints", anchoredComments.map((t) => t.anchor));

const arx = g.json?.anchored_reactions || [];
ok(arx.length === 2, "2 distinct anchored-reaction spans returned (equal 🎉, partial 👀)", arx.map((x) => x.anchor.exact));
const eqRx = arx.find((x) => x.anchor.exact === "brown fox");
ok(eqRx && eqRx.reactions.find((r) => r.emoji === "🎉"),
  "exact-equal reaction shares the SAME quote as the equal-span comment (one painted region, two attachments)", eqRx);

// Overlap-region authors are attributed (drives the chip popover + focus picker).
ok(eqRx.reactions[0].authors.includes(ownerEmail), "reaction authors attributed for the chip popover", eqRx.reactions[0]);

// Optimistic-toggle path still works on an overlapping span: re-POST owner's 🎉 on
// the equal span toggles off WITHOUT touching the overlapping comment.
const tog = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🎉", anchor: eqSpan }, auth(OWNER));
ok(tog.status === 200 && tog.json?.removed === true, "toggle off 🎉 on overlapping equal span", tog);
const g2 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const stillEqComment = (g2.json?.threads || []).find((t) => t.anchor?.exact === "brown fox" && t.group === "anchored");
ok(stillEqComment, "the co-anchored comment is untouched by the reaction toggle", stillEqComment?.anchor);
const eqRxGone = (g2.json?.anchored_reactions || []).find((x) => x.anchor.exact === "brown fox");
ok(!eqRxGone, "reaction span removed after toggle (chip disappears); comment highlight remains", g2.json?.anchored_reactions);

// The shell-embedded raw page injects the overlay; a direct /raw stays byte-pristine.
const rawShell = await fetch(`${BASE}/d/${slug}/raw?overlay=1`);
const rawShellBody = await rawShell.text();
ok(rawShell.status === 200 && /data-jh-overlay/.test(rawShellBody) && /data-jh-seg/.test(rawShellBody),
  "/raw?overlay=1 injects the segment-painting overlay", { status: rawShell.status, hasOverlay: /data-jh-overlay/.test(rawShellBody) });
const rawPlain = await fetch(`${BASE}/d/${slug}/raw`);
const rawPlainBody = await rawPlain.text();
ok(rawPlain.status === 200 && !/data-jh-overlay/.test(rawPlainBody),
  "/raw (no overlay) stays byte-pristine (no injected script)", { hasOverlay: /data-jh-overlay/.test(rawPlainBody) });

log(`\n==== B14 QA: ${PASS} passed, ${FAIL} failed ====`);
process.exit(FAIL ? 1 : 0);
