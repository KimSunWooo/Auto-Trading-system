import { sma } from "@/src/strategies/indicators";

async function snap(i: number) {
  const s = await (await fetch("http://127.0.0.1:43147/api/state")).json();
  const q = s.quotes?.["035720"];
  const hist = q?.history ?? [];
  const fast = sma(hist, 5);
  const slow = sma(hist, 20);
  const currRel =
    fast != null && slow != null ? (fast > slow ? "above" : fast < slow ? "below" : "flat") : null;
  const alloc = (s.allocations || []).find((a: { ruleId: string }) => a.ruleId === "paper-long-soak-ma");
  const prevRel = alloc?.meta?.maRel ?? null;
  const regime = alloc?.meta?.regime ?? null;
  const trueX = prevRel === "below" && currRel === "above";
  const recentOrders = (s.orders || []).filter(
    (o: { createdAt: string }) => o.createdAt >= "2026-09-21T07:30:00.000Z",
  );
  const unknown = (s.orders || []).filter((o: { status: string }) => o.status === "unknown");
  console.log(
    JSON.stringify({
      i,
      ruleEnabled: s.ruleConfig?.rules?.find((r: { id: string }) => r.id === "paper-long-soak-ma")?.enabled,
      autoTrading: s.settings?.autoTrading,
      market: s.market?.sessionLabel,
      open: s.market?.open,
      safety: s.safety?.kind,
      quoteOk: s.safety?.quoteOk,
      recon: s.safety?.reconciliation,
      q: q && {
        px: q.price,
        src: q.source,
        age: q.freshAt ? Date.now() - q.freshAt : null,
        hist: hist.length,
      },
      fast,
      slow,
      prevRel,
      currRel,
      regime,
      trueCrossover: trueX,
      recentOrders: recentOrders.length,
      unknown: unknown.length,
      lastMsg: alloc?.lastMessage,
    }),
  );
}

async function main() {
  for (let i = 1; i <= 5; i++) {
    await snap(i);
    await new Promise((r) => setTimeout(r, 12000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
