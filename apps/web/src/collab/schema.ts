import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { CODE_BLOCK_OPTIONS } from "@/lib/code-highlight";
import { mermaidSpec } from "@/components/mermaid/spec";
import { wikilinkSpec } from "@/components/wikilink/spec";
import { safeMediaUrl } from "@/lib/media-url";

// spec §11.1（P2 圖片行為）曾經逐字：上傳是 Plan 3 的範圍，P2 **不啟用 image
// block**，並且**攔截並拒絕**圖片的貼上／拖放。理由不是 UI 潔癖而是儲存：BlockNote
// 沒有 `uploadFile` 時會把貼進來的圖片轉成 data URL 塞進 block props，那份 base64
// 會直接進 Y.Doc → 經 `onStoreDocument` 灌爆 `note_states` 與分桶備份（§4 設計分桶
// 正是為了避免這類 bytea 膨脹）。
//
// Plan 3 Task 14 起這段已經**不成立**：image block 恢復啟用，`NoteEditor.tsx` 的
// `buildNoteEditorOptions` 掛了 `uploadFile`（Task 13 `createUploadFile`），純圖片
// 檔案的貼上／拖放改走「先上傳、拿到 url 才寫回 block props」這條路，不會再有 base64
// 進 Y.Doc。
//
// 下面 `classifyMediaTransfer` 的媒體 data URL 攔截**依然需要**：它擋的是「來源本身
// 就是 data URL、沒有真正的 `File`」這種形狀（例如從網頁複製圖片，剪貼簿只給
// HTML/文字表示法），這種情形完全繞過 `uploadFile` 管線，一旦放行一樣會把 base64 塞進
// block props。`audio`/`video`/`file` 三個檔案類 block 沒有自家 Upload tab（本專案的
// FilePanel 只給 image 掛 Upload tab，見 `components/FilePanel.tsx`），只剩「輸入
// 網址嵌入」一途，同樣不會有位元組進 Y.Doc；下方的 transfer 守衛因此對所有檔案／
// 媒體 data URL 一視同仁，不分型別。

/**
 * issue #43：檔案類 block 的 `toExternalHTML` 套上與渲染端相同的媒體 URL 守衛。
 *
 * #12 把 `safeMediaUrl` 掛在 `resolveFileUrl` 上，但那個鉤子只在 **render** 路徑；
 * `toExternalHTML`（BlockNote 內建的剪貼簿複製／dragstart 的 `text/html`，以及
 * `blocksToMarkdownLossy` 的 markdown 匯出——`AiSession.tsx` 用它把選取內容送給 AI）
 * 拿的是 raw `props.url`，`@blocknote/core` 0.52.1 的 audio／file／image／video 四個
 * `toExternalHTML` 都直接 `el.src = props.url` 或 `a.href = props.url`。複製一個被
 * 污染的 block 貼到別的應用程式，帶過去的就是 `<a href="javascript:…">`——不是本
 * 應用程式頁面上的 XSS（那條 #12 已堵住），但屬於「把惡意內容帶出應用程式」。
 *
 * 修法：不重寫四個 spec 的 DOM 產生邏輯，只在委派給原實作之前把 `props.url` 換成
 * `safeMediaUrl(url)`（危險 scheme → `about:blank`，相對網址與 http(s) 原樣放行，
 * 空字串走 BlockNote 自己的 placeholder 路徑——判斷規則與理由見 `lib/media-url.ts`）。
 * 這樣上游改版 `toExternalHTML` 的輸出形狀（caption 包 figure、showPreview 分支…）
 * 都自動跟上，我們只擁有「URL 必須先過守衛」這一件事。
 */
/** 本函式唯一需要碰的結構：`implementation.toExternalHTML` 與 block 的 `props.url`。
 * 四型 block 的 propSchema 泛型各不相同（image/video 多 showPreview 等），把它們
 * 收斂到共同具名型別做不到——比照 repo 慣例，BlockNote 泛型三元組的位置用 `any`。 */
type FileBlockSpecLike = {
  implementation: {
    // `this` 也必須是 `any`：真實簽名的 `this` 是 `Partial<{ blockContentDOMAttributes… }>`，
    // 函式型別對 `this` 逆變，寫 `unknown` 反而不相容。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例，同 wikilink/menu.ts）
    toExternalHTML?: (this: any, block: any, ...rest: any[]) => unknown;
  };
};

