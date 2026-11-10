/**
 * #181 垃圾桶的交易本體。S14：只收 `tx`、純資料與測試縫；
 * 共編閘門、刪附件檔、`onNotesRestored` 一律由呼叫端（`trash/service.ts`、`folders/service.ts`、清理工作）在交易之外做。
 *
 * - `trashNotesInTx` 是**唯一**把 `deleted_at` 寫成非 NULL 的函式，`restoreNotesInTx` 是唯一把它清回 NULL 的函式。
 *   兩者都用 DB `now()`／NULL，不碰 `updated_at`（它的語意是標題／網址變更）、不碰子表、不刪檔。
 *   資料夾：移入在同一句 UPDATE 寫 `trash_folder_path`（`folder_id` 不清、不取結構鎖）；還原在原資料夾
 *   不在時照快照重建路徑、一律清快照（見 `restoreNotesInTx`）。
 * - 三支單篇路徑（移入／還原／永久刪除）的筆記鎖一律 `lockNotes`：不論狀態先 `FOR UPDATE`（依 id 升冪，與
 *   `deleteNotesInTx` 同鎖序，多 id 不互鎖成環），之後才重判。還原在它之前先取 groups KS 與結構鎖
 *   （見 `restoreNotesInTx`）。移入只改非鍵欄，普通 UPDATE 取的是
 *   `FOR NO KEY UPDATE`，與上傳／複製來源／索引的 `FOR KEY SHARE` 不互斥——顯式 `FOR UPDATE` 才讓它們序列化。
 * - 交易內的權限重判寫成 `noteAccessFromRow((await accessQuery(tx, …))[0], …)`／`trashRightFromRow(trashedAccessQuery(…))`：
 *   S14 守衛不准 tx/ 檔出現單篇授權函式的字面呼叫，這是同一個查詢形與同一份推導。
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { TrashSkipDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { notes } from "../../db/schema.js";
import { ensureFolderPathInTx } from "../../folders/tx/ensure-path.js";
import { lockFolderSpacesInTx, lockGroupsKeyShareInTx } from "../../folders/tx/lock.js";
import { folderSpaceLockKey, noteFolderSpace, sortedSpaceLockKeys, type FolderSpace } from "../../folders/space.js";
import { folderPathJsonSql, NOTES_FOLDER_ID } from "../../folders/sql.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { accessQuery, noteAccessFromRow, trashedAccessQuery, trashRightFromRow } from "../service.js";
import { deleteNotesInTx } from "./delete-notes.js";

/** ids：已過 UUID_RE、已轉小寫、已去重（呼叫端負責）。by：操作者 userId。 */
export interface TrashIdsInput { ids: readonly string[]; by: string }
export interface TrashNotesOutcome { trashed: string[]; notFound: string[]; forbidden: string[] }
export interface TrashBatchOutcome { done: string[]; skipped: TrashSkipDto[] }
export interface TrashRestoreInput extends TrashIdsInput {
  /** 交易外預讀的群組（依 id 取 KS）與空間（取結構鎖）。 */
  groupIds: readonly string[]; spaces: readonly FolderSpace[]; lockTimeoutMs: number;
}

/** 鎖住 ids 裡存在的筆記列（不論在不在垃圾桶），回 id → 鎖時的狀態、歸屬與位置。 */
async function lockNotes(tx: Tx, ids: readonly string[]) {
  const rows = await tx
    .select({
      id: notes.id, deletedAt: notes.deletedAt, ownerId: notes.ownerId, groupId: notes.groupId,
      folderId: notes.folderId, trashFolderPath: notes.trashFolderPath,
    })
    .from(notes)
    .where(inArray(notes.id, [...ids]))
    .orderBy(asc(notes.id))
    .for("update");
  return new Map(rows.map(({ id, ...rest }) => [id, rest]));
}
/** 型別從 `lockNotes` 推（不另寫欄位鍵：守衛二凍結 `deletedAt:` 字面的處數）。 */
type LockedNote = Awaited<ReturnType<typeof lockNotes>> extends Map<string, infer V> ? V : never;

