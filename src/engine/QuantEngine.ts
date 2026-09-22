import { toBucket } from "@/src/accounts/AccountBucket";
import type { StateBox } from "@/src/accounts/StateBox";
import { createBroker, type CreateBrokerOpts } from "@/src/brokers/index";
import { RuleRunner } from "@/src/rules/RuleRunner";
import { getRuleConfig } from "@/src/rules/config";
import { autoRunAllowed } from "@/src/rules/disclaimer";
import { guardLog } from "@/src/rules/guard-log";
import { guardMetaFrom, ruleThrottleReason } from "@/src/rules/throttle";
import type { AppState } from "@/lib/types";
import { getMarketClock } from "@/lib/market-hours";
import { nowMs } from "@/src/clock";
import { tradingBlocked } from "@/src/risk/circuit";
import { CASH_RULE_ID, type RuleConfigFile } from "@/src/rules/params";
import type { KisApi } from "@/src/brokers/kis-client";

export type QuantEngineDeps = {
  kisClient?: KisApi;
  persistState?: (state: AppState) => Promise<void>;
  ruleConfig?: RuleConfigFile;
  safety?: import("@/src/runtime/trading-safety").TradingSafetyContext;
};

export class QuantEngine {
  static async run(state: AppState, deps: QuantEngineDeps = {}): Promise<AppState> {
    if (!autoRunAllowed(state)) return state;
    const clock = getMarketClock(new Date(nowMs()));
    if (!clock.open) {
      guardLog("정규장 아님", `QuantEngine 스킵 (${clock.sessionLabel})`);
      return {
        ...state,
        allocations: state.allocations.map((row) =>
          row.lastMessage?.includes("정규장 아님")
            ? row
            : { ...row, lastMessage: `정규장 아님 (${clock.sessionLabel}) — 신규 주문 거부` },
        ),
      };
    }

    const box: StateBox = { current: state };
    const brokerOpts: CreateBrokerOpts = {
      kisClient: deps.kisClient,
      persistState: deps.persistState,
      safety: deps.safety,
    };
    const root = createBroker(box, CASH_RULE_ID, brokerOpts);
    const rules = (deps.ruleConfig ?? getRuleConfig()).rules.filter((row) => row.enabled && row.ticker);

    for (const rule of rules) {
      const alloc = box.current.allocations.find((row) => row.ruleId === rule.id);
      if (!alloc || !alloc.enabled) continue;
      const blocked = tradingBlocked(box.current, deps.safety);
      if (blocked) {
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.ruleId === rule.id ? { ...row, lastMessage: blocked } : row,
          ),
        };
        continue;
      }
      const throttle = ruleThrottleReason(alloc, rule.ticker);
      if (throttle) {
        guardLog("룰 쿨다운", throttle);
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.ruleId === rule.id ? { ...row, lastMessage: throttle } : row,
          ),
        };
        continue;
      }
      const broker = root.forRule(rule.id);
      const before = toBucket(alloc, box.current.positions);
      try {
        const after = await RuleRunner.execute(broker, before, rule);
        const live = box.current.allocations.find((row) => row.ruleId === rule.id);
        const cooled = live?.lastMessage?.includes("쿨다운");
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.ruleId === rule.id
              ? {
                  ...row,
                  lastRunAt: after.lastRunAt,
                  lastMessage: cooled ? live?.lastMessage : after.lastMessage,
                  meta: { ...after.meta, ...guardMetaFrom(live?.meta) },
                }
              : row,
          ),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "조건식 실행 오류";
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.ruleId === rule.id ? { ...row, lastMessage: message } : row,
          ),
        };
      }
    }

    return box.current;
  }
}
