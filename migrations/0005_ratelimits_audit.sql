-- Rate-limit counters (§6) and audit_log (§7).

-- rate_limits — fixed-window upsert counter. No Redis.
CREATE TABLE rate_limits (
  key          text        NOT NULL,   -- e.g. 'ident:ip:203.0.113.7' | 'login:email:raf@kernel.sh'
  window_start timestamptz NOT NULL,   -- date_trunc('hour', now()) or day
  count        int         NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- audit_log — append-only. Never write secrets/codes/links into meta; IDs only.
CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event           text        NOT NULL,
  registration_id bigint      REFERENCES agent_registrations(id),
  user_id         bigint      REFERENCES users(id),
  api_key_id      bigint      REFERENCES api_keys(id),
  ip              inet,
  user_agent      text,
  meta            jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_registration_idx ON audit_log (registration_id);
CREATE INDEX audit_log_event_time_idx   ON audit_log (event, created_at);
