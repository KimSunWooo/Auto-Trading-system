import { nowIso, nowMs } from "@/src/clock";
import { accountValue } from "@/src/accounts/portfolio";
import type { StateBox } from "@/src/accounts/StateBox";
import { MockBroker } from "@/src/brokers/MockBroker";
import { KisBroker } from "@/src/brokers/KisBroker";
import { brokerDriver } from "@/src/brokers/kis-config";
import { getSharedKisClient, type KisApi } from "@/src/brokers/kis-client";
import type { AppState, KillReport, Side } from "@/lib/types";
import { seoulDay } from "@/src/risk/limits";
import { openCircuit, resetCircuit } from "@/src/risk/circuit";
import { DEFAULT_PRODUCT_RISK, type ProductRisk } from "@/src/risk/product";
import { settleOpenOrders } from "@/src/risk/reconcile";
import { applyKisSnapshot } from "@/src/risk/balance-sync";
import { createBroker, type CreateBrokerOpts } from "@/src/brokers/index";
import { sellBandSlices } from "@/src/accounts/execution-policy";
import { getRuleConfig } from "@/src/rules/config";
import { CASH_RULE_ID, type RuleConfigFile } from "@/src/rules/params";
import { autoRunAllowed } from "@/src/rules/disclaimer";
import { blockSafety, safetyOf } from "@/src/runtime/safety";
import { isLiveLike } from "@/src/runtime/trading-mode";
import { recordControlledEvent } from "@/src/runtime/controlled-run";

function riskOf(state: AppState): ProductRisk {
  return state.settings?.risk ?? DEFAULT_PRODUCT_RISK;
}

function hasUnknown(state: AppState): boolean {
  return state.orders.some((order) => order.status === "unknown");
}

function countCancelled(before: AppState, after: AppState): number {
  const prev = new Set(
    before.orders.filter((order) => order.status === "cancelled").map((order) => order.id),
  );
  return after.orders.filter((order) => order.status === "cancelled" && !prev.has(order.id)).length;
}

function abandonWorking(state: AppState, reason: string): AppState {
  return {
    ...state,
    orders: state.orders.map((order) =>
      !order.parentOrderId && (order.status === "pending" || order.status === "unknown")
        ? { ...order, status: "cancelled" as const, reason }
        : order,
    ),
  };
}

async function persist(
  box: StateBox,
  persistState?: (state: AppState) => Promise<void>,
) {
  if (process.env.npm_lifecycle_event === "test") return;
  if (persistState) {
    await persistState(box.current);
    return;
  }
  const { persistStateNow } = await import("@/lib/store");
  await persistStateNow(box.current);
}

export type RiskRuntimeDeps = {
  kisClient?: KisApi;
  persistState?: (state: AppState) => Promise<void>;
  ruleConfig?: RuleConfigFile;
};

export class RiskManager {
  constructor(private readonly box: StateBox) {}

  static rollDay(state: AppState, now = new Date()): AppState {
    const today = seoulDay(now);
    if (state.dayStart?.date === today && state.dayStart.equity > 0) return state;
    let next = state;
    if (state.circuit?.halted && state.circuit.kind === "daily-loss") {
      const reset = resetCircuit(state);
      if (!reset.error) next = reset.state;
    }
    return {
      ...next,
      dayStart: { date: today, equity: Math.max(1, accountValue(next)) },
    };
  }

  static checkDailyLoss(state: AppState): AppState {
    const marked = RiskManager.rollDay(state);
    if (marked.circuit?.halted) return marked;
    const start = marked.dayStart.equity;
    const equity = accountValue(marked);
    const lossPct = (start - equity) / start;
    const cap = riskOf(marked).dailyLossPct;
    if (lossPct + 1e-12 >= cap) {
      return openCircuit(
        marked,
        `일일 최대 손실 ${Math.round(cap * 100)}%에 도달해 당일 자동매매를 멈췄습니다.`,
        undefined,
        "daily-loss",
      );
    }
    return marked;
  }

