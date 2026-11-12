/**
 * Async PAPER auto-trading start jobs.
 * UI polls by requestId. ON is written to RDS only after required checks pass.
 * Cancel / OFF supersedes a late completion — never re-saves ON after cancel.
 */
import type { AppState } from "@/lib/types";
import { verifyApprovedRdsLiveCached } from "@/src/db/rds-authority";
import { isRecoverableInquiryHalt } from "@/src/runtime/controlled-run";
import {
  assertReadyToEnablePaperAutoTrading,
  runPaperTradingPreflightService,
  type PaperTradingPreflight,
} from "@/src/runtime/paper-trading-preflight";
import { resetCircuit } from "@/src/risk/circuit";
import {
  newStartRequestId,
  StartTimingTrace,
  type StageTiming,
} from "@/src/runtime/start-timing";
import type { ResolvedTradingRuntime } from "@/src/runtime/resolve-trading-runtime";

export type AutoTradingStartUiStatus =
  | "queued"
  | "running"
  | "reconciling"
  | "completed"
  | "failed"
  | "cancelled";

export type AutoTradingStartStage =
  | "queued"
  | "session"
  | "rds"
  | "credential"
  | "kis_auth"
  | "startup_sync"
  | "reconciliation"
  | "persist_on"
  | "done";

export type AutoTradingStartJob = {
  requestId: string;
  userId: string;
  brokerAccountId: string;
  createdAt: string;
  updatedAt: string;
  status: AutoTradingStartUiStatus;
  stage: AutoTradingStartStage;
  message: string;
  cancelRequested: boolean;
  /** Generation bump when user requests OFF — late jobs must not write ON. */
  generation: number;
  timings: StageTiming[];
  byStage: Partial<Record<string, number>>;
  totalMs: number | null;
  autoTradingOnInRds: boolean | null;
  firstFailureStage?: string | null;
  firstFailureReason?: string | null;
  blockers?: PaperTradingPreflight["blockerDetails"];
  checks?: PaperTradingPreflight["checks"];
  error?: string;
};

type JobGlobal = typeof globalThis & {
  __miraeAutoTradingStartJobs?: Map<string, AutoTradingStartJob>;
  __miraeAutoTradingStartByAccount?: Map<string, string>;
  __miraeAutoTradingStartGeneration?: Map<string, number>;
  __miraeAutoTradingStartRunners?: Map<string, Promise<void>>;
};

const g = globalThis as JobGlobal;

function jobs(): Map<string, AutoTradingStartJob> {
  g.__miraeAutoTradingStartJobs ??= new Map();
  return g.__miraeAutoTradingStartJobs;
}

function byAccount(): Map<string, string> {
  g.__miraeAutoTradingStartByAccount ??= new Map();
  return g.__miraeAutoTradingStartByAccount;
}

function generations(): Map<string, number> {
  g.__miraeAutoTradingStartGeneration ??= new Map();
  return g.__miraeAutoTradingStartGeneration;
}

function runners(): Map<string, Promise<void>> {
  g.__miraeAutoTradingStartRunners ??= new Map();
  return g.__miraeAutoTradingStartRunners;
}

const JOB_TTL_MS = 30 * 60_000;
const OVERALL_BUDGET_MS = 90_000;

function touch(job: AutoTradingStartJob): void {
  job.updatedAt = new Date().toISOString();
}

function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs()) {
    if (Date.parse(job.createdAt) < cutoff) {
      jobs().delete(id);
      const cur = byAccount().get(job.brokerAccountId);
      if (cur === id) byAccount().delete(job.brokerAccountId);
    }
  }
}

export function getAutoTradingStartJob(requestId: string): AutoTradingStartJob | null {
  pruneOldJobs();
  return jobs().get(requestId) ?? null;
}

export function getActiveAutoTradingStartJobForAccount(
  brokerAccountId: string,
): AutoTradingStartJob | null {
  pruneOldJobs();
  const id = byAccount().get(brokerAccountId);
  if (!id) return null;
  const job = jobs().get(id);
  if (!job) return null;
  if (job.status === "queued" || job.status === "running" || job.status === "reconciling") {
    return job;
  }
  return null;
}

