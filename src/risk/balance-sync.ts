import type { StateBox } from "@/src/accounts/StateBox";
import type { KisAccountBalance, KisApi } from "@/src/brokers/kis-client";
import { openCircuit } from "@/src/risk/circuit";
import { HARD_LIMITS } from "@/src/risk/limits";
import { cashFromAllocations } from "@/src/accounts/defaults";
import type { AppState, KisBalanceSnapshot, Position } from "@/lib/types";
import { CASH_RULE_ID } from "@/src/rules/params";

function padTicker(code: string): string {
  return code.replace(/\D/g, "").slice(-6).padStart(6, "0");
}

export function localHoldingsByTicker(
  state: AppState,
): Map<string, { qty: number; name: string }> {
  const map = new Map<string, { qty: number; name: string }>();
  for (const pos of state.positions) {
    if (pos.qty < 1) continue;
    const ticker = padTicker(pos.code);
    const prev = map.get(ticker);
    map.set(ticker, {
      qty: (prev?.qty ?? 0) + pos.qty,
      name: pos.name || prev?.name || ticker,
    });
  }
  return map;
}

export function diffLocalVsKis(
  state: AppState,
  remote: KisAccountBalance,
  cashToleranceKrw = HARD_LIMITS.balanceCashToleranceKrw,
): { matched: boolean; cashDelta: number; reasons: string[] } {
  const reasons: string[] = [];
  const cashDelta = state.cash - remote.cash;
  if (Math.abs(cashDelta) > cashToleranceKrw) {
    reasons.push(
      `예수금 로컬 ${state.cash.toLocaleString("ko-KR")}원 / KIS ${remote.cash.toLocaleString("ko-KR")}원 (Δ${cashDelta.toLocaleString("ko-KR")}원)`,
    );
  }

  const local = localHoldingsByTicker(state);
  const remoteMap = new Map(
    remote.holdings.filter((row) => row.qty > 0).map((row) => [padTicker(row.ticker), row]),
  );
  const tickers = new Set([...local.keys(), ...remoteMap.keys()]);
  for (const ticker of tickers) {
    const localQty = local.get(ticker)?.qty ?? 0;
    const remoteQty = remoteMap.get(ticker)?.qty ?? 0;
    if (localQty === remoteQty) continue;
    const name = local.get(ticker)?.name || remoteMap.get(ticker)?.name || ticker;
    reasons.push(`${name}(${ticker}) 수량 로컬 ${localQty}주 / KIS ${remoteQty}주`);
  }

  return { matched: reasons.length === 0, cashDelta, reasons };
}

/** Replace local buckets/positions with KIS inquire-balance. Does not invent fills. */
export function applyKisSnapshot(
  state: AppState,
  remote: KisAccountBalance,
  now = Date.now(),
): AppState {
  const fallback =
    [...state.allocations].sort((a, b) => b.budget - a.budget)[0]?.ruleId ?? CASH_RULE_ID;
  const positions: Position[] = remote.holdings
    .filter((row) => row.qty > 0)
    .map((row) => {
      const code = padTicker(row.ticker);
      const prev = state.positions.find((pos) => padTicker(pos.code) === code);
      return {
        code,
        name: row.name || prev?.name || code,
        qty: row.qty,
        avgPrice: row.avgPrice > 0 ? row.avgPrice : (prev?.avgPrice ?? 0),
        ruleId: prev?.ruleId ?? fallback,
      };
    });

  const cash = Math.max(0, Math.round(remote.cash));
  const weightSum = Math.max(
    1,
    state.allocations.reduce((sum, row) => sum + Math.max(0, row.budget), 0),
  );
  let leftover = cash;
  const allocations = state.allocations.map((row, index) => {
    const last = index === state.allocations.length - 1;
    const share = last ? leftover : Math.round((cash * Math.max(0, row.budget)) / weightSum);
    leftover -= share;
    return {
      ...row,
      enabled: false,
      balance: Math.max(0, share),
      lastMessage: "긴급 정지 · KIS 잔고로 장부를 맞췄습니다.",
    };
  });

  const snapshot: KisBalanceSnapshot = {
    syncedAt: new Date(now).toISOString(),
    cash: remote.cash,
    d2Cash: remote.d2Cash,
    holdings: remote.holdings,
    cashDelta: 0,
    matched: true,
    message: "긴급 정지로 KIS 실잔고를 로컬 장부에 덮어썼습니다.",
  };

  return {
    ...state,
    allocations,
    cash: cashFromAllocations(allocations),
    positions,
    lastBalanceSyncAt: now,
    kisBalance: snapshot,
  };
}

function hasOpenBrokerTicket(state: AppState): boolean {
  return state.orders.some(
    (order) =>
      !order.parentOrderId &&
      ((order.status === "pending" && Boolean(order.brokerOrderNo)) ||
        order.status === "unknown"),
  );
}

/**
 * Pull inquire-balance and halt if local buckets/positions disagree with KIS.
 * Local 0.015% fee estimates are not used as an allowed drift.
 */
export async function syncKisBalance(
  box: StateBox,
  client: KisApi,
  now = Date.now(),
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!client.configured) return { ok: true };
  const last = box.current.lastBalanceSyncAt ?? 0;
  if (!opts.force && now - last < HARD_LIMITS.balanceSyncMs) return { ok: true };

  let remote: KisAccountBalance;
  try {
    remote = await client.inquireBalance();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "잔고 조회에 실패했습니다.",
    };
  }

  const diff = diffLocalVsKis(box.current, remote);
  const snapshot: KisBalanceSnapshot = {
    syncedAt: new Date(now).toISOString(),
    cash: remote.cash,
    d2Cash: remote.d2Cash,
    holdings: remote.holdings,
    cashDelta: diff.cashDelta,
    matched: diff.matched,
    message: diff.matched
      ? "KIS 잔고와 로컬 버킷이 일치합니다."
      : diff.reasons.join(" · "),
  };

  box.current = {
    ...box.current,
    lastBalanceSyncAt: now,
    kisBalance: snapshot,
  };

  if (diff.matched || hasOpenBrokerTicket(box.current) || box.current.circuit.halted) {
    return { ok: true };
  }

  box.current = openCircuit(
    box.current,
    `KIS 실잔고와 로컬 장부가 어긋나 주문을 중지했습니다. ${snapshot.message}`,
    undefined,
    "balance",
  );
  return { ok: true };
}
