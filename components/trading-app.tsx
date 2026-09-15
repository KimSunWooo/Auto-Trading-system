"use client";

import { useState } from "react";
import {
  BookOpenIcon,
  CalendarClockIcon,
  GaugeIcon,
  LayoutDashboardIcon,
  MenuIcon,
  RadarIcon,
  ReceiptIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConditionsPanel } from "@/components/conditions-panel";
import { DcaPanel } from "@/components/dca-panel";
import { GuidePanel } from "@/components/guide-panel";
import { MarketBadge, OverviewPanel, BrokerBadge } from "@/components/overview-panel";
import { OrdersPanel } from "@/components/orders-panel";
import { StrategiesPanel } from "@/components/strategies-panel";
import { useTrading, api } from "@/hooks/use-trading";
import { formatWon } from "@/lib/format";
import type { PublicState } from "@/lib/types";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { toast } from "sonner";

const TABS = [
  { value: "overview", label: "대시보드", icon: LayoutDashboardIcon },
  { value: "quant", label: "퀀트", icon: GaugeIcon },
  { value: "conditions", label: "조건매수", icon: RadarIcon },
  { value: "dca", label: "적립매수", icon: CalendarClockIcon },
  { value: "orders", label: "체결내역", icon: ReceiptIcon },
  { value: "guide", label: "안내", icon: BookOpenIcon },
] as const;

export function TradingApp({ initialState }: { initialState: PublicState }) {
  const { state, setState, error, reload } = useTrading(initialState);
  const [tab, setTab] = useState<string>("overview");
  const [menu, setMenu] = useState(false);
  const [guide, setGuide] = useState(!initialState.settings.onboardingComplete);

  async function killSwitch() {
    if (!window.confirm(
      "긴급 정지를 실행할까요? 신규 매매를 막고, KIS 미체결을 즉시 취소한 뒤 보유 종목을 시장가 전량 매도합니다. 그다음 증권사 실잔고로 로컬 장부를 덮어씁니다.",
    )) return;
    try {
      setState(await api<PublicState>("/api/risk/kill", { method: "POST" }));
      toast.success("긴급 정지를 실행했습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "긴급 정지에 실패했습니다.");
    }
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMenu(true)}
            aria-label="메뉴"
          >
            <MenuIcon />
          </Button>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              M
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
                  미리매수
                </h1>
                <BrokerBadge state={state} />
              </div>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                한국투자증권 Open API 자동매매
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="destructive" size="sm" onClick={() => void killSwitch()}>
              긴급 정지
            </Button>
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={() => setGuide(true)}>
              시작 가이드
            </Button>
            <MarketBadge state={state} />
            <div className="hidden text-right sm:block">
              <div className="text-[11px] text-muted-foreground">예수금</div>
              <div className="text-sm tabular-nums font-medium">{formatWon(state.cash)}</div>
              {state.kisBalance ? (
                <div
                  className={`text-[10px] tabular-nums ${
                    state.kisBalance.matched ? "text-muted-foreground" : "text-destructive"
                  }`}
                >
                  KIS {formatWon(state.kisBalance.cash)}
                  {state.kisBalance.matched ? "" : " 불일치"}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {state.circuit?.halted || state.orders.some((order) => order.status === "unknown") ? (
        <div className="border-b border-destructive/40 bg-destructive/10">
          <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
            <p>
              {state.circuit?.reason ??
                "미확인 주문이 있어 신규 매매를 차단했습니다. 증권사 체결내역을 확인하세요."}
              {state.killReport?.notes?.length ? (
                <span className="block text-xs opacity-80">
                  {state.killReport.notes.join(" · ")}
                </span>
              ) : null}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void api<PublicState>("/api/circuit/reset", { method: "POST" })
                  .then(setState)
                  .catch((err: unknown) => {
                    toast.error(err instanceof Error ? err.message : "서킷을 해제하지 못했습니다.");
                  });
              }}
            >
              서킷 해제
            </Button>
          </div>
        </div>
      ) : null}

      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader>
            <SheetTitle>미리매수</SheetTitle>
          </SheetHeader>
          <nav className="grid gap-1 px-3 pb-6">
            {TABS.map((item) => (
              <Button
                key={item.value}
                variant={tab === item.value ? "secondary" : "ghost"}
                className="justify-start"
                onClick={() => {
                  setTab(item.value);
                  setMenu(false);
                }}
              >
                <item.icon data-icon="inline-start" />
                {item.label}
              </Button>
            ))}
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => {
                setGuide(true);
                setMenu(false);
              }}
            >
              시작 가이드
            </Button>
            <Button
              variant="destructive"
              className="justify-start"
              onClick={() => {
                setMenu(false);
                void killSwitch();
              }}
            >
              긴급 정지
            </Button>
          </nav>
        </SheetContent>
      </Sheet>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-4">
        {error ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void reload(true)}>
              다시 시도
            </Button>
          </div>
        ) : null}
        {guide ? (
          <OnboardingWizard
            state={state}
            onState={setState}
            onClose={() => setGuide(false)}
          />
        ) : (
        <Tabs value={tab} onValueChange={(value) => setTab(String(value ?? "overview"))}>
          <TabsList className="mb-4 hidden w-full max-w-3xl md:flex">
            {TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                <item.icon />
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview">
            <OverviewPanel state={state} onState={setState} />
          </TabsContent>
          <TabsContent value="quant">
            <StrategiesPanel state={state} onState={setState} />
          </TabsContent>
          <TabsContent value="conditions">
            <ConditionsPanel state={state} onState={setState} />
          </TabsContent>
          <TabsContent value="dca">
            <DcaPanel state={state} onState={setState} />
          </TabsContent>
          <TabsContent value="orders">
            <OrdersPanel state={state} />
          </TabsContent>
          <TabsContent value="guide">
            <GuidePanel state={state} onState={setState} />
          </TabsContent>
        </Tabs>
        )}
      </main>
    </div>
  );
}
