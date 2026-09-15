import type { AppState } from "@/lib/types";
import { copyBackup, readJsonWithBackup, writeJsonAtomic, type JsonLoad } from "@/src/runtime/atomic-file";
import { safetyOf } from "@/src/runtime/safety";

export class JsonStateRepository {
  constructor(private readonly filePath: string) {}

  load(): Promise<JsonLoad<AppState>> {
    return readJsonWithBackup<AppState>(this.filePath);
  }

  async save(state: AppState): Promise<void> {
    if (safetyOf(state).persistable === false) return;
    await copyBackup(this.filePath);
    await writeJsonAtomic(this.filePath, state);
  }
}
