/**
 * Exclusive PAPER trading runtime ownership.
 * Exactly one of bootstrap | accounts | disabled may own background order workers.
 * Hot switch is forbidden — process restart required.
 */
export type PaperRuntimeOwner = "bootstrap" | "accounts" | "disabled";

export type PaperRuntimeWorker = "bootstrap" | "accounts";

export type PaperRuntimeOwnerResolve =
  | {
      ok: true;
      owner: PaperRuntimeOwner;
      /** True when PAPER_RUNTIME_OWNER was unset and compatibility default applied. */
      usedUnsetDefault: boolean;
      /** True when a prior resolve locked this process's owner. */
      locked: boolean;
    }
  | {
      ok: false;
      error: string;
      raw: string;
    };

export class PaperRuntimeOwnerError extends Error {
  readonly code = "PAPER_RUNTIME_OWNER_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "PaperRuntimeOwnerError";
  }
}

type LockedOwner = {
  owner: PaperRuntimeOwner;
};

let lockedOwner: LockedOwner | null = null;
let unsetWarningEmitted = false;

const VALID = new Set<PaperRuntimeOwner>(["bootstrap", "accounts", "disabled"]);

/** Test reset — clears process-local owner lock. */
export function resetPaperRuntimeOwnerForTest(): void {
  lockedOwner = null;
  unsetWarningEmitted = false;
}

function parseRawOwner(raw: string): PaperRuntimeOwner | null {
  const v = raw.trim().toLowerCase();
  if (VALID.has(v as PaperRuntimeOwner)) return v as PaperRuntimeOwner;
  return null;
}

/**
 * Resolve PAPER_RUNTIME_OWNER.
 * Unset → bootstrap (legacy soak compatibility) with a one-time warning.
 * Invalid → fail closed (ok:false). Does not lock on invalid.
 * First successful resolve locks the process for the lifetime (no hot switch).
 */
export function resolvePaperRuntimeOwner(
  env: Record<string, string | undefined> = process.env,
  opts: { log?: (line: string) => void; freeze?: boolean } = {},
): PaperRuntimeOwnerResolve {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const freeze = opts.freeze !== false;

  const raw = env.PAPER_RUNTIME_OWNER;
  const hasExplicit = raw != null && String(raw).trim() !== "";

  if (hasExplicit) {
    const parsed = parseRawOwner(String(raw));
    if (!parsed) {
      return {
        ok: false,
        error: `Invalid PAPER_RUNTIME_OWNER=${JSON.stringify(String(raw))}; allowed: bootstrap|accounts|disabled`,
        raw: String(raw),
      };
    }
    if (lockedOwner) {
      if (lockedOwner.owner !== parsed) {
        log(
          `PAPER_RUNTIME_OWNER hot switch ignored (${parsed}); locked=${lockedOwner.owner}; server restart required`,
        );
      }
      return { ok: true, owner: lockedOwner.owner, usedUnsetDefault: false, locked: true };
    }
    if (freeze) lockedOwner = { owner: parsed };
    return { ok: true, owner: parsed, usedUnsetDefault: false, locked: false };
  }

  // Unset → bootstrap compatibility
  const owner: PaperRuntimeOwner = "bootstrap";
  if (lockedOwner) {
    return { ok: true, owner: lockedOwner.owner, usedUnsetDefault: true, locked: true };
  }
  if (!unsetWarningEmitted) {
    unsetWarningEmitted = true;
    log("PAPER_RUNTIME_OWNER unset → bootstrap compatibility mode");
  }
  if (freeze) lockedOwner = { owner };
  return { ok: true, owner, usedUnsetDefault: true, locked: false };
}

export function isPaperWorkerAllowed(
  owner: PaperRuntimeOwner,
  worker: PaperRuntimeWorker,
): boolean {
  if (owner === "disabled") return false;
  if (owner === "bootstrap") return worker === "bootstrap";
  if (owner === "accounts") return worker === "accounts";
  return false;
}

export type PaperWorkerStartPlan = {
  owner: PaperRuntimeOwner | null;
  bootstrap: boolean;
  accounts: boolean;
  error?: string;
  usedUnsetDefault?: boolean;
};

/** Plan which workers may start for the current env (fail-closed on invalid). */
export function planPaperRuntimeStarts(
  env: Record<string, string | undefined> = process.env,
  opts: { log?: (line: string) => void; freeze?: boolean } = {},
): PaperWorkerStartPlan {
  const resolved = resolvePaperRuntimeOwner(env, opts);
  if (!resolved.ok) {
    return {
      owner: null,
      bootstrap: false,
      accounts: false,
      error: resolved.error,
    };
  }
  return {
    owner: resolved.owner,
    bootstrap: isPaperWorkerAllowed(resolved.owner, "bootstrap"),
    accounts: isPaperWorkerAllowed(resolved.owner, "accounts"),
    usedUnsetDefault: resolved.usedUnsetDefault,
  };
}

export type PaperWorkerGateResult = {
  allowed: boolean;
  started: boolean;
  owner: PaperRuntimeOwner | null;
  reason?: string;
};

/**
 * Gate a direct startEngineLoop / startAccountEngineLoop call.
 * Does not start anything — callers start only when allowed.
 */
export function gatePaperWorkerStart(
  worker: PaperRuntimeWorker,
  env: Record<string, string | undefined> = process.env,
  opts: { log?: (line: string) => void } = {},
): PaperWorkerGateResult {
  const plan = planPaperRuntimeStarts(env, opts);
  if (plan.error) {
    return {
      allowed: false,
      started: false,
      owner: null,
      reason: plan.error,
    };
  }
  const allowed = worker === "bootstrap" ? plan.bootstrap : plan.accounts;
  if (!allowed) {
    return {
      allowed: false,
      started: false,
      owner: plan.owner,
      reason: `PAPER_RUNTIME_OWNER=${plan.owner} refuses ${worker} worker`,
    };
  }
  return { allowed: true, started: false, owner: plan.owner };
}

export type PaperRuntimeStartHooks = {
  startBootstrap: () => void;
  startAccounts: () => void;
};

/**
 * Instrumentation entry: start exactly one PAPER worker mode (or none).
 * Never starts both. Invalid owner → neither + throws PaperRuntimeOwnerError.
 */
export function startPaperRuntimeWorkers(
  hooks: PaperRuntimeStartHooks,
  env: Record<string, string | undefined> = process.env,
  opts: { log?: (line: string) => void } = {},
): PaperWorkerStartPlan {
  const plan = planPaperRuntimeStarts(env, opts);
  if (plan.error) {
    const err = new PaperRuntimeOwnerError(plan.error);
    opts.log?.(`[paper-runtime] ${err.message}`);
    console.error(`[paper-runtime] ${err.message}`);
    throw err;
  }
  if (plan.bootstrap) hooks.startBootstrap();
  if (plan.accounts) hooks.startAccounts();
  if (plan.owner === "disabled") {
    opts.log?.("[paper-runtime] PAPER_RUNTIME_OWNER=disabled — no trading workers started");
    console.info("[paper-runtime] PAPER_RUNTIME_OWNER=disabled — no trading workers started");
  }
  return plan;
}
