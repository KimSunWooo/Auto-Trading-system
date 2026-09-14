import assert from "node:assert/strict";
import test from "node:test";
import { StrategyFactory } from "./index";
import { RiskLevel1Strategy } from "./RiskLevel1Strategy";
import { RiskLevel5Strategy } from "./RiskLevel5Strategy";
import { RiskLevel10Strategy } from "./RiskLevel10Strategy";

test("StrategyFactory maps risk 1-10 onto three playbooks", () => {
  assert.ok(StrategyFactory.create(1) instanceof RiskLevel1Strategy);
  assert.ok(StrategyFactory.create(3) instanceof RiskLevel1Strategy);
  assert.ok(StrategyFactory.create(5) instanceof RiskLevel5Strategy);
  assert.ok(StrategyFactory.create(7) instanceof RiskLevel5Strategy);
  assert.ok(StrategyFactory.create(8) instanceof RiskLevel10Strategy);
  assert.ok(StrategyFactory.create(10) instanceof RiskLevel10Strategy);
});

test("StrategyFactory.createById returns the named class", () => {
  assert.equal(StrategyFactory.createById("Level1_Stable").id, "Level1_Stable");
  assert.equal(StrategyFactory.createById("Level5_Swing").id, "Level5_Swing");
  assert.equal(StrategyFactory.createById("Level10_Aggressive").id, "Level10_Aggressive");
});
