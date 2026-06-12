// B10 Comments QA against production.
// Usage: node --env-file=.env scripts/qa-b10.mjs
//
// Exercises: API-key comment auth (owner), anchored + doc-level + reply,
// GET all-threads grouping/order, edit-body (author only), resolve/unresolve,
// reactions toggle + dedup, comment-level reactions, permission negatives
// (anonymous write rejected, viewer grant can't comment), the 1-level thread
// guard, re-anchoring (patch offset-map survives, rewrite quote re-find,
// orphan on delete-text, un-orphan on restore), and the overlay-injected raw
// variant vs byte-pristine raw.

const BASE = "https://justhtml.sh";
const QA = process.env.QA_SECRET;
if (!QA) { console.error("QA_SECRET not set"); process.exit(1); }

const TS = Date.now().toString(36);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PASS = 0, FAIL = 0;
function ok(cond, label, extra) {
  if (cond) { PASS++; log(`  PASS ${label}`); }
  else { FAIL++; log(`  FAIL ${label}${extra !== undefined ? " :: " + JSON.stringify(extra) : ""}`); }
}

async function jpost(path, body, headers = {}) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, res: r };
}
async function jreq(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, res: r };
}
async function jget(path, headers = {}) {
  const r = await fetch(BASE + path, { headers });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, res: r };
}
async function form(path, params, headers = {}) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, ...headers }, body: new URLSearchParams(params).toString() });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, res: r };
}
async function qaClaimEmail(email) {
  const r = await fetch(`${BASE}/internal/qa/latest-claim-email?email=${encodeURIComponent(email)}`, { headers: { "X-QA-Secret": QA } });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}
