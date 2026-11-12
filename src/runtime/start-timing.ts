/**
 * Stage timings for PAPER auto-trading start (request-scoped).
 * Never logs secrets / account numbers.
 */

export type StartTimingStage =
  | "session"
  | "rds_pool"
  | "rds_ping"
  | "rds_schema"
  | "credential"
  | "kis_auth"
  | "startup_sync"
  | "reconciliation"
  | "quote_sample"
  | "state_wait"
  | "persist_on"
  | "total";

export type StageTiming = {
  stage: StartTimingStage;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  detail?: string;
};

export class StartTimingTrace {
  readonly requestId: string;
  readonly stages: StageTiming[] = [];
  private readonly open = new Map<StartTimingStage, number>();
  private readonly t0: number;

  constructor(requestId: string) {
    this.requestId = requestId;
    this.t0 = Date.now();
  }

  begin(stage: StartTimingStage, detail?: string): void {
    this.open.set(stage, Date.now());
    this.stages.push({
      stage,
      startedAt: new Date().toISOString(),
      detail,
    });
  }

  end(stage: StartTimingStage, detail?: string): number {
    const started = this.open.get(stage) ?? Date.now();
    this.open.delete(stage);
    const durationMs = Math.max(0, Date.now() - started);
    const row = [...this.stages].reverse().find((s) => s.stage === stage && s.durationMs == null);
    if (row) {
      row.endedAt = new Date().toISOString();
      row.durationMs = durationMs;
      if (detail) row.detail = detail;
    } else {
      this.stages.push({
        stage,
        startedAt: new Date(started).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs,
        detail,
      });
    }
    return durationMs;
  }

  async measure<T>(
    stage: StartTimingStage,
    fn: () => Promise<T>,
    detail?: string,
  ): Promise<{ value: T; durationMs: number }> {
    this.begin(stage, detail);
    try {
      const value = await fn();
      const durationMs = this.end(stage, detail);
      return { value, durationMs };
    } catch (err) {
      this.end(stage, detail ?? (err instanceof Error ? err.message : "error"));
      throw err;
    }
  }

  snapshot(): {
    requestId: string;
    totalMs: number;
    stages: StageTiming[];
    byStage: Partial<Record<StartTimingStage, number>>;
  } {
    const byStage: Partial<Record<StartTimingStage, number>> = {};
    for (const s of this.stages) {
      if (s.durationMs != null) {
        byStage[s.stage] = (byStage[s.stage] ?? 0) + s.durationMs;
      }
    }
    return {
      requestId: this.requestId,
      totalMs: Date.now() - this.t0,
      stages: this.stages.map((s) => ({ ...s })),
      byStage,
    };
  }
}

export function newStartRequestId(): string {
  return `start-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
