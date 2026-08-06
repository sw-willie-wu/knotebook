import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";

// spec §11.1（P2 圖片行為）逐字：上傳是 Plan 3 的範圍，P2 **不啟用 image block**，
// 並且**攔截並拒絕**圖片的貼上／拖放。理由不是 UI 潔癖而是儲存：BlockNote 沒有
// `uploadFile` 時會把貼進來的圖片轉成 data URL 塞進 block props，那份 base64 會直接
// 進 Y.Doc → 經 `onStoreDocument` 灌爆 `note_states` 與分桶備份（§4 設計分桶正是為了
// 避免這類 bytea 膨脹）。
//
// 保留 `audio`/`video`/`file` 三個檔案類 block：本專案不設定 `uploadFile`，這些 block
// 只剩「輸入網址嵌入」一途，不會有位元組進 Y.Doc；且下方的 transfer 守衛對所有
// 檔案／媒體 data URL 一視同仁，不分型別。
const { image: _imageBlockSpecIntentionallyRemoved, ...blockSpecsWithoutImage } = defaultBlockSpecs;

/** 本專案的 BlockNote schema：預設 block 全套**扣掉 image**。 */
export const noteSchema = BlockNoteSchema.create({ blockSpecs: blockSpecsWithoutImage });

export type NoteSchema = typeof noteSchema;

/**
 * 媒體 data URL 偵測。只認 `image`/`video`/`audio` 三種 MIME 大類——一般文字裡出現
 * 「data:」字樣（例如在講解程式碼）不該被誤擋。前綴 `(?:^|[\s"'(=])` 讓它同時吃得到
 * 純文字貼上與 HTML 片段裡的 `src="data:image/png;base64,…"`。
 */
const MEDIA_DATA_URL_RE = /(?:^|[\s"'(=])data:(?:image|video|audio)\/[a-z0-9.+-]+[;,]/i;

export function containsMediaDataUrl(text: string | null | undefined): boolean {
  return typeof text === "string" && MEDIA_DATA_URL_RE.test(text);
}

/**
 * 這次貼上／拖放該不該被攔下來（§11.1）。兩條判準：
 * 1. `dataTransfer.files` 非空——任何檔案（截圖貼上、拖曳圖片檔）一律擋。
 * 2. `text/html` 或 `text/plain` 裡含媒體 data URL——從別的網頁複製圖片時，剪貼簿
 *    常常只有 HTML 而沒有 file entry。
 *
 * 傳 `null`（某些合成事件沒有 dataTransfer）一律放行。
 */
export function isBlockedMediaTransfer(data: DataTransfer | null | undefined): boolean {
  if (!data) return false;
  if (data.files && data.files.length > 0) return true;
  return containsMediaDataUrl(data.getData("text/html")) || containsMediaDataUrl(data.getData("text/plain"));
}
