export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEngineLoop } = await import("./lib/engine-loop");
    startEngineLoop();
  }
}
