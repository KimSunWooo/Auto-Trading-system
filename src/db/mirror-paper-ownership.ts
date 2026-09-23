/**
 * Bootstrap/mirror broker_account projection for PAPER ownership.
 * ACTIVE kis/PAPER rows must always carry a non-null physical fingerprint.
 */
import { paperPhysicalAccountFingerprint } from "@/src/auth/crypto";
import { loadKisConfig } from "@/src/brokers/kis-config";

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
 *
 * Uses the provided env snapshot only (does not consult process owner lock).
 * Projection must remain deterministic for the env being mirrored.
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

  const raw = env.PAPER_RUNTIME_OWNER;
  const hasExplicit = raw != null && String(raw).trim() !== "";
  let owner: "bootstrap" | "accounts" | "disabled";
  if (hasExplicit) {
    const parsed = String(raw).trim().toLowerCase();
    if (parsed !== "bootstrap" && parsed !== "accounts" && parsed !== "disabled") {
      throw new MirrorPaperOwnershipError(
        `Invalid PAPER_RUNTIME_OWNER=${JSON.stringify(String(raw))}; allowed: bootstrap|accounts|disabled`,
      );
    }
    owner = parsed;
  } else {
    owner = "bootstrap";
  }

  if (owner === "accounts" || owner === "disabled") {
    return {
      status: "DISABLED",
      isDefault: false,
      physicalAccountFingerprint: null,
      reason: `PAPER_RUNTIME_OWNER=${owner} — bootstrap mirror is not the trading owner`,
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
