import { createHash, randomUUID } from "node:crypto";

/** RFC-4122 UUID v5-shaped id from a namespace+key. Deterministic for bootstrap rows. */
export function stableId(namespace: string, key: string): string {
  const digest = createHash("sha1").update(`${namespace}:${key}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newId(): string {
  return randomUUID();
}
