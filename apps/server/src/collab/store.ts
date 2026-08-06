/**
 * `note_states`/`note_state_backups` 的唯一寫入者：Hocuspocus 的 `onLoadDocument` /
 * `onStoreDocument` hook 實作（掛進 `collab/server.ts` 的 Hocuspocus 設定）。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 硬規則（brief §4/§6/N10，逐字）
 * ──────────────────────────────────────────────────────────────────────────
 * - store 時筆記已不存在（DB 查無 `notes` 對應列）→ 丟棄該次寫入：不 insert、不拋錯、
 *   不復活資料列。這是 Task 6 `beforeNoteDeleted` 賴以成立的前提——它會吞掉錯誤讓
 *   DELETE 交易照跑，真正保證「刪除中 pending store 不復活」的是本檔這條規則。
 * - `note_states` 樂觀鎖：`UPDATE ... WHERE version = <剛讀出的值>`；衝突（UPDATE 命中
 *   0 列）先重讀一次——若那時連 row 都查不到了，代表筆記在這段極短窗口內被刪除，一樣
 *   丟棄；若 row 還在（只是 version 被別的東西動過），本 process 是 `note_states` 的
 *   唯一寫入者，重讀後直接覆寫並 `log.warn`（不必真的重試——我們自己就是權威來源）。
 * - 備份：跨過 15 分桶邊界（`backup-policy.crossesBucketBoundary`）**且**
 *   `Y.encodeStateVector(doc)` 與快取不同才寫 `note_state_backups`；pruning
 *  （`backup-policy.selectPrunable`）在同一次寫入內順帶做掉（N10）。
 */
