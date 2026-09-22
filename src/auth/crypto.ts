import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { normalizePaperAccountIdentity } from "@/src/runtime/paper-account-identity";

export type PaperCredentialSecret = {
  appKey: string;
  appSecret: string;
  accountNo: string;
};

function masterKeyMaterial(): string {
  const raw = process.env.BROKER_CREDENTIAL_MASTER_KEY?.trim();
  if (!raw || raw.length < 32) {
    throw new Error("BROKER_CREDENTIAL_MASTER_KEY must be set (>=32 chars)");
  }
  return raw;
}

function masterKey(): Buffer {
  return createHash("sha256").update(masterKeyMaterial()).digest();
}

/**
 * Domain-separated HMAC key for PAPER physical-account fingerprints.
 * Not the AES-GCM key bytes — derived via HMAC over the master secret + domain label.
 */
export function paperPhysicalAccountFingerprintKey(): Buffer {
  return createHmac("sha256", masterKeyMaterial())
    .update("mirae:hmac-key:paper-physical-account-fingerprint:v1")
    .digest();
}

/**
 * Deterministic keyed fingerprint of a normalized KIS PAPER account identity.
 * Never log accountNo or the HMAC key. Returns 64 hex chars.
 */
export function paperPhysicalAccountFingerprint(accountNo: string): string {
  const normalized = normalizePaperAccountIdentity(accountNo);
  if (!normalized) {
    throw new Error("account number required for physical account fingerprint");
  }
  return createHmac("sha256", paperPhysicalAccountFingerprintKey())
    .update(`KIS:PAPER:PHYSICAL_ACCOUNT:${normalized}`)
    .digest("hex");
}

export function encryptPaperCredentials(secret: PaperCredentialSecret): {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    authTag: tag.toString("base64"),
    keyVersion: "v1",
  };
}

export function decryptPaperCredentials(input: {
  ciphertext: string;
  iv: string;
  authTag: string;
}): PaperCredentialSecret {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(input.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, "base64")),
    decipher.final(),
  ]);
  const parsed = JSON.parse(dec.toString("utf8")) as PaperCredentialSecret;
  if (!parsed.appKey || !parsed.appSecret || !parsed.accountNo) {
    throw new Error("Invalid credential payload");
  }
  return parsed;
}

export function maskAccountNumber(accountNo: string): string {
  const digits = accountNo.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}
