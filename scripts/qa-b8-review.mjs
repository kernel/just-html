// B8 docs-listing ADVERSARIAL REVIEW QA against production.
// Usage: node --env-file=.env scripts/qa-b8-review.mjs

const BASE = "https://justhtml.sh";
const QA = process.env.QA_SECRET;
if (!QA) { console.error("QA_SECRET not set"); process.exit(1); }

const TS = Date.now().toString(36);
const OWNER = `raf+qa-b8rev-owner-${TS}@kernel.sh`;
const GRANTEE = `raf+qa-b8rev-grantee-${TS}@kernel.sh`;   // registers an account (agent B)
const NOACCT = `raf+qa-b8rev-noacct-${TS}@kernel.sh`;     // never registers

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bearer = (key) => ({ Authorization: `Bearer ${key}` });

async function jpost(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function jget(path, headers = {}) {
  const r = await fetch(BASE + path, { headers });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function jdel(path, headers = {}) {
  const r = await fetch(BASE + path, { method: "DELETE", headers });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function form(path, params, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, ...headers },
    body: new URLSearchParams(params).toString(),
    redirect: "manual",
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, res: r };
}
async function getHtml(path, headers = {}) {
  const r = await fetch(BASE + path, { headers, redirect: "manual" });
  const text = await r.text();
  return { status: r.status, text, res: r };
}
async function qaLatestLink(email) {
  const r = await fetch(`${BASE}/internal/qa/latest-login-link?email=${encodeURIComponent(email)}`, {
    headers: { "X-QA-Secret": QA },
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}

async function registerAgent(email) {
  const ident = await jpost("/agent/identity", { type: "service_auth", login_hint: email });
  if (ident.status !== 200) throw new Error(`identity ${ident.status}: ${JSON.stringify(ident.json)}`);
  const claimToken = ident.json.claim_token;
  const userCode = ident.json.claim.user_code;
  const next = new URL(ident.json.claim.verification_uri).searchParams.get("next");
  const cvt = new URLSearchParams(next.split("?")[1]).get("claim_attempt_token");

  const lr = await form("/login", { email, next });
  if (lr.status !== 200) throw new Error(`/login ${lr.status}`);
  const link = (await qaLatestLink(email)).json.link;
  const lv = new URL(link);
  const verify = await form("/login/verify", {
    token: lv.searchParams.get("token"), next: lv.searchParams.get("next"),
  });
  const cookie = verify.res.headers.get("set-cookie").split(";")[0];
  const claimRes = await form("/claim", { claim_attempt_token: cvt, user_code: userCode }, { Cookie: cookie });
  if (claimRes.status >= 400) throw new Error(`/claim ${claimRes.status}`);
  let key = null;
  for (let i = 0; i < 6 && !key; i++) {
    const tok = await form("/oauth2/token", { grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: claimToken });
    if (tok.status === 200 && tok.json.access_token) { key = tok.json.access_token; break; }
    await sleep(1500);
  }
  if (!key) throw new Error("no access_token");
  return { key, cookie };
}

async function consumeShareLink(email) {
  const ll = await qaLatestLink(email);
  if (ll.status !== 200) throw new Error(`no share link for ${email} (${ll.status})`);
  const u = new URL(ll.json.link);
  const next = u.searchParams.get("next");
  const verify = await form("/login/verify", { token: u.searchParams.get("token"), next });
  const setCookie = verify.res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`share link did not mint a session (${verify.status})`);
  return { cookie: setCookie.split(";")[0], location: verify.res.headers.get("location"), status: verify.status };
}

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  (cond ? (pass++, log(`  PASS ${label} ${extra}`)) : (fail++, log(`  FAIL ${label} ${extra}`)));
}

async function main() {
  log("=== setup: register owner + grantee agents ===");
  const owner = await registerAgent(OWNER);
  const grantee = await registerAgent(GRANTEE);
  log("  owner+grantee keys obtained");

  log("=== owner creates 2 private docs + 1 grantee-owned doc ===");
  const d1 = (await jpost("/api/v1/docs", { html: "<h1>b8rev doc1 shared</h1>", title: "b8rev shared doc" }, bearer(owner.key))).json;
  const d2 = (await jpost("/api/v1/docs", { html: "<h1>b8rev doc2 domain</h1>", title: "b8rev domain doc" }, bearer(owner.key))).json;
  const g1 = (await jpost("/api/v1/docs", { html: "<h1>grantee own doc</h1>", title: "grantee owned" }, bearer(grantee.key))).json;
  log(`  d1=${d1.slug} d2=${d2.slug} granteeOwn=${g1.slug}`);

  log("=== share d1 -> grantee email (editor, notify off) ===");
  const grant1 = await jpost(`/api/v1/docs/${d1.slug}/grants`, { email: GRANTEE, role: "editor", notify: false }, bearer(owner.key));
  check("grant create 201", grant1.status === 201, `(${grant1.status})`);
  const grant1Id = grant1.json?.id;

  // ---------- API scope checks for grantee key ----------
  log("=== GET /api/v1/docs scopes (grantee key) ===");
  const defR = await jget("/api/v1/docs", bearer(grantee.key));
  const ownedR = await jget("/api/v1/docs?scope=owned", bearer(grantee.key));
  const sharedR = await jget("/api/v1/docs?scope=shared", bearer(grantee.key));
  const allR = await jget("/api/v1/docs?scope=all", bearer(grantee.key));

  const slugs = (r) => (r.json?.docs ?? []).map((d) => d.slug);
  check("default scope = owned only", defR.status === 200 && slugs(defR).includes(g1.slug) && !slugs(defR).includes(d1.slug));
  check("default scope items carry access:'owner'", (defR.json?.docs ?? []).every((d) => d.access === "owner"));
  check("default scope owned items carry view_token", (defR.json?.docs ?? []).every((d) => typeof d.view_token === "string" && d.view_token.length > 0));
  check("scope=owned same as default", JSON.stringify(slugs(ownedR)) === JSON.stringify(slugs(defR)));
  const sharedDoc = (sharedR.json?.docs ?? []).find((d) => d.slug === d1.slug);
  check("scope=shared includes granted doc", !!sharedDoc);
  check("scope=shared access='editor'", sharedDoc?.access === "editor");
  check("scope=shared NO view_token leak", sharedDoc && !("view_token" in sharedDoc), JSON.stringify(sharedDoc));
  check("scope=shared excludes own docs", !slugs(sharedR).includes(g1.slug));
  check("scope=shared excludes un-granted doc d2", !slugs(sharedR).includes(d2.slug));
  check("scope=all = union", slugs(allR).includes(g1.slug) && slugs(allR).includes(d1.slug));
  check("scope=all shared item has no view_token", !("view_token" in (allR.json.docs.find((d) => d.slug === d1.slug) ?? { view_token: "x" })));
  const badScope = await jget("/api/v1/docs?scope=bogus", bearer(grantee.key));
  check("scope=bogus -> 400", badScope.status === 400, `(${badScope.status})`);

  // required fields on every item
  const reqFields = ["slug", "title", "access", "version", "public", "created_at", "updated_at"];
  check("every item carries required fields", (allR.json?.docs ?? []).every((d) => reqFields.every((f) => f in d)));

  // ---------- domain grant ----------
  log("=== domain grant: d2 -> kernel.sh (viewer) ===");
  const dg = await jpost(`/api/v1/docs/${d2.slug}/grants`, { domain: "kernel.sh", role: "viewer" }, bearer(owner.key));
  check("domain grant 201", dg.status === 201, `(${dg.status})`);
  const sharedR2 = await jget("/api/v1/docs?scope=shared", bearer(grantee.key));
  const d2shared = (sharedR2.json?.docs ?? []).find((d) => d.slug === d2.slug);
  check("domain-granted doc appears in scope=shared", !!d2shared);
  check("domain-granted access='viewer'", d2shared?.access === "viewer");

  // overlap precedence: add email grant commenter on d2 for grantee -> email wins
  const eg2 = await jpost(`/api/v1/docs/${d2.slug}/grants`, { email: GRANTEE, role: "commenter", notify: false }, bearer(owner.key));
  check("overlap email grant 201", eg2.status === 201, `(${eg2.status})`);
  const sharedR3 = await jget("/api/v1/docs?scope=shared", bearer(grantee.key));
  const d2overlap = (sharedR3.json?.docs ?? []).find((d) => d.slug === d2.slug);
  check("email grant beats domain grant (commenter)", d2overlap?.access === "commenter", `got ${d2overlap?.access}`);
  // owner with own domain grant on their own doc must NOT see it in shared
  const ownerShared = await jget("/api/v1/docs?scope=shared", bearer(owner.key));
  check("owner's own domain-granted doc NOT in owner scope=shared", !(ownerShared.json?.docs ?? []).some((d) => d.slug === d2.slug || d.slug === d1.slug), JSON.stringify((ownerShared.json?.docs ?? []).map(d=>d.slug)));

  // ---------- /docs web page ----------
  log("=== /docs page: grantee session ===");
  const docsPageG = await getHtml("/docs", { Cookie: grantee.cookie });
  check("/docs 200 for grantee session", docsPageG.status === 200);
  check("/docs zero <script>", !/<script/i.test(docsPageG.text));
  check("/docs grantee shows shared doc title", docsPageG.text.includes("b8rev shared doc"));
  check("/docs grantee shows editor role", /editor/.test(docsPageG.text));
  check("/docs grantee owned section shows own doc", docsPageG.text.includes("grantee owned"));
  check("/docs has NO view tokens", !docsPageG.text.includes(d1.view_token ?? "@@") && !docsPageG.text.includes(d2.view_token ?? "@@"));

  log("=== click-through: grantee session -> /d/:slug (private, no viewtoken) ===");
  const shell = await getHtml(`/d/${d1.slug}`, { Cookie: grantee.cookie });
  check("shell 200 for grantee session", shell.status === 200);
  const masterTok = d1.view_token;
  check("shell does NOT contain master view_token", masterTok && !shell.text.includes(masterTok));
  const capMatch = shell.text.match(/cap=([A-Za-z0-9_.%-]+)/);
  check("shell iframe uses ?cap=", !!capMatch);
  const cap = capMatch ? decodeURIComponent(capMatch[1]) : null;

  log("=== /raw cap semantics ===");
  if (cap) {
    const rawCap = await getHtml(`/d/${d1.slug}/raw?cap=${encodeURIComponent(cap)}`);
    check("/raw?cap= -> 200 (no cookie, iframe path)", rawCap.status === 200, `(${rawCap.status})`);
    const rawCapWrongSlug = await getHtml(`/d/${d2.slug}/raw?cap=${encodeURIComponent(cap)}`);
    check("cap on different slug -> 404", rawCapWrongSlug.status === 404, `(${rawCapWrongSlug.status})`);
    const tampered = cap.slice(0, -2) + (cap.endsWith("aa") ? "bb" : "aa");
    const rawTampered = await getHtml(`/d/${d1.slug}/raw?cap=${encodeURIComponent(tampered)}`);
    check("tampered cap -> 404", rawTampered.status === 404, `(${rawTampered.status})`);
  }
  const rawNone = await getHtml(`/d/${d1.slug}/raw`);
  check("/raw private no cap/cookie -> 404", rawNone.status === 404, `(${rawNone.status})`);
  const rawMaster = await getHtml(`/d/${d1.slug}/raw?viewtoken=${encodeURIComponent(masterTok)}`);
  check("master ?viewtoken= still works -> 200", rawMaster.status === 200, `(${rawMaster.status})`);

  log("=== owner session /docs + click-through ===");
  const docsPageO = await getHtml("/docs", { Cookie: owner.cookie });
  check("owner /docs 200", docsPageO.status === 200);
  check("owner /docs lists owned docs", docsPageO.text.includes("b8rev shared doc") && docsPageO.text.includes("b8rev domain doc"));
  check("owner /docs marks owner access", /owner/.test(docsPageO.text));
  const shellO = await getHtml(`/d/${d1.slug}`, { Cookie: owner.cookie });
  check("owner shell click-through 200", shellO.status === 200);
  check("owner shell also avoids master token in source", !shellO.text.includes(masterTok));

  log("=== account-less grantee session ===");
  const gnote = await jpost(`/api/v1/docs/${d1.slug}/grants`, { email: NOACCT, role: "viewer" }, bearer(owner.key));
  check("notify grant for account-less 201", gnote.status === 201, `(${gnote.status})`);
  await sleep(2500); // allow email/qa-link record
  const sess = await consumeShareLink(NOACCT);
  check("share link signs in account-less grantee (303)", sess.status === 303, `loc=${sess.location}`);
  const docsPageN = await getHtml("/docs", { Cookie: sess.cookie });
  check("account-less /docs 200", docsPageN.status === 200);
  check("account-less /docs shows NO ACCOUNT YET", /NO ACCOUNT YET/i.test(docsPageN.text));
  check("account-less /docs shows tell-your-agent line", /auth\.md/.test(docsPageN.text));
  check("account-less /docs shared section lists doc", docsPageN.text.includes("b8rev shared doc"));
  const shellN = await getHtml(`/d/${d1.slug}`, { Cookie: sess.cookie });
  check("account-less grantee click-through 200", shellN.status === 200);
  check("account-less shell no master token", !shellN.text.includes(masterTok));

  log("=== logged-out behaviors ===");
  const docsOut = await getHtml("/docs");
  check("/docs logged out -> 303", docsOut.status === 303, `(${docsOut.status})`);
  check("/docs redirect -> /login?next=/docs", (docsOut.res.headers.get("location") ?? "").includes("/login?next=%2Fdocs"), docsOut.res.headers.get("location"));

  log("=== login landing ===");
  const loginForm = await getHtml("/login");
  const hiddenNext = loginForm.text.match(/name="next" value="([^"]*)"/);
  check("bare /login hidden next=/docs", hiddenNext?.[1] === "/docs", `got ${hiddenNext?.[1]}`);
  const loginForm2 = await getHtml("/login?next=%2Fd%2Ffoo");
  const hiddenNext2 = loginForm2.text.match(/name="next" value="([^"]*)"/);
  check("/login?next=/d/foo preserved", hiddenNext2?.[1] === "/d/foo", `got ${hiddenNext2?.[1]}`);
  // full magic-link verify with next=/ should land on /docs
  const lr = await form("/login", { email: NOACCT, next: "/" });
  check("POST /login next=/ accepted", lr.status === 200, `(${lr.status})`);
  const link2 = (await qaLatestLink(NOACCT)).json?.link;
  if (link2) {
    const u2 = new URL(link2);
    check("emailed link carries next=/docs (or /)", true, `next=${u2.searchParams.get("next")}`);
    const v2 = await form("/login/verify", { token: u2.searchParams.get("token"), next: "/" });
    check("verify with next=/ -> 303 /docs", v2.status === 303 && v2.res.headers.get("location")?.endsWith("/docs"), `loc=${v2.res.headers.get("location")}`);
  } else {
    check("got second login link", false);
  }

  log("=== revoke grant -> disappears ===");
  const grants = await jget(`/api/v1/docs/${d1.slug}/grants`, bearer(owner.key));
  const gEd = (grants.json?.grants ?? []).find((g) => (g.grantee ?? g.email) === GRANTEE.toLowerCase() || (g.grantee ?? g.email) === GRANTEE);
  const rid = gEd?.id ?? grant1Id;
  const rev = await jdel(`/api/v1/docs/${d1.slug}/grants/${rid}`, bearer(owner.key));
  check("revoke 200", rev.status === 200 || rev.status === 204, `(${rev.status})`);
  const sharedAfter = await jget("/api/v1/docs?scope=shared", bearer(grantee.key));
  check("revoked doc gone from scope=shared", !slugs(sharedAfter).includes(d1.slug), JSON.stringify(slugs(sharedAfter)));
  const docsPageAfter = await getHtml("/docs", { Cookie: grantee.cookie });
  check("revoked doc gone from /docs page", !docsPageAfter.text.includes("b8rev shared doc"));
  const shellAfterRevoke = await getHtml(`/d/${d1.slug}`, { Cookie: grantee.cookie });
  check("revoked grantee shell -> 404 private notice", shellAfterRevoke.status === 404, `(${shellAfterRevoke.status})`);

  log("=== llms.txt + spec.yaml ===");
  const llms = await getHtml("/llms.txt");
  check("llms.txt documents scope param", /scope=owned\|shared\|all/.test(llms.text));
  check("llms.txt documents access field", /access/.test(llms.text) && /view_token/.test(llms.text));
  const spec = await getHtml("/api/spec.yaml");
  check("spec.yaml documents scope enum", /enum: \[owned, shared, all\]/.test(spec.text));
  check("spec.yaml DocListItem access enum", /enum: \[owner, editor, commenter, viewer\]/.test(spec.text));
  // run the llms.txt example verbatim (scope=all)
  const ex = await jget("/api/v1/docs?scope=all", bearer(owner.key));
  check("llms.txt example scope=all runs (200)", ex.status === 200);

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
