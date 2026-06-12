-- Extensions required by the v1 schema.
-- citext: case-insensitive email columns (users, registrations, sessions, grants).
CREATE EXTENSION IF NOT EXISTS citext;
