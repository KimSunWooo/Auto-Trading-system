import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Allocation, AppState } from "@/lib/types";
import { cashFromAllocations } from "@/src/accounts/defaults";
import {
  CASH_RULE_ID,
  EMPTY_RULE_CONFIG,
  mergeRuleConfig,
  overlayRuleConfig,
  validateRuleConfig,
  watchedRuleTickers,
  enabledRuleTickers,
  type RuleConfigFile,
  type UserRule,
} from "@/src/rules/params";

export const RULE_CONFIG_PATH = path.join(process.cwd(), "data", "strategy-config.json");

let cache: { mtimeMs: number; value: RuleConfigFile } | null = null;
let testOverride: RuleConfigFile | null = null;

function cloneConfig(value: RuleConfigFile): RuleConfigFile {
  return structuredClone(value);
}

function inTest() {
  return process.env.npm_lifecycle_event === "test";
}

function readFileConfig(): RuleConfigFile {
  try {
    const raw = readFileSync(RULE_CONFIG_PATH, "utf8");
    return mergeRuleConfig(JSON.parse(raw) as unknown);
  } catch {
    return cloneConfig(EMPTY_RULE_CONFIG);
  }
}

function fileMtimeMs(): number {
  try {
    return statSync(RULE_CONFIG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function seedFileIfMissing() {
  if (inTest()) return;
  try {
    statSync(RULE_CONFIG_PATH);
  } catch {
    mkdirSync(path.dirname(RULE_CONFIG_PATH), { recursive: true });
    writeFileSync(RULE_CONFIG_PATH, `${JSON.stringify(EMPTY_RULE_CONFIG, null, 2)}\n`, "utf8");
  }
}

export function getRuleConfig(): RuleConfigFile {
  if (testOverride) return cloneConfig(testOverride);
  if (inTest()) return cloneConfig(testOverride ?? EMPTY_RULE_CONFIG);
  seedFileIfMissing();
  const mtimeMs = fileMtimeMs();
  if (cache && cache.mtimeMs === mtimeMs) return cloneConfig(cache.value);
  const value = readFileConfig();
  cache = { mtimeMs, value };
  return cloneConfig(value);
}

function persistConfig(next: RuleConfigFile) {
  if (!inTest()) {
    mkdirSync(path.dirname(RULE_CONFIG_PATH), { recursive: true });
    writeFileSync(RULE_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } else {
    testOverride = cloneConfig(next);
  }
  cache = { mtimeMs: fileMtimeMs() || Date.now(), value: next };
}

export function parseRuleConfig(raw: unknown): RuleConfigFile {
  const next = mergeRuleConfig(raw);
  const invalid = validateRuleConfig(next);
  if (invalid) throw new Error(invalid);
  return next;
}

export function commitRuleConfig(next: RuleConfigFile): RuleConfigFile {
  persistConfig(next);
  return cloneConfig(next);
}

export function saveRuleConfig(raw: unknown): RuleConfigFile {
  return commitRuleConfig(parseRuleConfig(raw));
}

export function patchRuleConfig(raw: unknown): RuleConfigFile {
  const next = overlayRuleConfig(getRuleConfig(), raw);
  const invalid = validateRuleConfig(next);
  if (invalid) throw new Error(invalid);
  return commitRuleConfig(next);
}

export function setRuleConfigForTest(value: RuleConfigFile | null) {
  testOverride = value ? cloneConfig(value) : null;
  cache = null;
}

export function cashAllocation(totalDeposit: number, extraBalance?: number): Allocation {
  const balance = extraBalance ?? totalDeposit;
  return {
    ruleId: CASH_RULE_ID,
    budget: Math.max(0, totalDeposit),
    balance: Math.max(0, balance),
    enabled: true,
    lastMessage: "사용자 예수금",
  };
}

export function syncAllocationsToRules(state: AppState, rules: UserRule[] = getRuleConfig().rules): AppState {
  const prev = new Map(state.allocations.map((row) => [row.ruleId, row]));
  const used = rules.reduce((sum, row) => sum + Math.max(0, row.budget), 0);
  if (used > state.totalDeposit) {
    throw new Error("룰 예산 합계가 총 예수금을 초과합니다.");
  }
  const allocations: Allocation[] = [
    cashAllocation(state.totalDeposit - used, prev.get(CASH_RULE_ID)?.balance),
  ];
  for (const rule of rules) {
    const prior = prev.get(rule.id);
    allocations.push({
      ruleId: rule.id,
      budget: rule.budget,
      balance: prior?.balance ?? rule.budget,
      enabled: rule.enabled,
      lastRunAt: prior?.lastRunAt,
      lastMessage: prior?.lastMessage,
      meta: prior?.meta ?? {},
    });
  }
  const cashRow = allocations[0];
  const others = allocations.slice(1).reduce((sum, row) => sum + row.balance, 0);
  if (cashRow) cashRow.balance = Math.max(0, state.totalDeposit - others);
  return {
    ...state,
    allocations,
    cash: cashFromAllocations(allocations),
  };
}

/**
 * Execution-critical tickers for LIVE quote refresh.
 * Includes: enabled rules, held positions, active conditions, enabled DCA.
 * Disabled unused rules are excluded so they cannot open a global data circuit.
 */
export function watchedTickersFrom(state: Pick<AppState, "allocations" | "positions" | "conditions" | "dcaPlans">): string[] {
  const codes = new Set<string>(enabledRuleTickers(getRuleConfig()));
  for (const pos of state.positions) {
    if (pos.qty > 0) codes.add(pos.code);
  }
  for (const cond of state.conditions) {
    if (cond.watching) codes.add(cond.code);
  }
  for (const plan of state.dcaPlans) {
    if (plan.enabled) codes.add(plan.code);
  }
  return [...codes];
}