  static checkBuy(
    state: AppState,
    input: { side: Side; ticker: string; qty: number; price: number },
  ): string | null {
    if (input.side !== "buy") return null;
    const cap = riskOf(state).maxTickerWeight;
    const quote = state.quotes[input.ticker];
    const last = quote?.price ?? input.price;
    const held =
      state.positions.filter((p) => p.code === input.ticker).reduce((sum, p) => sum + p.qty, 0) +
      input.qty;
    const denom = Math.max(1, state.totalDeposit);
    if ((held * last) / denom > cap + 1e-12) {
      return `종목 투자 비중 ${Math.round(cap * 100)}%를 넘을 수 없습니다.`;
    }
    return null;
  }

  /**
   * Overseas buys are sized in native currency (USD). KRW equivalent is reported, not mixed into KRW cash.
   * Fees/slippage/FX buffers stay caller-supplied; this method does not invent them.
   */
  static checkOverseasBuy(input: {
    qty: number;
    nativePrice: number;
    nativeCurrency?: string;
    fxRate?: number | null;
    orderableNative?: number | null;
    fxBufferPct?: number;
  }): { ok: true; nativeValue: number; krwEquivalent: number | null } | { ok: false; reason: string; nativeValue: number; krwEquivalent: number | null } {
    const nativeValue = Math.max(0, input.qty) * Math.max(0, input.nativePrice);
    const fxRate = input.fxRate ?? null;
    const krw = fxRate && fxRate > 0 ? nativeValue * fxRate : null;
    if (input.qty < 1) {
      return { ok: false, reason: "1주 미만이라 주문하지 않습니다.", nativeValue, krwEquivalent: krw };
    }
    const buffer = input.fxBufferPct && input.fxBufferPct > 0 ? input.fxBufferPct : 0;
    const needed = nativeValue * (1 + buffer);
    if (input.orderableNative != null && Number.isFinite(input.orderableNative) && needed > input.orderableNative + 1e-8) {
      return {
        ok: false,
        reason: `외화 매수가능금액 ${input.orderableNative} ${input.nativeCurrency ?? "USD"} 를 넘습니다.`,
        nativeValue,
        krwEquivalent: krw,
      };
    }
    return { ok: true, nativeValue, krwEquivalent: krw };
  }

  static shouldStopLoss(avgPrice: number, last: number, stopLossPct: number): boolean {
    if (avgPrice <= 0 || last <= 0) return false;
    return (last - avgPrice) / avgPrice <= -stopLossPct;
  }

  /** Sync freeze: stop new trades and drop local pending that never got an ODNO. */
  static freezeForKill(state: AppState): AppState {
    const frozen: AppState = {
      ...state,
      settings: {
        ...state.settings,
        autoTrading: false,
        liquidating: true,
      },
      allocations: state.allocations.map((row) => ({
        ...row,
        enabled: false,
        lastMessage: "긴급 정지",
      })),
      conditions: state.conditions.map((cond) =>
        cond.watching
          ? { ...cond, watching: false, status: "paused" as const, message: "긴급 정지" }
          : cond,
      ),
      dcaPlans: state.dcaPlans.map((plan) => ({
        ...plan,
        enabled: false,
        lastMessage: "긴급 정지",
      })),
      orders: state.orders.map((order) =>
        order.status === "pending" && !order.brokerOrderNo
          ? { ...order, status: "cancelled" as const, reason: "긴급 정지" }
          : order,
      ),
    };
    return blockSafety(frozen, "emergency_stop", "긴급 정지로 신규 주문을 막았습니다.", {
      tradingAllowed: false,
    });
  }

