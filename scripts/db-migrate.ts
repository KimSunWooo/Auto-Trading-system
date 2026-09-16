/**
 * Fresh-local only. Never run against existing production RDS.
 * Existing RDS already has the baseline schema; do not DROP/CREATE it.
 */
if (process.env.ALLOW_DB_MIGRATE !== "fresh-local") {
  console.error(
    "db:migrate is disabled by default.\n" +
      "Existing production RDS: do nothing (schema already adopted).\n" +
      "Fresh local MySQL: docker compose -f docker-compose.db.yml up, which loads db/baseline.mysql.sql.\n" +
      "To run drizzle-kit migrate you must set ALLOW_DB_MIGRATE=fresh-local AND review SQL for DROP/destructive ALTER.",
  );
  process.exit(2);
}

console.error("Review drizzle/*.sql for DROP TABLE / DROP COLUMN before applying. Aborting automatic apply.");
process.exit(2);
