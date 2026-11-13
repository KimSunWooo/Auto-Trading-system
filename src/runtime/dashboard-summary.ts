/**
 * Slim dashboard projection — quotes/balance/runtime only.
 * Full orders/fills/reports are loaded from dedicated tab APIs.
 */
import type { PublicState, Quote } from "@/lib/types";

export type DashboardSummaryState = Omit<
  PublicState,
  "orders" | "intents" | "conditions" | "dcaPlans"
> & {
  /** Always empty on summary — use /api/history/fills for 체결내역. */
  orders: [];
  intents: [];
  conditions: [];
  dcaPlans: [];
  /** Marker so clients can detect the slim contract. */
  view: "dashboard";
};

function slimQuote(quote: Quote): Quote {
  const history = quote.history?.length
    ? quote.history.slice(-24)
    : quote.history;
  return history === quote.history ? quote : { ...quote, history };
}

/**
 * Keep equityHistory chart name/shape; trim sparkline history on quotes.
 * Drop heavy book arrays that dashboard auto-refresh does not render.
 */
export function toDashboardSummary(state: PublicState): DashboardSummaryState {
  const quotes: Record<string, Quote> = {};
  for (const [code, quote] of Object.entries(state.quotes ?? {})) {
    quotes[code] = slimQuote(quote);
  }
  return {
    ...state,
    quotes,
    orders: [],
    intents: [],
    conditions: [],
    dcaPlans: [],
    view: "dashboard",
  };
}