  /** New orders off + cancel KIS working tickets. Does not flatten positions. */
  static async emergencyStop(
    box: StateBox,
    opts: { kis?: KisApi | null; persistState?: (state: AppState) => Promise<void> } = {},
  ): Promise<AppState> {
    const notes: string[] = [];
    const frozen = RiskManager.freezeForKill(box.current);
    box.current = {
      ...frozen,
      settings: { ...frozen.settings, liquidating: false },
    };
    await persist(box, opts.persistState);

    const kis =
      opts.kis === undefined
        ? brokerDriver() === "kis"
          ? getSharedKisClient()
          : null
        : opts.kis;

    let cancelled = 0;
    if (kis?.configured) {
      try {
        const open = await kis.inquireOpenOrders();
        for (const row of open) {
          if (!row.orderNo || row.unfilledQty < 1) continue;
          try {
            await kis.cancelOrder({
              orderNo: row.orderNo,
              krxOrgNo: "",
              ordDvsn: "limit",
            });
            cancelled += 1;
          } catch (err) {
            notes.push(
              `${row.ticker} 취소 실패: ${err instanceof Error ? err.message : "알 수 없음"}`,
            );
          }
        }
        await settleOpenOrders(box, kis, nowMs(), { cancelImmediately: true });
      } catch (err) {
        notes.push(`미체결 조회 실패: ${err instanceof Error ? err.message : "알 수 없음"}`);
      }
      await persist(box, opts.persistState);
    } else {
      notes.push("로컬 모의는 증권사 미체결 취소 대상이 없습니다.");
    }

    box.current = {
      ...box.current,
      killReport: {
        cancelled,
        flattened: 0,
        overwritten: false,
        notes: ["emergency-stop: 신규 주문 중단 + 미체결 취소", ...notes],
      },
    };
    await persist(box, opts.persistState);
    return box.current;
  }

  /** Flatten positions only. Does not mix with emergency-stop. */
  static async emergencyFlatten(
    box: StateBox,
    opts: { kis?: KisApi | null; persistState?: (state: AppState) => Promise<void> } = {},
  ): Promise<AppState> {
    box.current = {
      ...box.current,
      settings: { ...box.current.settings, liquidating: true, autoTrading: false },
    };
    await persist(box, opts.persistState);
    const kis =
      opts.kis === undefined
        ? brokerDriver() === "kis"
          ? getSharedKisClient()
          : null
        : opts.kis;
    const broker = kis?.configured
      ? new KisBroker(box, kis, CASH_RULE_ID, "rule", undefined, undefined, {
          persistState: opts.persistState,
        })
      : new MockBroker(box);
    let flattened = 0;
    const notes: string[] = [];
    const snapshot = [...box.current.positions];
    for (const pos of snapshot) {
      if (pos.qty < 1) continue;
      const live = box.current.positions.find(
        (row) => row.code === pos.code && row.ruleId === pos.ruleId,
      );
      if (!live || live.qty < 1) continue;
      const last = box.current.quotes[pos.code]?.price ?? 0;
      const fill =
        last > 0
          ? await sellBandSlices(
              broker.forRule(pos.ruleId),
              pos.code,
              live.qty,
              last,
              box.current.quotes[pos.code]?.prevClose,
            )
          : await broker.forRule(pos.ruleId).sellMarket(pos.code, live.qty);
      if (fill.ok || fill.status === "pending") flattened += 1;
      else notes.push(`${pos.name} 청산 실패: ${fill.reason ?? "알 수 없음"}`);
      await persist(box, opts.persistState);
    }
    box.current = {
      ...box.current,
      settings: { ...box.current.settings, liquidating: false },
      killReport: {
        cancelled: 0,
        flattened,
        overwritten: false,
        notes: ["emergency-flatten: 포지션 청산만 수행", ...notes],
      },
    };
    await persist(box, opts.persistState);
    return box.current;
  }

  static stopAllTrading(state: AppState): AppState {
    const frozen = RiskManager.freezeForKill(state);
    return openCircuit(
      {
        ...frozen,
        settings: { ...frozen.settings, liquidating: false },
      },
      "긴급 정지로 자동매매를 멈췄습니다.",
      undefined,
      "kill",
    );
  }

