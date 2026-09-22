import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type PaperCredentialSecret = {
  appKey: string;
  appSecret: string;
  accountNo: string;
};

function masterKey(): Buffer {
  const raw = process.env.BROKER_CREDENTIAL_MASTER_KEY?.trim();
  if (!raw || raw.length < 32) {
    throw new Error("BROKER_CREDENTIAL_MASTER_KEY must be set (>=32 chars)");
  }
  return createHash("sha256").update(raw).digest();
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
