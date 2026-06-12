// B13 Anchored reactions QA against production.
// Usage: node --env-file=.env scripts/qa-b13.mjs
//
// Exercises span-targeted reactions on top of B11:
//   - POST /reactions with anchor → 201 carrying anchor/anchored_version/orphaned.
//   - GET /comments surfaces anchored_reactions grouped by anchor signature.
//   - Re-POST same (author, emoji, span) → toggle off; another emoji on the same
//     span is a SEPARATE reaction (dedup is per-span-signature, not per-doc).
//   - Same emoji on a DIFFERENT span is a separate reaction (sig in the key).
//   - comment_id + anchor together → 400 (mutually exclusive target).
//   - Re-anchoring on a patch edit: the span MOVES (reaction follows), and an
//     edit that deletes the quoted text ORPHANS it (degrades to doc_reactions);
//     restoring the text un-orphans it.

import { execFileSync } from "node:child_process";

const BASE = "https://justhtml.sh";
const TS = Date.now().toString(36);
const log = (...a) => console.log(...a);
let PASS = 0, FAIL = 0;
function ok(cond, label, extra) {
  if (cond) { PASS++; log(`  PASS ${label}`); }
  else { FAIL++; log(`  FAIL ${label}${extra !== undefined ? " :: " + JSON.stringify(extra) : ""}`); }
}
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

const ownerEmail = `raf+qa-b13-owner-${TS}@kernel.sh`;
const reactorEmail = `raf+qa-b13-reactor-${TS}@kernel.sh`;
const seeded = JSON.parse(
  execFileSync("node", ["--env-file=.env", "scripts/qa-b10-seed.mjs", ownerEmail, reactorEmail], { encoding: "utf8" }).trim()
);
const OWNER = seeded[ownerEmail];
const REACTOR = seeded[reactorEmail];

log(`\n==== B13 QA (ts=${TS}) ====`);

// A doc with two distinct quotable spans + a repeated phrase to test dedup-by-span.
const html =
  "<h1>rectl</h1>" +
  "<p>rectl manages an append-only log with deterministic compaction every time.</p>" +
  "<p>We cap record bodies at two megabytes; anything larger is by reference.</p>";
const created = await jreq("POST", "/api/v1/docs", { html, title: "B13", public: true }, auth(OWNER));
ok(created.status === 201, "create public doc", created);
const slug = created.json?.slug;

const spanA = { exact: "deterministic compaction", prefix: "log with ", suffix: " every time" };
const spanB = { exact: "two megabytes", prefix: "record bodies at ", suffix: "; anything larger" };

// 1. Anchored reaction on span A → 201 with anchor echoed, not orphaned.
const a1 = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🚀", anchor: spanA }, auth(OWNER));
ok(a1.status === 201 && a1.json?.reaction?.anchor?.exact === "deterministic compaction" && a1.json?.reaction?.orphaned === false,
  "anchored reaction on span A → 201, not orphaned", a1);
ok(typeof a1.json?.reaction?.anchor?.start === "number", "server stamped resolved start offset", a1.json?.reaction?.anchor);

// 2. Second author reacts same emoji on span A → distinct reaction.
const a2 = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🚀", anchor: spanA }, auth(REACTOR));
ok(a2.status === 201, "second author reacts 🚀 on span A", a2);

// 3. GET /comments → anchored_reactions has span A with 🚀 count 2.
const g1 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const grpA = g1.json?.anchored_reactions?.find((g) => g.anchor.exact === "deterministic compaction");
ok(grpA && grpA.reactions.find((r) => r.emoji === "🚀")?.count === 2,
  "GET /comments anchored_reactions: span A 🚀 count 2", g1.json?.anchored_reactions);

// 4. Owner adds 👍 on span A → separate emoji group, same span.
const a3 = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "👍", anchor: spanA }, auth(OWNER));
ok(a3.status === 201, "owner adds 👍 on span A (separate emoji, same span)", a3);
const g2 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const grpA2 = g2.json?.anchored_reactions?.find((g) => g.anchor.exact === "deterministic compaction");
ok(grpA2 && grpA2.reactions.length === 2, "span A now has 2 emoji groups", grpA2);

