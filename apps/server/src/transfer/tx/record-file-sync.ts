/**
 * bulk transfer spec 2026-11-02 §9.5 第 8 步、§13（plan PR-2 §0.1-6、-7；S14）：檔案寫回的紀錄交易本體。**本檔不 import
 * 資料庫實例型別、不接 deps**——只收 `tx` 與純資料（spec §4.4 S14）。呼叫端（`notes/editing/write-service.ts` 的 `syncFile`）
 * 的 `.transaction(` callback 整段就是一個 `recordFileSyncInTx(tx, …)`；帶內容參數（`before_blocks`）的錯誤由呼叫端在交易外
 * `redactDbError`（plan 不變量 9 ①）。
 *
 * ① 一句多列 INSERT：每區一列（只有 `applied`／`conflict` 區；`same` 區不記），`created_at`＝`now() + i 微秒`（i＝文件順序），
 *    讓 `listEdits` 的排序與裁切對本請求自己的列是確定的（gate r1 m10）② 裁切到 `AI_EDITS_RETENTION`（同 `insertEditRecord`
 *    的 keep 查詢形，**限這篇**）③ `transfer_bases.applied_body_sha`＋`last_used_at = now()`。三步同一個交易：任一步失敗整筆回滾
 *    （拿掉交易＝INSERT 留下、基底沒寫，守衛 R2）。回傳**仍存活**的列 id（文件順序；區數 > 100 時本請求較早的列會被裁掉）。
 */
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { AI_EDITS_RETENTION } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { noteAiEdits, transferBases } from "../../db/schema.js";

export interface RecordFileSyncInput {
  noteId: string;
  baseKey: string;
  appliedBodySha: Buffer;
  /** 文件順序；每列 `op: "file_sync"`、`sectionId: null`。 */
  rows: Array<typeof noteAiEdits.$inferInsert>;
}

export async function recordFileSyncInTx(tx: Tx, input: RecordFileSyncInput): Promise<string[]> {
  let ids: string[] = [];
  if (input.rows.length > 0) {
    const inserted = await tx
      .insert(noteAiEdits)
      .values(input.rows.map((r, i) => ({ ...r, createdAt: sql`now() + ${i}::int * interval '1 microsecond'` })))
      .returning({ id: noteAiEdits.id });
    ids = inserted.map(r => r.id);
    const keep = await tx
      .select({ id: noteAiEdits.id })
      .from(noteAiEdits)
      .where(eq(noteAiEdits.noteId, input.noteId))
      .orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id))
      .limit(AI_EDITS_RETENTION);
    const kept = new Set(keep.map(k => k.id));
    await tx.delete(noteAiEdits).where(and(eq(noteAiEdits.noteId, input.noteId), notInArray(noteAiEdits.id, [...kept])));
    ids = ids.filter(id => kept.has(id));
  }
  // ④ `applied_edit_ids`：同檔重送時查這些列有沒有被撤回（探索測試 C）。
  await tx.update(transferBases).set({ appliedBodySha: input.appliedBodySha, appliedEditIds: ids, lastUsedAt: sql`now()` }).where(eq(transferBases.key, input.baseKey));
  return ids;
}