  /**
   * 1) freeze  2) cancel KIS working now  3) band-limit sell positions
   * 4) overwrite local book from inquire-balance
   * ODNO is never treated as a fill. Indeterminate cancel skips flatten/overwrite.
   */
  static async executeKillSwitch(
    box: StateBox,
    opts: { kis?: KisApi | null; persistState?: (state: AppState) => Promise<void> } = {},
  ): Promise<AppState> {
    const notes: string[] = [];
    const before = box.current;
    box.current = RiskManager.freezeForKill(box.current);
    await persist(box, opts.persistState);

    const kis =
      opts.kis === undefined
        ? brokerDriver() === "kis"
          ? getSharedKisClient()
          : null
        : opts.kis;

    if (kis?.configured) {
      await settleOpenOrders(box, kis, nowMs(), { cancelImmediately: true });
      await persist(box, opts.persistState);
    }

    if (hasUnknown(box.current)) {
      notes.push("미확인 주문이 남아 청산과 잔고 덮어쓰기를 건너뛰었습니다. 증권사 체결내역을 확인하세요.");
      return RiskManager.finishKill(box, before, { flattened: 0, overwritten: false, notes });
    }

    let flattened = 0;
    const snapshot = [...box.current.positions];
    const broker = kis?.configured
      ? new KisBroker(box, kis, CASH_RULE_ID, "rule", undefined, undefined, {
          persistState: opts.persistState,
        })
      : new MockBroker(box);
    for (const pos of snapshot) {
      if (pos.qty < 1) continue;
      const live = box.current.positions.find(
        (row) => row.code === pos.code && row.ruleId === pos.ruleId,
      );
      if (!live || live.qty < 1) continue;
      const last = box.current.quotes[pos.code]?.price ?? 0;
      const fill =
        last > 0
          ? await sellBandSlices(
              broker.forRule(pos.ruleId),
              pos.code,
              live.qty,
              last,
              box.current.quotes[pos.code]?.prevClose,
            )
          : await broker.forRule(pos.ruleId).sellMarket(pos.code, live.qty);
      if (fill.ok || fill.status === "pending") {
        flattened += 1;
        notes.push(
          fill.ok ? `${pos.name} 지정가 밴드 청산` : `${pos.name} 지정가 밴드 청산 접수`,
        );
      } else {
        notes.push(`${pos.name} 청산 실패: ${fill.reason ?? "알 수 없음"}`);
      }
      await persist(box, opts.persistState);
    }

    let overwritten = false;
    if (kis?.configured) {
      await settleOpenOrders(box, kis, nowMs(), { bookOnly: true });
      try {
        const remote = await kis.inquireBalance();
        box.current = applyKisSnapshot(box.current, remote);
        overwritten = true;
        notes.push("KIS 실잔고로 로컬 장부를 덮어썼습니다.");
      } catch (err) {
        notes.push(
          `잔고 조회 실패로 장부 덮어쓰기를 건너뛰었습니다. ${err instanceof Error ? err.message : ""}`.trim(),
        );
      }
      await persist(box, opts.persistState);

      if (box.current.orders.some((order) => order.status === "pending" && order.brokerOrderNo)) {
        await settleOpenOrders(box, kis, nowMs(), { cancelImmediately: true });
        try {
          const remote = await kis.inquireBalance();
          box.current = applyKisSnapshot(box.current, remote);
          overwritten = true;
        } catch {
          // keep the first snapshot if the second pull fails
        }
      }

      if (!hasUnknown(box.current)) {
        box.current = abandonWorking(
          box.current,
          "긴급 정지 후 KIS 잔고를 기준으로 대기 주문을 장부에서 닫았습니다.",
        );
      }
      await persist(box, opts.persistState);
    } else {
      notes.push("로컬 모의는 증권사 잔고가 없어 장부 덮어쓰기를 건너뜁니다.");
    }

    return RiskManager.finishKill(box, before, { flattened, overwritten, notes });
  }

