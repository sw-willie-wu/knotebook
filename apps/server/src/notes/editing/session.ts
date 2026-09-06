// D3（寫入機制）：AI 的編輯一律在 live doc 的 fork 上做，最後只把「fork 相對於 fork 當下狀態向量的
// 差異」合併回 live doc——所以合併期間別人打的字不會被整份覆蓋掉，兩邊的編輯都活著。
// `EditorSession` 負責 fork 上的那半段（mount 進 jsdom 才有 by-id 操作，見 runtime.ts）；
// `withDirectConnection` 是**唯一**開直連的地方，且只為「把 diff 合併回去」而開，開完立刻關。
// ⚠ `openDirectConnection` 繞過 `onAuthenticate`（它不是一條 WebSocket 連線），因此這裡沒有任何
// 授權檢查——呼叫端（路由層）必須自己先確認呼叫者對這篇筆記有寫入權限。
// `disconnect()` 就是落盤點（`onStoreDocument` 立刻把文件寫回 DB）：一定要 disconnect，否則改動
// 根本沒落地；但 `fn` 必須全有全無——中途 throw 時 yjs 已套用的部分 op 不會撤銷，一樣會被落盤。
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { Document, Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { YDOC_FRAGMENT, createHeadlessNoteSchema } from "@knotebook/shared";
import type { CollabContext } from "../../collab/server.js";
import type { EditingRuntime, SessionLease } from "./runtime.js";

export function forkFrom(source: Y.Doc | Uint8Array): { fork: Y.Doc; sv: Uint8Array } {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, source instanceof Y.Doc ? Y.encodeStateAsUpdate(source) : source);
  return { fork, sv: Y.encodeStateVector(fork) };
}

// 不變量（m3）：呼叫端一律 `try { … } finally { session.close() }`——`close()` 是唯一會釋放
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
      editor.mount(document.createElement("div")); // 未 mount 是空文件（spike）；detached div 即可
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
  source: "ai-edit";
  tokenId: string | null;
  agentLabel: string | null;
  applied: boolean;
}

/** 唯一開直連的地方，只為合併開；fn 在單一同步 transact 內；一定 disconnect（＝落盤點）。
 * `fn` 的原始錯誤優先於 disconnect 的錯誤（m4）：disconnect 失敗只 log，不取代 fn 丟出的錯誤，
 * 否則 Task 4 的錯誤分類會拿到錯的 error（例如把「AI 內容不合法」誤判成「落盤失敗」）。 */
export async function withDirectConnection<T>(
  hocuspocus: Hocuspocus<CollabContext>,
  noteId: string,
  ctx: DirectCtx,
  fn: (doc: Document) => T
): Promise<T> {
  const direct = await hocuspocus.openDirectConnection(noteId, ctx);
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
