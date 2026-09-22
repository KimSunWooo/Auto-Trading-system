export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
