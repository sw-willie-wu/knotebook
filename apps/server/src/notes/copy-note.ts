/**
 * #180 spec §3.3：複製的本體——REST `POST /api/notes/:id/copy` 與 MCP `copy_note` 共用（W7／W12：不讓共用函式長出 MCP 模式分支）。
 * 順序逐條＝原路由（F32）：入口 `sourceId.toLowerCase()`（MCP 的 NOTE_ID 收大寫；live doc 與踢線以小寫字串為鍵——gate r1 I1；
 * 對 web 是 no-op）→ `role === "none"` → `not_found` → 有 `groupId`：非 UUID 或 `loadCreateTarget` 落空／`!canCreate` →
 * `group_not_found`（交易外只是快速 404；授權本身在 `copyNoteInTx` (g) 重驗）→ 扣 **`edit` 桶** → 交易前 `loadNoteDoc`＋
 * `cloneForCopy`＋`extractForIndex`（S14：`loadNoteDoc` 借連線，不得在交易內）→ 數「會被複製的附件」→ `toCopy > 0` 時不持鎖
 * 預檢目標空間已滿 → `space_full`（不扣 upload 桶）→ **`upload` 桶 `consumeMany(userId, toCopy)`** → 交易 → catch：先 best-effort
 * 刪已落盤的新檔，再分類（`TxAbort`（含 `StorageQuotaExceeded`）→ `aborted`、FK → 群組 `group_not_found`／個人 `fk_personal`、
 * `isRetryableTxError` → `busy`、其餘 rethrow）→ commit 後 `syncLinksFromDoc`。
 * 含 `.transaction(` ⇒ 在 S14 的 `ROUTE_FILES`（④ `{all:1, inTx:1}`、⑤ 引數只有識別字／屬性存取）。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { CollabServer } from "../collab/server.js";
import { docClock } from "../collab/store.js";
import type { Db } from "../db/index.js";
import { isForeignKeyViolation, isRetryableTxError } from "../db/pg-errors.js";
import { notes, uploads } from "../db/schema.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import type { StorageSpace } from "../storage/space.js";
import { isSpaceFull, readSpaceUsage, type SpaceUsage } from "../storage/usage.js";
import { deleteUploadFiles } from "../uploads/service.js";
import { cloneForCopy } from "./copy-doc.js";
import type { NoteCreateHooks } from "./create.js";
import { loadCreateTarget } from "./create-target.js";
import { loadNoteDoc } from "./editing/read.js";
import { syncLinksFromDoc } from "./links.js";
import { extractForIndex } from "./search-index.js";
import { resolveNoteAccess, UUID_RE } from "./service.js";
import type { SlugScope } from "./slug.js";
import { copyNoteInTx, type CopyTargetInTx } from "./tx/copy.js";
import type { SearchIndexHooks } from "./tx/search-index.js";

export interface CopyNoteDeps {
  db: Db;
  collab?: CollabServer;
  log: FastifyBaseLogger;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  /** 與上傳端點、REST 複製**同一實例**（F40）。 */
  limiters: { edit: FixedWindowLimiter; upload: FixedWindowLimiter };
  groupTestHook?: GroupTestHook;
  noteCreateHooks?: NoteCreateHooks;
  searchIndexHooks?: SearchIndexHooks;
}

export type CopyOutcome =
  | { kind: "copied"; note: typeof notes.$inferSelect; target: CopyTargetInTx | null }
  | { kind: "not_found" }
  | { kind: "group_not_found" }
  | { kind: "edit_rate_limited" }
  | { kind: "upload_rate_limited" }
  /** 交易前不持鎖的「已滿」預檢（`incomingBytes` 未知）。 */
  | { kind: "space_full"; space: StorageSpace; usage: SpaceUsage & { quotaBytes: number } }
  /** 交易內的 `TxAbort`（含子類 `StorageQuotaExceeded`）——原樣交給呼叫端。 */
  | { kind: "aborted"; err: TxAbort }
  /** 個人目標的 23503（理論路徑：複製者帳號在交易中被硬刪，`src/` 沒有這條路徑）。 */
  | { kind: "fk_personal" }
  | { kind: "busy" };

