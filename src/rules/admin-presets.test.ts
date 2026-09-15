import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_PRESETS,
  AGGRESSIVE_UNIVERSE,
  applyAdminPreset,
  isAdminPresetUiEnabled,
  isLocalAdminHost,
} from "./admin-presets";

test("admin presets restore KODEX 200 DCA, Samsung MA, and 6-name breakout", () => {
  const stable = applyAdminPreset("Level1_Stable");
  assert.equal(stable.ticker, "069500");
  assert.equal(stable.kind, "interval");
  assert.equal(stable.intervalSec, "45");
  assert.equal(stable.buyPct, "5");
  assert.equal(stable.sliceKrw, "150000");
  assert.equal(stable.budget, "7000000");

  const swing = applyAdminPreset("Level5_Swing");
  assert.equal(swing.ticker, "005930");
  assert.equal(swing.kind, "ma-cross");
  assert.equal(swing.fastMa, "5");
  assert.equal(swing.slowMa, "20");
  assert.equal(swing.buyPct, "35");

  const aggressive = applyAdminPreset("Level10_Aggressive");
  assert.equal(aggressive.ticker, "005930");
  assert.equal(aggressive.kind, "interval");
  assert.equal(aggressive.intervalSec, "120");
  assert.equal(aggressive.buyPct, "25");
  assert.deepEqual(AGGRESSIVE_UNIVERSE, [
    "005930",
    "000660",
    "035720",
    "247540",
    "259960",
    "352820",
  ]);
  assert.equal(ADMIN_PRESETS.length, 3);
});

test("Level10 preset cycles the six tickers on repeat apply", () => {
  const first = applyAdminPreset("Level10_Aggressive");
  const second = applyAdminPreset("Level10_Aggressive", first);
  const third = applyAdminPreset("Level10_Aggressive", second);
  assert.equal(first.ticker, "005930");
  assert.equal(second.ticker, "000660");
  assert.equal(third.ticker, "035720");
});

test("admin preset UI is off on a public host unless ADMIN_MODE is true", () => {
  assert.equal(isLocalAdminHost("app.example.com"), false);
  assert.equal(isAdminPresetUiEnabled("app.example.com", undefined), false);
  assert.equal(isAdminPresetUiEnabled("app.example.com", "false"), false);
  assert.equal(isAdminPresetUiEnabled("app.example.com", "true"), true);
  assert.equal(isAdminPresetUiEnabled("localhost", undefined), true);
  assert.equal(isAdminPresetUiEnabled("127.0.0.1", "false"), true);
  assert.equal(isAdminPresetUiEnabled("[::1]"), true);
});
