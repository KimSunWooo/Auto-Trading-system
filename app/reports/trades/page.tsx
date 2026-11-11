import Link from "next/link";
import { redirect } from "next/navigation";
import { formatPct, formatSeoul, formatUsd, formatWon } from "@/lib/format";
import { getCurrentUser } from "@/src/auth/guards";
import { PaperAccountSelectionError, selectOwnedPaperAccount } from "@/src/auth/select-paper-account";
import { persistenceMode } from "@/src/db/config";
import {
  getPaperTradeReport, REPORT_PERIODS, type ReportCurrency,
} from "@/src/db/repositories/trade-report";

export const dynamic = "force-dynamic";

function holdingTime(seconds: number | null) {
  if (seconds === null) return "—";
  if (seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)}일`;
  if (seconds >= 3_600) return `${(seconds / 3_600).toFixed(1)}시간`;
  return seconds < 60 ? "1분 미만" : `${Math.round(seconds / 60)}분`;
}

function pnlColor(value: number) {
  if (value > 0) return "text-up";
  return value < 0 ? "text-down" : "text-foreground";
}

export default async function TradeReportPage({ searchParams }: {
  searchParams: Promise<{ period?: string | string[]; currency?: string | string[] }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const query = await searchParams;
  const period = REPORT_PERIODS.find((value) => String(value) === query.period) ?? 30;
  const currency: ReportCurrency = query.currency === "USD" ? "USD" : "KRW";
  const money = currency === "USD" ? formatUsd : formatWon;
  let report: Awaited<ReturnType<typeof getPaperTradeReport>> | undefined;
  let accountLabel: string | undefined;
  let issue = "DB 장부 모드에서 거래 리포트를 확인할 수 있습니다.";
  if (persistenceMode() !== "json") {
    try {
      const account = await selectOwnedPaperAccount(user.id);
      accountLabel = `${account.displayName} ${account.accountNumberMasked ?? ""}`.trim();
      report = await getPaperTradeReport(account.id, period, currency);
    } catch (err) {
      issue = err instanceof PaperAccountSelectionError
        ? "마이페이지에서 PAPER 계좌 연결 상태를 확인해 주세요."
        : "거래 장부를 조회할 수 없습니다. DB 연결을 확인해 주세요.";
    }
  }

  const daily = report?.daily.slice(-14) ?? [];
  const maxPnl = Math.max(1, ...daily.map(({ pnl }) => Math.abs(pnl)));
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">거래 리포트</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {accountLabel ? `${accountLabel} · ` : ""}PAPER · {report ? `${report.range.fromDate} ~ ${report.range.throughDate} (KST)` : "종료 거래"}
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2" action="/reports/trades">
          <label className="grid gap-1 text-xs text-muted-foreground">
            기간
            <select name="period" defaultValue={period} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
              {REPORT_PERIODS.map((days) => <option key={days} value={days}>최근 {days}일</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            통화
            <select name="currency" defaultValue={currency} className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
              <option value="KRW">KRW</option><option value="USD">USD</option>
            </select>
          </label>
          <button className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground" type="submit">조회</button>
        </form>
      </header>

      {report ? (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "장부 실현손익", value: money(report.realizedPnl), hint: currency, tone: pnlColor(report.realizedPnl) },
              { label: "승률", value: report.winRate === null ? "—" : `${(report.winRate * 100).toFixed(1)}%`, hint: `${report.wins}승 · ${report.losses}패 · ${report.flat}무` },
              { label: "종료 거래", value: `${report.closedCount.toLocaleString("ko-KR")}건`, hint: "매수·매도 수량 일치" },
              { label: "평균 보유 기간", value: holdingTime(report.averageHoldingSeconds), hint: "첫 매수부터 종료 체결까지" },
            ].map(({ label, value, hint, tone }) => (
              <div key={label} className="rounded-lg border bg-card p-3 sm:p-4">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className={`mt-2 text-xl font-semibold tabular-nums sm:text-2xl ${tone ?? ""}`}>{value}</dd>
                <dd className="mt-1 text-xs text-muted-foreground">{hint}</dd>
              </div>
            ))}
          </dl>
          {report.closedCount === 0 ? (
            <p className="rounded-lg border p-5 text-sm text-muted-foreground">선택한 기간에 매수·매도가 매칭된 종료 거래가 없습니다.</p>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-lg border bg-card p-4" aria-labelledby="trade-trend-title">
                  <h2 id="trade-trend-title" className="font-semibold">일별 실현손익</h2>
                  <p className="mb-4 text-xs text-muted-foreground">종료 거래가 있었던 최근 {daily.length}일</p>
                  <ul className="space-y-2 text-xs tabular-nums">
                    {daily.map(({ day, pnl }) => {
                      const width = `${Math.abs(pnl) / maxPnl * 100}%`;
                      return (
                        <li key={day} className="grid grid-cols-[2.75rem_1fr_minmax(5.5rem,auto)] items-center gap-2">
                          <time dateTime={day}>{day.slice(5).replace("-", ".")}</time>
                          <div aria-hidden="true" className="grid h-3 grid-cols-2 divide-x divide-border rounded bg-muted">
                            <div className="flex justify-end">{pnl < 0 ? <div className="bg-down" style={{ width }} /> : null}</div>
                            <div>{pnl > 0 ? <div className="h-full bg-up" style={{ width }} /> : null}</div>
                          </div>
                          <span className={`text-right ${pnlColor(pnl)}`}>{money(pnl)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
                <section className="rounded-lg border bg-card p-4" aria-labelledby="trade-strategy-title">
                  <h2 id="trade-strategy-title" className="mb-3 font-semibold">전략별 성과</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-xs text-muted-foreground"><tr><th scope="col">전략</th><th scope="col" className="text-right">거래</th><th scope="col" className="text-right">승률</th><th scope="col" className="text-right">실현손익</th></tr></thead>
                      <tbody className="divide-y tabular-nums">
                        {report.byStrategy.map((rule) => (
                          <tr key={rule.ruleKey}>
                            <th scope="row" className="py-2 pr-2 font-medium">{rule.name}</th>
                            <td className="text-right">{rule.closedCount}건</td>
                            <td className="text-right">{(rule.wins / rule.closedCount * 100).toFixed(1)}%</td>
                            <td className={`whitespace-nowrap pl-2 text-right ${pnlColor(rule.realizedPnl)}`}>{money(rule.realizedPnl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
              <section className="rounded-lg border bg-card p-4" aria-labelledby="recent-trade-title">
                <h2 id="recent-trade-title" className="mb-3 font-semibold">최근 종료 거래</h2>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[26rem] text-left text-sm">
                    <thead className="text-xs text-muted-foreground"><tr><th scope="col">종목</th><th scope="col">종료 시각 (KST)</th><th scope="col" className="text-right">실현손익</th><th scope="col" className="text-right">장부 수익률</th></tr></thead>
                    <tbody className="divide-y tabular-nums">
                      {report.recent.map((row) => (
                        <tr key={row.id}>
                          <th scope="row" className="py-2 font-medium">{row.name ?? row.ticker ?? "미등록 종목"}{row.ticker && row.name ? ` (${row.ticker})` : ""}</th>
                          <td>{row.closedAt ? formatSeoul(`${row.closedAt.replace(" ", "T")}Z`) : "—"}</td>
                          <td className={`text-right ${pnlColor(Number(row.realizedPnl))}`}>{money(Number(row.realizedPnl))}</td>
                          <td className="text-right">{row.realizedReturn == null ? "—" : formatPct(Number(row.realizedReturn) * 100)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      ) : (
        <div className="rounded-lg border p-5 text-sm text-muted-foreground">
          <p>{issue}</p>
          <Link href="/mypage" className="mt-2 inline-block text-foreground underline">계좌 설정</Link>
        </div>
      )}
    </div>
  );
}