async function pollToken(ct, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const tok = await form("/oauth2/token", { grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: ct });
    if (tok.status === 200 && tok.json?.access_token) return tok.json.access_token;
    await sleep(1200);
  }
  return null;
}
// Keys are seeded directly in the DB (scripts/qa-b10-seed.mjs) to avoid the
// auth-flow per-IP registration cap — the registration ceremony is covered by
// qa-b9; B10 only needs valid keys to exercise the comment/reaction surface.
import { execFileSync } from "node:child_process";
function seedKeys(emails) {
  const out = execFileSync("node", ["--env-file=.env", "scripts/qa-b10-seed.mjs", ...emails], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}
const auth = (k) => ({ Authorization: `Bearer ${k}` });

const DOC_HTML = `<!doctype html><html><body>
<h1>RECTL — record control</h1>
<p>rectl manages an append-only log of records. Each segment retains a full snapshot rather than a diff, which makes point-in-time reads cheap.</p>
<p>Compaction gives up honestly and marks the record orphaned rather than guessing.</p>
<p>Operators should run the vacuum subcommand nightly via cron.</p>
</body></html>`;

async function main() {
  log("[setup] seeding owner + commenter + viewer keys");
  const ownerEmail = `raf+qa-b10-owner-${TS}@kernel.sh`;
  const commenterEmail = `raf+qa-b10-commenter-${TS}@kernel.sh`;
  const viewerEmail = `raf+qa-b10-viewer-${TS}@kernel.sh`;
  const keys = seedKeys([ownerEmail, commenterEmail, viewerEmail]);
  const ownerKey = keys[ownerEmail], commenterKey = keys[commenterEmail], viewerKey = keys[viewerEmail];
  ok(ownerKey?.startsWith("jh_live_"), "owner key", ownerKey?.slice(0, 12));
  ok(commenterKey?.startsWith("jh_live_"), "commenter key", commenterKey?.slice(0, 12));
  ok(viewerKey?.startsWith("jh_live_"), "viewer key", viewerKey?.slice(0, 12));

  log("\n[1] create doc + grants");
  const create = await jpost("/api/v1/docs", { html: DOC_HTML, title: "RECTL comments QA" }, auth(ownerKey));
  ok(create.status === 201, "doc created", create.status);
  const slug = create.json?.slug;
  const base = `/api/v1/docs/${slug}`;
  // Grant commenter (can comment) and viewer (can only view).
  const g1 = await jpost(`${base}/grants`, { email: commenterEmail, role: "commenter" }, auth(ownerKey));
  const g2 = await jpost(`${base}/grants`, { email: viewerEmail, role: "viewer" }, auth(ownerKey));
  ok(g1.status === 201 && g2.status === 201, "commenter + viewer grants", [g1.status, g2.status]);

  log("\n[2] post comments (anchored, doc-level, reply)");
  const anchored = await jpost(`${base}/comments`, {
    body: "name the retention cap here?",
    anchor: { exact: "full snapshot rather than a diff", prefix: "Each segment retains a ", suffix: ", which makes" },
  }, auth(ownerKey));
  ok(anchored.status === 201, "anchored comment 201", anchored.json);
  ok(anchored.json?.comment?.orphaned === false, "anchored comment resolved (not orphaned)", anchored.json?.comment);
  ok(anchored.json?.comment?.author === ownerEmail, "author email attributed", anchored.json?.comment?.author);
  ok(typeof anchored.json?.comment?.author_avatar === "string", "gravatar avatar url present");
  const rootId = anchored.json?.comment?.id;

  const docLevel = await jpost(`${base}/comments`, { body: "overall: ship it." }, auth(ownerKey));
  ok(docLevel.status === 201 && docLevel.json?.comment?.anchor === null, "doc-level comment (null anchor)", docLevel.json?.comment?.anchor);

  // Commenter replies to the anchored root.
  const reply = await jpost(`${base}/comments`, { body: "+1, link LIMITS once it lands", parent_id: rootId }, auth(commenterKey));
  ok(reply.status === 201 && reply.json?.comment?.parent_id === rootId, "commenter reply on root", reply.json?.comment);

  // 1-level guard: reply to a reply -> 422.
  const nested = await jpost(`${base}/comments`, { body: "nested?", parent_id: reply.json.comment.id }, auth(ownerKey));
  ok(nested.status === 422, "reply-to-reply rejected (1-level)", nested.status);

  // Anchor on a reply -> 400.
  const badAnchorReply = await jpost(`${base}/comments`, { body: "x", parent_id: rootId, anchor: { exact: "rectl" } }, auth(ownerKey));
  ok(badAnchorReply.status === 400, "anchor on reply rejected", badAnchorReply.status);

  log("\n[3] GET all-threads view (grouping + order + reactions)");
  const all = await jget(`${base}/comments`, auth(ownerKey));
  ok(all.status === 200, "GET comments 200");
  // 3 live: anchored root + doc-level + 1 reply (the nested/anchor-on-reply
  // attempts were rejected, so they never persisted).
  ok(all.json?.total === 3, "total counts comments + replies (3)", all.json?.total);
  ok(all.json?.can_comment === true, "owner can_comment true");
  const groups = (all.json?.threads || []).map((t) => t.group);
  ok(groups[0] === "anchored", "anchored thread first (doc order)", groups);
  ok(groups.includes("doc"), "doc-level group present", groups);
  const anchoredThread = all.json.threads.find((t) => t.id === rootId);
  ok(anchoredThread?.replies?.length === 1, "anchored thread carries its reply", anchoredThread?.replies?.length);

  log("\n[4] edit body (author only), resolve, delete");
  const editByOther = await jreq("PATCH", `${base}/comments/${rootId}`, { body: "hijack" }, auth(commenterKey));
  ok(editByOther.status === 403, "non-author edit body -> 403", editByOther.status);
  const editByAuthor = await jreq("PATCH", `${base}/comments/${rootId}`, { body: "name the 100-version cap here?" }, auth(ownerKey));
  ok(editByAuthor.status === 200 && editByAuthor.json?.comment?.edited_at, "author edit sets edited_at", editByAuthor.json?.comment?.edited_at);
  // Resolve by commenter (anyone who can comment).
  const resolve = await jreq("PATCH", `${base}/comments/${rootId}`, { resolved: true }, auth(commenterKey));
  ok(resolve.status === 200 && resolve.json?.comment?.resolved === true, "commenter can resolve", resolve.json?.comment?.resolved);
  const unresolve = await jreq("PATCH", `${base}/comments/${rootId}`, { resolved: false }, auth(ownerKey));
  ok(unresolve.status === 200 && unresolve.json?.comment?.resolved === false, "unresolve", unresolve.json?.comment?.resolved);

  log("\n[5] reactions (toggle + dedup + comment-level)");
  const r1 = await jpost(`${base}/reactions`, { emoji: "👍", comment_id: rootId }, auth(ownerKey));
  ok(r1.status === 201, "react 👍 on comment", r1.json);
  const r1again = await jpost(`${base}/reactions`, { emoji: "👍", comment_id: rootId }, auth(ownerKey));
  ok(r1again.status === 200 && r1again.json?.removed === true, "re-react toggles off (dedup)", r1again.json);
  const r2 = await jpost(`${base}/reactions`, { emoji: "🎉", comment_id: rootId }, auth(commenterKey));
  const r3 = await jpost(`${base}/reactions`, { emoji: "🎉", comment_id: rootId }, auth(ownerKey));
  ok(r2.status === 201 && r3.status === 201, "two authors same emoji distinct", [r2.status, r3.status]);
  const afterRx = await jget(`${base}/comments`, auth(ownerKey));
  const t = afterRx.json.threads.find((x) => x.id === rootId);
  const tada = (t?.reactions || []).find((x) => x.emoji === "🎉");
  ok(tada?.count === 2, "🎉 count = 2 across two authors", tada);
  // Doc-level reaction.
  const rDoc = await jpost(`${base}/reactions`, { emoji: "🚀" }, auth(ownerKey));
  ok(rDoc.status === 201 && rDoc.json?.reaction?.comment_id === null, "doc-level reaction", rDoc.json?.reaction);
  // Bad emoji rejected.
  const rBad = await jpost(`${base}/reactions`, { emoji: "not-an-emoji" }, auth(ownerKey));
  ok(rBad.status === 400, "non-allowlisted emoji rejected", rBad.status);

  log("\n[6] permission negatives");
  const anon = await jpost(`${base}/comments`, { body: "anon" });
  ok(anon.status === 401 && anon.res.headers.get("www-authenticate")?.includes("resource_metadata"), "anonymous write -> 401 + WWW-Authenticate", anon.status);
  const viewerWrite = await jpost(`${base}/comments`, { body: "viewer tries" }, auth(viewerKey));
  ok(viewerWrite.status === 403, "viewer-grant cannot comment -> 403", viewerWrite.status);
  const viewerReact = await jpost(`${base}/reactions`, { emoji: "👍" }, auth(viewerKey));
  ok(viewerReact.status === 201 || viewerReact.status === 200, "viewer CAN react", viewerReact.status);
  // Delete: non-author non-owner -> 403; author own -> ok; owner any -> ok.
  const delByViewer = await jreq("DELETE", `${base}/comments/${reply.json.comment.id}`, null, auth(viewerKey));
  ok(delByViewer.status === 403, "viewer cannot delete others' comment", delByViewer.status);
  const delOwnReply = await jreq("DELETE", `${base}/comments/${reply.json.comment.id}`, null, auth(commenterKey));
  ok(delOwnReply.status === 200, "author deletes own reply", delOwnReply.status);

  log("\n[7] re-anchoring across edits");
  // 7a. Patch edit BEFORE the anchored quote — offset shifts, anchor survives.
  const v0 = create.json.version;
  const patch1 = await jpost(`${base}/edits`, {
    edits: [{ oldText: "rectl manages an append-only log", newText: "rectl manages a durable append-only log of immutable" }],
    base_version: v0,
  }, auth(ownerKey));
  ok(patch1.status === 200, "patch (text before anchor) applied", patch1.status);
  const afterPatch = await jget(`${base}/comments`, auth(ownerKey));
  const stillAnchored = afterPatch.json.threads.find((x) => x.id === rootId);
  ok(stillAnchored?.orphaned === false && stillAnchored?.group === "anchored", "anchor survived patch (tier 1)", { orphaned: stillAnchored?.orphaned, group: stillAnchored?.group });

  // 7b. Rewrite that DELETES the anchored text -> orphaned (tier 3).
  const delHtml = DOC_HTML.replace("Each segment retains a full snapshot rather than a diff, which makes point-in-time reads cheap.", "Segments are stored compactly.");
  const v1 = patch1.json.version;
  const rw1 = await jreq("PATCH", `${base}`, { html: delHtml }, auth(ownerKey));
  ok(rw1.status === 200, "rewrite removing anchor text applied", rw1.status);
  const afterDel = await jget(`${base}/comments`, auth(ownerKey));
  const orphan = afterDel.json.threads.find((x) => x.id === rootId);
  ok(orphan?.orphaned === true && orphan?.group === "orphaned", "anchor orphaned when text removed (tier 3)", { orphaned: orphan?.orphaned, group: orphan?.group });

  // 7c. Rewrite that RESTORES the text -> un-orphaned.
  const rw2 = await jreq("PATCH", `${base}`, { html: DOC_HTML }, auth(ownerKey));
  ok(rw2.status === 200, "rewrite restoring anchor text applied", rw2.status);
  const afterRestore = await jget(`${base}/comments`, auth(ownerKey));
  const unorphan = afterRestore.json.threads.find((x) => x.id === rootId);
  ok(unorphan?.orphaned === false && unorphan?.group === "anchored", "anchor un-orphaned when text restored", { orphaned: unorphan?.orphaned, group: unorphan?.group });

  log("\n[8] viewer shell + overlay variant vs byte-pristine raw");
  // Public the doc so we can fetch raw without a token for the byte test.
  await jreq("PATCH", `${base}`, { public: true }, auth(ownerKey));
  const pristine = await fetch(`${BASE}/d/${slug}/raw`);
  const pristineText = await pristine.text();
  ok(!pristineText.includes("__jhOverlay"), "direct /raw is byte-pristine (no overlay script)");
  const overlayed = await fetch(`${BASE}/d/${slug}/raw?overlay=1`);
  const overlayedText = await overlayed.text();
  ok(overlayedText.includes("__jhOverlay") && overlayedText.includes("jh:anchors"), "/raw?overlay=1 injects the overlay script");
  // The shell page for a doc WITH comments renders the rail (client bundle present).
  const shell = await fetch(`${BASE}/d/${slug}`);
  const shellText = await shell.text();
  ok(shell.status === 200 && /comment/i.test(shellText), "viewer shell renders (comments variant)", shell.status);

  log(`\n==== B10 QA: ${PASS} passed, ${FAIL} failed ====`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
