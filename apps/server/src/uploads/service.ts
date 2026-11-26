import { writeFileSync, unlinkSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";

export const UPLOAD_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Deletes `*.tmp` files older than `olderThanMs` (left behind when a restart cut an upload off); returns how many. Avatars also write short-lived `.tmp` files here, hence the age rule. */
export async function sweepUploadTemps(
  uploadsDir: string,
  opts: { olderThanMs: number; now?: number; log: Pick<FastifyBaseLogger, "warn"> },
): Promise<number> {
  const now = opts.now ?? Date.now();
  let deleted = 0;
  for (const name of await readdir(uploadsDir)) {
    if (!name.endsWith(".tmp")) continue;
    const filePath = path.join(uploadsDir, name);
    try {
      const st = await lstat(filePath);
      if (!st.isFile() || now - st.mtimeMs <= opts.olderThanMs) continue;
      await unlink(filePath);
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      opts.log.warn({ err, file: name }, "could not delete a leftover upload temp file");
    }
  }
  return deleted;
}

/** Not `accessSync(W_OK)` (always passes as root) nor `existsSync` (exists is not writable): writing a probe is the only reliable check. */
export function assertUploadsDirWritable(uploadsDir: string): void {
  const probePath = path.join(uploadsDir, `.write-probe-${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(probePath, "");
  } catch (err) {
    throw new Error(
      `uploads 目錄不可寫（${uploadsDir}）：請確認該路徑存在、是目錄（不是檔案）、且執行 process 的使用者有寫入權限`,
      { cause: err }
    );
  }
  try {
    unlinkSync(probePath);
  } catch {
    // The probe write already proved the directory is writable; a failed cleanup doesn't change that.
  }
}

/** Shared with the DELETE-note transaction so both compute the same path. */
export function uploadFilePath(uploadsDir: string, id: string): string {
  return path.join(uploadsDir, id);
}

export interface UploadDeleteLogger {
  error(obj: unknown, msg?: string): void;
}

/** Runs after the DELETE-note commit (a rollback can't restore files). Each file has its own try/catch: a failure (ENOENT included) is only logged. A blob linked from other notes is deleted with its single owning row (those links 404, intended). */
export async function deleteUploadFiles(uploadsDir: string, ids: readonly string[], log: UploadDeleteLogger): Promise<void> {
  await Promise.all(
    ids.map(async id => {
      try {
        await unlink(uploadFilePath(uploadsDir, id));
      } catch (err) {
        log.error({ name: (err as Error).name, code: (err as NodeJS.ErrnoException).code, uploadId: id }, "刪除上傳檔案失敗（best-effort，DB 列已刪除，磁碟孤兒檔案需維運排查）");
      }
    })
  );
}
