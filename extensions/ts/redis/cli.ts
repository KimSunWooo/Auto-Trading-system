#!/usr/bin/env npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBus, TICKER_QUOTES_TOPIC } from "../shared/file-bus.ts";
import { UiQuoteAggregator } from "./aggregator.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1] ?? fallback;
  return fallback;
}

async function main(): Promise<void> {
  const busDir = arg("--bus-dir", path.join(root, ".bus"))!;
  const bus = new FileBus(busDir);
  const agg = new UiQuoteAggregator(bus);
  const stats = await agg.consumeAll();
  const symbols = ["005930", "035720"];
  const snapshot = Object.fromEntries(
    symbols.map((s) => [
      s,
      {
        latest: agg.store.getLatest(s) ?? null,
        bars: agg.store.getBars(s),
      },
    ]),
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        topic: TICKER_QUOTES_TOPIC,
        stats,
        snapshot,
        separation: "UI cache only — not OrderManager/KisBroker path",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
