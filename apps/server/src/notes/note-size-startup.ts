/**
 * 開機時記下已經超過大小上限的筆記（`NOTE_MAX_BYTES`，`notes/note-size.ts`）：一句 SQL 比 `note_states.ydoc` 的位元組數，記篇數與
 * 筆記 id（**只記 id，不記標題**）。不改任何東西——超過上限的筆記照常開啟、讀出，只是不能再長大。
 */
import { gt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { noteStates } from "../db/schema.js";
import type { SiteLimits } from "../site-limits/store.js";

/** 日誌裡最多列幾個 id（其餘只算進篇數）。 */
export const OVER_CAP_IDS_LOGGED = 1000;

/**
 * `noteMaxBytes` 的生效值有變（管理頁改了）就重記一次超過新上限的筆記（#397）。**只有 `index.ts` 呼叫**；`buildApp` 不訂閱。
 * 回傳解除訂閱的函式。
 */
export function watchNotesOverCap(
  siteLimits: SiteLimits,
  db: Db,
  log: { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void },
): () => void {
  return siteLimits.onChange(keys => {
    if (!keys.has("noteMaxBytes")) return;
    void logNotesOverCap(db, siteLimits.get("noteMaxBytes"), log).catch(err => log.error({ err }, "failed to log notes over the size limit"));
  });
}

export async function logNotesOverCap(db: Db, limitBytes: number, log: { info(o: object, m: string): void; warn(o: object, m: string): void }): Promise<{ count: number; noteIds: string[] }> {
  const rows = await db
    .select({ noteId: noteStates.noteId })
    .from(noteStates)
    .where(gt(sql`octet_length(${noteStates.ydoc})`, limitBytes))
    .orderBy(noteStates.noteId);
  const noteIds = rows.map(r => r.noteId);
  if (noteIds.length === 0) log.info({ limitBytes, count: 0 }, "note size limit in effect; no note is over it");
  else log.warn({ limitBytes, count: noteIds.length, noteIds: noteIds.slice(0, OVER_CAP_IDS_LOGGED) }, "notes already over the note size limit (they still open and read; they can't grow)");
  return { count: noteIds.length, noteIds };
}
