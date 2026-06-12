import { query, getPool } from "@/lib/db";
import {
  mintRegistrationId,
  mintClaimAttemptId,
  mintClaimToken,
  mintAttemptToken,
  mintApproveToken,
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

export type ClaimDelivery = "email" | "agent";

export type RegistrationRow = {
  id: number;
  public_id: string;
  email: string;
  claim_delivery: ClaimDelivery;
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

/** Build the scanner-safe approve link emailed in claim_delivery=email mode. */
export function buildApproveUri(approveToken: string): string {
  return `${ORIGIN}/claim/approve?token=${approveToken}`;
}

export type MintedAttempt = {
  attemptId: string;
  userCode: string; // plaintext, returned exactly once
  attemptToken: string; // plaintext (cvt_), only inside verification_uri
  approveToken: string | null; // plaintext (cva_), only inside the approve link (email mode)
  verificationUri: string;
  approveUri: string | null;
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
  registrationId: number,
  delivery: ClaimDelivery = "agent"
): Promise<MintedAttempt & { claimCodeId: number }> {
  const attemptId = mintClaimAttemptId();
  const userCode = mintUserCode();
  const attemptToken = mintAttemptToken();
  // The approve link exists only in email mode — its single use IS the binding
  // proof (inbox possession), so it's tied to this specific attempt and dies on
  // re-mint along with the code (the row is superseded).
  const approveToken = delivery === "email" ? mintApproveToken() : null;

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
         (public_id, registration_id, code_hash, view_token_hash, approve_token_hash,
          expires_at, view_expires_at)
       VALUES ($1, $2, $3, $4, $5,
         now() + ($6 || ' seconds')::interval,
         now() + ($7 || ' seconds')::interval)
       RETURNING id, view_expires_at`,
      [
        attemptId,
        registrationId,
        sha256Hex(userCode),
        sha256Hex(attemptToken),
        approveToken ? sha256Hex(approveToken) : null,
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
      approveToken,
      verificationUri: buildVerificationUri(attemptToken),
      approveUri: approveToken ? buildApproveUri(approveToken) : null,
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
export async function createRegistration(
  email: string,
  delivery: ClaimDelivery = "email"
): Promise<{
  reg: { id: number; publicId: string; claimExpiresAt: string };
  claimToken: string; // plaintext, exactly once
  attempt: MintedAttempt & { claimCodeId: number };
}> {
  const publicId = mintRegistrationId();
  const claimToken = mintClaimToken();
  const { rows } = await query<{ id: number; claim_expires_at: string }>(
    `INSERT INTO agent_registrations (public_id, type, email, claim_delivery, claim_token_hash, claim_expires_at)
     VALUES ($1, 'service_auth', $2, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING id, claim_expires_at`,
    [publicId, email, delivery, sha256Hex(claimToken), String(CLAIM_WINDOW_S)]
  );
  const regId = rows[0].id;
  const attempt = await mintAttempt(regId, delivery);
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
    `SELECT id, public_id, email, claim_delivery, claim_expires_at, claimed_at,
            credential_issued_at, last_polled_at, remint_count
     FROM agent_registrations WHERE claim_token_hash = $1`,
    [sha256Hex(claimToken)]
  );
  return rows[0] ?? null;
}

/**
 * Confirm a claim in one transaction: consume the code, find-or-create the
 * users row (the ONLY place accounts are created), bind the registration, and
 * optionally backfill a session's user_id (the human walks away logged in).
 * Shared by the spec-pure /claim form, the agent read-back endpoint, and the
 * approve-link path. Returns the user id. Caller must have already verified the
 * code/approve-token and the live state of the attempt.
 */
/**
 * Resolve the registration email behind a claim_attempt_token (cvt_), for the
 * claim-aware /login copy (birthday.md "Copy rule"): "your agent is registering
 * a justhtml.sh account for <email> — sign in to confirm". Returns null if the
 * token doesn't resolve to a live, unclaimed attempt (so the copy degrades to a
 * generic claim line rather than leaking a stale address). The token is the
 * unguessable cvt_ from the verification_uri, so surfacing the email it was
 * minted for to whoever holds that link is not an enumeration vector.
 */
export async function emailForAttemptToken(
  attemptToken: string
): Promise<string | null> {
  if (!attemptToken.startsWith("cvt_")) return null;
  const { rows } = await query<{ email: string }>(
    `SELECT r.email
     FROM claim_codes c
     JOIN agent_registrations r ON r.id = c.registration_id
     WHERE c.view_token_hash = $1 AND c.superseded_at IS NULL`,
    [sha256Hex(attemptToken)]
  );
  return rows[0]?.email ?? null;
}

export async function confirmClaim(opts: {
  claimCodeId: number;
  registrationId: number;
  email: string;
  sessionId?: number | null;
  markApproved?: boolean; // set approved_at (approve-link path)
}): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE claim_codes SET consumed_at = now()${
        opts.markApproved ? ", approved_at = now()" : ""
      } WHERE id = $1`,
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
    if (opts.sessionId != null) {
      await client.query(`UPDATE sessions SET user_id = $1 WHERE id = $2`, [
        userId,
        opts.sessionId,
      ]);
    }
    await client.query("COMMIT");
    return userId;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
