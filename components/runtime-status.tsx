"use client";

import { Badge } from "@/components/ui/badge";
import type { PublicState } from "@/lib/types";

function tone(ok: boolean): "secondary" | "destructive" {
  return ok ? "secondary" : "destructive";
}

export function RuntimeStatusStrip({ state }: { state: PublicState }) {
  const runtime = state.runtime;
  if (!runtime) return null;
  return (
    <div className="border-b bg-muted/30">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={runtime.ordersAllowed ? "default" : "destructive"}>
            {runtime.ordersAllowed ? "주문 가능" : "주문 차단"}
          </Badge>
          <Badge variant="outline">{runtime.tradingMode.toUpperCase()}</Badge>
          <Badge variant={runtime.tradingStatus === "running" ? "secondary" : "destructive"}>
            {runtime.tradingStatus.toUpperCase()}
          </Badge>
          <Badge variant={tone(runtime.worker === "healthy")}>Worker {runtime.worker}</Badge>
          <Badge variant={tone(runtime.brokerLink === "connected")}>
            Broker {runtime.brokerLink}
          </Badge>
          <Badge variant="outline">Market {runtime.marketStatus}</Badge>
          <Badge variant={runtime.risk === "normal" ? "secondary" : "destructive"}>
            Risk {runtime.risk}
          </Badge>
          <Badge variant={runtime.reconciliation === "synced" ? "secondary" : "destructive"}>
            Recon {runtime.reconciliation}
          </Badge>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {runtime.lastError ? (
            <span className="text-destructive">
              오류 {runtime.lastErrorAt ? new Date(runtime.lastErrorAt).toLocaleTimeString("ko-KR") : ""} ·{" "}
              {runtime.lastError}
            </span>
          ) : (
            <span>
              마지막 틱 {runtime.lastTickAt ? new Date(runtime.lastTickAt).toLocaleTimeString("ko-KR") : "-"}
              {runtime.lastOrderAt ? ` · 주문 ${new Date(runtime.lastOrderAt).toLocaleTimeString("ko-KR")}` : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
