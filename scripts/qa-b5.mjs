// B5 Sharing end-to-end QA against production. Registers two agents (owner +
// teammate editor) via the spec-pure claim ceremony, driving the human steps
// through the QA login-link escape hatch, then exercises the grants API.
//
// Usage: node --env-file=.env scripts/qa-b5.mjs

const BASE = "https://justhtml.sh";
const QA = process.env.QA_SECRET;
if (!QA) { console.error("QA_SECRET not set"); process.exit(1); }

const TS = Date.now().toString(36);
const OWNER = `raf+qa-owner-${TS}@kernel.sh`;
const EDITOR = `raf+qa-editor-${TS}@kernel.sh`;
const OUTSIDER = `raf+qa-outsider-${TS}@kernel.sh`; // same kernel.sh domain

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jpost(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, www: r.headers.get("www-authenticate") };
}
async function form(path, params) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

// Register one agent for `email` and complete the human claim ceremony, returning
// the issued jh_live_ API key.
async function registerAgent(email) {
  log(`\n--- registering ${email} ---`);
  const ident = await jpost("/agent/identity", { type: "service_auth", login_hint: email });
  if (ident.status !== 200) throw new Error(`identity failed ${ident.status}: ${JSON.stringify(ident.json)}`);
  const claimToken = ident.json.claim_token;
  const userCode = ident.json.claim.user_code;
  const verifyUri = ident.json.claim.verification_uri;
  // claim_attempt_token is embedded in verification_uri (next=/claim?claim_attempt_token=...)
  const u = new URL(verifyUri);
  const next = u.searchParams.get("next");
  const cvt = new URLSearchParams(next.split("?")[1]).get("claim_attempt_token");
  log(`  user_code=${userCode} cvt=${cvt.slice(0, 12)}…`);

  // Human step 1: request a magic link by POSTing /login (sends email + records QA link).
  const loginNext = next; // /claim?claim_attempt_token=...
  const lr = await fetch(BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ email, next: loginNext }).toString(),
  });
  if (lr.status !== 200) throw new Error(`/login POST failed ${lr.status}`);

  // Fetch the QA login link.
  const llr = await fetch(`${BASE}/internal/qa/latest-login-link?email=${encodeURIComponent(email)}`, {
    headers: { "X-QA-Secret": QA },
  });
  if (llr.status !== 200) throw new Error(`qa link fetch failed ${llr.status}: ${await llr.text()}`);
  const link = (await llr.json()).link;

  // Human step 2: consume the magic link (POST /login/verify) to mint a session.
  const lv = new URL(link);
  const lt = lv.searchParams.get("token");
  const verifyNext = lv.searchParams.get("next");
  const verifyRes = await fetch(BASE + "/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ token: lt, next: verifyNext }).toString(),
    redirect: "manual",
  });
  const setCookie = verifyRes.headers.get("set-cookie");
  if (!setCookie) throw new Error(`/login/verify did not set a session cookie (status ${verifyRes.status})`);
  const cookie = setCookie.split(";")[0];

  // Human step 3: submit the 6-digit code at /claim with the session cookie.
  const claimRes = await fetch(BASE + "/claim", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Cookie: cookie },
    body: new URLSearchParams({ claim_attempt_token: cvt, user_code: userCode }).toString(),
    redirect: "manual",
  });
  if (claimRes.status >= 400) throw new Error(`/claim submit failed ${claimRes.status}: ${await claimRes.text()}`);

  // Agent polls the token endpoint for the key.
  let key = null;
  for (let i = 0; i < 5 && !key; i++) {
    const tok = await form("/oauth2/token", {
      grant_type: "urn:workos:agent-auth:grant-type:claim",
      claim_token: claimToken,
    });
    if (tok.status === 200 && tok.json.access_token) { key = tok.json.access_token; break; }
    await sleep(1200);
  }
  if (!key) throw new Error("never got an access_token");
  log(`  got key ${key.slice(0, 14)}…`);
  return key;
}

function bearer(key) { return { Authorization: `Bearer ${key}` }; }

