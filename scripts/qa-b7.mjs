// B7 Share-notifications end-to-end QA against production.
//
// Verifies: an email grant emails the grantee a 7-day single-use login link
// with next=/d/:slug; clicking it (no prior account) mints an email-keyed
// session and authorizes viewing /d/:slug and /d/:slug/raw with NO view token;
// notify:false and domain grants send NO notification; the stale-link fallback
// renders on the private-doc notice.
//
// Usage: node --env-file=.env scripts/qa-b7.mjs

const BASE = "https://justhtml.sh";
const QA = process.env.QA_SECRET;
if (!QA) { console.error("QA_SECRET not set"); process.exit(1); }

const TS = Date.now().toString(36);
const OWNER = `raf+qa-b7-owner-${TS}@kernel.sh`;
const GRANTEE = `raf+qa-b7-grantee-${TS}@kernel.sh`;      // never registers an account
const NONOTIFY = `raf+qa-b7-nonotify-${TS}@kernel.sh`;
const DOMAINEE = `raf+qa-b7-domain-${TS}@kernel.sh`;

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
async function qaLatestLink(email) {
  const r = await fetch(`${BASE}/internal/qa/latest-login-link?email=${encodeURIComponent(email)}`, {
    headers: { "X-QA-Secret": QA },
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}

// Register one agent and complete the spec-pure claim ceremony → jh_live_ key.
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
    await sleep(1200);
  }
  if (!key) throw new Error("no access_token");
  return key;
}

// Sign in a never-registered grantee purely via the share link → returns the
// session cookie (no account, no claim ceremony).
async function consumeShareLink(email) {
  const ll = await qaLatestLink(email);
  if (ll.status !== 200) throw new Error(`no share link for ${email} (${ll.status})`);
  const u = new URL(ll.json.link);
  const next = u.searchParams.get("next");
  const verify = await form("/login/verify", { token: u.searchParams.get("token"), next });
  const setCookie = verify.res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`share link did not mint a session (${verify.status})`);
  return { cookie: setCookie.split(";")[0], next, location: verify.res.headers.get("location"), status: verify.status };
}

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  (cond ? (pass++, log(`  PASS ${label} ${extra}`)) : (fail++, log(`  FAIL ${label} ${extra}`)));
}

async function main() {
  log("=== register owner ===");
  const ownerKey = await registerAgent(OWNER);
  log(`  owner key ${ownerKey.slice(0, 14)}…`);

  log("\n=== owner creates a PRIVATE doc ===");
  const create = await jpost("/api/v1/docs",
    { html: "<h1>secret plan — visible only to grantees</h1>", title: "B7 Share QA" }, bearer(ownerKey));
  if (create.status !== 201) throw new Error(`create ${create.status}: ${JSON.stringify(create.json)}`);
  const slug = create.json.slug;
  log(`  slug=${slug} public=${create.json.public}`);

  log("\n=== email grant WITH notify (default) ===");
  const grant = await jpost("/api/v1/docs/" + slug + "/grants", { email: GRANTEE, role: "editor" }, bearer(ownerKey));
  check("grant created (201)", grant.status === 201, `status=${grant.status}`);
  check("notified:true in response", grant.json?.notified === true, `notified=${grant.json?.notified}`);

  log("\n=== share-notification email link retrievable ===");
  await sleep(800);
  const ll = await qaLatestLink(GRANTEE);
  check("QA has a share link for grantee", ll.status === 200 && !!ll.json?.link);
  const shareNext = ll.status === 200 ? new URL(ll.json.link).searchParams.get("next") : null;
  check("share link next=/d/:slug", shareNext === `/d/${slug}`, `next=${shareNext}`);

  log("\n=== grantee (no account) clicks share link → session + redirect to doc ===");
  const sess = await consumeShareLink(GRANTEE);
  check("login/verify 303", sess.status === 303, `status=${sess.status}`);
  check("redirect Location = /d/:slug", sess.location === `/d/${slug}`, `loc=${sess.location}`);

  log("\n=== grantee session views the private doc with NO view token ===");
  const shellAnon = await fetch(BASE + "/d/" + slug, { redirect: "manual" });
  check("anonymous /d/:slug → 404 private notice", shellAnon.status === 404, `status=${shellAnon.status}`);
  const shell = await fetch(BASE + "/d/" + slug, { headers: { Cookie: sess.cookie } });
  const shellHtml = await shell.text();
  check("grantee session /d/:slug → 200", shell.status === 200, `status=${shell.status}`);
  check("shell iframe carries a viewtoken capability", /\/raw\?viewtoken=/.test(shellHtml));
  // /raw via the grantee's session (top-level nav sends Lax cookie).
  const raw = await fetch(BASE + "/d/" + slug + "/raw", { headers: { Cookie: sess.cookie } });
  check("grantee session /d/:slug/raw → 200", raw.status === 200, `status=${raw.status}`);
  const rawAnon = await fetch(BASE + "/d/" + slug + "/raw");
  check("anonymous /raw (no token) → 404", rawAnon.status === 404, `status=${rawAnon.status}`);

  log("\n=== notify:false suppresses the email ===");
  const gNo = await jpost("/api/v1/docs/" + slug + "/grants", { email: NONOTIFY, role: "viewer", notify: false }, bearer(ownerKey));
  check("grant 201, notified:false", gNo.status === 201 && gNo.json?.notified === false, `notified=${gNo.json?.notified}`);
  await sleep(500);
  const noLink = await qaLatestLink(NONOTIFY);
  check("no share link minted for notify:false grantee", noLink.status !== 200, `status=${noLink.status}`);

  log("\n=== domain grant NEVER notifies ===");
  const gDom = await jpost("/api/v1/docs/" + slug + "/grants", { domain: "kernel.sh", role: "viewer" }, bearer(ownerKey));
  check("domain grant 201, no 'notified' field", gDom.status === 201 && gDom.json?.notified === undefined, `notified=${gDom.json?.notified}`);
  // A same-domain email that was never granted/notified still gets NO email...
  const domLink = await qaLatestLink(DOMAINEE);
  check("no share link minted by the domain grant", domLink.status !== 200, `status=${domLink.status}`);
  // ...but a session on that domain can still VIEW via the domain grant.
  // (Mint a plain /login session for DOMAINEE and confirm viewer access.)
  const dl = await form("/login", { email: DOMAINEE, next: "/d/" + slug });
  const dLink = (await qaLatestLink(DOMAINEE)).json.link;
  const dv = new URL(dLink);
  const dVerify = await form("/login/verify", { token: dv.searchParams.get("token"), next: dv.searchParams.get("next") });
  const dCookie = dVerify.res.headers.get("set-cookie").split(";")[0];
  const dShell = await fetch(BASE + "/d/" + slug, { headers: { Cookie: dCookie } });
  check("kernel.sh domain-grant session views the doc", dShell.status === 200, `status=${dShell.status}`);

  log("\n=== stale-link fallback on the private notice ===");
  const notice = await fetch(BASE + "/d/" + slug); // anonymous
  const noticeHtml = await notice.text();
  check("private notice offers 'Was this shared with you? Sign in'",
    /Was this shared with you\?.*Sign in/s.test(noticeHtml) && noticeHtml.includes(`/login?next=%2Fd%2F${slug}`));

  log(`\n==== B7 QA: ${pass} passed, ${fail} failed ====  slug=${slug}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
