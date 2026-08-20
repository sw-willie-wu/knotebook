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
 * ⚠ **交回 `defaultPasteHandler()` 不等於「走 HTML 那條路」**（審查實測糾正過一次）：
 * BlockNote 的預設流程 `prioritizeMarkdownOverHTML` 是 true，會在處理 `text/html`
 * **之前**先看純文字像不像 markdown，像就直接拿去解析；而 `text/markdown` 的優先序
 * 本來就高於 `text/html`。所以「有 HTML 就交回去」會讓未正規化的 CRLF 走進同一個
 * 壞掉的解析器。判斷因此改成看**內容**（有沒有行首的 markdown 標記）而不是看格式。
 *
 * 反過來，真正該交回去的是：站內複製（`blocknote/html`）、檔案、VS Code 貼非 markdown
 * 的語言、游標在程式碼區塊裡、以及「有 HTML 且純文字沒有 markdown 行首標記」——最後
 * 這種就是從網頁複製排版內容，HTML 才是真正的格式來源。
 */

/** VS Code 的 `mode` 屬於這些語言時，我們把內容當 markdown 解析而不是包成程式碼區塊。
 *
 * `mode` 是 VS Code 的 languageId（審查反編譯 VS Code bundle 確認過），`.md` 給的是
 * `markdown`。`md` 實務上不會出現（那是副檔名），`mdx` 只有裝了 MDX 擴充才有——兩者
 * 留著不會有壞處。已知**不在**這裡而仍會變成程式碼區塊的：`quarto`／`rmd`／`mdc`，
 * 以及沒有語言關聯時的 `plaintext`。 */
const MARKDOWN_LANGUAGE_MODES = new Set(["markdown", "md", "mdx"]);

/** 這些格式一出現就代表「有比純文字更好的來源」，一律讓 BlockNote 自己處理。 */
const ALWAYS_DELEGATE_TYPES = ["blocknote/html", "Files"];

/**
 * markdown **文件**的結構性證據。門檻刻意訂得比「出現一個行首標記」高很多，因為審查
 * 用真剪貼簿實測發現：只要一個標記就接手的話，**從文件網站複製程式碼片段會被我們
 * 攔走並改壞**——`# 註解` 開頭的 shell／Dockerfile／YAML 在剪貼簿上是
 * `<pre><code>` ＋逐字純文字，接手後註解變成 `<h1>`、縮排被收掉；`- old` / `+ new`
 * 的 diff 會被吃成清單；純文字帶 `- ` 而 HTML 帶連結粗體的段落會被丟掉格式。
 * 那一組「我們與 BlockNote 判斷不同」的輸入，恰好就是「HTML 才是更好來源」的那組。
 *
 * 所以這裡要求的是**成對／成組**的結構，單獨一行標記一律不算：
 * - 標題後空一行再接內容（單獨一行 `# 標題` 或緊接指令的註解都不算）
 * - 連續兩個**同符號**的清單項（`- a` 接 `+ b` 是 diff 不是清單）
 * - 連續兩個同樣分隔符的編號項
 * - **成對閉合**的程式碼圍籬
 * - 表格的分隔列（`| --- |`）
 *
 * 這個門檻只用在「剪貼簿同時有 HTML」的情況；純文字貼上沒有更好的來源可退，不需要
 * 過這一關。BlockNote 自己的 `isMarkdown` 形狀相近（也是要求成對結構），但**它是
 * MPL-2.0 不能抄進本專案**，這裡是獨立寫的。
 */
const MARKDOWN_STRUCTURE_PATTERNS = [
  /^ {0,3}#{1,6} \S[^\n]*\n[ \t]*\n[ \t]*\S/m, // 標題 → 空行 → 內容
  /^ {0,3}([-*+]) \S[^\n]*\n {0,3}\1 \S/m, // 連續兩個同符號清單項
  /^ {0,3}\d+([.)]) \S[^\n]*\n {0,3}\d+\1 \S/m, // 連續兩個同分隔符編號項
  /^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?\n {0,3}\1/m, // 成對閉合的圍籬
  /^ {0,3}\|?[ :]*-{3,}[ :]*\|/m, // 表格分隔列
];

