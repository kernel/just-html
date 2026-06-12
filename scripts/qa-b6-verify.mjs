// B6 blocking-fix verification against production.
//   1. Write rate limit: 60/min enforced inside one minute (61st write -> 429).
//   2. Read rate limit:  300/min enforced inside one minute.
//   3. Grant id is a JSON number on POST/GET; DELETE returns integer grant_id.
// Reuses the spec-pure registration ceremony via the QA login-link escape hatch.
//
// Usage: node --env-file=.env scripts/qa-b6-verify.mjs

const BASE = "https://justhtml.sh";
const QA = process.env.QA_SECRET;
if (!QA) { console.error("QA_SECRET not set"); process.exit(1); }

const TS = Date.now().toString(36);
const OWNER = `raf+qa-b6-${TS}@kernel.sh`;
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jpost(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j, retryAfter: r.headers.get("retry-after") };
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

async function registerAgent(email) {
  const ident = await jpost("/agent/identity", { type: "service_auth", login_hint: email });
  if (ident.status !== 200) throw new Error(`identity ${ident.status}`);
  const claimToken = ident.json.claim_token;
  const userCode = ident.json.claim.user_code;
  const u = new URL(ident.json.claim.verification_uri);
  const next = u.searchParams.get("next");
  const cvt = new URLSearchParams(next.split("?")[1]).get("claim_attempt_token");

  await fetch(BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ email, next }).toString(),
  });
  const llr = await fetch(`${BASE}/internal/qa/latest-login-link?email=${encodeURIComponent(email)}`, {
    headers: { "X-QA-Secret": QA },
  });
  const link = (await llr.json()).link;
  const lv = new URL(link);
  const verifyRes = await fetch(BASE + "/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ token: lv.searchParams.get("token"), next: lv.searchParams.get("next") }).toString(),
    redirect: "manual",
  });
  const cookie = verifyRes.headers.get("set-cookie").split(";")[0];
  const claimRes = await fetch(BASE + "/claim", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Cookie: cookie },
    body: new URLSearchParams({ claim_attempt_token: cvt, user_code: userCode }).toString(),
    redirect: "manual",
  });
  if (claimRes.status >= 400) throw new Error(`/claim ${claimRes.status}`);
  for (let i = 0; i < 6; i++) {
    const tok = await form("/oauth2/token", {
      grant_type: "urn:workos:agent-auth:grant-type:claim",
      claim_token: claimToken,
    });
    if (tok.status === 200 && tok.json.access_token) return tok.json.access_token;
    await sleep(1200);
  }
  throw new Error("no access_token");
}

const bearer = (k) => ({ Authorization: `Bearer ${k}` });

async function main() {
  log(`registering ${OWNER}…`);
  const key = await registerAgent(OWNER);
  log(`got key ${key.slice(0, 14)}…`);

  const create = await jpost("/api/v1/docs", { html: "<h1>b6</h1>", title: "B6 verify" }, bearer(key));
  if (create.status !== 201) throw new Error(`create ${create.status}`);
  const slug = create.json.slug;
  log(`doc slug=${slug}`);

  // === Finding 1a: write rate limit 60/min ===
  // Align to just after a minute boundary so all 70 writes land in one window
  // (date_trunc('minute') resets the counter on the boundary).
  const msToNextMinute = 60000 - (Date.now() % 60000);
  log(`\n  aligning to minute boundary (waiting ${Math.round(msToNextMinute/1000)}s)…`);
  await sleep(msToNextMinute + 500);
  log("=== write rate limit (expect 429 at #61 within one minute) ===");
  const t0 = Date.now();
  let writes200 = 0, writes429 = 0, firstRetryAfter = null, first429At = null;
  for (let i = 1; i <= 70; i++) {
    const resp = await fetch(BASE + `/api/v1/docs/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...bearer(key) },
      body: JSON.stringify({ title: `t${i}` }),
    });
    const r = { status: resp.status, retryAfter: resp.headers.get("retry-after"), json: null };
    if (r.status === 200) writes200++;
    else if (r.status === 429) {
      writes429++;
      if (first429At === null) { first429At = i; firstRetryAfter = r.retryAfter; }
    } else log(`  unexpected write #${i} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  log(`  elapsed ${elapsed}s  200s=${writes200}  429s=${writes429}  first429@#${first429At}  Retry-After=${firstRetryAfter}`);
  const writePass = writes200 === 60 && writes429 === 10 && first429At === 61 && firstRetryAfter !== null;
  log(`  WRITE LIMIT: ${writePass ? "PASS" : "FAIL"} (want 200s=60, 429s=10, first429@#61, Retry-After present)`);

  // === Finding 1b: read rate limit 300/min (fast) ===
  // Use the GET-meta read counter. Fire 305; expect ~300 ok then 429.
  log("\n=== read rate limit (expect 429 at #301 within one minute) ===");
  const tr0 = Date.now();
  let reads200 = 0, reads429 = 0, firstRead429 = null;
  for (let i = 1; i <= 305; i++) {
    const r = await fetch(BASE + `/api/v1/docs/${slug}`, { headers: bearer(key) });
    if (r.status === 200) reads200++;
    else if (r.status === 429) { reads429++; if (firstRead429 === null) firstRead429 = i; }
  }
  const relapsed = Math.round((Date.now() - tr0) / 1000);
  log(`  elapsed ${relapsed}s  200s=${reads200}  429s=${reads429}  first429@#${firstRead429}`);
  const readPass = reads200 === 300 && firstRead429 === 301;
  log(`  READ LIMIT: ${readPass ? "PASS" : "FAIL"} (want 200s=300, first429@#301)`);

  // === Finding 2: grant id types ===
  // Wait for the write window to reset so the grant POST (a write) isn't 429'd.
  log("\n=== grant id types (waiting for write window reset) ===");
  await sleep((Number(firstRetryAfter || 60) + 2) * 1000);
  const g = await jpost(`/api/v1/docs/${slug}/grants`, { email: `raf+grantee-${TS}@kernel.sh`, role: "viewer" }, bearer(key));
  const postIdType = typeof g.json?.grant?.id;
  log(`  POST /grants -> ${g.status} id=${JSON.stringify(g.json?.grant?.id)} (typeof ${postIdType})`);
  const gl = await fetch(BASE + `/api/v1/docs/${slug}/grants`, { headers: bearer(key) });
  const glj = await gl.json();
  const getIdType = typeof glj.grants?.[0]?.id;
  log(`  GET /grants  -> id=${JSON.stringify(glj.grants?.[0]?.id)} (typeof ${getIdType})`);
  const gid = g.json?.grant?.id;
  const del = await fetch(BASE + `/api/v1/docs/${slug}/grants/${gid}`, { method: "DELETE", headers: bearer(key) });
  const delj = await del.json();
  const delType = typeof delj.grant_id;
  log(`  DELETE       -> grant_id=${JSON.stringify(delj.grant_id)} (typeof ${delType})`);
  const grantPass = postIdType === "number" && getIdType === "number" && delType === "number";
  log(`  GRANT ID TYPES: ${grantPass ? "PASS" : "FAIL"} (all three must be number)`);

  log(`\n=== SUMMARY === write:${writePass?"PASS":"FAIL"} read:${readPass?"PASS":"FAIL"} grant:${grantPass?"PASS":"FAIL"}`);
  if (!(writePass && readPass && grantPass)) process.exit(1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
