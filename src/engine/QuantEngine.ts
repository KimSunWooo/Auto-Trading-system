import { toBucket } from "@/src/accounts/AccountBucket";
import type { StateBox } from "@/src/accounts/StateBox";
import { createBroker } from "@/src/brokers/index";
import { RuleRunner } from "@/src/rules/RuleRunner";
import { getRuleConfig } from "@/src/rules/config";
import { autoRunAllowed } from "@/src/rules/disclaimer";
import type { AppState } from "@/lib/types";
import { tradingBlocked } from "@/src/risk/circuit";

export class QuantEngine {
  static async run(state: AppState): Promise<AppState> {
    if (!autoRunAllowed(state)) return state;
    const box: StateBox = { current: state };
    const root = createBroker(box);
    const rules = getRuleConfig().rules.filter((row) => row.enabled && row.ticker);

    for (const rule of rules) {
      const alloc = box.current.allocations.find((row) => row.ruleId === rule.id);
      if (!alloc || !alloc.enabled) continue;
      const blocked = tradingBlocked(box.current);
      if (blocked) {
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.ruleId === rule.id ? { ...row, lastMessage: blocked } : row,
          ),
        };
        continue;
      }
      const broker = root.forRule(rule.id);
      const before = toBucket(alloc, box.current.positions);
      try {
        const after = await RuleRunner.execute(broker, before, rule);
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.ruleId === rule.id
              ? {
                  ...row,
                  lastRunAt: after.lastRunAt,
                  lastMessage: after.lastMessage,
                  meta: after.meta,
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
