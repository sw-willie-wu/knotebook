/**
 * #175 T14（spec §6.2 row 15、§6 交易表）：刪筆記的交易本體——單篇 `DELETE /api/notes/:id`（PR2 起）與 PR4 的
 * 刪群組・全刪（T7）共用。掛在 notes 上的子表全是 ON DELETE CASCADE（`db/schema.ts`），刪 notes 就帶走它們；
 * uploads 也會被 CASCADE 刪，但要先顯式刪一次拿 `returning` 的 id——磁碟檔由呼叫端在 **commit 之後** best-effort 刪
 * （DB rollback 救不回已刪的檔）。S14：只收 `tx`；`beforeNoteDeleted`（會借連線）一律在交易**之前**由路由呼叫。
 */
import { inArray } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notes, uploads } from "../../db/schema.js";

export async function deleteNotesInTx(tx: Tx, noteIds: readonly string[]): Promise<string[]> {
  const ids = [...noteIds];
  const deleted = await tx.delete(uploads).where(inArray(uploads.noteId, ids)).returning({ id: uploads.id });
  await tx.delete(notes).where(inArray(notes.id, ids));
  return deleted.map(u => u.id);
}
