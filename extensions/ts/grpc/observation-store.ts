/**
 * Observation store for consumed backtest-result events.
 * Dedupe by eventId so Kafka republish does not double-apply.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { JobResult } from "./client.ts";
import type { BacktestResultEvent } from "./result-events.ts";

export type Observation = {
  eventId: string;
  jobId: string;
  eventStatus: string;
  jobStatus: string;
  metrics: JobResult["metrics"];
  error: string;
  observedAtUnixMs: number;
  grpcUpdatedAtUnixMs: number;
};

export class ObservationStore {
  constructor(private readonly root: string) {
    mkdirSync(this.root, { recursive: true });
    mkdirSync(path.join(this.root, "by-event"), { recursive: true });
  }

  private eventPath(eventId: string): string {
    const safe = eventId.replace(/[^a-zA-Z0-9._:-]/g, "_");
    return path.join(this.root, "by-event", `${safe}.json`);
  }

  has(eventId: string): boolean {
    return existsSync(this.eventPath(eventId));
  }

  get(eventId: string): Observation | null {
    const p = this.eventPath(eventId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Observation;
  }

  /** Idempotent apply: same eventId always yields one observation file. */
  apply(event: BacktestResultEvent, job: JobResult): { applied: boolean; observation: Observation } {
    const existing = this.get(event.eventId);
    if (existing) {
      return { applied: false, observation: existing };
    }
    const observation: Observation = {
      eventId: event.eventId,
      jobId: event.jobId,
      eventStatus: event.status,
      jobStatus: job.status,
      metrics: job.metrics,
      error: job.error,
      observedAtUnixMs: Date.now(),
      grpcUpdatedAtUnixMs: job.updatedAtUnixMs,
    };
    const p = this.eventPath(event.eventId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(observation, null, 2));
    renameSync(tmp, p);
    return { applied: true, observation };
  }

  list(): Observation[] {
    const dir = path.join(this.root, "by-event");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Observation);
  }

  count(): number {
    return this.list().length;
  }
}
