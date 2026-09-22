-- Additive only. Safe for adopted RDS after review.
-- Applied at runtime by ensureAuthSchema() (preferred).
-- Do NOT DROP columns/tables. Do NOT invent plaintext account columns.

-- 1) Column (nullable — DISABLED rows keep NULL to release unique claim)
ALTER TABLE broker_accounts
  ADD COLUMN IF NOT EXISTS physical_account_fingerprint VARCHAR(64) NULL;

-- MySQL < 8.0.12 may not support IF NOT EXISTS on ADD COLUMN; ensureAuthSchema
-- uses SHOW COLUMNS and conditional ALTER instead.

-- 2) Backfill ACTIVE kis/PAPER fingerprints via application (decrypt + HMAC).
--    If duplicates exist → FAIL CLOSED with DUPLICATE_ACTIVE_PAPER_PHYSICAL_ACCOUNT.
--    Never auto-disable/delete.

-- 3) Unique claim (NULLs allowed for DISABLED history)
-- ALTER TABLE broker_accounts
--   ADD UNIQUE KEY uq_broker_accounts_paper_physical (
--     broker,
--     environment,
--     physical_account_fingerprint
--   );
