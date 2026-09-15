import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // keep the original file if rename failed
    }
    throw err;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export type JsonLoad<T> =
  | { ok: true; value: T; source: "primary" | "backup" }
  | { ok: false; reason: "missing" | "corrupt" };

export async function readJsonWithBackup<T>(
  filePath: string,
  backupPath = `${filePath}.bak`,
): Promise<JsonLoad<T>> {
  const primary = await readJsonFile<T>(filePath);
  if (primary.ok) return { ok: true, value: primary.value, source: "primary" };
  if (primary.reason === "missing") {
    const backup = await readJsonFile<T>(backupPath);
    if (backup.ok) return { ok: true, value: backup.value, source: "backup" };
    return { ok: false, reason: "missing" };
  }
  const backup = await readJsonFile<T>(backupPath);
  if (backup.ok) return { ok: true, value: backup.value, source: "backup" };
  return { ok: false, reason: "corrupt" };
}

async function readJsonFile<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false; reason: "missing" | "corrupt" }> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return { ok: false, reason: "corrupt" };
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "corrupt" };
  }
}

export async function copyBackup(filePath: string, backupPath = `${filePath}.bak`): Promise<void> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return;
    JSON.parse(raw);
    await writeFileAtomic(backupPath, raw.endsWith("\n") ? raw : `${raw}\n`);
  } catch {
    // keep the previous backup if the new snapshot is unreadable
  }
}