  private static finishKill(
    box: StateBox,
    before: AppState,
    partial: { flattened: number; overwritten: boolean; notes: string[] },
  ): AppState {
    const report: KillReport = {
      cancelled: countCancelled(before, box.current),
      flattened: partial.flattened,
      overwritten: partial.overwritten,
      notes: partial.notes,
    };
    const summary = [
      "긴급 정지를 실행했습니다.",
      report.cancelled ? `대기 주문 ${report.cancelled}건 취소` : null,
      report.flattened ? `포지션 ${report.flattened}건 청산` : null,
      report.overwritten ? "KIS 잔고로 장부 동기화" : null,
      ...report.notes.slice(0, 3),
    ]
      .filter(Boolean)
      .join(" · ");

    box.current = openCircuit(
      {
        ...box.current,
        settings: { ...box.current.settings, autoTrading: false, liquidating: false },
        killReport: report,
        allocations: box.current.allocations.map((row) => ({
          ...row,
          enabled: false,
          lastMessage: summary,
        })),
      },
      summary,
      undefined,
      "kill",
    );
    return box.current;
  }

  async enforceStops(deps: RiskRuntimeDeps = {}): Promise<void> {
    const state = this.box.current;
    if (!autoRunAllowed(state)) return;
    if (state.circuit?.kind === "kill" || state.circuit?.kind === "unknown") return;
    const product = riskOf(state);
    const rules = (deps.ruleConfig ?? getRuleConfig()).rules;
    const brokerOpts: CreateBrokerOpts = {
      kisClient: deps.kisClient,
      persistState: deps.persistState,
    };
    const root = createBroker(this.box, CASH_RULE_ID, brokerOpts);
    const snapshot = [...state.positions];
    for (const pos of snapshot) {
      if (pos.qty < 1) continue;
      const quote = this.box.current.quotes[pos.code];
      if (isLiveLike() && (quote?.source !== "kis" || !quote.freshAt)) continue;
      const last = quote?.price ?? pos.avgPrice;
      const rule = rules.find((row) => row.id === pos.ruleId);
      const stopPct = rule?.stopLossPct ?? product.stopLossPct;
      const takePct = rule?.takeProfitPct ?? 0;
      const takeHit = takePct > 0 && pos.avgPrice > 0 && (last - pos.avgPrice) / pos.avgPrice >= takePct;
      const stopHit = RiskManager.shouldStopLoss(pos.avgPrice, last, stopPct);
      if (!takeHit && !stopHit) continue;
      const label = takeHit ? "익절" : "손절";
      const pct = takeHit ? takePct : stopPct;
      if (this.box.current.controlledRun) {
        this.box.current = recordControlledEvent(
          this.box.current,
          takeHit ? "TAKE_PROFIT" : "STOP_LOSS",
          `${pos.name} ${label} (${Math.round(pct * 100)}%)`,
        );
      }
      await sellBandSlices(root.forRule(pos.ruleId), pos.code, pos.qty, last, quote?.prevClose);
      const key = `${pos.ruleId}:${pos.code}`;
      const prevSafety = safetyOf(this.box.current);
      this.box.current = {
        ...this.box.current,
        safety: {
          ...prevSafety,
          closedByStop: { ...prevSafety.closedByStop, [key]: seoulDay() },
          blockedBuys: [...prevSafety.blockedBuys, key],
        },
        allocations: this.box.current.allocations.map((row) =>
          row.ruleId === pos.ruleId
            ? {
                ...row,
                lastMessage: `${pos.name} ${label} (${Math.round(pct * 100)}%, 평단 대비)`,
                lastRunAt: nowIso(),
              }
            : row,
        ),
      };
    }
  }
}
