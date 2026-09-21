# RDS Operations

No passwords, endpoints, or account numbers are recorded here.

## Connection environment

Application reads, in order:

1. `DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/auto_trading`
2. Or `DATABASE_URL=HOST:3306/db` (no credentials in URL) plus `DATABASE_USER_NAME` + `DATABASE_PASSWORD`
3. Or `AWS_RDS_USERNAME` + `AWS_RDS_PASSWORD` + `AWS_RDS_DATABASE` (hostname) with database name `AWS_RDS_DB_NAME` (default `auto_trading`)

`DATABASE_PASSWORD` is preferred. Legacy typo `DATABASE_PASSOWORD` is accepted as a deprecated alias (warning only; value never logged).

Also:

```text
PERSISTENCE_MODE=json|mirror     # default json
BOOTSTRAP_USER_EMAIL=            # optional LOCAL_OWNER email
AWS_RDS_PORT=3306
AWS_RDS_SSL=true
CONFIRM_LEGACY_IMPORT=YES        # required for npm run db:import-legacy
ALLOW_DB_MIGRATE=fresh-local     # still refuses automatic apply
```

Never log `DATABASE_URL`, passwords, APP_KEY/SECRET, or full account numbers. `GET /api/runtime/database` returns mode/connected/last error only.

## Application vs migration users

| User | Allowed |
| --- | --- |
| `autotrading_app` (runtime) | SELECT, INSERT, UPDATE, DELETE |
| Migration master | CREATE/ALTER only for **fresh local** installs, never as the Next.js runtime |

Runtime must not DROP, ALTER, or CREATE TABLE.

## Secrets policy

Store in env / secret manager only:

- `KIS_REAL_APP_KEY` / `KIS_REAL_APP_SECRET`
- `KIS_PAPER_APP_KEY` / `KIS_PAPER_APP_SECRET`
- full account numbers
- RDS passwords

`broker_accounts.credential_ref` may store `env:KIS_PAPER` or `env:KIS_REAL`. Audit logs must not include credentials.

## Backup

RDS automated backups / snapshots stay in AWS. JSON files (`data/paper-account.json`, `data/strategy-config.json`) remain the migration-era runtime copy. Do not treat Redis as a backup of fills.

## Local MySQL vs RDS

| | Local | Production RDS |
| --- | --- | --- |
| How to create | `docker compose -f docker-compose.db.yml up` loads `db/baseline.mysql.sql` | Already created. **Adopt. Do not recreate.** |
| App user | `autotrading_app` / local password | application user with DML only |
| `drizzle-kit push` | forbidden without review | **forbidden** |
| DROP DATABASE / DROP TABLE | not used by the app | forbidden |

Existing application Docker files are not rewritten. `docker-compose.db.yml` is additive.

## Fresh DB migration

1. Start local MySQL 8 from `docker-compose.db.yml`
2. Confirm `SHOW TABLES` matches the 37 tables + `v_buy_history`
3. Point `DATABASE_URL` at local, `PERSISTENCE_MODE=json` until tests pass
4. Then `PERSISTENCE_MODE=mirror` against **local** only

`npm run db:generate` writes SQL under `drizzle/` for review. `npm run db:migrate` refuses to apply automatically.

## Existing RDS adoption

The production schema is the baseline. Application Drizzle schema was written to match it.

Do **not**:

- `CREATE DATABASE` / `DROP DATABASE`
- `DROP TABLE` / recreate tables
- destructive ALTER, DROP COLUMN, RENAME COLUMN
- drop VIEW `v_buy_history`
- drop UNIQUE / FOREIGN KEY

If a generated migration contains those statements, STOP.

`npm run db:check` is read-only (`SHOW TABLES` / `SELECT 1`).

## Production migration precautions

- Default `PERSISTENCE_MODE=json` so an unset DB does not change trading
- Enable `mirror` only after local tests
- Application DSN should use `autotrading_app`, not the schema owner
- Do not run `RUN_KIS_VTS_ORDER_TESTS`, `RUN_KIS_VTS_OVERSEAS_ORDER_TESTS`, or `ALLOW_LIVE_TRADING` as part of DB work
- Mirror errors must not be mapped to reconciliation mismatch
- Never resubmit KIS orders because a DB transaction rolled back
