import Link from "next/link";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <nav aria-label="리포트" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b pb-3 text-sm font-medium">
        <Link href="/" className="text-muted-foreground hover:text-foreground">← 대시보드</Link>
        <Link href="/reports/trades" className="hover:underline">거래 리포트</Link>
        <Link href="/reports/ai" className="hover:underline">AI 추천 종목</Link>
      </nav>
      {children}
    </main>
  );
}
