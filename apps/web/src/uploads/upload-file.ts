import { MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { toast } from "@/components/ui/toast";
import type { EditorRef } from "@/components/wikilink/menu";

/**
 * 低階上傳呼叫（Task 10b `POST /api/notes/:id/uploads`，multipart 欄位 `file`）：
 * **可 reject**（`ApiFail`），呼叫端（{@link createUploadFile}）負責把它包成 BlockNote
 * 要的「絕不 reject」形狀。
 *
 * `noteId` 經 `encodeURIComponent`——`api/notes.ts`（`useNote`/`useBacklinks` 等）既有慣例。
 *
 * client 端前驗：檔案大小超過 `MAX_UPLOAD_BYTES` 時直接丟 `ApiFail(413, "file_too_large", …)`、
 * **不發請求**——大檔案沒必要先把整包 bytes 送到 server 才被拒絕；413 的 code 跟 server
 * 端 uploads 路由真的因為 `truncated` 而拒絕時完全一致，呼叫端（`createUploadFile`）不必
 * 分辨「是 client 前驗擋下還是 server 擋下」。
 */
export async function postUpload(noteId: string, file: File): Promise<{ id: string; url: string }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiFail(413, "file_too_large", "client-side precheck");
  }
  const fd = new FormData();
  fd.append("file", file);
  return api<{ id: string; url: string }>(`/api/notes/${encodeURIComponent(noteId)}/uploads`, {
    method: "POST",
    body: fd,
  });
}

/** 同一個錯誤 code 在這個時間窗內只 toast 一次（module 級，跨呼叫共享）。 */
const TOAST_DEDUPE_WINDOW_MS = 5000;
/** code → 上一次 toast 的時間戳。 */
const lastToastAtByCode = new Map<string, number>();

function codeOf(err: unknown): string {
  return err instanceof ApiFail ? err.code : "internal";
}

function toastOncePerCode(code: string, translate: (key: string) => string): void {
  const now = Date.now();
  const last = lastToastAtByCode.get(code);
  if (last !== undefined && now - last < TOAST_DEDUPE_WINDOW_MS) return;
  lastToastAtByCode.set(code, now);
  toast({ title: translate(`errors.${code}`) });
}

export interface CreateUploadFileOptions {
  noteId: string;
  /** late-bound 編輯器參照（同 `NoteEditor.tsx`/`wikilink/menu.ts` 的 `EditorRef`）——
   * `createUploadFile` 在 editor 建立之前就會被呼叫（掛進 `useCreateBlockNote` 的選項），
   * 失敗時清除 placeholder block 必須讀取「當下」的 editor 實例。 */
  editorRef: EditorRef;
  translate: (key: string) => string;
}

/**
 * 包成 BlockNote `editor.uploadFile` 要的形狀（**絕不 reject**）——`handleFileInsertion`
 * 對這個回傳的 promise 沒有任何 catch，reject 會變成未處理的 promise rejection，且會
 * 卡住它自己的 for 迴圈，後續要插入的檔案完全不會被處理。
 *
 * 契約（spec §12.4，逐字）：
 * - 成功：回傳 `url`（字串），交給 `handleFileInsertion` 塞進 block props。
 * - 失敗：
 *   1. `toastOncePerCode`——同一個錯誤 code 5 秒內只提示一次，文案 `errors.<code>`。
 *   2. **macrotask**（`setTimeout(…, 0)`，不是 microtask）清掉 placeholder block：
 *      `handleFileInsertion` 在 `await editor.uploadFile(...)` 之後緊接著同步呼叫
 *      `editor.updateBlock(insertedBlockId, ...)`（把 `url` 設回 block props）——那一行是
 *      當前 promise resolve 之後的**微任務續體**。若我們用 microtask 排清除，會搶在那
 *      個 `updateBlock` 之前執行，先刪了 block 之後 `updateBlock` 又對著一個已經不存在
 *      的 id 操作。用 macrotask 保證「先讓 `updateBlock` 跑完，才輪到我們清除」。
 *   3. 回傳空字串 sentinel（不 reject）——`handleFileInsertion` 會把它當成
 *      `props: { url: "" }` 設回 block，隨即被上面的 macrotask 移除，使用者只會瞬間
 *      看到一個空白 placeholder 閃一下，然後連著 block 一起消失。
 *
 * 清除時的兩個靜默失敗情形（不當例外拋出——`try { … } catch {}`）：
 * - 使用者在等待期間自己刪了這個 block（`getBlock(blockId)` 找不到）。
 * - `editorRef.current` 在這段等待期間變成 `null`（例如頁面已經卸載）。
 */
export function createUploadFile(
  opts: CreateUploadFileOptions,
): (file: File, blockId?: string) => Promise<string> {
  const { noteId, editorRef, translate } = opts;
  return async (file, blockId) => {
    try {
      const { url } = await postUpload(noteId, file);
      return url;
    } catch (err) {
      toastOncePerCode(codeOf(err), translate);
      setTimeout(() => {
        try {
          const ed = editorRef.current;
          if (blockId && ed && ed.getBlock(blockId)) {
            ed.removeBlocks([blockId]);
          }
        } catch {
          // block 已消失（或 editor 已卸載）等——靜默略過，不讓清理動作反過來炸掉呼叫端。
        }
      }, 0);
      return "";
    }
  };
}
