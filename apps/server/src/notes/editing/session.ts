// 寫入機制：AI 的編輯一律在 live doc 的 fork 上做，最後只把「fork 相對於 fork 當下狀態向量的
// 差異」合併回 live doc——所以合併期間別人打的字不會被整份覆蓋掉，兩邊的編輯都活著。
// `EditorSession` 負責 fork 上的那半段（mount 進 jsdom 才有 by-id 操作，見 runtime.ts）；
// `withDirectConnection` 是**唯一**開直連的地方，且只為「把 diff 合併回去」而開，開完立刻關。
// ⚠ `openDirectConnection` 繞過 `onAuthenticate`（它不是一條 WebSocket 連線），因此這裡沒有任何
// 授權檢查——呼叫端（路由層）必須自己先確認呼叫者對這篇筆記有寫入權限。
// `disconnect()` 就是落盤點（`onStoreDocument` 立刻把文件寫回 DB）：一定要 disconnect，否則改動
// 根本沒落地；但 `fn` 必須全有全無——中途 throw 時 yjs 已套用的部分 op 不會撤銷，一樣會被落盤。
// #181：授權之後筆記可能被移入垃圾桶，直連寫入的重確認統一在 `withDirectConnection`
// （記憶體刪除閘門＋DB 存活），不過 → `NoteGoneError`。開之前查一次：不替垃圾桶筆記把文件載回記憶體；
// 開之後再查一次：擋「開連線的那一刻剛好被移入」。前提是直連持有文件時 Hocuspocus 不 unload，移入的
// unload 輪詢會等到這次寫入落盤才 commit（由 `trash-direct-write.test.ts` 的 DW3 驗證）；剩下的窗口是
// unload 輪詢 5 s 逾時——寫入會落進垃圾桶裡的筆記，內容不丟（known-limitations）。
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { DirectConnection, Document, Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema } from "@knotebook/shared";
import type { CollabContext, CollabServer } from "../../collab/server.js";
import type { DbOrTx } from "../../db/tx.js";
import { noteIsLive } from "../service.js";
import type { EditingRuntime, SessionLease } from "./runtime.js";

/**
 * #398：`replaceBlocks(ids, blocks)` 的等價寫法——新 block 先插在舊的**最後一顆**後面、再刪掉舊的。結果的文件與插入的 block 相同。
 * 為什麼不直接 `replaceBlocks`：同一個交易裡換掉舊內容時，y-prosemirror 把新的段落「對上」舊的同型段落、在舊的 Y 文字上逐段套格式，
 * Yjs 每切一段都 `splice` 整個結構陣列——`x<br>`×4.9 萬的段落換成 `**b** _i_`×2.45 萬，主執行緒 12 秒；分兩步（先插、後刪）
 * y-prosemirror 兩次都只在兩端比對得上，0.85 秒。`blocks` 空＝只刪。
 * 為什麼插在最後一顆後面、不是第一顆前面：新內容的 Yjs 插入點（origin）落在舊段**裡面**。插在第一顆前面時，左鄰是上一段的
 * 最後一顆——瀏覽器同時在上一段末尾（目標段標題正前方）打的段落與它同一個插入點，合併後由 client id 決定先後，可能被排到新內容後面、
 * 悄悄搬進目標段。插在最後一顆後面，兩者插入點不同，使用者那段留在上一段；而有人在目標段最後一顆後面插東西，合併守衛
 * （`live-watch.ts` 的 insertedAfter）本來就算衝突。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組（同下）
export function replaceBlocksFresh(editor: BlockNoteEditor<any, any, any>, ids: string[], blocks: Parameters<BlockNoteEditor<any, any, any>["insertBlocks"]>[0]): { id: string }[] {
  const inserted = blocks.length === 0 ? [] : editor.insertBlocks(blocks, ids[ids.length - 1]!, "after");
  editor.removeBlocks(ids);
  return inserted;
}

export function forkFrom(source: Y.Doc | Uint8Array): { fork: Y.Doc; sv: Uint8Array } {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, source instanceof Y.Doc ? Y.encodeStateAsUpdate(source) : source);
  return { fork, sv: Y.encodeStateVector(fork) };
}

// 不變量：呼叫端一律 `try { … } finally { session.close() }`——`close()` 是唯一會釋放
// runtime lease 的路徑，漏呼叫等於永久佔用一個 in-flight 名額，可能讓 EditingRuntime 的延後
// 重建閘門永遠等不到「排空」而卡住後面所有 acquire()。
// ⚠ 同一族的第二條：**持有 lease 期間不得再 `open()`**（`acquire()` 不可重入，見 `runtime.ts` 檔頭）
// ——不需要任何洩漏就會死鎖，症狀是機率性的無訊息逾時。
export class EditorSession {
  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 apps/web 的 collab 測試）
    readonly editor: BlockNoteEditor<any, any, any>,
    private readonly fork: Y.Doc,
    private readonly lease: SessionLease
  ) {}

  static async open(runtime: EditingRuntime, fork: Y.Doc): Promise<EditorSession> {
    const lease = await runtime.acquire();
    try {
      const editor = BlockNoteEditor.create(
        withCollaboration({
          schema: createHeadlessNoteSchema(runtime.baseUrl),
          collaboration: { fragment: fork.getXmlFragment(YDOC_FRAGMENT), user: { name: "ai", color: "#7c3aed" } },
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上：createHeadlessNoteSchema 的三元組不上推到這裡
      ) as BlockNoteEditor<any, any, any>;
      editor.mount(document.createElement("div")); // 未 mount 是空文件；detached div 即可
      runtime.noteMount();
      return new EditorSession(editor, fork, lease);
    } catch (err) {
      lease.release();
      throw err;
    }
  }

  diffSince(sv: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.fork, sv);
  }

  close(): void {
    try {
      this.editor.unmount();
    } finally {
      this.lease.release();
    }
  }
}

export interface DirectCtx extends CollabContext {
  /** `ai-edit`＝AI／API 寫入與撤回；`version-apply`＝套用版本（不寫 note_ai_edits、不切版）。 */
  source: "ai-edit" | "version-apply";
  tokenId: string | null;
  agentLabel: string | null;
  applied: boolean;
}