function withGuardedExternalHTML<Spec extends FileBlockSpecLike>(spec: Spec): Spec {
  const original = spec.implementation.toExternalHTML;
  // 型別上 toExternalHTML 是 optional，這裡的 early return 純粹為了收斂型別——四個
  // 檔案類 spec 實際上都有它（0.52.1 核實）。真被上游拿掉時 schema.test.ts 的守衛
  // 測試也不會靜默失守：`BlockNoteSchema.create` 會以 `render` 合成 fallback，raw url
  // 直接進 `img.src`，危險 scheme 的斷言當場紅。
  if (!original) return spec;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // ⚠ `this` 必須**原樣轉發**（`.call(this, …)`）：`BlockNoteSchema.create` 重包
      // spec 時是以 `{ blockContentDOMAttributes, propSchema }` 為 `this` 呼叫
      // `implementation.toExternalHTML`（0.52.1 `createSpec.ts` 核實），裸呼叫會在
      // 讀 `this.blockContentDOMAttributes` 時 TypeError。誠實揭露：在 0.52.1，四個
      // 檔案類 block **自己的** toExternalHTML 不讀這兩個成員（讀它們的是委派沿途的
      // `createBlockSpec` 包裝層，且 `propSchema` 另有 fallback），所以轉發別的
      // 物件目前行為相同、也沒有測試分得出差異——選忠實轉發是防上游改版，不是被
      // 觀察到的行為差異。`...rest` 一樣原樣轉發，上游加參數也不會被吃掉。
      //
      // 為什麼在**委派之前**換掉 `props.url`（而不是拿回傳的 DOM 再改）：把 props 吐成
      // `data-*` 屬性（`data-url`）的 `wrapInBlockStructure` 就在被委派的原實作**裡面**
      // （`createBlockSpec` 回傳的 toExternalHTML，0.52.1 核實）——先換 props 再進去，
      // `src`/`href` 與 `data-url` 才會一起是消毒後的值。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上，BlockNote 泛型三元組
      toExternalHTML(this: unknown, block: any, ...rest: any[]) {
        return original.call(
          this,
          { ...block, props: { ...block.props, url: safeMediaUrl(block.props.url) } },
          ...rest,
        );
      },
    },
  } as Spec;
}

/**
 * 本專案的 BlockNote schema：預設 block **全套**（Plan 3 Task 14 起含 image；
 * audio／file／image／video 四個檔案類 block 的 `toExternalHTML` 套上 #43 的 URL
 * 守衛，見上方 `withGuardedExternalHTML`），inline content 全套**加上** `wikilink`
 * （Plan 3）。
 *
 * ⚠ `BlockNoteSchema.create` 傳入 `inlineContentSpecs` 是**整組覆寫**，不是「疊加在
 * 預設值上」——`BlockNoteSchema.create` 本體只有在完全不傳這個欄位時才會落回
 * `defaultInlineContentSpecs`。這裡漏了 `...defaultInlineContentSpecs` 的 spread，
 * 會靜默毀掉 `text`/`link` 兩個預設 inline spec（連最基本的文字輸入都會壞掉，且不會
 * 有任何型別錯誤提示）。
 */
export const noteSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    audio: withGuardedExternalHTML(defaultBlockSpecs.audio),
    file: withGuardedExternalHTML(defaultBlockSpecs.file),
    image: withGuardedExternalHTML(defaultBlockSpecs.image),
    video: withGuardedExternalHTML(defaultBlockSpecs.video),
    // issue #94：mermaid 圖表 block。⚠ `createReactBlockSpec` 回傳的是 **factory**
    // （與 `createReactInlineContentSpec` 不同，後者直接回傳 spec）——這裡的括號不能少。
    mermaid: mermaidSpec(),
    // issue #96：codeBlock 換成帶語法上色選項的版本。`defaultBlockSpecs.codeBlock` 是
    // `createCodeBlockSpec()` 不帶參數的產物（supportedLanguages 空物件＝語言下拉沒有
    // 東西、無 createHighlighter＝不上色）——選項封在 spec 閉包裡，**沒有** editor 層
    // 的 `codeBlock` 選項可以事後補（已對 0.52.1 dist 核實），唯一接線點就是這裡。
    codeBlock: createCodeBlockSpec(CODE_BLOCK_OPTIONS),
  },
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
