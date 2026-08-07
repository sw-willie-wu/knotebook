import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { wikilinkSpec } from "@/components/wikilink/spec";

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

/**
 * 本專案的 BlockNote schema：預設 block 全套**扣掉 image**，inline content 全套
 * **加上** `wikilink`（Plan 3）。
 *
 * ⚠ `BlockNoteSchema.create` 傳入 `inlineContentSpecs` 是**整組覆寫**，不是「疊加在
 * 預設值上」——`BlockNoteSchema.create` 本體只有在完全不傳這個欄位時才會落回
 * `defaultInlineContentSpecs`。這裡漏了 `...defaultInlineContentSpecs` 的 spread，
 * 會靜默毀掉 `text`/`link` 兩個預設 inline spec（連最基本的文字輸入都會壞掉，且不會
 * 有任何型別錯誤提示）。
 */
export const noteSchema = BlockNoteSchema.create({
  blockSpecs: blockSpecsWithoutImage,
  inlineContentSpecs: { ...defaultInlineContentSpecs, wikilink: wikilinkSpec },
});

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

/** {@link classifyMediaTransfer} 攔下這次貼上／拖放的原因；`null`＝放行。 */
export type BlockedTransferReason = "dataUrl" | "textRepresentation" | "nonImageFile";

/**
 * `containsMediaDataUrl` 掃描的四種文字格式（§12.4 規則①）。刻意**不含**
 * `vscode-editor-data`——那個管線只用 `text/plain` 造 code block，本身不會帶媒體
 * data URL，掃了也是白掃。
 */
const MEDIA_DATA_URL_TEXT_FORMATS = ["text/html", "text/plain", "text/markdown", "blocknote/html"] as const;

/**
 * BlockNote 內部 `acceptedMIMETypes`（`@blocknote/core/src/api/clipboard/fromClipboard/acceptedMIMETypes.ts`）
 * 的前五種——該常數未從套件公開匯出，這裡按規則②需要的子集重寫一份（不含殿後的
 * `"Files"`，那個交給下面的 `hasFiles` 另外判斷）。
 *
 * ⚠ 失效模式：這是手抄本，不是 import。BlockNote 升版異動 `acceptedMIMETypes`
 * （增減格式、調整順序）時，這裡不會有任何測試變紅——規則②會靜默跟上游脫節，
 * 直到有人手動比對兩邊才會發現。該常數不在套件的公開 exports map 裡，寫不出
 * import 型的 parity 測試來守住這條同步關係；升級 `@blocknote/core` 版本時記得
 * 回頭比對這份原始碼路徑。
 */
const TEXT_REPRESENTATION_MIME_TYPES = [
  "vscode-editor-data",
  "blocknote/html",
  "text/markdown",
  "text/html",
  "text/plain",
] as const;

/**
 * 這次貼上／拖放該不該被攔下來、為什麼（§12.4）。四條規則依序判斷，第一條命中
 * 就回傳，全部不匹配則放行（`null`）：
 *
 * ① `text/html`／`text/plain`／`text/markdown`／`blocknote/html` 任一含媒體 data
 *    URL → `"dataUrl"`——從別的網頁複製圖片時，剪貼簿常常只有 HTML 而沒有 file
 *    entry；即使有 file entry，內嵌 data URL 一樣會讓 BlockNote 把它塞進 block
 *    props（bytea 膨脹的源頭），所以這條的優先權在檔案判斷之前。
 * ② 帶 `File` 且 `dataTransfer.types` 含 `TEXT_REPRESENTATION_MIME_TYPES` 任一
 *    → `"textRepresentation"`——這種形狀代表來源本身還帶了一份可用的文字/HTML
 *    表示法（例如編輯器內部拖曳、或來源網頁的一般 `<img src="https://…">`），
 *    BlockNote 的 `handleFileInsertion` 一旦偵測到這些格式排在 `"Files"` 前面就會
 *    直接放棄檔案插入路徑；我們沿用同一個判準，統一攔下引導使用者改用檔案本身。
 * ③ `files` 非空且全部 `File.type` 以 `image/` 開頭（空字串＝非 image）→ 放行
 *    （`null`）——純圖片檔案的貼上／拖放本身不會產生 data URL，交給後續
 *    `uploadFile` 管線處理（Plan 3 Task 13/14）。
 * ④ 其餘含檔案的情形（任一非 image 檔）→ `"nonImageFile"`。
 *
 * 傳 `null`／`undefined`（某些合成事件沒有 dataTransfer）一律放行。
 */
export function classifyMediaTransfer(data: DataTransfer | null | undefined): BlockedTransferReason | null {
  if (!data) return null;

  // ①
  for (const format of MEDIA_DATA_URL_TEXT_FORMATS) {
    if (containsMediaDataUrl(data.getData(format))) return "dataUrl";
  }

  const files = data.files;
  const hasFiles = !!files && files.length > 0;
  if (!hasFiles) return null;

  // ②
  const types = Array.from(data.types ?? []);
  if (TEXT_REPRESENTATION_MIME_TYPES.some((mimeType) => types.includes(mimeType))) return "textRepresentation";

  // ③④
  const fileList = Array.from(files as unknown as ArrayLike<File>);
  const allImages = fileList.every((file) => file.type.startsWith("image/"));
  return allImages ? null : "nonImageFile";
}
