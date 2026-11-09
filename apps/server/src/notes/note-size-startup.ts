/**
 * 開機時記下已經超過大小上限的筆記（`NOTE_MAX_BYTES`，`notes/note-size.ts`）：一句 SQL 比 `note_states.ydoc` 的位元組數，記篇數與
 * 筆記 id（**只記 id，不記標題**）。不改任何東西——超過上限的筆記照常開啟、讀出，只是不能再長大。
 */
import { gt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { noteStates } from "../db/schema.js";

/** 日誌裡最多列幾個 id（其餘只算進篇數）。 */
export const OVER_CAP_IDS_LOGGED = 1000;

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