/** Call when user turns autoTrading OFF — cancels in-flight start jobs. */
export function cancelAutoTradingStartJobsForAccount(
  brokerAccountId: string,
  reason = "사용자가 자동매매를 해제했습니다.",
): void {
  const gen = (generations().get(brokerAccountId) ?? 0) + 1;
  generations().set(brokerAccountId, gen);
  for (const job of jobs().values()) {
    if (job.brokerAccountId !== brokerAccountId) continue;
    if (job.status === "queued" || job.status === "running" || job.status === "reconciling") {
      job.cancelRequested = true;
      job.generation = gen;
      job.status = "cancelled";
      job.message = reason;
      job.stage = "done";
      touch(job);
    }
  }
  byAccount().delete(brokerAccountId);
}

export function clearAutoTradingStartJobsForTest(): void {
  jobs().clear();
  byAccount().clear();
  generations().clear();
  runners().clear();
}

export type EnqueueStartRuntime = Pick<
  ResolvedTradingRuntime,
  "account" | "scope" | "store" | "rules"
> & {
  user?: { id: string };
  userId?: string;
};

export type EnqueueStartInput = {
  rt: EnqueueStartRuntime;
  disclaimerAccepted: boolean;
};

function runtimeUserId(rt: EnqueueStartRuntime): string {
  return rt.user?.id ?? rt.userId ?? "";
}

export type EnqueueStartResult = {
  job: AutoTradingStartJob;
  reused: boolean;
};

/**
 * Enqueue (or reuse) a start job for this PAPER account.
 * Returns immediately — work continues in the background.
 */
export function enqueueAutoTradingStart(input: EnqueueStartInput): EnqueueStartResult {
  pruneOldJobs();
  const accountId = input.rt.account.id;
  const userId = runtimeUserId(input.rt);
  if (!userId) {
    const requestId = newStartRequestId();
    const failed: AutoTradingStartJob = {
      requestId,
      userId: "",
      brokerAccountId: accountId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "failed",
      stage: "done",
      message: "세션 사용자를 확인할 수 없습니다.",
      cancelRequested: false,
      generation: generations().get(accountId) ?? 0,
      timings: [],
      byStage: {},
      totalMs: 0,
      autoTradingOnInRds: false,
      error: "SESSION_MISSING",
    };
    jobs().set(requestId, failed);
    return { job: failed, reused: false };
  }

  if (String(input.rt.account.environment).toUpperCase() === "REAL") {
    const requestId = newStartRequestId();
    const failed: AutoTradingStartJob = {
      requestId,
      userId,
      brokerAccountId: accountId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "failed",
      stage: "done",
      message: "REAL 계좌는 자동매매 시작 대상이 아닙니다.",
      cancelRequested: false,
      generation: generations().get(accountId) ?? 0,
      timings: [],
      byStage: {},
      totalMs: 0,
      autoTradingOnInRds: false,
      error: "REAL_LOCKED",
    };
    jobs().set(requestId, failed);
    return { job: failed, reused: false };
  }

  const existingId = byAccount().get(accountId);
  if (existingId) {
    const existing = jobs().get(existingId);
    if (
      existing &&
      (existing.status === "queued" ||
        existing.status === "running" ||
        existing.status === "reconciling")
    ) {
      return { job: existing, reused: true };
    }
  }

  const requestId = newStartRequestId();
  const generation = generations().get(accountId) ?? 0;
  const job: AutoTradingStartJob = {
    requestId,
    userId,
    brokerAccountId: accountId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    stage: "queued",
    message: "시작 요청을 접수했습니다.",
    cancelRequested: false,
    generation,
    timings: [],
    byStage: {},
    totalMs: null,
    autoTradingOnInRds: null,
  };
  jobs().set(requestId, job);
  byAccount().set(accountId, requestId);

  const runner = runAutoTradingStartJob(job, input).finally(() => {
    runners().delete(requestId);
  });
  runners().set(requestId, runner);
  return { job, reused: false };
}

