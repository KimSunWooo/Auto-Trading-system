-- Additive migration: per-user preferred PAPER/REAL broker account pointers.
-- Safe on AWS RDS auto_trading. Never DROP. Rollback = NULL out the two columns
-- (or DROP COLUMN if explicitly approved); does not delete broker_accounts or ledgers.
--
-- Apply (ops):
--   mysql ... < docs/migrations/2026-11-12-user-broker-account-prefs.sql
-- Or rely on ensureAuthSchema() which adds columns + conservative backfill.
--
-- Rollback (optional):
--   ALTER TABLE users DROP COLUMN paper_broker_account_id;
--   ALTER TABLE users DROP COLUMN real_broker_account_id;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS paper_broker_account_id CHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS real_broker_account_id CHAR(36) NULL;

-- MySQL < 8.0.12 may not support IF NOT EXISTS on ADD COLUMN; use ensureAuthSchema instead.

-- Indexes (ignore error if already present):
-- ALTER TABLE users ADD KEY ix_users_paper_broker_account (paper_broker_account_id);
-- ALTER TABLE users ADD KEY ix_users_real_broker_account (real_broker_account_id);
