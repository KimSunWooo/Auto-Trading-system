import { readFileSync } from "node:fs";

async function main() {
  const body = {
    rules: [
      {
        id: "paper-long-soak-ma",
        name: "PAPER Long Soak MA",
        ticker: "035720",
        kind: "ma-cross",
        intervalMs: 60000,
        fastMa: 5,
        slowMa: 20,
        buyPct: 0.05,
        sliceKrw: 300000,
        minAmountKrw: 10000,
        stopLossPct: 0.03,
        takeProfitPct: 0.03,
        enabled: true,
        budget: 800000,
      },
      {
        id: "23cd18d6-5dd3-426b-baf1-4e00a2dfeafc",
        name: "안정형 · KODEX 200 적립",
        ticker: "069500",
        kind: "interval",
        intervalMs: 45000,
        fastMa: 5,
        slowMa: 20,
        buyPct: 0.05,
        sliceKrw: 150000,
        minAmountKrw: 10000,
        stopLossPct: 0.05,
        takeProfitPct: 0.03,
        enabled: false,
        budget: 7000000,
      },
    ],
  };

  const res = await fetch("http://127.0.0.1:43147/api/strategy-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const s = await res.json();
  if (!res.ok) {
    console.error("API_ERROR", s);
    process.exit(1);
  }
  const rules = s.ruleConfig?.rules || [];
  const allocs = s.allocations || [];
  for (const id of ["paper-long-soak-ma", "23cd18d6-5dd3-426b-baf1-4e00a2dfeafc"]) {
    const r = rules.find((x: { id: string }) => x.id === id);
    const a = allocs.find((x: { ruleId: string }) => x.ruleId === id);
    console.log(
      JSON.stringify({
        id,
        ticker: r?.ticker,
        kind: r?.kind,
        ruleEnabled: r?.enabled,
        allocEnabled: a?.enabled,
        budget: r?.budget,
        balance: a?.balance,
      }),
    );
  }
  console.log(
    "enabledRules",
    rules
      .filter((r: { enabled: boolean }) => r.enabled)
      .map((r: { id: string; ticker: string; kind: string }) => ({
        id: r.id,
        ticker: r.ticker,
        kind: r.kind,
      })),
  );
  console.log(
    "positions",
    (s.positions || []).map((p: { code: string; qty: number }) => ({ code: p.code, qty: p.qty })),
  );
  console.log(
    "kisHoldings",
    (s.kisBalance?.holdings || []).map((h: { ticker: string; qty: number }) => ({
      t: h.ticker,
      q: h.qty,
    })),
  );
  console.log("file", JSON.parse(readFileSync("data/strategy-config.json", "utf8")));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
