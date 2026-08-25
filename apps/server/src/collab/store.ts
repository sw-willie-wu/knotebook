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
import { and, desc, eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteStateBackups, noteStates, notes } from "../db/schema.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { crossesBucketBoundary, selectPrunable } from "./backup-policy.js";

/**
 * 文件目前的「邏輯時鐘」——`Y.decodeStateVector(Y.encodeStateVector(doc))` 各 client
 * 的 seq 值總和。**定於本檔、`collab/server.ts` 只 import 用**：反過來（server.ts 定義、
 * store.ts import）會形成循環 import（store.ts 已被 server.ts import）。
 *
 * 單調不減：state vector 的每個 entry 只會隨編輯遞增，`Y.applyUpdate` 合併不同 client
 * 的狀態時逐 entry 取兩者較大值，GC（`Y.encodeStateAsUpdate` → `applyUpdate` 往返）不影響
 * state vector——因此這個總和可以拿來當「wikilink 索引是否已涵蓋此次編輯」的判定基準
 * （`onLoadDocument` 尾端的 `notes.links_clock` 鉗制、以及 `CollabServer.linkSyncState`）。
 */
export function docClock(doc: Y.Doc): number {
  let total = 0;
  for (const seq of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) {
    total += seq;
  }
  return total;
}

export interface StoreLogger {
  warn(obj: object, msg: string): void;
}

/** {@link collectUnsafeUrlFindings} 的一筆發現：哪種 block、什麼 scheme（不含 URL 本體）。 */
export interface UnsafeUrlFinding {
  block: string;
  scheme: string;
}

/**
 * issue #44 的最小步：掃描共編文件裡「`url` 屬性帶著非 http(s) scheme」的節點。
 *
 * **只偵測、不改寫、不拒收**——server 對 Y.Doc 內容的驗證是 spec 級取捨（要不要讓
 * server 理解 BlockNote 結構、拒收語意、client 呈現…），這裡刻意不碰：render 端（#12）
 * 與 export 端（#43）已讓這種 URL 到處都吃不到 sink，殘餘風險是「髒資料留存」；本掃描
 * 讓自架者至少**知道**文件裡有這種東西（配 log 一行），而不是永遠無感。
 *
 * 為了不與 BlockNote schema 綁定，判斷刻意極窄：只看名為 `url` 的屬性（四個檔案類
 * block 存放媒體網址的欄位；caption/name 等文字欄位可能含冒號，掃它們會誤報）、只把
 * 「能被 `new URL` 解析出**非** http(s) scheme」的值當發現——相對網址（自家上傳的
 * `/api/uploads/<id>`）parse 不出、http(s) 放行，兩者都與 web 端 `isSafeMediaUrl` 的
 * 白名單一致（副作用：`about:`/`blob:` 也會被列為發現——#43 匯出替代值 `about:blank`
 * 被貼回文件時會警告一次，屬可接受的訊號而非誤報）。屬性值**不限字串**：敵意 client
 * 可以直接寫任意 Yjs 可編碼的值（例如陣列），`new URL` 的 ToString 會攤平它們——
 * `typeof` 守衛反而讓這一類逃過掃描（審查指出）。scheme 記進發現（URL parser 已把它
 * 限制在 `[a-z0-9+.-]`，可安全進 log），URL 本體**不**記——那是攻擊者控制的內容，
 * 不給它進日誌的機會。
 *
 * ⚠ 走訪**必須是迭代**（顯式 stack）：巢狀深度是攻擊者可控的（深 5000 的
 * blockContainer 鏈只是一個 125KB 的 update，yjs 自己的 encode/apply 都撐得住），
 * 遞迴版在 vitest worker 的這個深度就 RangeError（bare Node 主執行緒的門檻更高一些，
 * 但攻擊者把鏈加深就是了——任何環境都有炸點）——而 onStoreDocument 拋錯會讓
 * Hocuspocus 把文件永久 pin 在記憶體、備份停擺（`maybeBackup` 註解描述的同一個
 * 失效形）。呼叫端另有 try/catch 兜底（見 onStoreDocument），但這裡先天就不該炸。
 *
 * 已知不掃的範疇：`Y.XmlHook`（Y.Map 形狀）與 `Y.XmlText` 內嵌內容底下都不深入
 * ——走訪只展開 XmlElement/XmlFragment 的子節點；BlockNote 的真實媒體形狀用不到
 * 那兩種嵌法，log-only 的最小步不追。
 */

/** 進 log 的 block 名上限——`nodeName` 與 URL 一樣是 client 寫進 Y.Doc 的任意字串，
 * 不封頂等於讓單行日誌的長度由攻擊者決定（比照 `collab/server.ts` 對 client 提供的
 * noteId 做的同款截斷）。 */
const LOGGED_BLOCK_NAME_MAX = 64;

