import type { HistoryFilter } from "@/src/db/rows";
import { persistenceMode } from "@/src/db/config";
import { resolveMirrorLedger } from "@/src/db/mirror";
import type { EnvMap } from "@/src/runtime/trading-mode";

function ledgerModes(env: EnvMap) {
  const mode = persistenceMode(env);
  return mode === "mirror" || mode === "database";
}

export async function getBuyHistory(filter: HistoryFilter = {}, env: EnvMap = process.env) {
  if (!ledgerModes(env)) {
    return { items: [], nextCursor: null, limit: Math.min(100, filter.limit ?? 50), mode: "json" as const };
  }
  const ledger = await resolveMirrorLedger(env);
  if (!ledger) {
    return { items: [], nextCursor: null, limit: Math.min(100, filter.limit ?? 50), mode: "unavailable" as const };
  }
  const page = await ledger.transaction((tx) => tx.listBuyHistory(filter));
  return { ...page, mode: persistenceMode(env) };
}

export async function getTradeHistory(filter: HistoryFilter = {}, env: EnvMap = process.env) {
  if (!ledgerModes(env)) {
    return { items: [], nextCursor: null, limit: Math.min(100, filter.limit ?? 50), mode: "json" as const };
  }
  const ledger = await resolveMirrorLedger(env);
  if (!ledger) {
    return { items: [], nextCursor: null, limit: Math.min(100, filter.limit ?? 50), mode: "unavailable" as const };
  }
  const page = await ledger.transaction((tx) => tx.listTrades(filter));
  return { ...page, mode: persistenceMode(env) };
}

export async function getTradeById(id: string, env: EnvMap = process.env) {
  if (!ledgerModes(env)) return null;
  const ledger = await resolveMirrorLedger(env);
  if (!ledger) return null;
  return ledger.transaction(async (tx) => {
    const trade = await tx.getTrade(id);
    if (!trade) return null;
    const executions = await tx.listExecutionsForTrade(id);
    const instrument = await tx.getInstrument(trade.instrumentId);
    return {
      ...trade,
      symbol: instrument?.symbol,
      name: instrument?.displayName,
      market: instrument?.market,
      executions,
    };
  });
}

export async function getDbPositions(filter: HistoryFilter = {}, env: EnvMap = process.env) {
  if (!ledgerModes(env)) {
    return { items: [], nextCursor: null, limit: Math.min(100, filter.limit ?? 50), mode: "json" as const };
  }
  const ledger = await resolveMirrorLedger(env);
  if (!ledger) {
    return { items: [], nextCursor: null, limit: Math.min(100, filter.limit ?? 50), mode: "unavailable" as const };
  }
  const page = await ledger.transaction((tx) => tx.listCurrentPositions(filter));
  return { ...page, mode: persistenceMode(env) };
}