/** 這段文字有 markdown **文件**的結構（而不是碰巧含有標記字元的程式碼或一般文字）嗎？ */
export function hasMarkdownStructure(text: string): boolean {
  return MARKDOWN_STRUCTURE_PATTERNS.some((pattern) => pattern.test(text));
}

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
  if (ALWAYS_DELEGATE_TYPES.some((type) => types.includes(type))) return null;

  const explicitMarkdown = data.getData("text/markdown");
  const source = normalizeLineEndings(explicitMarkdown || data.getData("text/plain"));

  // 純空白會讓 `markdownToHTML` 回空字串、`pasteHTML` 隨即早退——貼上會變成
  // 「什麼都沒發生也沒有回饋」。交回去至少維持既有行為。
  if (source.trim() === "") return null;

  // VS Code 的 markdown、以及對方明確標了 `text/markdown` 的，都不必再看內容。
  // （`text/markdown` 的優先序本來就高於 `text/html`，交回去只會讓它拿未正規化的
  // 版本去解析。VS Code 設 `mode` 時必定同時附 `text/html`，所以這個例外是必要的。）
  if (mode !== null || explicitMarkdown) return source;

  // 只剩「純文字」與「純文字＋HTML」兩種。後者有更好的來源可以退，所以門檻拉高到
  // 「有 markdown 文件的結構」；純文字沒得退，維持 BlockNote 原本就會做的解析。
  if (types.includes("text/html") && !hasMarkdownStructure(source)) return null;

  return source;
}

/**
 * 本模組需要的最小 editor 介面（測試用假物件即可滿足）。
 *
 * ⚠ callback 的參數**必須**寫成 ProseMirror `Transaction` 結構上滿足的形狀，不能圖省事
 * 寫 `never`：參數位置是逆變的，寫 `never` 會讓真正的 `BlockNoteEditor` 反而不能指派
 * 給這個介面，於是 `withCollaboration<Options extends Partial<BlockNoteEditorOptions>>`
 * 的推論退化成約束本身（`Partial<…>`），回傳型別上的 `collaboration` 等欄位整個消失
 * ——錯誤還會冒在別的檔案（呼叫端的測試）而不是這裡。
 */
interface PasteResolvedPos {
  parent: { type: { spec: { code?: boolean } } };
}

interface PasteTransaction {
  selection: { $from: PasteResolvedPos; $to: PasteResolvedPos };
}

interface PasteTargetEditor {
  pasteMarkdown: (markdown: string) => void;
  transact: <T>(callback: (tr: PasteTransaction) => T) => T;
}

/**
 * 游標是否落在程式碼區塊內。判斷方式與 BlockNote 的預設流程逐字相同
 * （`$from` 與 `$to` 的 parent 都是 `spec.code`）——刻意不用
 * `getTextCursorPosition()`：那條路徑會把周邊四個區塊都轉成 BlockNote block
 * （`nodeToBlock` 有十幾個 throw 點，其中 `getNearestBlockPos` 的 fallback 註解
 * 還特別提到「用 collaboration plugin 時」），而本 handler 拋錯的代價是整個貼上
 * 靜默失效。
 */
function isCursorInCodeBlock(editor: PasteTargetEditor): boolean {
  return editor.transact(
    ({ selection }) => selection.$from.parent.type.spec.code === true && selection.$to.parent.type.spec.code === true,
  );
}

/**
 * 交給 BlockNote 的 `pasteHandler` 選項。回傳 `true` ＝已處理。
 *
 * ⚠ BlockNote 的外掛在呼叫本 handler **之前**就 `event.preventDefault()` 了，所以這裡
 * 任何未捕捉的例外都會讓使用者的貼上「按了完全沒反應」。整段包 try/catch，出任何
 * 意外一律退回預設流程。
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
    let markdown: string | null = null;
    try {
      markdown = decideMarkdownPaste(event.clipboardData, isCursorInCodeBlock(editor));
    } catch {
      markdown = null; // 判斷階段出任何意外都退回預設流程
    }

    // ⚠ `defaultPasteHandler()` 一定要在 try **外面**、而且只呼叫一次：它自己也可能拋
    // （BlockNote 對 `vscode-editor-data` 是無防護的 `JSON.parse`），包在 try 裡就會被
    // catch 再叫一次、同樣再拋一次，使用者得到「貼上完全沒反應」。
    if (markdown === null) return defaultPasteHandler();

    try {
      editor.pasteMarkdown(markdown);
    } catch {
      // 可能已經插入一部分了——這時**不能**再退回預設流程，否則會在半套內容上再貼
      // 一次變成重複內容。回報已處理，讓它停在這裡。
    }
    return true;
  };
}
