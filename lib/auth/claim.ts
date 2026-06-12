import { query, getPool } from "@/lib/db";
import {
  mintRegistrationId,
  mintClaimAttemptId,
  mintClaimToken,
  mintAttemptToken,
  mintUserCode,
  sha256Hex,
} from "@/lib/auth/tokens";
import {
  CLAIM_WINDOW_S,
  USER_CODE_TTL_S,
  ATTEMPT_TOKEN_TTL_S,
  POLL_INTERVAL_S,
  ORIGIN,
} from "@/lib/auth/config";

// Registration + claim-attempt minting shared by /agent/identity and
// /agent/identity/claim (re-mint). The claim_attempt_token (cvt_) identifies a
// registration without leaking the user-typed code; it rides verification_uri.

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

/** Build the /login-wrapped verification_uri for an attempt token (§3.1). */
export function buildVerificationUri(attemptToken: string): string {
  const claimPath = `/claim?claim_attempt_token=${attemptToken}`;
  return `${ORIGIN}/login?next=${encodeURIComponent(claimPath)}`;
}

export type MintedAttempt = {
  attemptId: string;
  userCode: string; // plaintext, returned exactly once
  attemptToken: string; // plaintext (cvt_), only inside verification_uri
  verificationUri: string;
  expiresIn: number;
  interval: number;
  viewExpiresAt: string;
};

/**
 * Insert a fresh claim attempt for a registration, superseding any prior live
 * attempt (the partial unique index enforces one live attempt). Returns the
 * plaintext code + token (exactly once) and the claim_codes row id.
 */
export async function mintAttempt(
  registrationId: number
): Promise<MintedAttempt & { claimCodeId: number }> {
  const attemptId = mintClaimAttemptId();
  const userCode = mintUserCode();
  const attemptToken = mintAttemptToken();

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
         (public_id, registration_id, code_hash, view_token_hash, expires_at, view_expires_at)
       VALUES ($1, $2, $3, $4,
         now() + ($5 || ' seconds')::interval,
         now() + ($6 || ' seconds')::interval)
       RETURNING id, view_expires_at`,
      [
        attemptId,
        registrationId,
        sha256Hex(userCode),
        sha256Hex(attemptToken),
        String(USER_CODE_TTL_S),
        String(ATTEMPT_TOKEN_TTL_S),
      ]
    );
    await client.query("COMMIT");
    return {
      claimCodeId: rows[0].id as number,
      attemptId,
      userCode,
      attemptToken,
      verificationUri: buildVerificationUri(attemptToken),
      expiresIn: USER_CODE_TTL_S,
      interval: POLL_INTERVAL_S,
      viewExpiresAt: rows[0].view_expires_at as string,
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
  attempt: MintedAttempt & { claimCodeId: number };
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
