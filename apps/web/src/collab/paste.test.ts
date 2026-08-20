import { describe, expect, it, vi } from "vitest";
import { createMarkdownPasteHandler, decideMarkdownPaste, looksLikeMarkdownSource } from "./paste";

/** 只實作 `decideMarkdownPaste` 會摸到的那幾個 DataTransfer 成員。 */
function clipboard(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

const MD_CRLF = "# 標題\r\n\r\n- 一\r\n- 二\r\n\r\n```bash\r\nls\r\n```\r\n";
const MD_LF = "# 標題\n\n- 一\n- 二\n\n```bash\nls\n```\n";

describe("looksLikeMarkdownSource", () => {
  it.each([
    ["標題", "# 標題"],
    ["清單（單項也算）", "- 一"],
    ["星號清單", "* 一"],
    ["編號清單", "1. 一"],
    ["程式碼圍籬", "```bash\nls\n```"],
    ["引用", "> 一句"],
    ["表格列", "| a | b |"],
    ["前面有縮排的標題", "  ## 標題"],
  ])("行首標記：%s → 是 markdown 原始碼", (_name, src) => {
    expect(looksLikeMarkdownSource(src)).toBe(true);
  });

  it.each([
    ["普通段落", "就是一段普通文字。"],
    ["只有行內標記的段落", "這段有 **粗體** 和 `code` 還有 [連結](https://example.com)"],
    ["網頁清單複製出來的純文字（沒有標記）", "第一項\n第二項\n第三項"],
    ["數學或程式片段裡的井號", "x = 1 # 註解"],
  ])("沒有行首標記：%s → 不是 markdown 原始碼", (_name, src) => {
    expect(looksLikeMarkdownSource(src)).toBe(false);
  });
});

describe("decideMarkdownPaste", () => {
  it("純 text/plain：交給我們解析，且換行正規化成 LF", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": MD_CRLF }), false)).toBe(MD_LF);
  });

  it("text/markdown：同樣接手並正規化", () => {
    expect(decideMarkdownPaste(clipboard({ "text/markdown": MD_CRLF, "text/plain": "略" }), false)).toBe(MD_LF);
  });

  /**
   * 審查實測：`text/markdown` 在 BlockNote 的優先序**高於** `text/html`，所以交回去
   * 之後它會拿未正規化的 markdown 去解析，HTML 根本不會被看——交回去毫無好處，
   * 只是把剛修好的東西還回去。有明確的 markdown flavour 就一律接手。
   */
  it("text/markdown ＋ text/html 並存：仍然接手（BlockNote 本來就會選 markdown，只是不正規化）", () => {
    const data = clipboard({ "text/markdown": MD_CRLF, "text/html": "<p>hi</p>", "text/plain": "略" });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  /**
   * 從瀏覽器複製一律會同時帶 `text/html`。BlockNote 預設的 `prioritizeMarkdownOverHTML`
   * 會在處理 HTML **之前**先看純文字像不像 markdown，像就拿去解析——所以交回去等於
   * 讓未正規化的 CRLF 走進同一個壞掉的解析器（審查實測 GitHub raw 那種形狀會踩到）。
   */
  it("text/html ＋ 看起來是 markdown 原始碼的純文字：接手並正規化", () => {
    const data = clipboard({ "text/html": "<pre>…</pre>", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it("text/html ＋ 沒有行首標記的純文字：不接手，讓 HTML 那條路正常帶格式進來", () => {
    const data = clipboard({ "text/html": "<ul><li>第一項</li></ul>", "text/plain": "第一項\r\n第二項" });

    expect(decideMarkdownPaste(data, false)).toBeNull();
  });

  it("VS Code 複製 markdown 檔（mode=markdown，同時帶 text/html）：接手", () => {
    const data = clipboard({
      "vscode-editor-data": JSON.stringify({ mode: "markdown" }),
      "text/html": "<div style='color:#000'>…</div>",
      "text/plain": MD_CRLF,
    });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it.each(["md", "mdx"])("VS Code 的其他 markdown 家族 mode（%s）同樣接手", (mode) => {
    const data = clipboard({ "vscode-editor-data": JSON.stringify({ mode }), "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it("VS Code 複製程式碼（mode=python）：不接手，維持 BlockNote 的程式碼區塊行為", () => {
    const data = clipboard({ "vscode-editor-data": JSON.stringify({ mode: "python" }), "text/plain": "print(1)\r\n" });

    expect(decideMarkdownPaste(data, false)).toBeNull();
  });

  /**
   * BlockNote 的 `handleVSCodePaste` 對 `vscode-editor-data` 是無防護的 `JSON.parse`
   * ——解不出來就拋，而事件在外層早已 `preventDefault`，使用者會得到「貼上完全沒
   * 反應」。這裡當它不存在、照一般規則走，至少內容進得去。
   */
  it("vscode-editor-data 不是合法 JSON：當它不存在，照一般規則接手且不拋錯", () => {
    const data = clipboard({ "vscode-editor-data": "{壞掉的", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it("剪貼簿帶 blocknote/html（站內複製）：不接手", () => {
    const data = clipboard({ "blocknote/html": "<p>hi</p>", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBeNull();
  });

  it("游標在程式碼區塊內：不接手——在那裡貼上本來就該是純文字", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": MD_CRLF }), true)).toBeNull();
  });

  it("空的純文字：不接手", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": "" }), false)).toBeNull();
  });

  /**
   * 純空白會讓 `markdownToHTML` 回空字串，`pasteHTML` 隨即早退——什麼都沒貼進去
   * 也沒有任何回饋。從 VS Code 複製空行/縮排時原本會得到一個程式碼區塊，接手後
   * 反而變成無事發生，所以純空白一律交回去。
   */
  it.each(["   ", "\r\n\r\n", "\t"])("只有空白（%o）：不接手，避免貼上靜默無事發生", (source) => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": source }), false)).toBeNull();
    expect(
      decideMarkdownPaste(clipboard({ "vscode-editor-data": JSON.stringify({ mode: "markdown" }), "text/plain": source }), false),
    ).toBeNull();
  });

  it("沒有 clipboardData：不接手，也不能拋錯", () => {
    expect(decideMarkdownPaste(null, false)).toBeNull();
  });
});

describe("createMarkdownPasteHandler", () => {
  function fakeEditor({ inCodeBlock = false, throwOnTransact = false } = {}) {
    return {
      pasteMarkdown: vi.fn(),
      transact: vi.fn(<T,>(callback: (tr: never) => T): T => {
        if (throwOnTransact) throw new Error("boom");
        // ProseMirror 的 `$from`／`$to` 是 ResolvedPos，區塊節點要再取 `.parent`。
        const resolved = { parent: { type: { spec: { code: inCodeBlock } } } };
        return callback({ selection: { $from: resolved, $to: resolved } } as never);
      }),
    };
  }

  function pasteEvent(data: Record<string, string>): ClipboardEvent {
    return { clipboardData: clipboard(data) } as unknown as ClipboardEvent;
  }

  it("接手時呼叫 pasteMarkdown（正規化後的內容）並回報已處理，不再走預設流程", () => {
    const editor = fakeEditor();
    const defaultPasteHandler = vi.fn(() => true);

    const handled = createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": MD_CRLF }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(editor.pasteMarkdown).toHaveBeenCalledWith(MD_LF);
    expect(defaultPasteHandler).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });

  it("不接手時原封不動交給 BlockNote 的預設流程", () => {
    const editor = fakeEditor();
    const defaultPasteHandler = vi.fn(() => true);

    const handled = createMarkdownPasteHandler()({
      event: pasteEvent({ "blocknote/html": "<p>hi</p>", "text/plain": "hi" }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(editor.pasteMarkdown).not.toHaveBeenCalled();
    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(handled).toBe(true);
  });

  it("游標在程式碼區塊內：交給預設流程（BlockNote 會貼純文字）", () => {
    const editor = fakeEditor({ inCodeBlock: true });
    const defaultPasteHandler = vi.fn(() => true);

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": MD_CRLF }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(editor.pasteMarkdown).not.toHaveBeenCalled();
    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
  });

  /**
   * BlockNote 的外掛在呼叫本 handler **之前**就 `preventDefault()` 了，所以只要我們
   * 這裡拋錯，使用者的貼上就是「按了完全沒反應」。任何意外一律退回預設流程。
   */
  it("讀取編輯器狀態時拋錯：吞掉並退回預設流程，不讓貼上靜默失效", () => {
    const editor = fakeEditor({ throwOnTransact: true });
    const defaultPasteHandler = vi.fn(() => true);

    const handled = createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": MD_CRLF }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(handled).toBe(true);
  });
});