// 5. Same emoji 🚀 on span B → separate reaction (sig in dedup key).
const b1 = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🚀", anchor: spanB }, auth(OWNER));
ok(b1.status === 201, "🚀 on span B is a separate reaction (per-span dedup)", b1);
const g3 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
ok((g3.json?.anchored_reactions || []).length === 2, "two anchored spans now present", g3.json?.anchored_reactions?.map((g) => g.anchor.exact));

// 6. Re-POST owner's 🚀 on span A → toggle off (count drops to 1).
const tog = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🚀", anchor: spanA }, auth(OWNER));
ok(tog.status === 200 && tog.json?.removed === true, "re-POST owner 🚀 span A toggles off", tog);
const g4 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const grpA3 = g4.json?.anchored_reactions?.find((g) => g.anchor.exact === "deterministic compaction");
ok(grpA3?.reactions.find((r) => r.emoji === "🚀")?.count === 1, "span A 🚀 count back to 1 after toggle", grpA3);

// 7. comment_id + anchor together → 400.
const c1 = await jreq("POST", `/api/v1/docs/${slug}/comments`, { body: "x" }, auth(OWNER));
const both = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "👀", comment_id: c1.json?.comment?.id, anchor: spanA }, auth(OWNER));
ok(both.status === 400, "comment_id + anchor together → 400", both);

// 8. Re-anchoring on patch edit: rename a word INSIDE span B's surroundings so
//    the span SHIFTS but its quote survives → reaction follows (still resolved).
const ed1 = await jreq("POST", `/api/v1/docs/${slug}/edits`,
  { edits: [{ oldText: "We cap record bodies", newText: "Note: we cap individual record bodies" }] }, auth(OWNER));
ok(ed1.status === 200, "patch edit shifting span B succeeds", ed1);
const g5 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const grpB = g5.json?.anchored_reactions?.find((g) => g.anchor.exact === "two megabytes");
ok(grpB && grpB.reactions.find((r) => r.emoji === "🚀"), "span B reaction survived + re-anchored after shift", g5.json?.anchored_reactions);

// 9. Orphan: delete span B's quoted text → reaction orphans, degrades to doc_reactions.
const ed2 = await jreq("POST", `/api/v1/docs/${slug}/edits`,
  { edits: [{ oldText: "two megabytes", newText: "a fixed size" }] }, auth(OWNER));
ok(ed2.status === 200, "patch edit deleting span B quote succeeds", ed2);
const g6 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const stillB = (g6.json?.anchored_reactions || []).find((g) => g.anchor.exact === "two megabytes");
ok(!stillB, "orphaned span B no longer in anchored_reactions", g6.json?.anchored_reactions);
ok((g6.json?.doc_reactions || []).find((r) => r.emoji === "🚀"), "orphaned anchored reaction degraded into doc_reactions", g6.json?.doc_reactions);

// 10. Un-orphan: restore the text → reaction re-anchors, leaves doc_reactions.
const ed3 = await jreq("POST", `/api/v1/docs/${slug}/edits`,
  { edits: [{ oldText: "a fixed size", newText: "two megabytes" }] }, auth(OWNER));
ok(ed3.status === 200, "patch edit restoring span B quote succeeds", ed3);
const g7 = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const backB = (g7.json?.anchored_reactions || []).find((g) => g.anchor.exact === "two megabytes");
ok(backB && backB.reactions.find((r) => r.emoji === "🚀"), "restored text un-orphans the anchored reaction", g7.json?.anchored_reactions);

// 11. Bad emoji still 400s on the anchored path.
const bad = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🦄", anchor: spanA }, auth(OWNER));
ok(bad.status === 400 && Array.isArray(bad.json?.allowed), "non-curated emoji on anchor → 400 with allowed[]", bad);

log(`\n==== B13 QA: ${PASS} passed, ${FAIL} failed ====`);
process.exit(FAIL ? 1 : 0);
