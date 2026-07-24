import { query } from "@/lib/db";
import { createDoc } from "@/lib/docs/store";
import { createSession } from "@/lib/auth/session";

async function ensureUser(email: string): Promise<number> {
  await query(`INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
  const { rows } = await query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
  return rows[0].id;
}

async function main() {
  const aliceId = await ensureUser("alice@example.com");
  await ensureUser("bob@example.com");

  const priv = await createDoc({ ownerId: aliceId, html: "<h1>private 1</h1>", title: "Alice private doc 1 ", isPublic: false });
  const priv2 = await createDoc({ ownerId: aliceId, html: "<h1>private 2</h1>", title: "Alice private doc 2 ", isPublic: false });
  const pub  = await createDoc({ ownerId: aliceId, html: "<h1>public</h1>",  title: "Alice public doc",  isPublic: true });
  if ("quota" in priv || "quota" in priv2 || "quota" in pub) throw new Error("quota hit");

  const alice = await createSession("alice@example.com");
  const bob   = await createSession("bob@example.com");

  console.log("\nLog in by pasting one of these into the devtools console at http://localhost:3000:");
  console.log(`  alice: document.cookie = "jh_sess=${alice.token}; path=/";`);
  console.log(`  bob:   document.cookie = "jh_sess=${bob.token}; path=/";`);
  console.log("\nPrivate share link (open while logged in as bob):");
  console.log(`  http://localhost:3000/d/${priv.doc.slug}?viewtoken=${priv.doc.view_token}`);
  console.log("\nprivate 1 slug:", priv.doc.slug, "| token:", priv.doc.view_token, 
    "| private 2 slug:", priv2.doc.slug, "| token:", priv2.doc.view_token, 
    "| public slug:", pub.doc.slug);
  process.exit(0);
}

main();