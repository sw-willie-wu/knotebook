/**
 * #175 T4（spec §6.5）：複製的交易本體。快照（`loadNoteDoc`，會借連線）由路由在交易**之前**讀、clone 成 `input.copy`
 * （gate r2 M-6）。S14：只收 `tx`、純資料、型別明示的測試縫；檔案 I/O（`copyFile`）不借連線。
 *   (g) 目標是群組時（**第一把鎖**）：目標 `groups` 列 `FOR KEY SHARE`，再在交易內重讀呼叫者的成員資格與 `can_create`
 *       → 群組不存在、非成員、無 can_create → 404 `group_not_found`（與路由交易外的快速檢查同形；同 `move.ts` (1)）。
 *   (0) 來源 `FOR KEY SHARE`（不擋一般 UPDATE、仍擋刪列——gate r1 M1）；讀不到 → 404
 *   (3) 只留**屬於來源**的附件（他篇的附件原樣引用）
 *   (4) `insertNoteWithAutoSlug` 交易內模式（savepoint 重試，§6.9）
 *   (5) 每個附件：新 id → copyFile → INSERT uploads（uploader＝複製者）→ 記 mapping；檔不在（ENOENT）→ 跳過（plan 規格落差 8）
 *   (6) 改寫網址後寫 `note_states` 首列（version 1，與 `persistNoteState` 首寫同形）
 * 失敗時已落盤的新檔 id 留在 `input.copiedFileIds`，路由在交易外 best-effort 刪。
 * 副本的 notes 列經 `insertNoteWithAutoSlug`（`create.ts`）寫入——那條 INSERT 不在本檔，S14 守衛 ① 掃不到它。
 * 副本的 `updated_at` 不在這裡寫：吃 DB default（新筆記＝本交易的 `now()`，必晚於來源；`test/unit/copy-doc.test.ts` 源碼守衛）。
 * 鎖序（spec §11；T4 review r1 I-1 改）：**目標 groups KEY SHARE → 來源筆記 KEY SHARE**（目標是個人時只有後者）。
 * 為什麼 groups 要在來源之前：來源與目標同在群組 G 時，若先鎖來源（G 的筆記）、再由 (4) INSERT 的 FK 檢查取 G 的
 * KEY SHARE，會與「groups FOR UPDATE → 該群組筆記 FOR UPDATE」（PR4 全刪的形）成環（review r1 實測 40P01；
 * `groups-v2-copy.test.ts` C19b 釘住）。現序下 `lockGroup` 方與 (g) 在各自的第一把鎖就互斥，後到者等的時候不持任何鎖。
 * (g) 也關掉「複製∥移除成員／降級」的授權窗口（C19a／C19c）：`lockGroup`（T6／T7 刪群組、T9–T11 成員異動、PR3 角色異動）
 * 的 FOR UPDATE 與 KEY SHARE 互斥，所以 (g) 讀到的成員資格從讀到 commit 都成立。PR3 角色異動（T12／T13）先 `lockGroup`
 * 這個前提由 PR3 的 race 測試檔守著（T4 review r2 M-3）。(g) 同一句也讀出群組名與角色旗標並回傳（`target`），路由用它組
 * 201 的 role／permissions——交易外 `loadCreateTarget` 只剩快速 404（review r2 M-2：兩次讀之間被降級時不再回降級前的值）。
 * 與其他路徑的鎖對（逐一）：移動＝筆記 FOR UPDATE → groups KEY SHARE——與 (g) 兩把 KEY SHARE 互容，交集只在來源列
 * （KEY SHARE vs FOR UPDATE），持該列的移動之後只要 groups KEY SHARE、不等複製，不成環；PATCH slug／刪筆記只鎖筆記列、
 * 不碰 groups；shares PUT 的 FOR SHARE、改群組名的 NO KEY UPDATE 都與 KEY SHARE 互容。
 * (g) 之後群組刪不掉，(4) 的 INSERT 不會撞 FK 23503；路由的 23503 → 404 映射只剩防禦縱深。
 */
