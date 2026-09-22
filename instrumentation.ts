export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEngineLoop } = await import("./lib/engine-loop");
    const { startAccountEngineLoop } = await import("./lib/account-engine-loop");
    startEngineLoop();
    startAccountEngineLoop();
  }
}
