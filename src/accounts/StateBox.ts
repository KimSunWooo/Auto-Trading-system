import type { AppState } from "@/lib/types";

/** Mutable box so a broker instance can commit fills back into the paper book. */
export type StateBox = {
  current: AppState;
};
