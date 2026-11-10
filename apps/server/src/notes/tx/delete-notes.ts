/**
 * #175 T14：永久刪筆記的交易本體——#181 起由垃圾桶的永久刪除（`purgeTrashedNotesInTx`）、
 * 保留期清理（`purgeExpiredBatchInTx`）與刪群組・全刪（T7）三個呼叫端共用；單篇 `DELETE /api/notes/:id` 已改為移入
 * 垃圾桶，不再用它。掛在 notes 上的子表全是 ON DELETE CASCADE（`db/schema.ts`），刪 notes 就帶走它們；
 * uploads 也會被 CASCADE 刪，但要先顯式刪一次拿 `returning` 的 id——磁碟檔由呼叫端在 **commit 之後** best-effort 刪
 * （DB rollback 救不回已刪的檔）。S14：只收 `tx`；`beforeNoteDeleted`（會借連線）只有刪群組・全刪要，在交易**之前**由路由呼叫
 * （永久刪除與清理的對象已在垃圾桶裡，不開共編閘門）。
 *
 * #188：第一步對待刪筆記取 `FOR UPDATE`（依 id 排序，多篇時鎖序固定），之後才 `DELETE uploads … RETURNING`。上傳交易
 * （`insertUploadInTx`）先以 `FOR KEY SHARE` 讀筆記列，與 FOR UPDATE 互斥 → 等本交易 commit 後讀到 0 列 → TxAbort 404（路由先
 * unlink）；以前是 INSERT 的 FK 檢查取同一把鎖（撞 23503，路由仍留這條映射作防禦縱深）。
 * 沒有這把鎖時，上傳可在 RETURNING 之後、DELETE notes 之前 commit，它的列被 CASCADE 帶走卻不在回傳的 id 裡，磁碟檔成孤兒。
 * T7 進來前已以群組述詞 FOR UPDATE 過同一批列（刻意保留，理由見 `groups/tx/delete-group.ts`），這裡對它是同交易重鎖、不等待。
 * 舊序（先 DELETE uploads、後 DELETE notes）與 T7（先 L FOR UPDATE、後 uploads）在同一篇筆記上會成環——#188 以
 * 拋棄式 pg17 兩條 psql 實測得 `deadlock detected`（40P01）；現序兩邊都先筆記後 uploads，在筆記列上序列化。
 * 本交易不碰 groups，與「筆記 FOR UPDATE → groups KEY SHARE」（移動）、「groups FOR UPDATE → 筆記 FOR UPDATE」（T6／T7）都不成環。
 */
import { asc, inArray } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notes, uploads } from "../../db/schema.js";

export async function deleteNotesInTx(tx: Tx, noteIds: readonly string[]): Promise<string[]> {
  const ids = [...noteIds];
  await tx.select({ id: notes.id }).from(notes).where(inArray(notes.id, ids)).orderBy(asc(notes.id)).for("update");
  const deleted = await tx.delete(uploads).where(inArray(uploads.noteId, ids)).returning({ id: uploads.id });
  await tx.delete(notes).where(inArray(notes.id, ids));
  return deleted.map(u => u.id);
}
