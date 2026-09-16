# Drizzle SQL output (fresh local only)

Do **not** apply these files to the existing production RDS.

- Existing RDS: already has baseline schema. Application Drizzle schema is adopted to match it.
- Fresh local: prefer `docker compose -f docker-compose.db.yml up` which loads `db/baseline.mysql.sql` (includes CHECKs and `v_buy_history`).

`npm run db:generate` may write SQL here. Review for DROP TABLE / DROP COLUMN before any apply.
`npm run db:migrate` refuses unless `ALLOW_DB_MIGRATE=fresh-local`, and still does not auto-apply.
