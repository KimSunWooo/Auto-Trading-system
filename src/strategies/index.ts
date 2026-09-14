import { RiskLevel1Strategy } from "@/src/strategies/RiskLevel1Strategy";
import { RiskLevel5Strategy } from "@/src/strategies/RiskLevel5Strategy";
import { RiskLevel10Strategy } from "@/src/strategies/RiskLevel10Strategy";
import type { IStrategy } from "@/src/strategies/IStrategy";

/**
 * Maps investor risk 1–10 onto the three implemented playbooks.
 * 1–3 defensive DCA, 4–7 MA swing, 8–10 volatility chase.
 */
export class StrategyFactory {
  static create(riskLevel: number): IStrategy {
    const level = Math.min(10, Math.max(1, Math.round(riskLevel)));
    if (level <= 3) return new RiskLevel1Strategy();
    if (level <= 7) return new RiskLevel5Strategy();
    return new RiskLevel10Strategy();
  }

  static createById(strategyId: string): IStrategy {
    switch (strategyId) {
      case "Level1_Stable":
        return new RiskLevel1Strategy();
      case "Level5_Swing":
        return new RiskLevel5Strategy();
      case "Level10_Aggressive":
        return new RiskLevel10Strategy();
      default:
        return StrategyFactory.create(5);
    }
  }
}
