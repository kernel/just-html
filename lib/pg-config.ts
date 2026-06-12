import type { PoolConfig } from "pg";

// PlanetScale's connection string carries `sslmode=verify-full&sslrootcert=system`.
// node-postgres' connection-string parser tries to read a file literally named
// "system" for sslrootcert and crashes (ENOENT). PlanetScale serves a publicly
// trusted certificate, so we strip the libpq-style ssl params from the URL and
// drive TLS via an explicit `ssl` object that verifies against Node's bundled
// CA store (rejectUnauthorized: true => full verification).
export function pgConfigFromEnv(): PoolConfig {
  const raw = process.env.PLANETSCALE_URL;
  if (!raw) {
    throw new Error("PLANETSCALE_URL is not set");
  }
  const url = new URL(raw);
  const sslmode = url.searchParams.get("sslmode");
  // Remove libpq-only params node-postgres can't interpret.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("sslrootcert");

  const wantsTls = sslmode == null || sslmode !== "disable";

  return {
    connectionString: url.toString(),
    ssl: wantsTls ? { rejectUnauthorized: true } : false,
  };
}
