import { mutateStore } from "@/lib/store";
import { RiskManager } from "@/src/risk/RiskManager";

async function main() {
  const state = await mutateStore(async (current) => {
    const box = { current };
    await RiskManager.emergencyStop(box);
    return box.current;
  });
  const report = state.killReport;
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "emergency-stop",
        autoTrading: state.settings.autoTrading,
        liquidating: state.settings.liquidating,
        safety: state.safety?.kind,
        circuit: state.circuit?.kind,
        cancelled: report?.cancelled ?? 0,
        flattened: report?.flattened ?? 0,
        notes: report?.notes ?? [],
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
