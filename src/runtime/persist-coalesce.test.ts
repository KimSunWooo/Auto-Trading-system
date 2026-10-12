import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createRuleConfigStore,
  resetRuleConfigStoresForTest,
} from "@/src/runtime/rule-config-store";
import {
  nextPersistGeneration,
  persistGenerationIsCurrent,
  persistScopeKey,
  resetPersistGenerationForTest,
} from "@/src/db/ledger-tx";

test("durable FIFO is not dropped when a later coalesce snapshot arrives", () => {
  const durable: string[] = [];
  let coalesce: string | null = null;
  function enqueue(id: string, isDurable: boolean) {
    if (isDurable) durable.push(id);
    else coalesce = id;
  }
  function drain(): string[] {
    const out: string[] = [];
    while (durable.length > 0 || coalesce) {
      out.push(
        durable.shift() ??
          (() => {
            const c = coalesce!;
            coalesce = null;
            return c;
          })(),
      );
    }
    return out;
  }
  enqueue("tick-old", false);
  enqueue("intent-pre-submit", true);
  enqueue("tick-new", false);
  assert.deepEqual(drain(), ["intent-pre-submit", "tick-new"]);
});

test("persist generation is scoped per account — A does not invalidate B", () => {
  resetPersistGenerationForTest();
  const a = persistScopeKey("acct-aaaa");
  const b = persistScopeKey("acct-bbbb");
  const ga = nextPersistGeneration(a);
  const gb = nextPersistGeneration(b);
  assert.equal(persistGenerationIsCurrent(a, ga), true);
  assert.equal(persistGenerationIsCurrent(b, gb), true);
  nextPersistGeneration(a);
  assert.equal(persistGenerationIsCurrent(a, ga), false);
  assert.equal(persistGenerationIsCurrent(b, gb), true);
});

test("rule-config-store reloads when another writer updates mtime", () => {
  resetRuleConfigStoresForTest();
  const dir = mkdtempSync(path.join(tmpdir(), "rule-cfg-"));
  try {
    const file = path.join(dir, "strategy-config.json");
    const storeA = createRuleConfigStore(file);
    const storeB = createRuleConfigStore(file);
    storeA.commit({
      version: 1,
      rules: [
        {
          id: "r1",
          name: "a",
          ticker: "069500",
          kind: "interval",
          intervalMs: 60_000,
          fastMa: 5,
          slowMa: 20,
          buyPct: 0.1,
          sliceKrw: 100_000,
          minAmountKrw: 10_000,
          stopLossPct: 0.05,
          takeProfitPct: 0.03,
          enabled: false,
          budget: 0,
          budgetMode: "orderable_ratio",
          allocationPct: 0.2,
        },
      ],
    });
    assert.equal(storeB.get().rules[0]?.allocationPct, 0.2);
    assert.equal(storeB.get().rules[0]?.enabled, false);

    // Simulate another process writing OFF + new ratio directly to disk.
    const next = {
      version: 2,
      rules: [
        {
          ...storeA.get().rules[0]!,
          enabled: false,
          allocationPct: 0.05,
        },
      ],
    };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    const now = new Date();
    utimesSync(file, now, new Date(now.getTime() + 1000));

    const reloaded = storeB.get();
    assert.equal(reloaded.version, 2);
    assert.equal(reloaded.rules[0]?.allocationPct, 0.05);
    assert.equal(reloaded.rules[0]?.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