export function collectUnsafeUrlFindings(doc: Y.Doc): UnsafeUrlFinding[] {
  const findings: UnsafeUrlFinding[] = [];
  const stack: unknown[] = [doc.getXmlFragment(YDOC_FRAGMENT)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node instanceof Y.XmlElement) {
      const url: unknown = node.getAttribute("url");
      if (url != null && url !== "") {
        let parsed: URL | null;
        try {
          parsed = new URL(url as string); // URL 建構子自帶 ToString——非字串值一併涵蓋
        } catch {
          parsed = null; // 相對網址／非 URL：web 端渲染時會以頁面為 base 解析成 http(s)，安全範疇
        }
        if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          findings.push({ block: node.nodeName.slice(0, LOGGED_BLOCK_NAME_MAX), scheme: parsed.protocol.slice(0, 32) });
        }
      }
      for (const child of node.toArray()) stack.push(child);
    } else if (node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) stack.push(child);
    }
  }
  return findings;
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
  // issue #44：這個 noteId 在本次載入週期內已警告過「文件含危險 scheme 的 url」——
  // onStoreDocument 每 2s debounce 就來一次，不設閘的話一篇被污染的筆記能以近乎固定
  // 頻率灌日誌（正是 #50 那類形狀）。每篇筆記每個載入週期最多一行；unload 時清掉，
  // 下次載入若還在就再警告一次（自架者重啟 process 也會再看到，訊號不會永久消失）。
  const warnedUnsafeUrl = new Set<string>();

  function forgetNote(noteId: string): void {
    svCache.delete(noteId);
    lastBackupAtCache.delete(noteId);
    warnedUnsafeUrl.delete(noteId);
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

    // links_clock 鉗制：載入當下的 doc clock 是「wikilink 索引最多可能涵蓋到」的上界。
    // ① 主因：note_links 交易是立即 commit 的，但產生該 clock 的 Y.Doc 內容要等
    //   `onStoreDocument`（debounce 2s/max 10s）才真正落盤——若 process 在這個窗口內被
    //   砍掉、且沒有 client 回填同一份編輯，重載時 doc 只能還原到「上次落盤」的舊狀態，
    //   其 clock 會低於已經 commit 的 links_clock，導致 `>=` 閘門（Task 5/9 判斷「是否
    //   需要重新索引」的比較）永遠鎖死——鉗制在載入當下把 links_clock 夾回 doc 現況，
    //   解除這個鎖死。② 雙保險配對：還原（restore）runbook（spec §4 決策 2）在同一個
    //   交易內把 links_clock 重置為 0，兩者一起保證 links_clock 不會卡在「比 doc 實際
    //   內容更新」的狀態。`LEAST` 是唯一需要的方向：links_clock 若已經 ≤ 這個上界
    //   （索引器正常運作、追得上或落後的常態）就不動它，不會反過來把落後的索引進度
    //   提前拉高。
    await db
      .update(notes)
      .set({ linksClock: sql`LEAST(${notes.linksClock}, ${docClock(doc)})` })
      .where(eq(notes.id, noteId));

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

    // issue #44 最小步：只記錄、不改寫、不拒收（完整理由見 collectUnsafeUrlFindings）。
    // 放在 maybeBackup **之後**且整段 try/catch：這是純診斷，任何一種失敗都不得
    // 影響落盤/備份，更不得拋出 onStoreDocument——那會讓 Hocuspocus 把文件永久 pin
    // 在記憶體（見 maybeBackup 的同型註解）。已警告過就跳過掃描；乾淨的筆記（常態）
    // 仍是每次 store 走一次樹——成本與上面本來就有的 encodeStateAsUpdate 同量級，
    // 可接受（審查核實過遞迴深度是唯一的真風險，已由迭代版排除）。
    if (!warnedUnsafeUrl.has(noteId)) {
      try {
        const findings = collectUnsafeUrlFindings(doc);
        if (findings.length > 0) {
          warnedUnsafeUrl.add(noteId);
          // distinct 清單也封頂（前 10 個 + 總數）：block 名是 client 寫進 Y.Doc 的任意
          // 字串，200 個各異的名字就是 200 個陣列元素——單行大小不得由攻擊者決定
          // （每個元素本身已由 LOGGED_BLOCK_NAME_MAX 截斷）。
          const schemes = [...new Set(findings.map(f => f.scheme))];
          const blocks = [...new Set(findings.map(f => f.block))];
          log.warn(
            {
              noteId,
              findings: findings.length,
              schemes: schemes.slice(0, 10),
              schemesTotal: schemes.length,
              blocks: blocks.slice(0, 10),
              blocksTotal: blocks.length,
            },
            "筆記內容含非 http(s) scheme 的媒體 URL（僅記錄；渲染與匯出端各有守衛，此處不改寫文件）"
          );
        }
      } catch (err) {
        // 掃描自己出錯也只記一次（進 warned 集合擋重複），絕不外拋；連這裡的 log 也
        // 兜住——logger 拋錯逃出 onStoreDocument 一樣會 pin 文件。
        warnedUnsafeUrl.add(noteId);
        try {
          log.warn({ err, noteId }, "危險 URL 掃描失敗（忽略，不影響落盤/備份）");
        } catch {
          /* logger 自己炸：無處可記，僅止損 */
        }
      }
    }
  }

  return { onLoadDocument, onStoreDocument, afterUnloadDocument: forgetNote };
}
