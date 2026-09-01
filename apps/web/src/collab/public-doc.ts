import * as Y from "yjs";

/**
 * 公開端點 `GET /api/public/notes/:token` 的 `ydoc`（base64 的 Yjs update）→ 新的
 * `Y.Doc`。空文件的合法編碼是 shared 的 `EMPTY_YDOC_UPDATE_B64`（`AAA=`）——server
 * 對從沒開過編輯器的筆記回這個值，`applyUpdate` 吃它不會 throw（零長度才會）。
 *
 * 壞掉的輸入（非 base64、毀損的 update）**刻意讓它 throw**：呼叫端（PublicNotePage
 * 的 render → PublicNoteErrorBoundary）接手顯示錯誤卡。靜默回空文件會把資料毀損
 * 渲染成一篇看似正常的「空筆記」。
 */
export function decodePublicYdoc(base64: string): Y.Doc {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}
