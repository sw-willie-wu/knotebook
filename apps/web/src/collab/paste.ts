/**
 * 貼上 markdown 的自訂處理（issues #27／#28）。
 *
 * BlockNote 0.52 預設**已經**會把純文字當 markdown 解析，但在 Windows 上有兩個實測
 * 到的破口，這支 handler 就是補這兩個：
 *
 * 1. **CRLF 不被解析**（#28）：`pasteMarkdown` → `markdownToHTML` 不正規化行尾。
 *    同一份內容用 LF 進去會得到 `<ul><li>`／`<pre><code>`，用 CRLF 進去清單變成
 *    `<p>- …</p>`、圍籬變成字面上的 ```` ```bash ````（標題不受影響，因為它的規則
 *    不依賴行尾）。Windows 剪貼簿的 `text/plain` 一律是 CRLF，所以幾乎必踩。
 *    BlockNote 自己的 `handleVSCodePaste` 有做這個正規化，一般路徑沒有。
 * 2. **從 VS Code 貼 markdown 會變成程式碼區塊**（#27）：VS Code 會附一個私有格式
 *    `vscode-editor-data`（含 `{"mode":"<語言 id>"}`），而它在 BlockNote 的格式
 *    優先序裡排第一，命中後整份會被包成 `<pre><code class="language-markdown">`。
 *    對貼 Python 是對的，對貼 markdown 不是使用者要的。
 *
 * 其餘情況一律原封不動交回 `defaultPasteHandler()`——**刻意不重寫 BlockNote 的整套
 * 優先序**：帶 `text/html` 的貼上（從網頁複製）那份 HTML 才是真正的格式來源，站內
 * 複製的 `blocknote/html`、檔案、非 markdown 的 VS Code 內容也都該走原本的路。
 */

/** VS Code 的 `mode` 屬於這些語言時，我們把內容當 markdown 解析而不是包成程式碼區塊。 */
const MARKDOWN_LANGUAGE_MODES = new Set(["markdown", "md", "mdx"]);

/** 這些格式一出現就代表「有比純文字更好的來源」，讓 BlockNote 自己處理。 */
const RICHER_SOURCE_TYPES = ["blocknote/html", "text/html", "Files"];

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function vscodeMode(data: DataTransfer): string | null {
  const raw = data.getData("vscode-editor-data");
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const mode = (parsed as { mode?: unknown } | null)?.mode;
    return typeof mode === "string" ? mode : null;
  } catch {
    // VS Code 以外的來源也可能塞這個 key，解不出來就當它不存在。
    return null;
  }
}

/**
 * 這次貼上要不要由我們當 markdown 解析？要的話回傳**已正規化行尾**的來源文字，
 * 不要的話回傳 `null`（呼叫端交給 BlockNote 的預設流程）。
 *
 * @param isInCodeBlock 游標是否在程式碼區塊內——在那裡貼上本來就該是純文字。
 */
export function decideMarkdownPaste(data: DataTransfer | null, isInCodeBlock: boolean): string | null {
  if (!data || isInCodeBlock) return null;

  const mode = vscodeMode(data);
  if (mode !== null && !MARKDOWN_LANGUAGE_MODES.has(mode)) return null; // 例如 python：維持程式碼區塊

  const types = Array.from(data.types ?? []);
  // VS Code 的 markdown 例外於此規則之上：它同時帶 text/html 也仍然要當 markdown。
  if (mode === null && RICHER_SOURCE_TYPES.some((type) => types.includes(type))) return null;

  const source = data.getData("text/markdown") || data.getData("text/plain");
  if (!source) return null;

  return normalizeLineEndings(source);
}

/** `decideMarkdownPaste` 需要的最小 editor 介面（測試用假物件即可滿足）。 */
interface PasteTargetEditor {
  pasteMarkdown: (markdown: string) => void;
  getTextCursorPosition: () => { block: { type: string } };
}

/**
 * 交給 BlockNote 的 `pasteHandler` 選項。回傳 `true` ＝已處理。
 */
export function createMarkdownPasteHandler() {
  return ({
    event,
    editor,
    defaultPasteHandler,
  }: {
    event: ClipboardEvent;
    editor: PasteTargetEditor;
    defaultPasteHandler: () => boolean | undefined;
  }): boolean | undefined => {
    const isInCodeBlock = editor.getTextCursorPosition().block.type === "codeBlock";
    const markdown = decideMarkdownPaste(event.clipboardData, isInCodeBlock);

    if (markdown === null) return defaultPasteHandler();

    editor.pasteMarkdown(markdown);
    return true;
  };
}
