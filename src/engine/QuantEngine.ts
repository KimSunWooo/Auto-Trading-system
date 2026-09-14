import { toBucket } from "@/src/accounts/AccountBucket";
import type { StateBox } from "@/src/accounts/StateBox";
import { createBroker } from "@/src/brokers/index";
import { StrategyFactory } from "@/src/strategies/index";
import type { AppState } from "@/lib/types";
import { tradingBlocked } from "@/src/risk/circuit";

export class QuantEngine {
  static async run(state: AppState): Promise<AppState> {
    const box: StateBox = { current: state };
    const root = createBroker(box);

    for (const alloc of box.current.allocations) {
      if (!alloc.enabled) continue;
      const blocked = tradingBlocked(box.current);
      if (blocked) {
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.strategy === alloc.strategy ? { ...row, lastMessage: blocked } : row,
          ),
        };
        continue;
      }
      const strategy = StrategyFactory.create(alloc.riskLevel);
      const broker = root.forStrategy(alloc.strategy);
      const before = toBucket(alloc, box.current.positions);
      try {
        const after = await strategy.execute(broker, before);
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.strategy === alloc.strategy
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
        const message = err instanceof Error ? err.message : "전략 실행 오류";
        box.current = {
          ...box.current,
          allocations: box.current.allocations.map((row) =>
            row.strategy === alloc.strategy ? { ...row, lastMessage: message } : row,
          ),
        };
      }
    }

    return box.current;
  }
}
