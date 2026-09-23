/**
 * Bootstrap/mirror broker_account projection for PAPER ownership.
 * ACTIVE kis/PAPER rows must always carry a non-null physical fingerprint.
 */
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { loadKisConfig } from "@/src/brokers/kis-config";
import { resolvePaperRuntimeOwner } from "@/src/runtime/paper-runtime-owner";

export type EnvMap = Record<string, string | undefined>;

export type MirrorPaperAccountPlan = {
  status: "ACTIVE" | "DISABLED";
  isDefault: boolean;
  /** undefined = leave existing fingerprint unchanged on UPSERT update */
  physicalAccountFingerprint: string | null | undefined;
  reason: string;
};

export class MirrorPaperOwnershipError extends Error {
  readonly code = "MIRROR_PAPER_OWNERSHIP";
  constructor(message: string) {
    super(message);
    this.name = "MirrorPaperOwnershipError";
  }
}

/**
 * Decide status/fingerprint for the env-backed bootstrap mirror row.
 * - PAPER_RUNTIME_OWNER=accounts|disabled → never ACTIVE; fingerprint null
 * - PAPER_RUNTIME_OWNER=bootstrap → ACTIVE only with computed fingerprint
 */
export function planMirrorPaperBrokerAccount(
  broker: string,
  environment: string,
  env: EnvMap = process.env,
): MirrorPaperAccountPlan {
  if (broker.toLowerCase() !== "kis" || environment.toUpperCase() !== "PAPER") {
    return {
      status: "ACTIVE",
      isDefault: true,
      physicalAccountFingerprint: undefined,
      reason: "non-paper-kis",
    };
  }

  const resolved = resolvePaperRuntimeOwner(env, { freeze: false });
  if (!resolved.ok) {
    throw new MirrorPaperOwnershipError(resolved.error);
  }

  if (resolved.owner === "accounts" || resolved.owner === "disabled") {
    return {
      status: "DISABLED",
      isDefault: false,
      physicalAccountFingerprint: null,
      reason: `PAPER_RUNTIME_OWNER=${resolved.owner} — bootstrap mirror is not the trading owner`,
    };
  }

  // bootstrap owner — ACTIVE requires fingerprint
  let accountNo = "";
  try {
    accountNo = loadKisConfig(env).accountNo;
  } catch {
    accountNo = String(env.KIS_PAPER_ACCOUNT_NO ?? "").trim();
  }
  if (!accountNo) {
    throw new MirrorPaperOwnershipError(
      "ACTIVE PAPER bootstrap mirror requires KIS_PAPER_ACCOUNT_NO (fingerprint fail-closed)",
    );
  }
  try {
    const fingerprint = paperPhysicalAccountFingerprint(accountNo);
    return {
      status: "ACTIVE",
      isDefault: true,
      physicalAccountFingerprint: fingerprint,
      reason: "bootstrap owner with fingerprint",
    };
  } catch (err) {
    throw new MirrorPaperOwnershipError(
      err instanceof Error
        ? `ACTIVE PAPER bootstrap fingerprint failed: ${err.message}`
        : "ACTIVE PAPER bootstrap fingerprint failed",
    );
  }
}

/** Invariant: ACTIVE kis/PAPER must never carry a null fingerprint. */
export function assertActivePaperFingerprint(
  broker: string,
  environment: string,
  status: string,
  fingerprint: string | null | undefined,
): void {
  if (broker.toLowerCase() !== "kis" || environment.toUpperCase() !== "PAPER") return;
  if (status !== "ACTIVE") return;
  if (!fingerprint || String(fingerprint).trim() === "") {
    throw new MirrorPaperOwnershipError(
      "ACTIVE kis/PAPER broker_account requires physicalAccountFingerprint",
    );
  }
}
