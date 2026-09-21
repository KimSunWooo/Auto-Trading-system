/**
 * Detect node:test / npm test workers.
 * Child workers often omit `--test` from argv and only receive the `*.test.ts` path.
 */
export function isNodeTestProcess(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
): boolean {
  if (env.MIRAEMAESU_TEST === "1" || env.NODE_ENV === "test") return true;
  if (env.npm_lifecycle_event === "test" || env.npm_lifecycle_event === "db:test") return true;
  if (argv.some((arg) => arg === "--test" || arg.includes("node:test"))) return true;
  // node:test file workers: argv contains the test file, not always `--test`.
  if (argv.some((arg) => /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(arg))) return true;
  return false;
}
