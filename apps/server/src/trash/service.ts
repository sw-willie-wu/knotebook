/**
 * #181 垃圾桶的服務層：REST 與 MCP 共用的唯一入口。
 * 每支的形一律是「共編閘門／預判 → 交易（`notes/tx/trash.ts`，S14：callback 整段一個 `xInTx`）→ commit 後的 hook／刪檔」；
 * 交易本體只收 `tx` 與純資料，閘門、刪檔、`onNotesRestored` 都在這裡、在交易之外。
 */
import { and, inArray, isNotNull } from "drizzle-orm";
import type { TrashSkipDto } from "@knotebook/shared";
import type { CollabHooks } from "../collab/hooks.js";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { folderSpaceLockKey, noteFolderSpace, type FolderSpace } from "../folders/space.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { resolveTrashedNoteAccess } from "../notes/service.js";
import {
  purgeTrashedNotesInTx,
  restoreNotesInTx,
  trashNotesInTx,
  type TrashBatchOutcome,
  type TrashIdsInput,
  type TrashNotesOutcome,
  type TrashRestoreInput,
} from "../notes/tx/trash.js";
import { deleteUploadFiles, type UploadDeleteLogger } from "../uploads/service.js";

export interface TrashServiceDeps {
  db: Db;
  collabHooks: CollabHooks;
  /** 永久刪除 commit 後刪附件檔用；移入不刪檔。 */
  uploadsDir: string;
  /** 還原照路徑重建取結構鎖的等待上限（ms），透傳自 `AppDeps.storageLockTimeoutMs`。 */
  storageLockTimeoutMs: number;
  groupTestHook?: GroupTestHook;
}

export type TrashNoteOutcome = "trashed" | "not_found" | "forbidden";

/**
 * 單篇移入：`beforeNoteDeleted`（交易外）→ `trashNotesInTx` → 結果不是 trashed、或交易 throw，一律 `gate.release()`（throw 時 release 後原樣再丟）。
 * 呼叫端先做自己的授權與錯誤形（REST：`resolveNoteAccess` none → 404、無刪除權 → 403；MCP：not_found／forbidden）；本函式在交易內再判一次（TOCTOU）。
 * `noteId` 須已過 UUID；這裡一律轉小寫（交易本體的結果陣列是小寫 id，大寫輸入不轉會在移入成功後誤判成 not_found 並收門）。
 * release 在回傳之前同步呼叫（不延到呼叫端回應之後）。
 */
export async function trashNote(deps: TrashServiceDeps, input: { noteId: string; by: string }): Promise<TrashNoteOutcome> {
  const noteId = input.noteId.toLowerCase();
  const gate = await deps.collabHooks.beforeNoteDeleted(noteId);
  const txInput: TrashIdsInput = { ids: [noteId], by: input.by };
  let out: TrashNotesOutcome;
  try {
    out = await deps.db.transaction(tx => trashNotesInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    gate.release();
    throw err;
  }
  if (out.trashed.includes(noteId)) return "trashed";
  // 交易內重判沒過（授權之後被降權、被別人先移入或刪掉）：閘門收回去，否則接下來兩分鐘新連線都會被告知「已刪除」。
  gate.release();
  return out.forbidden.includes(noteId) ? "forbidden" : "not_found";
}

export interface TrashBatchResult { done: string[]; skipped: TrashSkipDto[] }

/**
 * 預判：逐 id `resolveTrashedNoteAccess`，false（不存在、活筆記、沒有垃圾桶權）→ 不進交易、記
 * `not_found`。**這是承重點**：交易本體的分類順序對任意 id 是存在性 oracle，只能收這裡放行的 id。
 */
async function prejudge(db: Db, input: { ids: readonly string[]; by: string }): Promise<{ ok: string[]; denied: Set<string> }> {
  const ok: string[] = [];
  const denied = new Set<string>();
  for (const id of input.ids) {
    if (await resolveTrashedNoteAccess(db, input.by, id)) ok.push(id);
    else denied.add(id);
  }
  return { ok, denied };
}

/** 預判略過與交易內略過依**原輸入索引**合併（不是兩段串接）。 */
function mergeSkipped(ids: readonly string[], denied: ReadonlySet<string>, inTx: readonly TrashSkipDto[]): TrashSkipDto[] {
  const byId = new Map(inTx.map(s => [s.id, s]));
  const out: TrashSkipDto[] = [];
  for (const id of ids) {
    if (denied.has(id)) out.push({ id, reason: "not_found" });
    else {
      const s = byId.get(id);
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * 還原。ids：已過 UUID_RE、已轉小寫、已去重（呼叫端負責）。預判 → `restoreNotesInTx`（鎖內重判）→ commit 後
 * **同步** `onNotesRestored(done)`（只傳實際還原的 id、中間不 await；done 為空不呼叫）。`done`、`skipped` 照輸入順序。
 * 不檢查容量。預判全數略過 → 不開交易。
 * 資料夾：交易外不持鎖預讀這批筆記的群組與空間，交給交易照序取 groups KS 與結構鎖；預讀之後歸屬才變的
 * 那篇在交易內不重建。
 */
export async function restoreTrashed(deps: TrashServiceDeps, input: { ids: readonly string[]; by: string }): Promise<TrashBatchResult> {
  const { ok, denied } = await prejudge(deps.db, input);
  let out: TrashBatchOutcome = { done: [], skipped: [] };
  if (ok.length > 0) {
    const owners = await deps.db
      .select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId })
      .from(notes)
      .where(and(inArray(notes.id, ok), isNotNull(notes.deletedAt)));
    const groupIds = [...new Set(owners.flatMap(r => (r.groupId === null ? [] : [r.groupId])))].sort();
    const spaces = new Map<string, FolderSpace>();
    for (const r of owners) {
      const space = noteFolderSpace(r);
      spaces.set(folderSpaceLockKey(space), space);
    }
    await deps.groupTestHook?.("trash-restore-prejudged", { noteId: ok[0]! });
    const txInput: TrashRestoreInput = {
      ids: ok, by: input.by, groupIds, spaces: [...spaces.values()], lockTimeoutMs: deps.storageLockTimeoutMs,
    };
    out = await deps.db.transaction(tx => restoreNotesInTx(tx, txInput, deps.groupTestHook));
    if (out.done.length > 0) deps.collabHooks.onNotesRestored(out.done);
  }
  return { done: out.done, skipped: mergeSkipped(input.ids, denied, out.skipped) };
}

/**
 * 永久刪除。ids 的前提同 `restoreTrashed`。預判 → `purgeTrashedNotesInTx`（活筆記一律不刪）→ commit 後
 * `deleteUploadFiles`（best-effort；交易 throw 時一個檔都不刪）。不開共編閘門。預判全數略過 → 不開交易。
 */
export async function purgeTrashed(
  deps: TrashServiceDeps,
  input: { ids: readonly string[]; by: string },
  log: UploadDeleteLogger,
): Promise<TrashBatchResult> {
  const { ok, denied } = await prejudge(deps.db, input);
  let out: TrashBatchOutcome = { done: [], skipped: [] };
  if (ok.length > 0) {
    const txInput: TrashIdsInput = { ids: ok, by: input.by };
    const purged = await deps.db.transaction(tx => purgeTrashedNotesInTx(tx, txInput, deps.groupTestHook));
    await deleteUploadFiles(deps.uploadsDir, purged.uploadIds, log);
    out = purged;
  }
  return { done: out.done, skipped: mergeSkipped(input.ids, denied, out.skipped) };
}
