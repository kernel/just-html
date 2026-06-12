// QA helper: seed N users + API keys directly in the DB, bypassing the auth-flow
// rate limiter (the registration ceremony is tested separately in qa-b9; B10's
// concern is the comment/reaction surface, which only needs valid keys). Prints
// the plaintext keys as JSON to stdout. Mirrors how the QA login-link endpoint
// bypasses email for automated tests — same spirit, DB-direct.
//
// Usage: node --env-file=.env scripts/qa-b10-seed.mjs <email1> <email2> ...
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const emails = process.argv.slice(2);
if (emails.length === 0) {
  console.error("usage: qa-b10-seed.mjs <email> [email ...]");
  process.exit(1);
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const mintKey = () => "jh_live_" + randomBytes(32).toString("base64url");

const raw = process.env.PLANETSCALE_URL;
const url = new URL(raw);
url.searchParams.delete("sslmode");
url.searchParams.delete("sslrootcert");
const c = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true } });
await c.connect();

const out = {};
for (const email of emails) {
  const { rows } = await c.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [email]
  );
  const userId = rows[0].id;
  const key = mintKey();
  await c.query(
    `INSERT INTO api_keys (user_id, token_hash, prefix, scopes, created_via)
     VALUES ($1, $2, $3, '{docs.read,docs.write}', 'qa-seed')`,
    [userId, sha256(key), key.slice(0, 12)]
  );
  out[email] = key;
}
await c.end();
console.log(JSON.stringify(out));
