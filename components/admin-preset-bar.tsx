"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ADMIN_PRESETS,
  applyAdminPreset,
  isAdminPresetUiEnabled,
  type AdminPlaybookId,
  type AdminPresetDraft,
} from "@/src/rules/admin-presets";

export function AdminPresetBar({
  currentTicker,
  onApply,
}: {
  currentTicker?: string;
  onApply: (next: AdminPresetDraft) => void;
}) {
  const envOn = process.env.NEXT_PUBLIC_ADMIN_MODE === "true";
  const [visible, setVisible] = useState(envOn);

  useEffect(() => {
    setVisible(isAdminPresetUiEnabled(window.location.hostname));
  }, []);

  if (!visible) return null;

  function apply(id: AdminPlaybookId) {
    onApply(applyAdminPreset(id, { ticker: currentTicker ?? "" }));
  }

  return (
    <div className="rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">🛠 관리자 프리셋</div>
          <p className="text-xs text-muted-foreground">
            로컬·ADMIN_MODE 전용. 일반 배포에는 이 영역이 렌더링되지 않습니다. 클릭하면 아래 입력칸만 채웁니다.
            세 개를 모두 저장할 경우 기본 예수금 1,000만 원 기준 7M / 2M / 1M 으로 맞춰 두었습니다.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {ADMIN_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => apply(preset.id)}
          >
            {preset.label}
            <span className="ml-1 font-normal text-muted-foreground">· {preset.summary}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
