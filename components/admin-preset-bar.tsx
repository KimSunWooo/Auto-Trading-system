"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AdminPlaybookId, AdminPreset, AdminPresetDraft } from "@/src/rules/admin-presets";

function nextUniverseTicker(universe: string[], current?: string): string {
  if (universe.length === 0) return current ?? "";
  const idx = current ? universe.indexOf(current) : -1;
  if (idx < 0) return universe[0]!;
  return universe[(idx + 1) % universe.length]!;
}

function applyFetchedPreset(
  presets: AdminPreset[],
  id: AdminPlaybookId,
  currentTicker?: string,
): AdminPresetDraft | null {
  const preset = presets.find((row) => row.id === id);
  if (!preset) return null;
  const ticker = preset.universe
    ? nextUniverseTicker(preset.universe, currentTicker)
    : preset.draft.ticker;
  const name =
    preset.id === "Level10_Aggressive"
      ? `공격형 · 변동성 돌파 ${ticker}`
      : preset.draft.name;
  return { ...preset.draft, ticker, name };
}

/**
 * Visible only when /api/admin/presets returns 200 (users.role === ADMIN).
 * localhost / NEXT_PUBLIC_ADMIN_MODE never authorize this UI.
 */
export function AdminPresetBar({
  currentTicker,
  onApply,
}: {
  currentTicker?: string;
  onApply: (next: AdminPresetDraft) => void;
}) {
  const [presets, setPresets] = useState<AdminPreset[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/presets");
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setPresets(null);
          return;
        }
        if (!res.ok) {
          setPresets(null);
          return;
        }
        const body = (await res.json()) as { presets?: AdminPreset[] };
        setPresets(Array.isArray(body.presets) ? body.presets : null);
      } catch {
        if (!cancelled) setPresets(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!presets?.length) return null;

  function apply(id: AdminPlaybookId) {
    const next = applyFetchedPreset(presets!, id, currentTicker);
    if (next) onApply(next);
  }

  return (
    <div className="rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">관리자 프리셋</div>
          <p className="text-xs text-muted-foreground">
            ADMIN 역할 전용입니다. 클릭하면 아래 입력칸만 채웁니다. 주문은 실행하지 않습니다.
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {presets.map((preset) => (
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
