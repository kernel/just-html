// B11 Reactions & collab-polish QA against production.
// Usage: node --env-file=.env scripts/qa-b11.mjs
//
// Exercises the B11 additions on top of B10:
//   - GET /api/v1/docs items carry comment_count (0, then non-zero after a comment).
//   - POST /reactions on a comment + on the doc; toggle off by re-POST; dedup.
//   - DELETE /reactions/:id (own); 404 on someone else's / unknown id.
//   - Allowed-emoji rejection: a non-curated emoji 400s with an "allowed" array.
//   - GET /comments surfaces doc_reactions (doc-level) and per-comment reactions.
//   - bad comment_id → 422.
//
// Keys are seeded directly in the DB (scripts/qa-b10-seed.mjs) to dodge the
// auth-flow per-IP registration cap — the ceremony is covered by qa-b9.

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

// --- seed two keys: owner + a reactor (second identity, on a public doc) ---
const ownerEmail = `raf+qa-b11-owner-${TS}@kernel.sh`;
const reactorEmail = `raf+qa-b11-reactor-${TS}@kernel.sh`;
const seeded = JSON.parse(
  execFileSync("node", ["--env-file=.env", "scripts/qa-b10-seed.mjs", ownerEmail, reactorEmail], {
    encoding: "utf8",
  }).trim()
);
const OWNER = seeded[ownerEmail];
const REACTOR = seeded[reactorEmail];

log(`\n==== B11 QA (ts=${TS}) ====`);

// 1. Create a public doc (public so the reactor identity can view+react).
const created = await jreq("POST", "/api/v1/docs", { html: "<h1>B11 doc</h1><p>react to me</p>", title: "B11", public: true }, auth(OWNER));
ok(created.status === 201, "create public doc", created);
const slug = created.json?.slug;

// 2. List items carry comment_count = 0 initially.
const list0 = await jreq("GET", "/api/v1/docs?scope=owned", null, auth(OWNER));
const item0 = list0.json?.docs?.find((d) => d.slug === slug);
ok(item0 && item0.comment_count === 0, "list item comment_count == 0 before any comment", item0);

// 3. Owner posts a doc-level comment.
const c1 = await jreq("POST", `/api/v1/docs/${slug}/comments`, { body: "first comment" }, auth(OWNER));
ok(c1.status === 201, "owner posts comment", c1);
const commentId = c1.json?.comment?.id;

// 4. comment_count now 1.
const list1 = await jreq("GET", "/api/v1/docs?scope=owned", null, auth(OWNER));
const item1 = list1.json?.docs?.find((d) => d.slug === slug);
ok(item1 && item1.comment_count === 1, "list item comment_count == 1 after a comment", item1);

// 5. React on the comment (owner).
const r1 = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🚀", comment_id: commentId }, auth(OWNER));
ok(r1.status === 201 && r1.json?.reaction?.emoji === "🚀", "owner reacts 🚀 on comment", r1);
const reactionId = r1.json?.reaction?.id;

// 6. Re-POST same → toggle off.
const r1again = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🚀", comment_id: commentId }, auth(OWNER));
ok(r1again.status === 200 && r1again.json?.removed === true, "re-POST same reaction toggles off", r1again);

// 7. Re-add, then DELETE by id.
const r1c = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🚀", comment_id: commentId }, auth(OWNER));
const rid2 = r1c.json?.reaction?.id;
const del = await jreq("DELETE", `/api/v1/docs/${slug}/reactions/${rid2}`, null, auth(OWNER));
ok(del.status === 200 && del.json?.deleted === true, "DELETE own reaction by id", del);
// deleting again → 404 (gone / not yours).
const delAgain = await jreq("DELETE", `/api/v1/docs/${slug}/reactions/${rid2}`, null, auth(OWNER));
ok(delAgain.status === 404, "DELETE already-removed reaction → 404", delAgain);

// 8. Reactor (different identity, public doc) reacts on the DOC (no comment_id).
const r2 = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "👀" }, auth(REACTOR));
ok(r2.status === 201, "second identity reacts 👀 on the doc (public, viewer-with-identity)", r2);

// 9. Owner also reacts 👀 on the doc → count 2, two authors.
const r3 = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "👀" }, auth(OWNER));
ok(r3.status === 201, "owner reacts 👀 on the doc", r3);

// 10. GET /comments surfaces doc_reactions with count 2.
const threads = await jreq("GET", `/api/v1/docs/${slug}/comments`, null, auth(OWNER));
const docReact = (threads.json?.doc_reactions || []).find((x) => x.emoji === "👀");
ok(docReact && docReact.count === 2, "GET /comments doc_reactions 👀 count == 2", threads.json?.doc_reactions);
ok(threads.json?.can_react === true, "GET /comments reports can_react", { can_react: threads.json?.can_react });

// 11. Disallowed emoji → 400 with allowed[].
const bad = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "🦄" }, auth(OWNER));
ok(bad.status === 400 && Array.isArray(bad.json?.allowed) && bad.json.allowed.length > 0,
  "disallowed emoji → 400 with allowed[]", bad);

// 12. Bad comment_id → 422.
const badc = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "👍", comment_id: 999999999 }, auth(OWNER));
ok(badc.status === 422, "reaction on nonexistent comment_id → 422", badc);

// 13. Anonymous reaction (no auth) on a public doc → 401 (attributed-only).
const anon = await jreq("POST", `/api/v1/docs/${slug}/reactions`, { emoji: "👍" });
ok(anon.status === 401, "anonymous reaction → 401 (attributed-only)", anon);

// cleanup
await jreq("DELETE", `/api/v1/docs/${slug}`, null, auth(OWNER));

log(`\n==== B11 QA: ${PASS} passed, ${FAIL} failed ====`);
process.exit(FAIL === 0 ? 0 : 1);
