/**
 * Per-path rule config store — no global mutable RULE_CONFIG_PATH swap.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  EMPTY_RULE_CONFIG,
  mergeRuleConfig,
  overlayRuleConfig,
  validateRuleConfig,
  type RuleConfigFile,
} from "@/src/rules/params";

export type RuleConfigStore = {
  readonly configPath: string;
  get(): RuleConfigFile;
  save(raw: unknown): RuleConfigFile;
  patch(raw: unknown): RuleConfigFile;
  commit(next: RuleConfigFile): RuleConfigFile;
};

const caches = new Map<string, { mtimeHint: number; value: RuleConfigFile }>();

function clone(value: RuleConfigFile): RuleConfigFile {
  return structuredClone(value);
}

export function createRuleConfigStore(configPath: string): RuleConfigStore {
  const absolute = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);

  function read(): RuleConfigFile {
    try {
      if (!existsSync(absolute)) return clone(EMPTY_RULE_CONFIG);
      return mergeRuleConfig(JSON.parse(readFileSync(absolute, "utf8")) as unknown);
    } catch {
      return clone(EMPTY_RULE_CONFIG);
    }
  }

  function persist(next: RuleConfigFile): void {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    caches.set(absolute, { mtimeHint: Date.now(), value: clone(next) });
  }

  return {
    configPath: absolute,
    get() {
      const cached = caches.get(absolute);
      if (cached) return clone(cached.value);
      const value = read();
      caches.set(absolute, { mtimeHint: Date.now(), value: clone(value) });
      return clone(value);
    },
    commit(next) {
      const invalid = validateRuleConfig(next);
      if (invalid) throw new Error(invalid);
      persist(next);
      return clone(next);
    },
    save(raw) {
      const next = mergeRuleConfig(raw);
      const invalid = validateRuleConfig(next);
      if (invalid) throw new Error(invalid);
      persist(next);
      return clone(next);
    },
    patch(raw) {
      const next = overlayRuleConfig(this.get(), raw);
      const invalid = validateRuleConfig(next);
      if (invalid) throw new Error(invalid);
      persist(next);
      return clone(next);
    },
  };
}

export function resetRuleConfigStoresForTest(): void {
  caches.clear();
}
