/**
 * PAPER fill (execution) history — BUY and SELL, including partial fills.
 * Scoped by owned broker account id from the session (never trust client account).
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/src/db/client";
import { persistenceMode } from "@/src/db/config";
import { executions, instruments, orders } from "@/src/db/schema";
import { toMysqlUtc } from "@/src/db/time";
import { seoulDay } from "@/src/risk/limits";
import type { EnvMap } from "@/src/runtime/trading-mode";

export type FillHistoryItem = {
  executionId: string;
  orderId: string;
  side: "BUY" | "SELL" | string;
  symbol: string;
  displayName: string;
  quantity: number;
  price: number;
  grossAmount: number;
  currency: string;
  brokerOrderNo: string | null;
  executedAt: string;
  orderSource: string | null;
  orderedQty: number | null;
  filledQtyOnOrder: number | null;
};

export type FillHistoryResult =
  | {
      ok: true;
      status: "ok" | "empty";
      items: FillHistoryItem[];
      nextCursor: string | null;
      limit: number;
      range: { fromDate: string; throughDate: string };
    }
  | {
      ok: false;
      status: "rds_unavailable" | "json_mode";
      items: [];
      nextCursor: null;
      limit: number;
      error: string;
    };

function clampLimit(limit?: number): number {
  const n = Number(limit ?? 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

export function fillHistoryRange(days = 90, now = new Date()) {
  const today = Date.parse(`${seoulDay(now)}T00:00:00+09:00`);
  const dayMs = 86_400_000;
  const from = today - (days - 1) * dayMs;
  return {
    fromUtc: toMysqlUtc(from),
    untilUtc: toMysqlUtc(today + dayMs),
    fromDate: seoulDay(new Date(from)),
    throughDate: seoulDay(now),
  };
}

export async function getOwnedFillHistory(opts: {
  brokerAccountId: string;
  limit?: number;
  cursor?: string | null;
  days?: number;
  env?: EnvMap;
}): Promise<FillHistoryResult> {
  const env = opts.env ?? process.env;
  const limit = clampLimit(opts.limit);
  const mode = persistenceMode(env);
  if (mode === "json") {
    return {
      ok: false,
      status: "json_mode",
      items: [],
      nextCursor: null,
      limit,
      error: "DB 장부 모드에서만 체결내역을 조회합니다.",
    };
  }
  const db = getDb(env);
  if (!db) {
    return {
      ok: false,
      status: "rds_unavailable",
      items: [],
      nextCursor: null,
      limit,
      error: "RDS 조회 실패 — 장부 연결을 확인할 수 없습니다.",
    };
  }

  const range = fillHistoryRange(opts.days ?? 90);
  const cursorAt = opts.cursor?.includes("|")
    ? opts.cursor.slice(0, opts.cursor.indexOf("|"))
    : opts.cursor?.includes(":")
      ? opts.cursor.split(":")[0]
      : null;
  const cursorId = opts.cursor?.includes("|")
    ? opts.cursor.slice(opts.cursor.indexOf("|") + 1)
    : opts.cursor?.includes(":")
      ? opts.cursor.split(":").slice(1).join(":")
      : null;

  try {
    const rows = await db
      .select({
        executionId: executions.id,
        orderId: executions.orderId,
        side: executions.side,
        symbol: instruments.symbol,
        displayName: instruments.displayName,
        quantity: executions.quantity,
        price: executions.price,
        grossAmount: executions.grossAmount,
        currency: executions.currency,
        brokerOrderNo: executions.brokerOrderNo,
        executedAt: executions.executedAt,
        orderSource: orders.source,
        orderedQty: orders.requestedQty,
        filledQtyOnOrder: orders.filledQty,
      })
      .from(executions)
      .innerJoin(instruments, eq(instruments.id, executions.instrumentId))
      .leftJoin(orders, eq(orders.id, executions.orderId))
      .where(
        and(
          eq(executions.brokerAccountId, opts.brokerAccountId),
          gte(executions.executedAt, range.fromUtc),
          lt(executions.executedAt, range.untilUtc),
          cursorAt && cursorId
            ? sql`(${executions.executedAt} < ${cursorAt} OR (${executions.executedAt} = ${cursorAt} AND ${executions.id} < ${cursorId}))`
            : undefined,
        ),
      )
      .orderBy(desc(executions.executedAt), desc(executions.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit).map((row) => ({
      executionId: row.executionId,
      orderId: row.orderId,
      side: row.side,
      symbol: row.symbol,
      displayName: row.displayName,
      quantity: Number(row.quantity),
      price: Number(row.price),
      grossAmount: Number(row.grossAmount),
      currency: row.currency,
      brokerOrderNo: row.brokerOrderNo,
      executedAt: String(row.executedAt),
      orderSource: row.orderSource ?? null,
      orderedQty: row.orderedQty != null ? Number(row.orderedQty) : null,
      filledQtyOnOrder: row.filledQtyOnOrder != null ? Number(row.filledQtyOnOrder) : null,
    }));
    const extra = rows[limit];
    return {
      ok: true,
      status: page.length === 0 ? "empty" : "ok",
      items: page,
      nextCursor: extra
        ? `${extra.executedAt}|${extra.executionId}`
        : null,
      limit,
      range: { fromDate: range.fromDate, throughDate: range.throughDate },
    };
  } catch (err) {
    return {
      ok: false,
      status: "rds_unavailable",
      items: [],
      nextCursor: null,
      limit,
      error: err instanceof Error ? err.message : "RDS 조회 실패",
    };
  }
}