async function main() {
  const ownerKey = await registerAgent(OWNER);
  const editorKey = await registerAgent(EDITOR);

  // 1. Owner creates a private doc.
  log("\n=== 1. owner creates a doc ===");
  const create = await jpost("/api/v1/docs", { html: "<h1>v1 by owner</h1>", title: "B5 QA" }, bearer(ownerKey));
  if (create.status !== 201) throw new Error(`create failed ${create.status}: ${JSON.stringify(create.json)}`);
  const slug = create.json.slug;
  log(`  slug=${slug} version=${create.json.version} view_token=${create.json.view_token}`);

  // 2. Editor (teammate) cannot see/edit the doc yet → 404.
  log("\n=== 2. teammate has no access (expect 404) ===");
  const pre = await jpost("/api/v1/docs/" + slug + "/edits", { edits: [{ oldText: "v1", newText: "v2" }] }, bearer(editorKey));
  log(`  editor /edits before grant → ${pre.status} ${pre.json?.error}`);
  const preGet = await fetch(BASE + "/api/v1/docs/" + slug, { headers: bearer(editorKey) });
  log(`  editor GET before grant → ${preGet.status}`);

  // 3. Owner grants editor to the teammate email.
  log("\n=== 3. owner grants editor to teammate email ===");
  const grant = await jpost("/api/v1/docs/" + slug + "/grants", { email: EDITOR, role: "editor" }, bearer(ownerKey));
  log(`  grant → ${grant.status} ${JSON.stringify(grant.json?.grant)}`);
  const grantId = grant.json?.grant?.id;

  // 3b. Idempotent re-grant (same target+role) → 200 unchanged.
  const regrant = await jpost("/api/v1/docs/" + slug + "/grants", { email: EDITOR, role: "editor" }, bearer(ownerKey));
  log(`  re-grant (same) → ${regrant.status} unchanged=${regrant.json?.unchanged}`);

  // 4. Editor can now GET (no view_token leaked) and patch via /edits.
  log("\n=== 4. teammate now has editor access ===");
  const eget = await fetch(BASE + "/api/v1/docs/" + slug, { headers: bearer(editorKey) });
  const egetj = await eget.json();
  log(`  editor GET → ${eget.status} role=${egetj.role} view_token_leaked=${"view_token" in egetj}`);
  const edit = await jpost("/api/v1/docs/" + slug + "/edits",
    { edits: [{ oldText: "v1 by owner", newText: "v2 by teammate editor" }], base_version: 1 }, bearer(editorKey));
  log(`  editor /edits → ${edit.status} version=${edit.json?.version}`);

  // 5. Editor CANNOT delete, change visibility, rotate token, or manage grants.
  log("\n=== 5. editor is denied owner-only ops ===");
  const eDel = await fetch(BASE + "/api/v1/docs/" + slug, { method: "DELETE", headers: bearer(editorKey) });
  log(`  editor DELETE → ${eDel.status} (expect 404)`);
  const eVis = await jpost("/api/v1/docs/" + slug, { public: true }, bearer(editorKey));
  log(`  editor PATCH {public:true} → ${eVis.status} ${eVis.json?.error} (expect 403 owner_only)`);
  const eRot = await jpost("/api/v1/docs/" + slug + "/rotate-token", {}, bearer(editorKey));
  log(`  editor rotate-token → ${eRot.status} (expect 404)`);
  const eGr = await jpost("/api/v1/docs/" + slug + "/grants", { email: "x@kernel.sh", role: "viewer" }, bearer(editorKey));
  log(`  editor POST grants → ${eGr.status} (expect 404)`);
  const eGrList = await fetch(BASE + "/api/v1/docs/" + slug + "/grants", { headers: bearer(editorKey) });
  log(`  editor GET grants → ${eGrList.status} (expect 404)`);

  // 6. Consumer-domain rejection.
  log("\n=== 6. consumer-domain rejection ===");
  for (const d of ["gmail.com", "outlook.com", "proton.me", "@yahoo.co.uk"]) {
    const r = await jpost("/api/v1/docs/" + slug + "/grants", { domain: d, role: "viewer" }, bearer(ownerKey));
    log(`  grant domain ${d} → ${r.status} ${r.json?.error}`);
  }
  // A real org domain is accepted.
  const orgGrant = await jpost("/api/v1/docs/" + slug + "/grants", { domain: "kernel.sh", role: "commenter" }, bearer(ownerKey));
  log(`  grant domain kernel.sh (commenter) → ${orgGrant.status} role=${orgGrant.json?.grant?.role}`);

  // 6b. Domain grant authorizes the outsider (commenter = read but not edit).
  log("\n=== 6b. domain grant gives a same-domain outsider read (commenter≈viewer) ===");
  const outsiderKey = await registerAgent(OUTSIDER);
  const oGet = await fetch(BASE + "/api/v1/docs/" + slug, { headers: bearer(outsiderKey) });
  const oGetj = await oGet.json();
  log(`  outsider GET (via kernel.sh domain grant) → ${oGet.status} role=${oGetj.role}`);
  const oEdit = await jpost("/api/v1/docs/" + slug + "/edits", { edits: [{ oldText: "v2", newText: "v3" }] }, bearer(outsiderKey));
  log(`  outsider /edits (commenter, expect 404 no-edit) → ${oEdit.status}`);

  // 6c. Explicit email grant beats domain grant: give the outsider an explicit
  // editor email grant and confirm they can now edit.
  await jpost("/api/v1/docs/" + slug + "/grants", { email: OUTSIDER, role: "editor" }, bearer(ownerKey));
  const oEdit2 = await jpost("/api/v1/docs/" + slug + "/edits",
    { edits: [{ oldText: "v2 by teammate editor", newText: "v3 by outsider (explicit editor beats domain)" }] }, bearer(outsiderKey));
  log(`  outsider /edits after explicit editor email grant → ${oEdit2.status} version=${oEdit2.json?.version}`);

  // 7. Owner lists grants and revokes one.
  log("\n=== 7. owner lists + revokes grants ===");
  const list = await fetch(BASE + "/api/v1/docs/" + slug + "/grants", { headers: bearer(ownerKey) });
  const listj = await list.json();
  log(`  grants count=${listj.count} max=${listj.max}: ${listj.grants.map((g) => `${g.grantee}=${g.role}`).join(", ")}`);
  const del = await fetch(BASE + "/api/v1/docs/" + slug + "/grants/" + grantId, { method: "DELETE", headers: bearer(ownerKey) });
  log(`  revoke grant ${grantId} → ${del.status}`);
  // After revoking the editor email grant, the teammate loses edit (kernel.sh
  // domain grant is commenter only → read but not edit).
  const postRevoke = await jpost("/api/v1/docs/" + slug + "/edits", { edits: [{ oldText: "v3", newText: "v4" }] }, bearer(editorKey));
  log(`  teammate /edits after revoke (domain=commenter) → ${postRevoke.status} (expect 404 no-edit)`);

  // 8. History shows both authors.
  log("\n=== 8. version history ===");
  const vers = await fetch(BASE + "/api/v1/docs/" + slug + "/versions", { headers: bearer(ownerKey) });
  const versj = await vers.json();
  log(`  versions: ${versj.versions.map((v) => `v${v.version}(${v.edit_kind},by=${v.author_user_id})`).join(", ")}`);

  log("\nDONE. slug=" + slug);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
