#!/usr/bin/env npx tsx
/**
 * Validate Agent-exported fixtures against ai.trade-proposal.v1.
 * Reuses trading-core validator. Contract rejection codes ≠ order eligibility.
 * All accepted v1 proposals remain orderEligible=false; autoOrderEnabled=false.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAiTradeProposalV1 } from "../../../src/ai/trade-proposal-v1.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

function main(): void {
  const file = path.join(root, "fixtures/ai-proposals.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  const rows = raw.map((item, i) => {
    const proposalId =
      item && typeof item === "object" && "proposalId" in item
        ? String((item as { proposalId: unknown }).proposalId)
        : `index-${i}`;
    const v = validateAiTradeProposalV1(item, {
      nowMs: Date.parse("2026-11-10T07:00:30.000Z"),
    });
    if (!v.ok) {
      return {
        index: i,
        proposalId,
        ok: false as const,
        code: v.code,
        reason: v.reason,
        orderEligible: false as const,
      };
    }
    return {
      index: i,
      proposalId,
      ok: true as const,
      action: v.proposal.action,
      dataMode: v.proposal.dataMode,
      orderEligible: v.orderEligible,
      reason: v.reason,
    };
  });

  const accepted = rows.filter((r) => r.ok);
  const rejected = rows.filter((r) => !r.ok);
  const eligibleLeak = accepted.some((r) => r.ok && r.orderEligible);

  // Expected fixture outcomes (contract vs eligibility separation):
  // - NO_TRADE → NON_ORDER_ACTION (not converted to order candidate)
  // - FIXTURE BUY → accepted, orderEligible=false
  // - isOrder=true → IS_ORDER_FORBIDDEN
  const noTrade = rejected.find((r) => r.proposalId === "fix-001");
  const buy = accepted.find((r) => r.proposalId === "fix-002");
  const badFlag = rejected.find((r) => r.proposalId === "fix-bad-order-flag");

  const checks = {
    noTradeRejectedAsNonOrder: noTrade?.ok === false && noTrade.code === "NON_ORDER_ACTION",
    buyAcceptedNotEligible: Boolean(buy?.ok && buy.orderEligible === false),
    isOrderForbidden: badFlag?.ok === false && badFlag.code === "IS_ORDER_FORBIDDEN",
    noEligibleLeak: !eligibleLeak,
  };

  const ok = Object.values(checks).every(Boolean);
  const report = {
    ok,
    fetched: rows.length,
    accepted: accepted.length,
    rejected: rejected.length,
    orderEligibleCount: 0,
    autoOrderEnabled: false as const,
    checks,
    rows,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
}

main();
