"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DISCLAIMER_TEXT } from "@/src/rules/params";

export function DisclaimerModal({
  open,
  onOpenChange,
  onAccept,
  confirmLabel = "동의하고 실행",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAccept: () => void | Promise<void>;
  confirmLabel?: string;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!checked) return;
    setBusy(true);
    try {
      await onAccept();
      setChecked(false);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setChecked(false);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>이용 동의</DialogTitle>
          <DialogDescription>자동 실행을 켜기 전에 아래 내용을 확인하고 동의해야 합니다.</DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-6">{DISCLAIMER_TEXT}</p>
        <label className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span>위 내용을 읽었고, 모든 투자 판단과 결과에 대한 책임이 본인에게 있음에 동의합니다.</span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button disabled={!checked || busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