import { and, desc, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "../db/index.js";
import { noteStateBackups, noteStates } from "../db/schema.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { crossesBucketBoundary, selectPrunable } from "./backup-policy.js";

export interface StoreLogger {
  warn(obj: object, msg: string): void;
}

const noopLogger: StoreLogger = { warn: () => {} };

export interface NoteStoreDeps {
  db: Db;
  log?: StoreLogger;
  /**
   * 測試注入：覆寫「現在時刻」，決定要不要跨桶備份／寫進 `note_state_backups.createdAt`。
   * production 一律用真 `Date`（未傳時的預設）。真實的 15 分桶邊界在測試裡等不到，
   * 「跨桶但內容未變」這條規則因此只能靠這個注入點直接呼叫本模組驗證（見
   * `test/collab-store.test.ts`），不透過即時協作的 WebSocket 往返。
   */
  now?: () => Date;
}

export interface NoteStore {
  /**
   * Hocuspocus `onLoadDocument`：回傳目前持久化的 ydoc update（無既有 row 時回傳
   * `undefined`，讓文件從空白狀態開始——Hocuspocus 對 `undefined` 不會套用任何內容）。
   * 同時以「載入當下」的 doc 內容初始化 sv 快取與（從 `note_state_backups` 查來的）
   * 上次備份時間快取。
   */
  onLoadDocument(noteId: string, doc: Y.Doc): Promise<Uint8Array | undefined>;
  /** Hocuspocus `onStoreDocument`：寫回 `note_states`，視情況（跨桶且內容有變）追加一筆備份並 prune。 */
  onStoreDocument(noteId: string, doc: Y.Doc): Promise<void>;
  /**
   * Hocuspocus `afterUnloadDocument`：文件從記憶體卸載時清掉這個 noteId 的 sv／
   * lastBackupAt 快取，否則每篇曾經打開過的筆記都會在 process 存活期間永久占一個
   * Map entry（fix round 1 IMPORTANT 2）。安全：下一次 `onLoadDocument` 會重新以
   * DB 現況重新初始化這兩個快取，清掉不影響正確性。
   */
  afterUnloadDocument(noteId: string): void;
}

function svEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createNoteStore(deps: NoteStoreDeps): NoteStore {
  const db = deps.db;
  const log = deps.log ?? noopLogger;
  const now = deps.now ?? ((): Date => new Date());

  // 「上次備份時的 state vector」——onLoadDocument 時以現 doc（已套用 note_states 內容
  // 後）的狀態初始化；之後每次真的寫了一筆備份就更新。key 消失（unset）等同「未知」，
  // 下一次 store 時 `svCache.get(noteId)` 回傳 `undefined`，與任何 sv 都不相等，效果是
  // 「不知道就當作有變」——不會漏備份，頂多多備份一次。
  const svCache = new Map<string, Uint8Array>();
  // 「上次備份的時間」——同上時機初始化/更新；null 代表「從未備份過」。
  const lastBackupAtCache = new Map<string, Date | null>();

  function forgetNote(noteId: string): void {
    svCache.delete(noteId);
    lastBackupAtCache.delete(noteId);
  }

  async function onLoadDocument(noteId: string, doc: Y.Doc): Promise<Uint8Array | undefined> {
    const [row] = await db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);

    // sv 快取必須在「套用完既有持久化內容之後」的 doc 狀態上取——它代表的是「已知已落地
    // 的基準」，之後的編輯才會讓 sv 偏離這個基準，觸發下一次備份判斷。Hocuspocus 的
    // `loadDocument` 雖然會在 `onLoadDocument` 回傳 `Uint8Array` 時自動把它套用進真正的
    // document 物件（見 v4 原始碼），但那個套用發生在本函式回傳「之後」；為了讓下面立刻
    // 取用的 sv 快取正確反映套用後的狀態，這裡對傳入的 `doc`（同一個 Y.Doc 實例）先手動
    // 套用一次——兩邊套用同一份 update 是等冪的（CRDT），不會造成重複或不一致的狀態。
    if (row) {
      Y.applyUpdate(doc, row.ydoc);
    }
    svCache.set(noteId, Y.encodeStateVector(doc));

    const [backupRow] = await db
      .select({ createdAt: noteStateBackups.createdAt })
      .from(noteStateBackups)
      .where(eq(noteStateBackups.noteId, noteId))
      .orderBy(desc(noteStateBackups.createdAt))
      .limit(1);
    lastBackupAtCache.set(noteId, backupRow?.createdAt ?? null);

    return row?.ydoc;
  }

  /**
   * `note_states` 的樂觀鎖寫入。回傳 `false` 代表筆記已不存在（該次寫入被丟棄）。
   * `at`：一律用 `onStoreDocument` 讀到的同一個「現在時刻」（測試可注入），不在這裡
   * 另外呼叫 `new Date()`——與 `note_state_backups.createdAt`、backup-policy 的桶判斷
   * 共用同一個時間點，避免同一次 store 內部出現兩個不同的「現在」。
   */
  async function persistNoteState(noteId: string, ydocBuf: Buffer, at: Date): Promise<boolean> {
    const [existing] = await db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);

    if (!existing) {
      // 首次寫入：若筆記本身已不存在（刪除發生在 select 之後、insert 之前的窄窗，或
      // 從一開始就沒有這個 noteId），insert 會撞 `note_states.note_id` 的外鍵——接住並丟棄。
      try {
        await db.insert(noteStates).values({ noteId, ydoc: ydocBuf, version: 1, updatedAt: at });
        return true;
      } catch (err) {
        if (isForeignKeyViolation(err)) return false;
        throw err;
      }
    }

    const updated = await db
      .update(noteStates)
      .set({ ydoc: ydocBuf, version: existing.version + 1, updatedAt: at })
      .where(and(eq(noteStates.noteId, noteId), eq(noteStates.version, existing.version)))
      .returning({ noteId: noteStates.noteId });
    if (updated.length > 0) return true;

    // UPDATE 命中 0 列：可能是版本被動過（衝突），也可能是這段時間筆記被整筆刪除
    // （cascade 把 row 也帶走了）——重讀一次才分得清楚，兩者的 WHERE 命中結果相同。
    const [reread] = await db.select({ version: noteStates.version }).from(noteStates).where(eq(noteStates.noteId, noteId)).limit(1);
    if (!reread) return false; // 筆記已刪除：丟棄，絕不復活資料列

    // row 還在，只是 version 對不上：本 process 是 note_states 的唯一寫入者，沒有第二個
    // 寫入源頭可信，直接覆寫（不重試比對版本）並記一筆警告供事後追查。
    log.warn({ noteId, readVersion: existing.version, currentVersion: reread.version }, "note_states 樂觀鎖衝突，重讀後覆寫");
    await db
      .update(noteStates)
      .set({ ydoc: ydocBuf, version: reread.version + 1, updatedAt: at })
      .where(eq(noteStates.noteId, noteId));
    return true;
  }

  async function maybeBackup(noteId: string, doc: Y.Doc, at: Date): Promise<void> {
    const lastBackupAt = lastBackupAtCache.get(noteId) ?? null;
    if (!crossesBucketBoundary(lastBackupAt, at)) return;

    const sv = Y.encodeStateVector(doc);
    const cachedSv = svCache.get(noteId);
    if (cachedSv && svEqual(cachedSv, sv)) return;

    const ydocBuf = Buffer.from(Y.encodeStateAsUpdate(doc));
    // fix round 1 IMPORTANT 1：note_states 的 UPDATE 成功之後、這筆 insert 之前，筆記仍
    // 可能在極窄窗口內被刪除（cascade 把 note_states 帶走，但這個 backup insert 撞的是
    // 它自己的外鍵）。不接住的話這個例外會被 Hocuspocus 的 `storeDocumentHooks` 吞掉、
    // 但文件因此被**刻意**留在記憶體裡「避免資料遺失」（v4 原始碼原文），0 連線也不會
    // 有人再觸發下一次 store 來重試——等於永久卡住這份文件。比照 `persistNoteState`
    // 的首次 insert，一樣用 `isForeignKeyViolation` 接住並丟棄。
    try {
      await db.insert(noteStateBackups).values({ noteId, ydoc: ydocBuf, createdAt: at });
    } catch (err) {
      if (isForeignKeyViolation(err)) return;
      throw err;
    }
    svCache.set(noteId, sv);
    lastBackupAtCache.set(noteId, at);

    // N10：pruning 於寫備份時順帶——重查該 note 目前所有備份的時間戳，讓 backup-policy
    // 決定哪些該刪，再依原始 Date 物件的參照同一性反查對應的 id 刪除。
    const rows = await db.select({ id: noteStateBackups.id, createdAt: noteStateBackups.createdAt }).from(noteStateBackups).where(eq(noteStateBackups.noteId, noteId));
    const timestamps = rows.map(r => r.createdAt);
    const prunable = new Set(selectPrunable(timestamps, at));
    const prunableIds = rows.filter(r => prunable.has(r.createdAt)).map(r => r.id);
    for (const id of prunableIds) {
      await db.delete(noteStateBackups).where(eq(noteStateBackups.id, id));
    }
  }

  async function onStoreDocument(noteId: string, doc: Y.Doc): Promise<void> {
    const at = now();
    const ydocBuf = Buffer.from(Y.encodeStateAsUpdate(doc));

    const exists = await persistNoteState(noteId, ydocBuf, at);
    if (!exists) {
      forgetNote(noteId);
      return;
    }

    await maybeBackup(noteId, doc, at);
  }

  return { onLoadDocument, onStoreDocument, afterUnloadDocument: forgetNote };
}