/**
 * ⚠ 前置條件：呼叫端已在交易外授權並開好每篇的共編閘門（`beforeNoteDeleted`）；交易內鎖完重判——這裡只擋「授權之後、
 * 鎖之前」的變化；分類本身不是存在性 oracle（看不到的與不存在的同為 `notFound`）。兩個呼叫端：`trash/service.ts`（單篇移入）、
 * `folders/tx/delete-folder.ts`（刪資料夾，子樹活筆記每批一呼叫；`forbidden`／`notFound` 非空即整筆回滾）。
 *
 * 移到垃圾桶。鎖完後依 id 升冪逐篇重判：none（含已在垃圾桶、列不在）→ `notFound`；沒有刪除權 → `forbidden`；
 * 其餘一句 UPDATE 移入。三個陣列都依 id 升冪。ids 空 → 不發任何語句。
 */
export async function trashNotesInTx(tx: Tx, input: TrashIdsInput, hook?: GroupTestHook): Promise<TrashNotesOutcome> {
  const out: TrashNotesOutcome = { trashed: [], notFound: [], forbidden: [] };
  if (input.ids.length === 0) return out;
  await lockNotes(tx, input.ids);
  await hook?.("note-trash-locked", { noteId: input.ids[0]! });

  const ok: string[] = [];
  for (const id of [...input.ids].sort()) {
    const access = noteAccessFromRow((await accessQuery(tx, input.by, id))[0], input.by);
    if (access.role === "none") out.notFound.push(id);
    else if (!access.permissions.delete) out.forbidden.push(id);
    else ok.push(id);
  }
  if (ok.length === 0) return out;
  // 路徑快照：交易內以相關遞迴 CTE 讀 `folder_id` 的路徑，根層 → NULL；不取結構鎖（讀到稍舊的名字無害）。
  const rows = await tx
    .update(notes)
    .set({ deletedAt: sql`now()`, deletedBy: input.by, trashFolderPath: folderPathJsonSql(NOTES_FOLDER_ID()) })
    .where(and(inArray(notes.id, ok), isNull(notes.deletedAt)))
    .returning({ id: notes.id });
  const hit = new Set(rows.map(r => r.id));
  out.trashed = ok.filter(id => hit.has(id));
  return out;
}

/** restore／purge 共用的分類：沒鎖到 → not_found；活筆記 → not_in_trash；沒有垃圾桶權 → not_found。 */
async function classifyTrashed(tx: Tx, input: TrashIdsInput, locked: Map<string, LockedNote>): Promise<{ ok: string[]; skipped: TrashSkipDto[] }> {
  const ok: string[] = [];
  const skipped: TrashSkipDto[] = [];
  for (const id of input.ids) {
    const row = locked.get(id);
    if (row === undefined) skipped.push({ id, reason: "not_found" });
    else if (row.deletedAt === null) skipped.push({ id, reason: "not_in_trash" });
    else if (!trashRightFromRow((await trashedAccessQuery(tx, input.by, id))[0], input.by)) skipped.push({ id, reason: "not_found" });
    else ok.push(id);
  }
  return { ok, skipped };
}

/**
 * ⚠ 呼叫端必須先以 `resolveTrashedNoteAccess` 預判、只把有垃圾桶權的 id 傳進來——本函式的分類順序（不在 → `not_found`、
 * 活著 → `not_in_trash`、才看垃圾桶權）對任意 id 而言是存在性 oracle。唯一呼叫端是 `trash/service.ts`。
 *
 * 還原：鎖完逐篇分類，其餘一句 UPDATE 清 `deleted_at`／`deleted_by`／`trash_folder_path`。`done`、`skipped` 都照輸入順序。
 * ids 空 → 不發任何語句。
 *
 * 資料夾（表「還原」列）：
 * - 鎖序：`groupIds` 的 groups KS（依 id；不在的群組忽略）→ `spaces` 的結構鎖（依鍵）→ `lockNotes`。兩者由呼叫端在交易外預讀；
 *   重建的資料夾 INSERT（父列 FK KS）在筆記鎖之後——同空間結構鎖已持，會對該空間資料夾取 FU 的交易都要先拿它（附錄 A 偏離）。
 * - 對 ok 依 id：`folder_id` 非 NULL（原資料夾還在）→ 不動；否則快照是非空陣列 → 在筆記**鎖時**的空間 `ensureFolderPathInTx`
 *   （段名先 NFC）並寫 `folder_id`。該空間的鎖鍵不在已取的鍵裡（預讀之後歸屬才變，例如被轉移）→ 不重建、留在新空間根層。
 * - 重建不檢查深度與數量上限；權限＝垃圾桶權（個人 owner、群組 `can_edit ∧ can_delete`），是管理權的超集，不另判。
 */