export async function copyNote(
  deps: CopyNoteDeps,
  input: { sourceId: string; userId: string; groupId?: string },
): Promise<CopyOutcome> {
  const sourceId = input.sourceId.toLowerCase();
  const userId = input.userId;

  // 看得到就能讀（規格落差 16：role 非 none ⇒ permissions.read 恆真），不另看 read 旗標。
  if ((await resolveNoteAccess(deps.db, userId, sourceId)).role === "none") return { kind: "not_found" };

  let scope: SlugScope;
  if (input.groupId === undefined) {
    scope = { ownerId: userId };
  } else {
    if (!UUID_RE.test(input.groupId)) return { kind: "group_not_found" };
    const groupId = input.groupId.toLowerCase();
    // 快速 404 only：結果不用來組 DTO（降級可能落在這裡與 (g) 之間——review r2 M-2）。
    const m = await loadCreateTarget(deps.db, userId, groupId);
    if (!m || !m.canCreate) return { kind: "group_not_found" };
    scope = { groupId };
  }
  if (!deps.limiters.edit.consume(userId)) return { kind: "edit_rate_limited" };

  const { doc: snapshot } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, sourceId);
  const copy = cloneForCopy(snapshot);
  const searchExtract = extractForIndex(copy.doc); // #93 §5.4：交易前抽（純資料）
  // #175 T4 M-1（Willie 裁決）：複製會多存一份附件檔，依「會被複製的附件數」扣 upload 桶（與上傳端點同桶、同 429 形；
  // 單位＝檔案數，同上傳端點一次一檔）。數法與 `copyNoteInTx` (3) 同一個述詞（文件引用到、且 `note_id`＝來源）；交易前
  // 數、交易內再讀，兩次之間來源新增／刪除附件會讓扣的數與實際複製的差幾張，磁碟檔已遺失而被跳過的那張（RF4）也照扣——
  // 都只在「多扣或少扣幾張」的量級，不值得為此把扣桶搬進交易。0 張不碰桶。額度不足 → 429、不做任何寫入（edit 桶已扣）。
  const wanted = [...copy.uploadNodes.keys()];
  const toCopy = wanted.length === 0
    ? 0
    : (await deps.db.select({ n: sql<number>`count(*)::int` }).from(uploads).where(and(inArray(uploads.id, wanted), eq(uploads.noteId, sourceId))))[0]!.n;
  // 儲存配額 §6.4-3a：不持鎖的「已滿」預檢——有附件要複製、且目標空間已滿 → 409，不開交易、不寫檔、不扣 upload 桶。
  // 只在 toCopy > 0 時做（A4：無附件的複製不受配額限——起草裁定 1／Review Focus RF2）。權威判定在交易內（鎖內、以實際複製的大小）。
  if (toCopy > 0) {
    const space: StorageSpace = "groupId" in scope ? { kind: "group", id: scope.groupId } : { kind: "user", id: userId };
    const usage = await readSpaceUsage(deps.db, space);
    if (isSpaceFull(usage)) return { kind: "space_full", space, usage };
  }
  if (!deps.limiters.upload.consumeMany(userId, toCopy)) return { kind: "upload_rate_limited" };

  // S14：callback 整段就是 `copyNoteInTx(tx, …)`，引數是交易前備好的純資料（`copiedFileIds` 是 out 參數）與測試縫。
  const copiedFileIds: string[] = [];
  const txInput = { sourceId, userId, scope, copy, uploadsDir: deps.uploadsDir, copiedFileIds, searchExtract, lockTimeoutMs: deps.storageLockTimeoutMs };
  let created;
  try {
    created = await deps.db.transaction(tx => copyNoteInTx(tx, txInput, deps.groupTestHook, deps.noteCreateHooks, deps.searchIndexHooks));
  } catch (err) {
    // 交易已 rollback（uploads 列不在了；配額被拒時列根本還沒寫）：best-effort 刪掉已落盤的新檔，失敗只記 log。
    await deleteUploadFiles(deps.uploadsDir, copiedFileIds, deps.log);
    // `TxAbort` 含子類 `StorageQuotaExceeded`：原樣交給呼叫端，由呼叫端先判子類（反序會失去數字）。
    if (err instanceof TxAbort) return { kind: "aborted", err };
    if (isForeignKeyViolation(err)) {
      // 防禦縱深：群組目標在 (g) 已持 groups KEY SHARE，群組在交易中刪不掉，INSERT 不會撞 FK 23503；撞到也回同一條 404。
      if ("groupId" in scope) return { kind: "group_not_found" };
      // 個人目標唯一可能的 23503 是 notes.owner_id／uploads.uploader_id → users（複製者帳號在交易中被硬刪；`src/` 目前
      // 沒有這條路徑）。個人建立路徑沒有對應的錯誤形（它把 23503 一律當群組被刪），這裡不借用 `group_not_found`
      // （詞不對題，review r1 M-3），回通用 404 `not_found`——對已不存在的帳號而言，「找不到」是最不誤導的答案。
      return { kind: "fk_personal" };
    }
    // 儲存配額 §6.9：空間鎖逾時（55P03）／死結（40P01）／40001 → 409 server_busy（已複製的檔已在上面清掉）。
    if (isRetryableTxError(err)) return { kind: "busy" };
    throw err;
  }
  await syncLinksFromDoc({ db: deps.db, log: deps.log }, { sourceNoteId: created.note.id, userId, doc: copy.doc, clock: docClock(copy.doc) });
  return { kind: "copied", note: created.note, target: created.target };
}
