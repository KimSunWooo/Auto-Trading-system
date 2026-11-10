#!/usr/bin/env npx tsx
/**
 * Fixture-first ingest CLI. Live WS is opt-in and documented as unmeasured
 * against the trading-core hub subscription budget (41).
 *
 *   npx tsx extensions/ts/ingest/cli.ts --source fixture --once
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildH0stCnt0Fixture } from "../../../src/market-data/h0stcnt0-fixture.ts";
import { FileBus, MemoryBus, resetFileTopic, TICKER_QUOTES_TOPIC } from "../shared/file-bus.ts";
import { QuoteIngestProducer } from "./producer.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1] ?? fallback;
  return fallback;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const source = arg("--source", "fixture") ?? "fixture";
  const once = has("--once");
  const busDir = arg("--bus-dir", path.join(root, ".bus"))!;
  const useMemory = has("--memory");

  if (source === "live-ws") {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          "live-ws disabled until shared AppKey hub subscription impact is measured; use --source fixture",
      }),
    );
    process.exit(2);
  }

  const bus = useMemory ? new MemoryBus() : new FileBus(busDir);
  if (!useMemory) resetFileTopic(busDir, TICKER_QUOTES_TOPIC);

  const producer = new QuoteIngestProducer(bus, {
    emitOrderBookStub: has("--orderbook-stub"),
  });

  const fixturePath = arg(
    "--fixture",
    path.join(root, "fixtures/h0stcnt0-frames.jsonl"),
  )!;

  const frames: string[] = [];
  if (existsSync(fixturePath)) {
    for (const line of readFileSync(fixturePath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parsed = JSON.parse(t) as { frame?: string } | string;
      frames.push(typeof parsed === "string" ? parsed : String(parsed.frame ?? ""));
    }
  } else {
    // Built-in minimal PAPER fixture when file missing.
    frames.push(
      buildH0stCnt0Fixture({ MKSC_SHRN_ISCD: "005930", STCK_PRPR: "70000", CNTG_VOL: "10" }),
      buildH0stCnt0Fixture({ MKSC_SHRN_ISCD: "005930", STCK_PRPR: "70100", CNTG_VOL: "5" }),
      buildH0stCnt0Fixture({ MKSC_SHRN_ISCD: "035720", STCK_PRPR: "45200", CNTG_VOL: "3" }),
    );
  }

  const ac = new AbortController();
  const loop = producer.startPublishLoop(ac.signal);
  for (const frame of frames) {
    if (frame) producer.onRawFrame(frame, Date.now());
  }

  // Drain queue
  await sleep(80);
  ac.abort();
  producer.stop();
  await loop;

  console.log(
    JSON.stringify(
      {
        ok: true,
        source: "fixture",
        frames: frames.length,
        metrics: producer.metrics,
        bus: useMemory ? "memory" : busDir,
        note: "ORDERBOOK imbalance detectors stay disabled (paperUnverified)",
      },
      null,
      2,
    ),
  );
  if (!once) {
    // keep process semantics for long-run later; fixture once exits.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
