-- One-time codes for "Forgot password". Only a bcrypt hash of each 6-digit code is
-- stored; a code works once, expires after 15 minutes and allows a few wrong guesses.
-- (Not to be confused with 126_identity_invites.sql, a migration of the earlier schema
-- version that the shared Supabase database also records.)

CREATE TABLE IF NOT EXISTS identity.password_resets (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  code_hash   TEXT        NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON identity.password_resets (user_id, created_at DESC);
