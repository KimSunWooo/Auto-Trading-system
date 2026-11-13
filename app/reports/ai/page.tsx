import { redirect } from "next/navigation";
import { formatPct, formatSeoul } from "@/lib/format";
import { readAiObservationReport } from "@/src/ai/observation-report";
import type { AiProposalAction } from "@/src/ai/trade-proposal-v1";
import { getCurrentUser } from "@/src/auth/guards";
import { formatInstrumentLabel } from "@/src/instruments/metadata";

export const dynamic = "force-dynamic";

const ACTIONS: Record<AiProposalAction, string> = {
  BUY: "매수 제안", SELL: "매도 제안", HOLD: "보유", NO_TRADE: "거래 보류",
  TACTICAL_WAIT: "조건 대기", EXIT_REVIEW: "청산 검토",
};

export default async function AiReportPage() {
  if (!(await getCurrentUser())) redirect("/login");
  const report = await readAiObservationReport().catch(() => null);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">AI 추천 종목</h1>
        <p className="mt-1 text-sm text-muted-foreground">예상 수익률은 AI Agent의 추정치입니다. 수익률과 판단 시각을 함께 확인할 수 있습니다.</p>
      </header>
      {report === null ? (
        <p className="rounded-lg border p-5 text-sm text-muted-foreground">AI 제안 저장소를 읽을 수 없습니다.</p>
      ) : (
        <>
          <section aria-labelledby="ai-recommendations-title" className="space-y-3">
            <h2 id="ai-recommendations-title" className="font-semibold">유효한 매수 제안 <span className="text-muted-foreground">{report.recommendations.length}건</span></h2>
            {report.recommendations.length === 0 ? (
              <p className="rounded-lg border p-5 text-sm text-muted-foreground">현재 유효한 실데이터 매수 제안이 없습니다.</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {report.recommendations.map(({ proposal }) => (
                  <li key={proposal.proposalId} className="rounded-lg border bg-card p-4">
                    <h3 className="font-semibold">{formatInstrumentLabel(proposal.ticker)}</h3>
                    <dl className="mt-3 grid grid-cols-[1fr_auto] gap-2 text-sm">
                      <dt className="text-muted-foreground">AI 예상 수익률</dt>
                      <dd className="text-right text-lg font-semibold tabular-nums">
                        {proposal.expectedReturn === undefined ? "—" : formatPct(proposal.expectedReturn * 100)}
                      </dd>
                      <dt className="text-muted-foreground">투자 시계</dt>
                      <dd>{proposal.horizon === "LONG_TERM" ? "장기" : proposal.horizon === "SHORT_TERM" ? "단기" : "—"}</dd>
                      <dt className="text-muted-foreground">분석 기준 (KST)</dt>
                      <dd className="tabular-nums">{formatSeoul(proposal.analysisAsOf)}</dd>
                      <dt className="text-muted-foreground">유효 기한 (KST)</dt>
                      <dd className="tabular-nums">{formatSeoul(proposal.validUntil)}</dd>
                    </dl>
                    {proposal.thesis?.summary ? <p className="mt-3 break-words text-sm text-muted-foreground">{proposal.thesis.summary}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-lg border bg-card p-4" aria-labelledby="ai-history-title">
            <h2 id="ai-history-title" className="mb-3 font-semibold">최근 AI 판단</h2>
            {report.latest.length === 0 ? (
              <p className="text-sm text-muted-foreground">수신기로 저장한 AI 제안이 여기에 표시됩니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[38rem] text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th scope="col">종목</th><th scope="col">판단</th><th scope="col">데이터 모드</th>
                      <th scope="col">분석 기준 (KST)</th><th scope="col" className="text-right">AI 예상 수익률</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y tabular-nums">
                    {report.latest.slice(0, 30).map(({ proposal }) => (
                      <tr key={proposal.proposalId}>
                        <th scope="row" className="py-2 pr-2 font-medium">{formatInstrumentLabel(proposal.ticker)}</th>
                        <td>{ACTIONS[proposal.action]}{Date.parse(proposal.validUntil) <= report.evaluatedAt ? " · 만료" : ""}</td>
                        <td>{proposal.dataMode}</td>
                        <td>{formatSeoul(proposal.analysisAsOf)}</td>
                        <td className="text-right">
                          {proposal.action === "BUY" && proposal.expectedReturn !== undefined ? formatPct(proposal.expectedReturn * 100) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {report.invalidCount > 0 ? <p className="mt-3 text-xs text-muted-foreground">읽을 수 없는 제안 {report.invalidCount}건</p> : null}
          </section>
        </>
      )}
    </div>
  );
}
