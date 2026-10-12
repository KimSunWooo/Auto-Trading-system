import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryLedger } from "@/src/db/ledger";
import {
  LedgerTxTimeoutError,
  LedgerTxStaleError,
  nextPersistGeneration,
  persistGenerationIsCurrent,
  resetPersistGenerationForTest,
} from "@/src/db/ledger-tx";

test("MemoryLedger timeout does not commit late work", async () => {
  const ledger = new MemoryLedger();
  let lateCommitted = false;
  await assert.rejects(
    () =>
      ledger.transaction(
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          lateCommitted = true;
          return "ok";
        },
        { timeoutMs: 5 },
      ),
    (err: unknown) => err instanceof LedgerTxTimeoutError,
  );
  // Give late fn a chance; MemoryLedger timedOut flag must block snapshot commit.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ledger.snapshot.users.size, 0);
  assert.equal(lateCommitted, true);
});

test("stale generation blocks commit", async () => {
  resetPersistGenerationForTest();
  const scope = "acct-test";
  const gen = nextPersistGeneration(scope);
  nextPersistGeneration(scope); // supersede
  assert.equal(persistGenerationIsCurrent(scope, gen), false);
  const ledger = new MemoryLedger();
  await assert.rejects(
    () =>
      ledger.transaction(async () => "x", {
        isCurrent: () => persistGenerationIsCurrent(scope, gen),
      }),
    (err: unknown) => err instanceof LedgerTxStaleError,
  );
});
