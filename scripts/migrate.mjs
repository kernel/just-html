#!/usr/bin/env node
// Tiny SQL migration runner.
//
// - Reads *.sql files from migrations/ in lexical order.
// - Records applied filenames + sha256 in a schema_migrations table.
// - Each migration runs inside a transaction; the whole file is one unit.
// - `status` subcommand prints applied vs pending without changing anything.
//
// Usage:
//   node --env-file=.env scripts/migrate.mjs          # apply pending
//   node --env-file=.env scripts/migrate.mjs status   # list state
//
// Idempotent: re-running applies nothing. If a previously-applied file's
// checksum changed, the runner aborts loudly (migrations are immutable).

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function listMigrations() {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(migrationsDir, name), "utf8");
      return { name, sql, checksum: sha256(sql) };
    });
}

// PlanetScale's URL carries sslmode=verify-full&sslrootcert=system, which the
// pg connection-string parser mishandles (tries to read a file named "system").
// Strip the libpq-only ssl params and drive TLS explicitly against Node's CA
// store. Mirrors lib/pg-config.ts (kept inline so this script has no TS dep).
function pgConfig() {
  const raw = process.env.PLANETSCALE_URL;
  if (!raw) {
    console.error("PLANETSCALE_URL is not set");
    process.exit(1);
  }
  const url = new URL(raw);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");
  const wantsTls = sslmode == null || sslmode !== "disable";
  return {
    connectionString: url.toString(),
    ssl: wantsTls ? { rejectUnauthorized: true } : false,
  };
}

async function main() {
  const mode = process.argv[2] === "status" ? "status" : "apply";
  const client = new Client(pgConfig());
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text        PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows: appliedRows } = await client.query(
      "SELECT name, checksum FROM schema_migrations ORDER BY name"
    );
    const applied = new Map(appliedRows.map((r) => [r.name, r.checksum]));
    const migrations = listMigrations();

    if (mode === "status") {
      console.log("migration".padEnd(48), "status");
      console.log("-".repeat(64));
      for (const m of migrations) {
        let status = "PENDING";
        if (applied.has(m.name)) {
          status = applied.get(m.name) === m.checksum ? "applied" : "CHECKSUM MISMATCH";
        }
        console.log(m.name.padEnd(48), status);
      }
      return;
    }

    let count = 0;
    for (const m of migrations) {
      if (applied.has(m.name)) {
        if (applied.get(m.name) !== m.checksum) {
          throw new Error(
            `Checksum mismatch for already-applied migration ${m.name}. ` +
              `Migrations are immutable; create a new migration instead.`
          );
        }
        continue;
      }
      process.stdout.write(`applying ${m.name} ... `);
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [m.name, m.checksum]
        );
        await client.query("COMMIT");
        console.log("ok");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }
    console.log(count === 0 ? "nothing to apply (up to date)" : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
