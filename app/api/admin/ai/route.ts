/**
 * Future AI admin surface — ADMIN only.
 * AI must never call broker order endpoints directly.
 * Auto-order remains off until PAPER ledger/worker priorities are proven.
 */
import { AuthError, requireAdmin } from "@/src/auth/guards";
import { DEFAULT_AI_BUDGET_POLICY } from "@/src/ai/budget-policy";
import { AI_TRADE_PROPOSAL_SCHEMA } from "@/src/ai/trade-proposal-v1";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({
      ok: true,
      note: "AI proposals only. Path: proposal → validate → budget → Risk → Intent → OrderManager → Broker",
      brokerOrderDirect: false,
      schema: AI_TRADE_PROPOSAL_SCHEMA,
      autoOrderEnabled: false,
      haltNewAiOrders: true,
      budgetPolicyDefaults: {
        allocationKrw: DEFAULT_AI_BUDGET_POLICY.allocationKrw,
        allowTenPercentOverdraft: DEFAULT_AI_BUDGET_POLICY.allowTenPercentOverdraft,
        absoluteCapFormula: "allowTenPercentOverdraft ? 1.10*A : A",
      },
      pull: {
        decisions: "/decisions",
        envelope: "/decisions/{decision_id}/envelope",
        configured: Boolean(process.env.AI_AGENT_BASE_URL?.trim()),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
    };
    if (body.action === "halt_new_ai_orders") {
      return Response.json({
        ok: true,
        haltNewAiOrders: true,
        note: "신규 AI 주문만 중단합니다. 보유 청산·타 전략 취소는 수행하지 않습니다.",
        flatten: false,
        cancelOtherStrategies: false,
      });
    }
    if (body.action === "enable_auto_order") {
      return Response.json(
        {
          error: "AI auto-order remains disabled until PAPER account/ledger/worker priorities 1–5 are verified",
          autoOrderEnabled: false,
        },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "AI direct broker order is forbidden" },
      { status: 403 },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
