import { Pool } from "pg";
import { pgConfigFromEnv } from "@/lib/pg-config";

// Single shared pool per serverless instance. PlanetScale Postgres speaks the
// standard wire protocol; the connection string (PLANETSCALE_URL) carries
// sslmode=verify-full and the credentials.
//
// We keep the pool small: Vercel functions are short-lived and PlanetScale's
// pooler fronts the cluster, so a large client-side pool buys nothing.

declare global {
  // eslint-disable-next-line no-var
  var __jhPool: Pool | undefined;
}

function makePool(): Pool {
  return new Pool({
    ...pgConfigFromEnv(),
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function getPool(): Pool {
  if (!global.__jhPool) {
    global.__jhPool = makePool();
  }
  return global.__jhPool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const pool = getPool();
  const res = await pool.query(text, params as never);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

/** Lightweight connectivity probe used by /api/health. */
export async function pingDb(): Promise<boolean> {
  try {
    const { rows } = await query<{ ok: number }>("SELECT 1 AS ok");
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
