/**
 * 儲存配額 U-tx（spec 2026-10-08 §6.3-2）：上傳的 DB 寫入。S14：只收 `tx`／純資料／型別明示測試縫。
 *   筆記 `FOR KEY SHARE`（顯式；與原本 INSERT 的 FK 檢查是同一把鎖，只是提前——#188／C22 的推理不變）→ 0 列 → 404 not_found
 *   → `assertSpaceRoomInTx(該筆記的空間, size)`（Q-S2：空間鎖在筆記列鎖之後）→ INSERT uploads
 * 空間以交易內讀到的 owner_id／group_id 為準（preHandler 的預檢讀到的可能已被移動改掉——R3）。
 * 檔案已由路由寫好；本交易任何拋出都由路由 unlink（M4）。
 */
import { eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notes, uploads } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { spaceOfNote } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";

export interface InsertUploadInput {
  id: string;
  /** 已過 UUID_RE、已轉小寫。 */
  noteId: string;
  uploaderId: string;
  mime: string;
  size: number;
  lockTimeoutMs: number;
}

export async function insertUploadInTx(tx: Tx, input: InsertUploadInput, hook?: GroupTestHook): Promise<void> {
  const [note] = await tx
    .select({ ownerId: notes.ownerId, groupId: notes.groupId })
    .from(notes)
    .where(eq(notes.id, input.noteId))
    .for("key share");
  if (!note) throw new TxAbort(404, "not_found", "找不到此筆記");
  await assertSpaceRoomInTx(tx, spaceOfNote(note), input.size, { lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { noteId: input.noteId } });
  await tx.insert(uploads).values({ id: input.id, noteId: input.noteId, uploaderId: input.uploaderId, mime: input.mime, size: input.size });
}
