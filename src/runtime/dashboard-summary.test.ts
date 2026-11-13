import assert from "node:assert/strict";
import test from "node:test";
import { createPaperState } from "@/lib/engine";
import { toDashboardSummary } from "@/src/runtime/dashboard-summary";
import type { PublicState } from "@/lib/types";

test("dashboard summary drops heavy book arrays but keeps equityHistory chart name", () => {
  const base = createPaperState() as PublicState;
  base.orders = [
    {
      id: "o1",
      source: "manual",
      code: "005930",
      name: "삼성전자",
      side: "buy",
      qty: 1,
      price: 70_000,
      gross: 70_000,
      fee: 0,
      tax: 0,
      net: 70_000,
      status: "filled",
      createdAt: new Date().toISOString(),
    },
  ];
  base.intents = [{ intentId: "i1" } as never];
  base.conditions = [{ id: "c1" } as never];
  base.dcaPlans = [{ id: "d1" } as never];
  base.quotes["005930"] = {
    ...base.quotes["005930"]!,
    history: Array.from({ length: 80 }, (_, i) => 70_000 + i),
  };
  base.equityHistory = [1, 2, 3];
  base.equity = 10_000_000;
  base.market = {
    timezone: "Asia/Seoul",
    now: new Date().toISOString(),
    open: true,
    sessionLabel: "정규장",
  };
  base.broker = {
    driver: "kis",
    mode: "paper",
    configured: true,
    liveEnabled: true,
    accountMasked: "****",
    message: "ok",
  };
  base.ruleConfig = { version: 1, rules: [] };
  base.runtime = {} as never;

  const summary = toDashboardSummary(base);
  assert.equal(summary.view, "dashboard");
  assert.deepEqual(summary.orders, []);
  assert.deepEqual(summary.intents, []);
  assert.deepEqual(summary.conditions, []);
  assert.deepEqual(summary.dcaPlans, []);
  assert.deepEqual(summary.equityHistory, [1, 2, 3]);
  assert.ok((summary.quotes["005930"]?.history?.length ?? 0) <= 24);
  assert.equal(summary.cash, base.cash);
});
