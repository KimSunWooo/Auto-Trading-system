/**
 * Local file/memory bus — Kafka stand-in for fixture smoke tests.
 * Optional kafkajs publisher can wrap the same MarketEvent shape later.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MarketEvent } from "./types.ts";

export type BusPublishResult = { ok: true; offset: number } | { ok: false; error: string };

export interface MarketEventBus {
  publish(topic: string, event: MarketEvent): Promise<BusPublishResult>;
  readAll(topic: string): Promise<MarketEvent[]>;
}

export class MemoryBus implements MarketEventBus {
  private readonly topics = new Map<string, MarketEvent[]>();

  async publish(topic: string, event: MarketEvent): Promise<BusPublishResult> {
    const list = this.topics.get(topic) ?? [];
    list.push(event);
    this.topics.set(topic, list);
    return { ok: true, offset: list.length - 1 };
  }

  async readAll(topic: string): Promise<MarketEvent[]> {
    return [...(this.topics.get(topic) ?? [])];
  }
}

export class FileBus implements MarketEventBus {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(topic: string): string {
    const safe = topic.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.jsonl`);
  }

  async publish(topic: string, event: MarketEvent): Promise<BusPublishResult> {
    try {
      const f = this.file(topic);
      appendFileSync(f, `${JSON.stringify(event)}\n`, "utf8");
      const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
      return { ok: true, offset: lines.length - 1 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async readAll(topic: string): Promise<MarketEvent[]> {
    const f = this.file(topic);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MarketEvent);
  }
}

export function resetFileTopic(dir: string, topic: string): void {
  mkdirSync(dir, { recursive: true });
  const safe = topic.replace(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(path.join(dir, `${safe}.jsonl`), "", "utf8");
}

export const TICKER_QUOTES_TOPIC = "ticker-quotes";
export const RISK_SIGNALS_TOPIC = "risk-signals";