function isCancelled(job: AutoTradingStartJob): boolean {
  if (job.cancelRequested) return true;
  const gen = generations().get(job.brokerAccountId) ?? 0;
  return gen !== job.generation;
}

function publishTimings(job: AutoTradingStartJob, trace: StartTimingTrace): void {
  const snap = trace.snapshot();
  job.timings = snap.stages;
  job.byStage = snap.byStage;
  job.totalMs = snap.totalMs;
  touch(job);
}

async function runAutoTradingStartJob(
  job: AutoTradingStartJob,
  input: EnqueueStartInput,
): Promise<void> {
  const { rt } = input;
  const trace = new StartTimingTrace(job.requestId);
  const deadline = Date.now() + OVERALL_BUDGET_MS;

  const fail = (message: string, extra?: Partial<AutoTradingStartJob>) => {
    job.status = "failed";
    job.stage = "done";
    job.message = message;
    job.error = message;
    Object.assign(job, extra);
    publishTimings(job, trace);
    if (byAccount().get(job.brokerAccountId) === job.requestId) {
      byAccount().delete(job.brokerAccountId);
    }
  };

  try {
    job.status = "running";
    job.stage = "session";
    job.message = "세션·계좌를 확인하는 중…";
    touch(job);
    await trace.measure("session", async () => {
      if (runtimeUserId(rt) !== job.userId) throw new Error("세션 사용자 불일치");
      if (rt.account.id !== job.brokerAccountId) throw new Error("계좌 불일치");
      if (String(rt.account.environment).toUpperCase() !== "PAPER") {
        throw new Error("PAPER 계좌만 시작할 수 있습니다.");
      }
    });

    if (isCancelled(job)) {
      job.status = "cancelled";
      job.message = "시작이 취소되었습니다.";
      publishTimings(job, trace);
      return;
    }
    if (Date.now() > deadline) {
      fail("시작 제한 시간을 초과했습니다 (세션).");
      return;
    }

    job.stage = "rds";
    job.message = "승인된 RDS 연결을 확인하는 중…";
    touch(job);
    const rds = await trace.measure("rds_ping", () =>
      verifyApprovedRdsLiveCached(process.env, { budgetMs: 5_000 }),
    );
    if (!rds.value.ok) {
      fail(rds.value.message, {
        firstFailureStage: "RDS_UNVERIFIED",
        firstFailureReason: rds.value.message,
      });
      return;
    }

    if (isCancelled(job)) {
      job.status = "cancelled";
      job.message = "시작이 취소되었습니다.";
      publishTimings(job, trace);
      return;
    }

    job.stage = "kis_auth";
    job.message = "KIS PAPER 인증·장부 대사를 확인하는 중…";
    job.status = "reconciling";
    touch(job);

    const state0 = await rt.store.getState();
    const preflight = await runPaperTradingPreflightService({
      userId: job.userId,
      brokerAccountId: rt.account.id,
      state: state0,
      workerLockPath: rt.scope.lockPath,
      kisClient: rt.scope.kisClient,
      mutateStore: (fn) => rt.store.mutateStore(fn),
      getState: () => rt.store.getState(),
      refreshIfNeeded: true,
      probeKisAuth: true,
      /** ON path — quote sample is order-gate only. */
      includeQuoteSample: false,
      timingTrace: trace,
      softKisAuth: true,
    });

    job.checks = preflight.checks;
    job.blockers = preflight.blockerDetails;
    job.firstFailureStage = preflight.firstFailureStage;
    job.firstFailureReason = preflight.firstFailureReason;
    publishTimings(job, trace);

    if (isCancelled(job)) {
      job.status = "cancelled";
      job.message = "시작이 취소되었습니다.";
      publishTimings(job, trace);
      return;
    }

    const blocked = assertReadyToEnablePaperAutoTrading(preflight);
    if (blocked) {
      fail(blocked, {
        firstFailureStage: preflight.firstFailureStage,
        firstFailureReason: preflight.firstFailureReason,
      });
      return;
    }

    if (Date.now() > deadline) {
      fail("시작 제한 시간을 초과했습니다 (대사 후).");
      return;
    }

    job.stage = "persist_on";
    job.message = "자동매매 ON을 RDS에 저장하는 중…";
    job.status = "running";
    touch(job);

    // Final cancel check before any ON write.
    if (isCancelled(job)) {
      job.status = "cancelled";
      job.message = "시작이 취소되었습니다 — ON을 저장하지 않았습니다.";
      job.autoTradingOnInRds = false;
      publishTimings(job, trace);
      return;
    }

    const saved = await trace.measure("persist_on", async () => {
      // Re-read cancel/generation under mutate to beat races with OFF.
      if (isCancelled(job)) {
        throw new StartCancelledError("cancelled before mutate");
      }
      const next = await rt.store.mutateStore(
        (current) => {
          if (isCancelled(job)) {
            throw new StartCancelledError("cancelled during mutate");
          }
          const disclaimerAccepted =
            Boolean(input.disclaimerAccepted) || current.settings.disclaimerAccepted;
          if (!disclaimerAccepted) {
            throw new Error("이용 동의 전에는 자동 실행을 켤 수 없습니다.");
          }
          let state: AppState = {
            ...current,
            settings: {
              ...current.settings,
              disclaimerAccepted: true,
              disclaimerAcceptedAt:
                current.settings.disclaimerAcceptedAt ?? new Date().toISOString(),
              autoTrading: true,
              onboardingComplete: true,
            },
          };
          if (state.circuit.halted && isRecoverableInquiryHalt(state)) {
            const reset = resetCircuit(state);
            if (!reset.error) state = reset.state;
          }
          return state;
        },
        { projectMode: "flags" },
      );
      return next;
    });

    if (isCancelled(job)) {
      // User cancelled while we were writing — force OFF so late ON does not stick.
      await rt.store.mutateStore(
        (current) => ({
          ...current,
          settings: { ...current.settings, autoTrading: false },
        }),
        { projectMode: "flags" },
      );
      job.status = "cancelled";
      job.message = "시작이 취소되어 ON 저장을 되돌렸습니다.";
      job.autoTradingOnInRds = false;
      publishTimings(job, trace);
      return;
    }

    job.autoTradingOnInRds = saved.value.settings.autoTrading === true;
    job.status = "completed";
    job.stage = "done";
    job.message = "시작 완료 — 자동매매가 ON 되었습니다.";
    publishTimings(job, trace);
    if (byAccount().get(job.brokerAccountId) === job.requestId) {
      byAccount().delete(job.brokerAccountId);
    }
  } catch (err) {
    if (err instanceof StartCancelledError) {
      job.status = "cancelled";
      job.stage = "done";
      job.message = "시작이 취소되었습니다 — ON을 저장하지 않았습니다.";
      job.autoTradingOnInRds = false;
      publishTimings(job, trace);
      return;
    }
    fail(err instanceof Error ? err.message : "자동매매 시작에 실패했습니다.");
  }
}

class StartCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartCancelledError";
  }
}

/** Public poll payload for UI. */
export function toAutoTradingStartPublic(job: AutoTradingStartJob) {
  const uiStatus =
    job.status === "reconciling"
      ? ("장부 대사 중" as const)
      : job.status === "completed"
        ? ("시작 완료" as const)
        : job.status === "failed"
          ? ("시작 실패" as const)
          : job.status === "cancelled"
            ? ("시작 취소" as const)
            : ("시작 중" as const);

  return {
    requestId: job.requestId,
    status: job.status,
    uiStatus,
    stage: job.stage,
    message: job.message,
    totalMs: job.totalMs,
    byStage: job.byStage,
    timings: job.timings,
    autoTradingOnInRds: job.autoTradingOnInRds,
    firstFailureStage: job.firstFailureStage ?? null,
    firstFailureReason: job.firstFailureReason ?? null,
    blockers: job.blockers,
    checks: job.checks,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** Test helper — wait for runner to settle. */
export async function awaitAutoTradingStartJob(requestId: string): Promise<AutoTradingStartJob | null> {
  const runner = runners().get(requestId);
  if (runner) await runner;
  return getAutoTradingStartJob(requestId);
}
