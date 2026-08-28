import { describe, expect, it, vi } from "vitest";
import { createMarkdownPasteHandler, decideMarkdownPaste, hasMarkdownStructure, isSingleCodeBlockHtml } from "./paste";

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

describe("isSingleCodeBlockHtml", () => {
  it("文件網站的程式碼區塊（pre > code）→ 是", () => {
    expect(isSingleCodeBlockHtml('<pre><code class="language-dockerfile"># syntax=1\n\nFROM node:22</code></pre>')).toBe(true);
  });

  it("Chrome 複製時前置的 meta 不影響判定", () => {
    expect(isSingleCodeBlockHtml('<meta charset="utf-8"><pre><code>FROM node:22</code></pre>')).toBe(true);
  });

  it("瀏覽器顯示純文字檔的裸 pre（raw .md 頁面）→ 不是", () => {
    expect(isSingleCodeBlockHtml('<pre style="white-space: pre-wrap"># 標題\n\n內文</pre>')).toBe(false);
  });

  it("程式碼區塊之外還有其他內容 → 不是（整份不是單一程式碼區塊）", () => {
    expect(isSingleCodeBlockHtml("<p>說明文字</p><pre><code>FROM node:22</code></pre>")).toBe(false);
  });

  it("一般段落 HTML → 不是", () => {
    expect(isSingleCodeBlockHtml('<p>- see the <a href="https://x">docs</a></p>')).toBe(false);
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

  /**
   * 從文件網站複製的程式碼片段：`# 註解` 後面接空行再接指令，在 markdown 眼裡就是
   * 「標題＋內容」（BlockNote 自己的判斷也是），於是會被解析成大標題。但剪貼簿的
   * HTML 已經明擺著是一個程式碼區塊——那才是使用者看到、也是他要的東西。
   */
  it("HTML 本身就是單一程式碼區塊：即使純文字有 markdown 結構也不接手", () => {
    const data = clipboard({
      "text/html": '<pre><code class="language-dockerfile"># syntax=docker/dockerfile:1\n\nFROM node:22</code></pre>',
      "text/plain": "# syntax=docker/dockerfile:1\r\n\r\nFROM node:22",
    });

    expect(decideMarkdownPaste(data, false)).toBeNull();
  });

  it("裸 pre（瀏覽器顯示的 raw .md 頁面）不算程式碼區塊：照結構判斷接手", () => {
    const data = clipboard({ "text/html": '<pre style="white-space: pre-wrap">…</pre>', "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
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

/** `fakeEditor` 用得到的 block 形狀（BlockNote 的真型別泛型太深）。 */
interface FakeBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
}

describe("createMarkdownPasteHandler", () => {
  /**
   * `documentAfterInsert` 是 issue #94 的關鍵：貼上**插完之後**文件長什麼樣。
   * 沒有它，`collectBlockIds(editor.document)` 會拋、`convertMermaid()` 靜默退化成 no-op
   * ——把 `paste.ts` 的兩個 `convertMermaid()` 呼叫整個刪掉，測試也不會紅（2026-08-28
   * 審查實測：兩個突變都存活）。
   */
  function fakeEditor({
    inCodeBlock = false,
    throwOnTransact = false,
    throwOnPaste = false,
    documentBefore = [] as FakeBlock[],
    documentAfterInsert = null as FakeBlock[] | null,
  } = {}) {
    const editor = {
      document: documentBefore,
      replaceBlocks: vi.fn(),
      pasteMarkdown: vi.fn(() => {
        if (throwOnPaste) throw new Error("paste boom");
        if (documentAfterInsert !== null) editor.document = documentAfterInsert;
      }),
      transact: vi.fn(<T,>(callback: (tr: never) => T): T => {
        if (throwOnTransact) throw new Error("transact boom");
        // ProseMirror 的 `$from`／`$to` 是 ResolvedPos，區塊節點要再取 `.parent`。
        const resolved = { parent: { type: { spec: { code: inCodeBlock } } } };
        return callback({ selection: { $from: resolved, $to: resolved } } as never);
      }),
    };
    return editor;
  }

  /** BlockNote 兩條貼上路徑產出的 mermaid code block 形狀。 */
  function mermaidCodeBlock(id: string, code: string): FakeBlock {
    return { id, type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: code }] };
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

  /**
   * 交回去的時候還要多說一句話：BlockNote 預設 `prioritizeMarkdownOverHTML` 是 true，
   * 純文字像 markdown 就會蓋過 HTML——那正是「文件網站的程式碼片段變成標題」的成因。
   * HTML 已經是一個程式碼區塊時，要明確要求它以 HTML 為準。
   */
  it("HTML 是單一程式碼區塊：交回去時要求 BlockNote 以 HTML 為準", () => {
    const editor = fakeEditor();
    const defaultPasteHandler = vi.fn(() => true);

    createMarkdownPasteHandler()({
      event: pasteEvent({
        "text/html": "<pre><code># syntax=1\n\nFROM node:22</code></pre>",
        "text/plain": "# syntax=1\r\n\r\nFROM node:22",
      }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(editor.pasteMarkdown).not.toHaveBeenCalled();
    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(defaultPasteHandler).toHaveBeenCalledWith({ prioritizeMarkdownOverHTML: false });
  });

  it("一般交回去（HTML 不是程式碼區塊）：不帶任何選項，維持 BlockNote 預設", () => {
    const editor = fakeEditor();
    const defaultPasteHandler = vi.fn(() => true);

    createMarkdownPasteHandler()({
      event: pasteEvent({ "blocknote/html": "<p>hi</p>", "text/plain": "hi" }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(defaultPasteHandler).toHaveBeenCalledWith(undefined);
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

  // ── issue #94：貼上的 ```mermaid 轉成圖 ─────────────────────────────────
  //
  // 兩條插入出口各有一個 `convertMermaid()`，**兩個都要有測試**：審查者實測把任一個刪掉，
  // 693 條全綠（e2e 也只覆蓋 markdown 那條）。預設流程那條正是 `docs/diagrams.md` 主打的
  // 情境——從 AI 對話／GitHub README 複製，剪貼簿同時帶 text/plain 與 text/html。

  it("markdown 路徑：這次插入的 ```mermaid code block 被轉成 mermaid block", () => {
    const editor = fakeEditor({
      documentBefore: [{ id: "old", type: "paragraph" }],
      documentAfterInsert: [{ id: "old", type: "paragraph" }, mermaidCodeBlock("new", "graph TD; A-->B;")],
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": "# 標題\n\n```mermaid\ngraph TD; A-->B;\n```\n" }),
      editor: editor as never,
      defaultPasteHandler: vi.fn(() => true),
    });

    expect(editor.replaceBlocks).toHaveBeenCalledWith(["new"], [{ type: "mermaid", props: { code: "graph TD; A-->B;" } }]);
  });

  it("預設流程路徑（剪貼簿帶 text/html 的單一 code block）：一樣會轉", () => {
    const editor = fakeEditor({ documentBefore: [{ id: "old", type: "paragraph" }] });
    const defaultPasteHandler = vi.fn(() => {
      editor.document = [{ id: "old", type: "paragraph" }, mermaidCodeBlock("new", "graph LR; P-->Q;")];
      return true;
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({
        "text/plain": "graph LR; P-->Q;",
        "text/html": '<pre><code class="language-mermaid">graph LR; P-->Q;</code></pre>',
      }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(editor.replaceBlocks).toHaveBeenCalledWith(["new"], [{ type: "mermaid", props: { code: "graph LR; P-->Q;" } }]);
  });

  it("貼上前就存在的 mermaid code block 不會被轉（使用者刻意留成程式碼的那些）", () => {
    const before: FakeBlock[] = [{ id: "old", type: "paragraph" }, mermaidCodeBlock("kept", "graph TD; K-->K;")];
    const editor = fakeEditor({
      documentBefore: before,
      documentAfterInsert: [...before, { id: "new", type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": MD_CRLF }),
      editor: editor as never,
      defaultPasteHandler: vi.fn(() => true),
    });

    expect(editor.replaceBlocks).not.toHaveBeenCalled();
  });
});
