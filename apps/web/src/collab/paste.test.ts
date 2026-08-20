import { describe, expect, it, vi } from "vitest";
import { createMarkdownPasteHandler, decideMarkdownPaste } from "./paste";

/** 只實作 `decideMarkdownPaste` 會摸到的那幾個 DataTransfer 成員。 */
function clipboard(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

const MD_CRLF = "# 標題\r\n\r\n- 一\r\n- 二\r\n\r\n```bash\r\nls\r\n```\r\n";
const MD_LF = "# 標題\n\n- 一\n- 二\n\n```bash\nls\n```\n";

describe("decideMarkdownPaste", () => {
  it("純 text/plain：交給我們解析，且換行正規化成 LF", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": MD_CRLF }), false)).toBe(MD_LF);
  });

  it("text/markdown：同樣接手並正規化", () => {
    expect(decideMarkdownPaste(clipboard({ "text/markdown": MD_CRLF, "text/plain": "略" }), false)).toBe(MD_LF);
  });

  it("VS Code 複製 markdown 檔（mode=markdown）：接手，不讓它變成程式碼區塊", () => {
    const data = clipboard({ "vscode-editor-data": JSON.stringify({ mode: "markdown" }), "text/plain": MD_CRLF });

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
   * BlockNote 的 `handleVSCodePaste` 對 `vscode-editor-data` 是無防護的
   * `JSON.parse`——解不出來就拋，而事件在外層早已 `preventDefault`，使用者會得到
   * 「貼上完全沒反應」。所以這裡刻意當它不存在、照一般規則接手，至少內容進得去。
   */
  it("vscode-editor-data 不是合法 JSON：當它不存在，照一般規則接手且不拋錯", () => {
    const data = clipboard({ "vscode-editor-data": "{壞掉的", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it("剪貼簿帶 text/html：不接手（那份 HTML 通常才是真正的格式來源）", () => {
    const data = clipboard({ "text/html": "<p>hi</p>", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBeNull();
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

  it("沒有 clipboardData：不接手，也不能拋錯", () => {
    expect(decideMarkdownPaste(null, false)).toBeNull();
  });
});

describe("createMarkdownPasteHandler", () => {
  function fakeEditor(blockType: string) {
    return {
      pasteMarkdown: vi.fn(),
      getTextCursorPosition: () => ({ block: { type: blockType } }),
    };
  }

  it("接手時呼叫 pasteMarkdown（正規化後的內容）並回報已處理，不再走預設流程", () => {
    const editor = fakeEditor("paragraph");
    const defaultPasteHandler = vi.fn(() => true);
    const handler = createMarkdownPasteHandler();

    const handled = handler({
      event: { clipboardData: clipboard({ "text/plain": MD_CRLF }) } as unknown as ClipboardEvent,
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(editor.pasteMarkdown).toHaveBeenCalledWith(MD_LF);
    expect(defaultPasteHandler).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });

  it("不接手時原封不動交給 BlockNote 的預設流程", () => {
    const editor = fakeEditor("paragraph");
    const defaultPasteHandler = vi.fn(() => true);
    const handler = createMarkdownPasteHandler();

    const handled = handler({
      event: { clipboardData: clipboard({ "text/html": "<p>hi</p>", "text/plain": "hi" }) } as unknown as ClipboardEvent,
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(editor.pasteMarkdown).not.toHaveBeenCalled();
    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(handled).toBe(true);
  });

  it("游標在程式碼區塊內：交給預設流程（BlockNote 會貼純文字）", () => {
    const editor = fakeEditor("codeBlock");
    const defaultPasteHandler = vi.fn(() => true);
    const handler = createMarkdownPasteHandler();

    handler({
      event: { clipboardData: clipboard({ "text/plain": MD_CRLF }) } as unknown as ClipboardEvent,
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(editor.pasteMarkdown).not.toHaveBeenCalled();
    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
  });
});
