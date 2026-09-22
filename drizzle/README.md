# Drizzle SQL output (fresh local only)

Do **not** apply full generated `CREATE TABLE` dumps to the existing production RDS.

- Existing RDS: already has baseline schema. Additive changes go through `ensureAuthSchema()` (preferred) or a reviewed ALTER-only file such as `0001_paper_physical_fingerprint.sql`.
- Fresh local: prefer `docker compose -f docker-compose.db.yml up` which loads `db/baseline.mysql.sql` (includes CHECKs, `v_buy_history`, and PAPER physical fingerprint unique).

`npm run db:generate` may write SQL here. Review for DROP TABLE / DROP COLUMN before any apply.
`npm run db:migrate` refuses unless `ALLOW_DB_MIGRATE=fresh-local`, and still does not auto-apply.

PAPER physical ownership (ACTIVE claim):

- Column: `broker_accounts.physical_account_fingerprint` (HMAC hex, never plaintext CANO)
- Unique: `uq_broker_accounts_paper_physical (broker, environment, physical_account_fingerprint)`
- DISABLED rows set fingerprint to NULL to release the claim