export async function restoreNotesInTx(tx: Tx, input: TrashRestoreInput, hook?: GroupTestHook): Promise<TrashBatchOutcome> {
  if (input.ids.length === 0) return { done: [], skipped: [] };
  await lockGroupsKeyShareInTx(tx, input.groupIds);
  await lockFolderSpacesInTx(tx, input.spaces, { lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { noteId: input.ids[0]! } });
  const held = new Set(sortedSpaceLockKeys(input.spaces));
  const locked = await lockNotes(tx, input.ids);
  await hook?.("note-restore-locked", { noteId: input.ids[0]! });

  const { ok, skipped } = await classifyTrashed(tx, input, locked);
  if (ok.length === 0) return { done: [], skipped };
  for (const id of [...ok].sort()) {
    const row = locked.get(id)!;
    const path = row.trashFolderPath;
    if (row.folderId !== null || !Array.isArray(path) || path.length === 0 || !path.every(s => typeof s === "string")) continue;
    const space = noteFolderSpace(row);
    if (!held.has(folderSpaceLockKey(space))) continue;
    const leaf = await ensureFolderPathInTx(tx, space, path.map(s => s.normalize("NFC")), input.by);
    await tx.update(notes).set({ folderId: leaf }).where(and(eq(notes.id, id), isNotNull(notes.deletedAt)));
  }
  const rows = await tx
    .update(notes)
    .set({ deletedAt: null, deletedBy: null, trashFolderPath: null })
    .where(and(inArray(notes.id, ok), isNotNull(notes.deletedAt)))
    .returning({ id: notes.id });
  const hit = new Set(rows.map(r => r.id));
  return { done: ok.filter(id => hit.has(id)), skipped };
}

/**
 * ⚠ 呼叫端必須先以 `resolveTrashedNoteAccess` 預判、只把有垃圾桶權的 id 傳進來——本函式的分類順序（不在 → `not_found`、
 * 活著 → `not_in_trash`、才看垃圾桶權）對任意 id 而言是存在性 oracle。唯一呼叫端是 `trash/service.ts`。
 *
 * 永久刪除：分類同還原（活筆記一律 `not_in_trash`、不刪），其餘交給 `deleteNotesInTx`（同交易）。回被刪的 upload id，
 * 磁碟檔由呼叫端在 commit 之後刪。`done`、`skipped` 照輸入順序。ids 空 → 不發任何語句。
 */
export async function purgeTrashedNotesInTx(tx: Tx, input: TrashIdsInput, hook?: GroupTestHook): Promise<TrashBatchOutcome & { uploadIds: string[] }> {
  if (input.ids.length === 0) return { done: [], skipped: [], uploadIds: [] };
  const locked = await lockNotes(tx, input.ids);
  await hook?.("note-purge-locked", { noteId: input.ids[0]! });

  const { ok, skipped } = await classifyTrashed(tx, input, locked);
  if (ok.length === 0) return { done: [], skipped, uploadIds: [] };
  const uploadIds = await deleteNotesInTx(tx, ok);
  return { done: ok, skipped, uploadIds };
}

/**
 * 保留期清理的一批：`deleted_at` 嚴格早於 `now() - retentionDays 天` 的垃圾桶筆記，依 `deleted_at, id`
 * 升冪取至多 `limit` 篇、`FOR UPDATE SKIP LOCKED`（不等正在還原或手動永久刪除的列，下一輪再處理），同交易
 * `deleteNotesInTx`。時間全在 DB 端算。
 */
export async function purgeExpiredBatchInTx(
  tx: Tx,
  input: { retentionDays: number; limit: number },
  hook?: GroupTestHook,
): Promise<{ noteIds: string[]; uploadIds: string[] }> {
  const rows = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNotNull(notes.deletedAt), sql`${notes.deletedAt} < now() - make_interval(days => ${input.retentionDays})`))
    .orderBy(asc(notes.deletedAt), asc(notes.id))
    .limit(input.limit)
    .for("update", { skipLocked: true });
  await hook?.("trash-purge-locked", rows[0] ? { noteId: rows[0].id } : {});
  if (rows.length === 0) return { noteIds: [], uploadIds: [] };
  const noteIds = rows.map(r => r.id);
  return { noteIds, uploadIds: await deleteNotesInTx(tx, noteIds) };
}
