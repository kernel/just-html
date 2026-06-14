import { query, getPool } from "@/lib/db";
import {
  mintRegistrationId,
  mintClaimAttemptId,
  mintClaimToken,
  mintUserCode,
  mintApiKey,
  sha256Hex,
} from "@/lib/auth/tokens";
import {
  CLAIM_WINDOW_S,
  USER_CODE_TTL_S,
  POLL_INTERVAL_S,
  SCOPE_PG_ARRAY,
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
 * Discriminated result of the "look up by claim_token, then classify" precheck
 * that was triple-copied (with DIVERGENT status codes) across oauth2/token,
 * /agent/identity/claim, and /agent/identity/claim/complete (Theme T5). This
 * extracts only the LOOKUP LOGIC — each handler maps the union to its own
 * existing HTTP status codes / error envelope and emits its own audit events.
 *
 * IMPORTANT: the three handlers check `claimed` vs `expired` in DIFFERENT
 * precedence. oauth2/token checks the registration window BEFORE the claimed
 * branch (an expired-but-claimed reg is `expired`, not issued); /claim and
 * /claim/complete check claimed BEFORE expiry (a claimed reg is always 409,
 * even past its window). So `precedence` selects which discriminant wins when a
 * row is both claimed and past its window — preserving each handler's exact
 * current behavior.
 */
export type LiveRegistration =
  | { kind: "notFound" }
  | { kind: "claimed"; reg: RegistrationRow }
  | { kind: "expired"; reg: RegistrationRow }
  | { kind: "live"; reg: RegistrationRow };

export async function resolveLiveRegistration(
  claimToken: string,
  precedence: "expiredFirst" | "claimedFirst"
): Promise<LiveRegistration> {
  const reg = await findByClaimToken(claimToken);
  if (!reg) return { kind: "notFound" };
  const expired = new Date(reg.claim_expires_at).getTime() <= Date.now();
  const claimed = reg.claimed_at != null;
  if (precedence === "expiredFirst") {
    if (expired) return { kind: "expired", reg };
    if (claimed) return { kind: "claimed", reg };
  } else {
    if (claimed) return { kind: "claimed", reg };
    if (expired) return { kind: "expired", reg };
  }
  return { kind: "live", reg };
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

/**
 * Plain result of the one-time API-key issuance transaction. oauth2/token maps
 * this to HTTP (and emits the token.issued audit on success). Mirrors the three
 * outcomes the inline transaction used to return as Responses.
 */
export type IssueResult =
  | { kind: "notLive" } // registration vanished or has no bound user (under the lock)
  | { kind: "alreadyIssued" } // credential_issued_at already set
  | {
      kind: "issued";
      apiKey: string;
      userId: number;
      apiKeyId: number;
      publicId: string;
    };

/**
 * Mint the long-lived API key in a transaction guarded against double-issue.
 * Locks the registration row and re-checks credential_issued_at under the lock
 * so two concurrent first-polls can't both mint a key. Returns a PLAIN result;
 * the caller (oauth2/token) maps it to the OAuth envelope and audits.
 */
export async function issueCredential(regId: number): Promise<IssueResult> {
  const apiKey = mintApiKey();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: lockRows } = await client.query(
      `SELECT user_id, credential_issued_at, public_id FROM agent_registrations
       WHERE id = $1 FOR UPDATE`,
      [regId]
    );
    const lock = lockRows[0];
    if (!lock || lock.user_id == null) {
      await client.query("ROLLBACK");
      return { kind: "notLive" };
    }
    if (lock.credential_issued_at != null) {
      await client.query("ROLLBACK");
      return { kind: "alreadyIssued" };
    }
    const { rows: keyRows } = await client.query(
      `INSERT INTO api_keys (user_id, registration_id, token_hash, prefix, scopes, created_via)
       VALUES ($1, $2, $3, $4, $5::text[], 'auth.md')
       RETURNING id`,
      [lock.user_id, regId, sha256Hex(apiKey), apiKey.slice(0, 12), SCOPE_PG_ARRAY]
    );
    await client.query(
      `UPDATE agent_registrations SET credential_issued_at = now() WHERE id = $1`,
      [regId]
    );
    await client.query("COMMIT");
    return {
      kind: "issued",
      apiKey,
      userId: lock.user_id as number,
      apiKeyId: keyRows[0].id as number,
      publicId: lock.public_id as string,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
