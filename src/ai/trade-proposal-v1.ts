/**
 * AI trade-proposal.v1 contract validation (ATS consumer side).
 * Does not activate auto-orders. LIVE_OBSERVATION / LIVE_SHADOW / FIXTURE / REPLAY
 * are never treated as live order eligibility by renaming alone.
 */
export const AI_TRADE_PROPOSAL_SCHEMA = "ai.trade-proposal.v1" as const;

export type AiDataMode =
  | "FIXTURE"
  | "REPLAY"
  | "LIVE_OBSERVATION"
  | "LIVE_SHADOW";

export type AiProposalAction =
  | "BUY"
  | "SELL"
  | "HOLD"
  | "NO_TRADE"
  | "TACTICAL_WAIT"
  | "EXIT_REVIEW";

export type AiTradeProposalV1 = {
  proposalId: string;
  schemaVersion: typeof AI_TRADE_PROPOSAL_SCHEMA | string;
  dataMode: AiDataMode;
  generatedAt: string;
  analysisAsOf: string;
  validUntil: string;
  modelVersion: string;
  featureVersion: string;
  policyVersion: string;
  market: string;
  ticker: string;
  action: AiProposalAction;
  rationale?: string;
  invalidation?: string;
  recommendedRatio?: string;
  artifactType?: string;
  isOrder?: boolean;
  producer?: string;
  intendedConsumer?: string;
  rawConfidence?: number;
  modelApproved?: boolean;
};

export type AiProposalValidation =
  | { ok: true; proposal: AiTradeProposalV1; orderEligible: false; reason: string }
  | { ok: false; code: string; reason: string };

const ORDER_ACTIONS = new Set(["BUY", "SELL"]);
const NON_ORDER_ACTIONS = new Set(["HOLD", "NO_TRADE", "TACTICAL_WAIT", "EXIT_REVIEW"]);
const DATA_MODES = new Set<AiDataMode>([
  "FIXTURE",
  "REPLAY",
  "LIVE_OBSERVATION",
  "LIVE_SHADOW",
]);

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Validate proposal shape. Always returns orderEligible=false for v1 modes —
 * no LIVE_ORDER mode exists yet; observation/shadow must not auto-trade.
 */
export function validateAiTradeProposalV1(
  raw: unknown,
  opts: { nowMs?: number; clockSkewMs?: number } = {},
): AiProposalValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, code: "INVALID_PAYLOAD", reason: "proposal must be an object" };
  }
  const body = raw as Record<string, unknown>;
  const proposalId = asString(body.proposalId);
  const schemaVersion = asString(body.schemaVersion);
  const dataMode = asString(body.dataMode) as AiDataMode | null;
  const generatedAt = asString(body.generatedAt);
  const analysisAsOf = asString(body.analysisAsOf);
  const validUntil = asString(body.validUntil);
  const modelVersion = asString(body.modelVersion);
  const featureVersion = asString(body.featureVersion);
  const policyVersion = asString(body.policyVersion);
  const market = asString(body.market);
  const ticker = asString(body.ticker);
  const action = asString(body.action) as AiProposalAction | null;

  if (!proposalId) return { ok: false, code: "MISSING_PROPOSAL_ID", reason: "proposalId required" };
  if (schemaVersion !== AI_TRADE_PROPOSAL_SCHEMA) {
    return {
      ok: false,
      code: "SCHEMA_VERSION",
      reason: `expected ${AI_TRADE_PROPOSAL_SCHEMA}`,
    };
  }
  if (!dataMode || !DATA_MODES.has(dataMode)) {
    return { ok: false, code: "DATA_MODE", reason: "unsupported or missing dataMode" };
  }
  if (!isIso(generatedAt) || !isIso(analysisAsOf) || !isIso(validUntil)) {
    return { ok: false, code: "TIMESTAMPS", reason: "generatedAt/analysisAsOf/validUntil must be ISO" };
  }
  if (!modelVersion || !featureVersion || !policyVersion) {
    return { ok: false, code: "VERSIONS", reason: "model/feature/policy versions required" };
  }
  if (!market || !ticker || !action) {
    return { ok: false, code: "SIGNAL", reason: "market/ticker/action required" };
  }
  if (!ORDER_ACTIONS.has(action) && !NON_ORDER_ACTIONS.has(action)) {
    return { ok: false, code: "ACTION", reason: `unsupported action ${action}` };
  }

  const gen = Date.parse(generatedAt);
  const asOf = Date.parse(analysisAsOf);
  const until = Date.parse(validUntil);
  if (!(asOf <= gen && gen <= until)) {
    return {
      ok: false,
      code: "TIME_ORDER",
      reason: "require analysisAsOf <= generatedAt <= validUntil",
    };
  }

  const now = opts.nowMs ?? Date.now();
  const skew = opts.clockSkewMs ?? 60_000;
  if (until + skew < now) {
    return { ok: false, code: "EXPIRED", reason: "proposal validUntil expired" };
  }

  if (body.isOrder === true) {
    return {
      ok: false,
      code: "IS_ORDER_FORBIDDEN",
      reason: "producer isOrder=true is rejected; ATS decides order eligibility",
    };
  }

  if (NON_ORDER_ACTIONS.has(action)) {
    return {
      ok: false,
      code: "NON_ORDER_ACTION",
      reason: `${action} must not be converted to BUY/SELL`,
    };
  }

  const proposal: AiTradeProposalV1 = {
    proposalId,
    schemaVersion,
    dataMode,
    generatedAt,
    analysisAsOf,
    validUntil,
    modelVersion,
    featureVersion,
    policyVersion,
    market,
    ticker,
    action,
    rationale: asString(body.rationale) ?? undefined,
    invalidation: asString(body.invalidation) ?? undefined,
    recommendedRatio: asString(body.recommendedRatio) ?? undefined,
    artifactType: asString(body.artifactType) ?? undefined,
    isOrder: false,
    producer: asString(body.producer) ?? undefined,
    intendedConsumer: asString(body.intendedConsumer) ?? undefined,
    rawConfidence: typeof body.rawConfidence === "number" ? body.rawConfidence : undefined,
    modelApproved: typeof body.modelApproved === "boolean" ? body.modelApproved : undefined,
  };

  return {
    ok: true,
    proposal,
    orderEligible: false,
    reason:
      "v1 dataMode is observation/shadow/fixture/replay only — AI auto-order blocked until order-eligible contract",
  };
}
