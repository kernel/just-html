import { query, getPool } from "@/lib/db";
import {
  mintRegistrationId,
  mintClaimAttemptId,
  mintClaimToken,
  mintUserCode,
  sha256Hex,
} from "@/lib/auth/tokens";
import {
  CLAIM_WINDOW_S,
  USER_CODE_TTL_S,
  POLL_INTERVAL_S,
} from "@/lib/auth/config";

// Registration + claim-attempt minting shared by /agent/identity and
// /agent/identity/claim (re-mint).
//
// ONE flow (founder directive 2026-06-12, birthday.md "The claim ceremony —
// ONE flow"): registration emails the human a 6-digit code (the code and
// nothing else — no links, no buttons). The human reads the code back to the
// agent, which submits it to /agent/identity/claim/complete. There is no
// approve link, no hosted claim form, no claim_delivery parameter, and no
// spec-pure variant. The user_code never appears in any API response. The
// ceremony does NOT mint a browser session — binding proof is inbox
// possession; humans sign in separately at /login.

export type RegistrationRow = {
  id: number;
  public_id: string;
  email: string;
  claim_expires_at: string;
  claimed_at: string | null;
  credential_issued_at: string | null;
  last_polled_at: string | null;
  remint_count: number;
};

export type MintedAttempt = {
  attemptId: string;
  userCode: string; // plaintext, emailed to the human; NEVER returned to the agent
  expiresIn: number;
  interval: number;
  claimCodeId: number;
};

/**
 * Insert a fresh claim attempt for a registration, superseding any prior live
 * attempt (the partial unique index enforces one live attempt). Returns the
 * plaintext code (emailed, never API-returned) and the claim_codes row id.
 *
 * NOTE: the claim_codes table still carries view_token_hash / approve_token_hash
 * columns from the removed hosted-form / approve-link flows. They are dead — we
 * always insert NULL — and are left in place (the column drop is a no-op cleanup
 * deferred to avoid a destructive migration; see migrations/ and birthday.md).
 */
export async function mintAttempt(
  registrationId: number
): Promise<MintedAttempt> {
  const attemptId = mintClaimAttemptId();
  const userCode = mintUserCode();

  // Supersede any existing live attempt, then insert the new one. Done in a
  // transaction so the partial unique index never sees two live rows.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE claim_codes SET superseded_at = now()
       WHERE registration_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [registrationId]
    );
    const { rows } = await client.query(
      `INSERT INTO claim_codes
         (public_id, registration_id, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       RETURNING id`,
      [attemptId, registrationId, sha256Hex(userCode), String(USER_CODE_TTL_S)]
    );
    await client.query("COMMIT");
    return {
      claimCodeId: rows[0].id as number,
      attemptId,
      userCode,
      expiresIn: USER_CODE_TTL_S,
      interval: POLL_INTERVAL_S,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Create a brand-new pending registration with its first attempt. */
export async function createRegistration(email: string): Promise<{
  reg: { id: number; publicId: string; claimExpiresAt: string };
  claimToken: string; // plaintext, exactly once
  attempt: MintedAttempt;
}> {
  const publicId = mintRegistrationId();
  const claimToken = mintClaimToken();
  const { rows } = await query<{ id: number; claim_expires_at: string }>(
    `INSERT INTO agent_registrations (public_id, type, email, claim_token_hash, claim_expires_at)
     VALUES ($1, 'service_auth', $2, $3, now() + ($4 || ' seconds')::interval)
     RETURNING id, claim_expires_at`,
    [publicId, email, sha256Hex(claimToken), String(CLAIM_WINDOW_S)]
  );
  const regId = rows[0].id;
  const attempt = await mintAttempt(regId);
  return {
    reg: { id: regId, publicId, claimExpiresAt: rows[0].claim_expires_at },
    claimToken,
    attempt,
  };
}

/** Look up a registration by plaintext claim_token. */
export async function findByClaimToken(
  claimToken: string
): Promise<RegistrationRow | null> {
  const { rows } = await query<RegistrationRow>(
    `SELECT id, public_id, email, claim_expires_at, claimed_at,
            credential_issued_at, last_polled_at, remint_count
     FROM agent_registrations WHERE claim_token_hash = $1`,
    [sha256Hex(claimToken)]
  );
  return rows[0] ?? null;
}

/**
 * Confirm a claim in one transaction: consume the code, find-or-create the
 * users row (the ONLY place accounts are created), and bind the registration.
 * The ceremony does NOT mint or backfill a browser session (inbox possession is
 * the proof; humans sign in separately at /login). Returns the user id. Caller
 * must have already verified the code and the live state of the attempt.
 */
export async function confirmClaim(opts: {
  claimCodeId: number;
  registrationId: number;
  email: string;
}): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE claim_codes SET consumed_at = now() WHERE id = $1`,
      [opts.claimCodeId]
    );
    const { rows: userRows } = await client.query(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [opts.email]
    );
    const userId = userRows[0].id as number;
    await client.query(
      `UPDATE agent_registrations SET user_id = $1, claimed_at = now() WHERE id = $2`,
      [userId, opts.registrationId]
    );
    await client.query("COMMIT");
    return userId;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