/**
 * #269：轉換工作的直連 ctx——**不帶 `userId`**：`collab/server.ts` 的落款（`stampLastEdited`）與編輯者累積（`onChange`）
 * 都以「ctx 有沒有 string `userId`」為閘，因此不落款、不累積編輯者、不算最後活動；`collab/versions.ts` 的 `noteStored` 把它歸
 * 「其他（人）」分支（轉換後的狀態交給當時生效的自動切版規則）。
 */
export interface LinkConvertCtx {
  source: "link-convert";
  applied: boolean;
}

/** `withDirectConnection`／`mergeDiff` 吃的 ctx：AI／版本套用（帶 userId）或轉換工作（不帶）。以 `source` 判別。 */
export type DirectConnectionCtx = DirectCtx | LinkConvertCtx;

/** 直連寫入時筆記已不在或已在垃圾桶（或正被移入：記憶體閘門開著）。呼叫端映射成該路徑既有的 not_found。 */
export class NoteGoneError extends Error {
  override name = "NoteGoneError";
}

/** 直連寫入的對象：開直連用的 hocuspocus＋重確認的兩個判準（#181）。 */
export interface DirectTarget {
  hocuspocus: Hocuspocus<CollabContext>;
  isDeleting(noteId: string): boolean;
  noteIsLive(noteId: string): Promise<boolean>;
}

export function directTarget(collab: Pick<CollabServer, "hocuspocus" | "isDeleting">, db: DbOrTx): DirectTarget {
  return {
    hocuspocus: collab.hocuspocus,
    isDeleting: noteId => collab.isDeleting(noteId),
    noteIsLive: noteId => noteIsLive(db, noteId),
  };
}

async function goneNow(target: DirectTarget, noteId: string): Promise<boolean> {
  return target.isDeleting(noteId) || !(await target.noteIsLive(noteId));
}

async function disconnectQuietly(direct: DirectConnection): Promise<void> {
  try {
    await direct.disconnect();
  } catch (err) {
    console.error("withDirectConnection: disconnect after recheck failed", err);
  }
}

/** 唯一開直連的地方，只為合併開；fn 在單一同步 transact 內；一定 disconnect（＝落盤點）。
 * 開之前、開之後各重確認一次（`isDeleting`、`noteIsLive`），不過 → `NoteGoneError`（開之後的失敗先 disconnect，不 transact）。
 * `fn` 的原始錯誤優先於 disconnect 的錯誤：disconnect 失敗只 log，不取代 fn 丟出的錯誤，
 * 否則呼叫端的錯誤分類會拿到錯的 error（例如把「AI 內容不合法」誤判成「落盤失敗」）。
 * 版本歷史：`opts.beforeDisconnect` 在 transact **成功**之後、disconnect 之前 await，收到 `fn` 的回傳；
 * 它失敗只 log、不影響 disconnect 與回傳（套用的基底寫回失敗＝內容已套、基底未更新，可接受）。fn 失敗時不呼叫。 */
export async function withDirectConnection<T>(
  target: DirectTarget,
  noteId: string,
  ctx: DirectConnectionCtx,
  fn: (doc: Document) => T,
  opts?: { beforeDisconnect?: (result: T) => Promise<void>; afterOpen?: () => Promise<void> }
): Promise<T> {
  if (await goneNow(target, noteId)) throw new NoteGoneError();
  // Hocuspocus 的 context 型別是 CollabContext（`{ userId }`）；`LinkConvertCtx` 刻意沒有 userId（見上）。context 對 Hocuspocus 是不透明的。
  const direct = await target.hocuspocus.openDirectConnection(noteId, ctx as unknown as CollabContext);
  let gone: boolean;
  try {
    gone = await goneNow(target, noteId);
  } catch (err) {
    await disconnectQuietly(direct);
    throw err;
  }
  if (gone) {
    // Hocuspocus 4.5 的 `disconnect()` 沒有不落盤的選項：這裡會把未改的文件存一次（無害，同 `fn` 拒絕路徑）。
    await disconnectQuietly(direct);
    throw new NoteGoneError();
  }
  // 測試縫（`EditingTestHooks.afterOpenDirect`）：開了直連、重確認過、transact 之前——在這裡改文件的測試守 transact 內的那道比對。
  if (opts?.afterOpen) {
    try {
      await opts.afterOpen();
    } catch (err) {
      await disconnectQuietly(direct);
      throw err;
    }
  }
  let result!: T;
  let fnFailed = false;
  let fnError: unknown;
  try {
    await direct.transact(doc => {
      result = fn(doc);
    });
  } catch (err) {
    fnFailed = true;
    fnError = err;
  }
  if (!fnFailed && opts?.beforeDisconnect) {
    try {
      await opts.beforeDisconnect(result);
    } catch (bdErr) {
      console.error("withDirectConnection: beforeDisconnect failed", bdErr);
    }
  }
  // disconnect 一定只呼叫一次（＝落盤一次）；fn 有錯時 disconnect 的錯誤只 log，不能蓋過 fn 的錯誤。
  try {
    await direct.disconnect();
  } catch (disconnectErr) {
    if (!fnFailed) throw disconnectErr;
    console.error("withDirectConnection: disconnect after fn error failed", disconnectErr);
  }
  if (fnFailed) throw fnError;
  return result;
}
