/**
 * Local OHLCV JSONL reader for UploadBars CLI (no arbitrary path traversal from server).
 * Format per line: {"t_ms", "ticker", "open", "high", "low", "close", "volume", "incomplete"?}
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

export type OhlcvBar = {
  tMs: number;
  ticker: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  incomplete?: boolean;
};

export async function* readOhlcvJsonl(filePath: string): AsyncGenerator<OhlcvBar> {
  const resolved = path.resolve(filePath);
  const rl = createInterface({
    input: createReadStream(resolved, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const row = JSON.parse(trimmed) as Record<string, unknown>;
    yield {
      tMs: Number(row.t_ms ?? row.tMs),
      ticker: String(row.ticker ?? ""),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume ?? 0),
      incomplete: Boolean(row.incomplete ?? false),
    };
  }
}

export async function collectBatches(
  filePath: string,
  batchSize: number,
): Promise<{ bars: OhlcvBar[]; ticker: string }[]> {
  const batches: { bars: OhlcvBar[]; ticker: string }[] = [];
  let cur: OhlcvBar[] = [];
  let ticker = "";
  for await (const bar of readOhlcvJsonl(filePath)) {
    if (!ticker) ticker = bar.ticker;
    cur.push(bar);
    if (cur.length >= batchSize) {
      batches.push({ bars: cur, ticker });
      cur = [];
    }
  }
  if (cur.length) batches.push({ bars: cur, ticker });
  return batches;
}