import { randomUUID } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups, noteStates, notes, uploads } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { uploadFilePath } from "../../uploads/service.js";
import { rewriteUploadUrls, type CopyDoc } from "../copy-doc.js";
import { insertNoteWithAutoSlug, type NoteCreateHooks } from "../create.js";
import type { NoteGroupFlags } from "../service.js";
import type { SlugScope } from "../slug.js";

export interface CopyNoteInput {
  sourceId: string;
  userId: string;
  scope: SlugScope;
  copy: CopyDoc;
  uploadsDir: string;
  /** out：已落盤的新附件 id（失敗時由路由清檔）。 */
  copiedFileIds: string[];
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/** (g) 在交易內（持目標 groups KEY SHARE 時）讀到的群組名與呼叫者角色的筆記旗標；目標是個人時為 null。 */
export interface CopyTargetInTx extends NoteGroupFlags {
  name: string;
}

export interface CopyNoteResult {
  note: typeof notes.$inferSelect;
  target: CopyTargetInTx | null;
}

export async function copyNoteInTx(tx: Tx, input: CopyNoteInput, hook?: GroupTestHook, createHooks?: NoteCreateHooks): Promise<CopyNoteResult> {
  let target: CopyTargetInTx | null = null;
  if ("groupId" in input.scope) {
    const groupId = input.scope.groupId;
    const [g] = await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId)).for("key share");
    const [member] = await tx
      .select({
        canRead: groupRoles.canRead,
        canCreate: groupRoles.canCreate,
        canEdit: groupRoles.canEdit,
        canDelete: groupRoles.canDelete,
        canManagePublicLink: groupRoles.canManagePublicLink,
      })
      .from(groupMembers)
      .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, input.userId)))
      .limit(1);
    if (!g || !member || !member.canCreate) throw new TxAbort(404, "group_not_found", "找不到此群組");
    target = { name: g.name, canRead: member.canRead, canEdit: member.canEdit, canDelete: member.canDelete, canManagePublicLink: member.canManagePublicLink };
    await hook?.("note-copy-target-locked", { noteId: input.sourceId, groupId });
  }

  const [src] = await tx.select({ id: notes.id, title: notes.title }).from(notes).where(eq(notes.id, input.sourceId)).for("key share");
  if (!src) throw new TxAbort(404, "not_found", "找不到此筆記");
  await hook?.("note-copy-locked", { noteId: input.sourceId });

  const wanted = [...input.copy.uploadNodes.keys()];
  const owned = wanted.length === 0 ? [] : await tx
    .select({ id: uploads.id, mime: uploads.mime, size: uploads.size })
    .from(uploads)
    .where(and(inArray(uploads.id, wanted), eq(uploads.noteId, input.sourceId)));

  const created = await insertNoteWithAutoSlug(tx, input.scope, src.title, createHooks, { inTx: true });

  const mapping = new Map<string, string>();
  for (const u of owned) {
    const newId = randomUUID();
    // 先記再複製：copyFile 中途失敗（目的檔可能已寫了一半）時，路由的清檔名單也涵蓋它。
    input.copiedFileIds.push(newId);
    try {
      await copyFile(uploadFilePath(input.uploadsDir, u.id), uploadFilePath(input.uploadsDir, newId));
    } catch (err) {
      if (isMissingFile(err)) {
        input.copiedFileIds.pop(); // 來源檔不在：沒有目的檔可清（`deleteUploadFiles` 對不存在的檔會記 error log）
        continue;
      }
      throw err;
    }
    await tx.insert(uploads).values({ id: newId, noteId: created.id, uploaderId: input.userId, mime: u.mime, size: u.size });
    mapping.set(u.id.toLowerCase(), newId);
  }
  rewriteUploadUrls(input.copy, mapping);
  await hook?.("note-copy-files-copied", { noteId: created.id });

  await tx.insert(noteStates).values({ noteId: created.id, ydoc: Buffer.from(Y.encodeStateAsUpdate(input.copy.doc)), version: 1 });
  return { note: created, target };
}
