/**
 * ATS pull consumer for Auto_Trading_AI_Agent decisions API.
 * Auto-orders remain disabled. Pull only; no push dual-path.
 */
import {
  validateAiTradeProposalV1,
  type AiProposalValidation,
  type AiTradeProposalV1,
} from "@/src/ai/trade-proposal-v1";

export type AiPullConfig = {
  baseUrl: string;
  /** Bearer or shared secret header value — never log. */
  authToken?: string;
  timeoutMs?: number;
  maxPages?: number;
};

export type AiDecisionEnvelope = {
  decisionId: string;
  proposal?: unknown;
  raw?: unknown;
};

export type AiPullResult = {
  fetched: number;
  accepted: AiTradeProposalV1[];
  rejected: Array<{ decisionId?: string; code: string; reason: string }>;
  orderEligibleCount: 0;
  autoOrderEnabled: false;
};

function authHeaders(cfg: AiPullConfig): HeadersInit {
  const headers: Record<string, string> = { accept: "application/json" };
  if (cfg.authToken) headers.authorization = `Bearer ${cfg.authToken}`;
  return headers;
}

async function fetchJson(
  url: string,
  cfg: AiPullConfig,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; reason: string }> {
  const timeoutMs = cfg.timeoutMs ?? 8_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: authHeaders(cfg),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: res.status >= 500 ? "retryable_upstream" : "permanent_reject",
      };
    }
    return { ok: true, body: await res.json() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return { ok: false, status: 0, reason: /abort/i.test(msg) ? "timeout" : "retryable_network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull decisions from AI producer. Validates each envelope; never places orders.
 */
export async function pullAiTradeProposals(cfg: AiPullConfig): Promise<AiPullResult> {
  const base = cfg.baseUrl.replace(/\/$/, "");
  if (!base) {
    return {
      fetched: 0,
      accepted: [],
      rejected: [{ code: "NO_BASE_URL", reason: "AI_AGENT_BASE_URL unset" }],
      orderEligibleCount: 0,
      autoOrderEnabled: false,
    };
  }

  const list = await fetchJson(`${base}/decisions`, cfg);
  if (!list.ok) {
    return {
      fetched: 0,
      accepted: [],
      rejected: [{ code: list.reason.toUpperCase(), reason: `GET /decisions failed (${list.status})` }],
      orderEligibleCount: 0,
      autoOrderEnabled: false,
    };
  }

  const items = Array.isArray(list.body)
    ? list.body
    : Array.isArray((list.body as { items?: unknown[] })?.items)
      ? ((list.body as { items: unknown[] }).items)
      : [];

  const accepted: AiTradeProposalV1[] = [];
  const rejected: AiPullResult["rejected"] = [];
  const maxPages = cfg.maxPages ?? 20;
  let fetched = 0;

  for (const item of items.slice(0, maxPages)) {
    fetched += 1;
    const decisionId =
      item && typeof item === "object" && "decision_id" in item
        ? String((item as { decision_id: unknown }).decision_id)
        : item && typeof item === "object" && "decisionId" in item
          ? String((item as { decisionId: unknown }).decisionId)
          : undefined;

    let proposalRaw: unknown = item;
    if (decisionId) {
      const env = await fetchJson(`${base}/decisions/${encodeURIComponent(decisionId)}/envelope`, cfg);
      if (env.ok) {
        const body = env.body as { proposal?: unknown; payload?: unknown };
        proposalRaw = body.proposal ?? body.payload ?? env.body;
      } else if (env.reason === "permanent_reject") {
        rejected.push({
          decisionId,
          code: "ENVELOPE_REJECTED",
          reason: `envelope ${env.status}`,
        });
        continue;
      }
    }

    const validated: AiProposalValidation = validateAiTradeProposalV1(proposalRaw);
    if (!validated.ok) {
      rejected.push({ decisionId, code: validated.code, reason: validated.reason });
      continue;
    }
    accepted.push(validated.proposal);
  }

  return {
    fetched,
    accepted,
    rejected,
    orderEligibleCount: 0,
    autoOrderEnabled: false,
  };
}
