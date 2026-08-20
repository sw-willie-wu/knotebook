import { describe, expect, it, vi } from "vitest";
import { createMarkdownPasteHandler, decideMarkdownPaste, hasMarkdownStructure } from "./paste";

/** 只實作 `decideMarkdownPaste` 會摸到的那幾個 DataTransfer 成員。 */
function clipboard(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

const MD_CRLF = "# 標題\r\n\r\n- 一\r\n- 二\r\n\r\n```bash\r\nls\r\n```\r\n";
const MD_LF = "# 標題\n\n- 一\n- 二\n\n```bash\nls\n```\n";

describe("hasMarkdownStructure", () => {
  it.each([
    ["標題後空行再接內容", "# 標題\n\n一段內文"],
    ["連續兩個同符號清單項", "- 一\n- 二"],
    ["連續兩個編號項", "1. 一\n2. 二"],
    ["成對的程式碼圍籬", "```bash\nls\n```"],
    ["表格分隔列", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ])("結構性證據：%s → 是 markdown 文件", (_name, src) => {
    expect(hasMarkdownStructure(src)).toBe(true);
  });

  /**
   * 這一組全部是審查用真剪貼簿量到的**回歸案例**：它們的 `text/html` 是
   * `<pre><code>`／帶連結粗體的段落，才是更好的來源。判斷若只要求「出現一個行首
   * 標記」，這些都會被我們接手，程式碼會被改壞、連結與粗體會被靜默丟掉。
   */
  it.each([
    ["shell 註解後直接接指令", "# install deps\nnpm install foo"],
    ["Dockerfile 註解", "# build stage\nFROM node:22"],
    ["YAML 只有單一 `- ` 項", "services:\n  - name: web\n    image: nginx"],
    ["diff 片段（`-` 與 `+` 不同符號）", "- old line\n+ new line"],
    ["段落裡只有一個清單項", "- see the docs for details\n\nand more bold text"],
    ["未閉合的圍籬", "```bash\nls"],
    ["單獨一行標題", "# 標題"],
    ["普通段落", "就是一段普通文字。"],
    ["行內標記但沒有結構", "這段有 **粗體** 和 `code` 還有 [連結](https://example.com)"],
    ["郵件引用", "> 引用一句\n> 第二句"],
  ])("不足以判定：%s → 不是 markdown 文件", (_name, src) => {
    expect(hasMarkdownStructure(src)).toBe(false);
  });
});

describe("decideMarkdownPaste", () => {
  it("純 text/plain：交給我們解析，且換行正規化成 LF", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": MD_CRLF }), false)).toBe(MD_LF);
  });

  it("純 text/plain 即使沒有結構性證據也接手（沒有 HTML 可以退，行為與 BlockNote 相同只是多了正規化）", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": "# install deps\r\nnpm install foo" }), false)).toBe(
      "# install deps\nnpm install foo",
    );
  });

  it("text/markdown：同樣接手並正規化", () => {
    expect(decideMarkdownPaste(clipboard({ "text/markdown": MD_CRLF, "text/plain": "略" }), false)).toBe(MD_LF);
  });

  it("text/markdown ＋ text/html 並存：仍然接手（BlockNote 本來就會選 markdown，只是不正規化）", () => {
    const data = clipboard({ "text/markdown": MD_CRLF, "text/html": "<p>hi</p>", "text/plain": "略" });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  /**
   * 結構判斷必須跑在**正規化之後**的文字上。順序反了的話，Windows 剪貼簿那種
   * `## 標題\r\n\r\n內容` 因為「空行」其實是 `\r\n\r\n` 而過不了「真空行」那條規則，
   * 於是被交回去、又落回 CRLF 解析——正是 #28 本身。
   */
  it("結構判斷跑在正規化之後：CRLF 的『標題＋空行＋內容』仍算數", () => {
    const data = clipboard({ "text/html": "<pre>…</pre>", "text/plain": "## Install\r\n\r\nRun npm i." });

    expect(decideMarkdownPaste(data, false)).toBe("## Install\n\nRun npm i.");
  });

  it("text/html ＋ 有結構性證據的 markdown 原始碼（例如從 raw 頁面複製整份文件）：接手並正規化", () => {
    const data = clipboard({ "text/html": "<pre>…</pre>", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it.each([
    ["文件網站的 shell 片段", "# install deps\r\nnpm install foo", "<pre><code>…</code></pre>"],
    ["diff 片段", "- old line\r\n+ new line", "<pre><code>…</code></pre>"],
    ["帶連結與粗體的段落", "- see the docs for details\r\n\r\nand more bold text", '<p>- see the <a href="https://x">docs</a></p>'],
  ])("text/html ＋ 沒有結構性證據（%s）：不接手，讓 HTML 那條路保住格式", (_name, plain, html) => {
    expect(decideMarkdownPaste(clipboard({ "text/html": html, "text/plain": plain }), false)).toBeNull();
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

  it("vscode-editor-data 不是合法 JSON：當它不存在，照一般規則走且不拋錯", () => {
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
  function fakeEditor({ inCodeBlock = false, throwOnTransact = false, throwOnPaste = false } = {}) {
    return {
      pasteMarkdown: vi.fn(() => {
        if (throwOnPaste) throw new Error("paste boom");
      }),
      transact: vi.fn(<T,>(callback: (tr: never) => T): T => {
        if (throwOnTransact) throw new Error("transact boom");
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

  it("判斷階段拋錯：退回預設流程", () => {
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

  /**
   * `defaultPasteHandler` 自己也可能拋（BlockNote 對 `vscode-editor-data` 是無防護的
   * `JSON.parse`）。它**只能被呼叫一次**：呼叫第二次的話，同樣的輸入會同樣拋出去，
   * 使用者得到的是「貼上完全沒反應」。
   */
  it("預設流程自己拋錯：不重複呼叫它（重試只會再拋一次）", () => {
    const editor = fakeEditor();
    const defaultPasteHandler = vi.fn(() => {
      throw new Error("default boom");
    });

    expect(() =>
      createMarkdownPasteHandler()({
        event: pasteEvent({ "text/html": "<pre>x</pre>", "text/plain": "# install deps\nnpm i" }),
        editor: editor as never,
        defaultPasteHandler,
      }),
    ).toThrow("default boom");
    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
  });

  /**
   * `pasteMarkdown` 可能拋在「已經插入一部分」之後。這時**不能**再退回預設流程——
   * 那會在半套內容上再貼一次，變成重複內容。
   */
  it("pasteMarkdown 拋錯：回報已處理，不再走預設流程（避免重複貼上）", () => {
    const editor = fakeEditor({ throwOnPaste: true });
    const defaultPasteHandler = vi.fn(() => true);

    const handled = createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": MD_CRLF }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(defaultPasteHandler).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });
});
