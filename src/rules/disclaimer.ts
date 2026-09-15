import type { AppState } from "@/lib/types";
import { DISCLAIMER_TEXT } from "@/src/rules/params";

export { DISCLAIMER_TEXT };

export function executionLocked(state: Pick<AppState, "settings">): string | null {
  if (!state.settings.disclaimerAccepted) {
    return "이용 동의 전에는 매매 실행이 잠겨 있습니다.";
  }
  return null;
}

export function autoRunAllowed(state: Pick<AppState, "settings">): boolean {
  return Boolean(state.settings.autoTrading && state.settings.disclaimerAccepted);
}
