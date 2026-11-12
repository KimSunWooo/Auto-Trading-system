export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Force .env.local over injected shell DATABASE_URL (local docker must not win).
    const { loadLocalEnv } = await import("./src/db/load-env");
    loadLocalEnv();
    const { startEngineLoop } = await import("./lib/engine-loop");
    const { startAccountEngineLoop } = await import("./lib/account-engine-loop");
    const { startPaperRuntimeWorkers, PaperRuntimeOwnerError } = await import(
      "./src/runtime/paper-runtime-owner"
    );
    try {
      startPaperRuntimeWorkers({
        startBootstrap: () => {
          startEngineLoop();
        },
        startAccounts: () => {
          startAccountEngineLoop();
        },
      });
    } catch (err) {
      if (err instanceof PaperRuntimeOwnerError) {
        console.error(`[instrumentation] ${err.message}`);
        return;
      }
      throw err;
    }
  }
}
