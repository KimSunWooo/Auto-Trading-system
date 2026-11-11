/**
 * ATS pull consumer for Auto_Trading_AI_Agent decisions API.
 * Auto-orders remain disabled. Pull only; no push dual-path.
 */
import {
  validateAiTradeProposalV1,
  type AiProposalValidation,
  type AiTradeProposalV1,
} from "./trade-proposal-v1";

export type AiPullConfig = {
  baseUrl: string;
  /** Bearer or shared secret header value — never log. */
  authToken?: string;
  timeoutMs?: number;
  /** Maximum number of decisions to inspect per pull. */
  maxPages?: number;
  includeNonOrderActions?: boolean;
  /** A pinned analysis clock for local FIXTURE runs only. */
  fixtureNowMs?: number;
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
      redirect: "error",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: res.status >= 500 || res.status === 429 ? "retryable_upstream" : "permanent_reject",
      };
    }
    return { ok: true, body: await res.json() };
  } catch (err) {
    if (ctrl.signal.aborted) return { ok: false, status: 0, reason: "timeout" };
    if (err instanceof SyntaxError) return { ok: false, status: 0, reason: "invalid_json" };
    return { ok: false, status: 0, reason: "retryable_network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull decisions from AI producer. Validates each envelope; never places orders.
 */
export async function pullAiTradeProposals(cfg: AiPullConfig): Promise<AiPullResult> {
  const base = cfg.baseUrl.trim().replace(/\/+$/, "");
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

  const items = Array.isArray(list.body) ? list.body : (list.body as { items?: unknown })?.items;
  if (!Array.isArray(items)) {
    return {
      fetched: 0,
      accepted: [],
      rejected: [{ code: "INVALID_DECISIONS", reason: "GET /decisions did not return a decision list" }],
      orderEligibleCount: 0,
      autoOrderEnabled: false,
    };
  }

  const accepted: AiTradeProposalV1[] = [];
  const rejected: AiPullResult["rejected"] = [];
  const maxPages = cfg.maxPages ?? 20;
  let fetched = 0;

  // The Agent journal lists its decisions from oldest to newest.
  for (const item of items.slice(Math.max(0, items.length - maxPages))) {
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
        const body = env.body as { proposal?: unknown; payload?: unknown } | null;
        proposalRaw = body?.proposal ?? body?.payload ?? env.body;
      } else {
        rejected.push({
          decisionId,
          code: env.reason === "permanent_reject" ? "ENVELOPE_REJECTED" : env.reason.toUpperCase(),
          reason: `envelope ${env.status}`,
        });
        continue;
      }
    }

    const mode = (proposalRaw as { dataMode?: unknown } | null)?.dataMode;
    const validated: AiProposalValidation = validateAiTradeProposalV1(proposalRaw, {
      includeNonOrderActions: cfg.includeNonOrderActions,
      nowMs: mode === "FIXTURE" ? cfg.fixtureNowMs : undefined,
    });
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
