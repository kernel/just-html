-- Auth domain: users, agent registrations, claim codes, login tokens,
-- sessions, api_keys. DDL is authoritative per authmd-implementation.md §10.

-- users — created ONLY at claim confirm (never at registration or /login).
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      citext NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- agent_registrations — pending registration; no user row until claimed.
-- Status is DERIVED (claimed_at / claim_expires_at), not stored. No sweeper.
CREATE TABLE agent_registrations (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id            text NOT NULL UNIQUE,          -- 'reg_' + 16B base64url (wire id)
  type                 text NOT NULL DEFAULT 'service_auth'
                         CHECK (type = 'service_auth'),
  email                citext NOT NULL,               -- the login_hint; updatable by re-mint
  user_id              bigint REFERENCES users(id),   -- NULL until claimed
  claim_token_hash     text NOT NULL UNIQUE,          -- sha256 hex of clm_…
  claim_expires_at     timestamptz NOT NULL,          -- created_at + 24h
  claimed_at           timestamptz,
  credential_issued_at timestamptz,                   -- long-lived key issued exactly once
  last_polled_at       timestamptz,                   -- slow_down enforcement
  remint_count         int NOT NULL DEFAULT 0,        -- cap 10
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_registrations_email_idx ON agent_registrations (email);

-- claim_codes — the spec's claim attempt. One live attempt per registration;
-- re-mint supersedes the old one but keeps it as history.
CREATE TABLE claim_codes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id         text NOT NULL UNIQUE,             -- 'cla_' + 16B base64url (claim_attempt_id)
  registration_id   bigint NOT NULL REFERENCES agent_registrations(id),
  code_hash         text NOT NULL,                    -- sha256 of 6-digit user_code
  view_token_hash   text NOT NULL UNIQUE,             -- sha256 of cvt_… (claim_attempt_token)
  expires_at        timestamptz NOT NULL,             -- code TTL: +600s
  view_expires_at   timestamptz NOT NULL,             -- attempt-token TTL: +600s
  attempts          int NOT NULL DEFAULT 0,           -- dead at 5
  consumed_at       timestamptz,                      -- set on success OR attempts-exhausted
  superseded_at     timestamptz,                      -- set when a re-mint replaces this attempt
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_codes_registration_idx ON claim_codes (registration_id);
CREATE UNIQUE INDEX claim_codes_one_live_attempt
  ON claim_codes (registration_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

-- login_tokens — single-use magic links (15 min TTL).
CREATE TABLE login_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       citext NOT NULL,
  token_hash  text NOT NULL UNIQUE,                   -- sha256 of lt_…
  expires_at  timestamptz NOT NULL,                   -- created_at + 15 min
  consumed_at timestamptz,                            -- single-use
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- sessions — DB-backed, keyed by verified email; user_id nullable (the human
-- signs in before their account exists). 30 d sliding.
CREATE TABLE sessions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        citext NOT NULL,
  user_id      bigint REFERENCES users(id),
  token_hash   text NOT NULL UNIQUE,                  -- sha256 of sess_…
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,                  -- 30 d sliding
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- api_keys — long-lived jh_live_ keys, hashed at rest; one issued per
-- registration (locked by agent_registrations.credential_issued_at).
CREATE TABLE api_keys (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id),
  registration_id bigint REFERENCES agent_registrations(id),
  token_hash      text NOT NULL UNIQUE,               -- sha256 of full jh_live_… key
  prefix          text NOT NULL,                      -- first 12 chars for display
  scopes          text[] NOT NULL DEFAULT '{docs.read,docs.write}',
  created_via     text NOT NULL DEFAULT 'auth.md',
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);
