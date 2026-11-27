import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT, type SiteLinkCandidate } from "@knotebook/shared";
import { replaceBlocksKeepColumns } from "./columns/keep-columns";
import { createMarkdownPasteHandler, decideMarkdownPaste, hasMarkdownStructure, isSingleCodeBlockHtml } from "./paste";
import { noteSchema } from "./schema";
import { collabUndoManager } from "./undo";
import { createSiteLinkConvertExtension, createSiteLinkPasteHook, type SiteLinkEnv, type SiteLinkEnvRef } from "./site-link-convert";
import { attachTestElementRenderer } from "@/test/element-renderer";

// Wrapped in a spy that calls through to the real implementation (the mermaid conversion goes through the column-preserving helper); not automock: the real-editor cases in this file must keep writing.
vi.mock("./columns/keep-columns", async (importOriginal) => {
  const m = await importOriginal<typeof import("./columns/keep-columns")>();
  return { ...m, replaceBlocksKeepColumns: vi.fn(m.replaceBlocksKeepColumns) };
});
beforeEach(() => {
  vi.mocked(replaceBlocksKeepColumns).mockReset(); // Not an arrow returning it: a function returned from beforeEach runs as teardown; mockReset also clears the mockImplementationOnce queue and restores the wrapped original
});

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
    ["heading, blank line, then content", "# 標題\n\n一段內文"],
    ["two consecutive list items with the same marker", "- 一\n- 二"],
    ["two consecutive numbered items", "1. 一\n2. 二"],
    ["a matched pair of code fences", "```bash\nls\n```"],
    ["a table separator row", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ])("structural evidence: %s -> is a markdown document", (_name, src) => {
    expect(hasMarkdownStructure(src)).toBe(true);
  });

  /**
   * Regression cases from a real clipboard: their `text/html` (`<pre><code>`, or a paragraph with link and bold) is the better source. If the decision only required one line-start marker, we would take all of these over, corrupting code and silently dropping links and bold.
   */
  it.each([
    ["shell comment followed directly by a command", "# install deps\nnpm install foo"],
    ["Dockerfile comment", "# build stage\nFROM node:22"],
    ["YAML with only a single `- ` item", "services:\n  - name: web\n    image: nginx"],
    ["diff fragment (`-` and `+` are different markers)", "- old line\n+ new line"],
    ["only one list item inside a paragraph", "- see the docs for details\n\nand more bold text"],
    ["unclosed fence", "```bash\nls"],
    ["a lone heading line", "# 標題"],
    ["ordinary paragraph", "就是一段普通文字。"],
    ["inline markup without structure", "這段有 **粗體** 和 `code` 還有 [連結](https://example.com)"],
    ["email-style quote", "> 引用一句\n> 第二句"],
  ])("not enough to decide: %s -> not a markdown document", (_name, src) => {
    expect(hasMarkdownStructure(src)).toBe(false);
  });
});

describe("isSingleCodeBlockHtml", () => {
  it("a docs site's code block (pre > code) -> yes", () => {
    expect(isSingleCodeBlockHtml('<pre><code class="language-dockerfile"># syntax=1\n\nFROM node:22</code></pre>')).toBe(true);
  });

  it("the meta Chrome prepends on copy doesn't affect the result", () => {
    expect(isSingleCodeBlockHtml('<meta charset="utf-8"><pre><code>FROM node:22</code></pre>')).toBe(true);
  });

  it("a bare pre the browser shows for a plain-text file (raw .md page) -> no", () => {
    expect(isSingleCodeBlockHtml('<pre style="white-space: pre-wrap"># 標題\n\n內文</pre>')).toBe(false);
  });

  it("other content besides the code block -> no (the whole isn't a single code block)", () => {
    expect(isSingleCodeBlockHtml("<p>說明文字</p><pre><code>FROM node:22</code></pre>")).toBe(false);
  });

  it("ordinary paragraph HTML -> no", () => {
    expect(isSingleCodeBlockHtml('<p>- see the <a href="https://x">docs</a></p>')).toBe(false);
  });
});

describe("decideMarkdownPaste", () => {
  it("plain text/plain: handed to us to parse, with line breaks normalized to LF", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": MD_CRLF }), false)).toBe(MD_LF);
  });

  it("plain text/plain is taken over even without structural evidence (no HTML to fall back to; behaviour is BlockNote's plus normalization)", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": "# install deps\r\nnpm install foo" }), false)).toBe(
      "# install deps\nnpm install foo",
    );
  });

  it("text/markdown: also taken over and normalized", () => {
    expect(decideMarkdownPaste(clipboard({ "text/markdown": MD_CRLF, "text/plain": "略" }), false)).toBe(MD_LF);
  });

  it("text/markdown + text/html together: still taken over (BlockNote would pick markdown anyway, just without normalization)", () => {
    const data = clipboard({ "text/markdown": MD_CRLF, "text/html": "<p>hi</p>", "text/plain": "略" });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  /**
   * The structure decision must run on the **normalized** text. In the wrong order, a Windows clipboard's `## heading\r\n\r\ncontent` fails the "real blank line" rule because the blank line is actually `\r\n\r\n`, so it is handed back and falls back to CRLF parsing: #28 itself.
   */
  it("structure decision runs after normalization: CRLF heading + blank line + content still counts", () => {
    const data = clipboard({ "text/html": "<pre>…</pre>", "text/plain": "## Install\r\n\r\nRun npm i." });

    expect(decideMarkdownPaste(data, false)).toBe("## Install\n\nRun npm i.");
  });

  it("text/html + markdown source with structural evidence (e.g. a whole document copied from a raw page): taken over and normalized", () => {
    const data = clipboard({ "text/html": "<pre>…</pre>", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it.each([
    ["shell snippet from a docs site", "# install deps\r\nnpm install foo", "<pre><code>…</code></pre>"],
    ["diff fragment", "- old line\r\n+ new line", "<pre><code>…</code></pre>"],
    ["paragraph with a link and bold", "- see the docs for details\r\n\r\nand more bold text", '<p>- see the <a href="https://x">docs</a></p>'],
  ])("text/html + no structural evidence (%s): not taken over, so the HTML path keeps the formatting", (_name, plain, html) => {
    expect(decideMarkdownPaste(clipboard({ "text/html": html, "text/plain": plain }), false)).toBeNull();
  });

  /**
   * A code snippet copied from a docs site: a `# comment` followed by a blank line and a command is "heading + content" to markdown (and to BlockNote's own decision), so it would be parsed as a big heading. But the clipboard's HTML is plainly a code block, which is what the user saw and wants.
   */
  it("HTML is itself a single code block: not taken over even if the plain text has markdown structure", () => {
    const data = clipboard({
      "text/html": '<pre><code class="language-dockerfile"># syntax=docker/dockerfile:1\n\nFROM node:22</code></pre>',
      "text/plain": "# syntax=docker/dockerfile:1\r\n\r\nFROM node:22",
    });

    expect(decideMarkdownPaste(data, false)).toBeNull();
  });

  it("a bare pre (the browser's raw .md page) isn't a code block: taken over per the structure decision", () => {
    const data = clipboard({ "text/html": '<pre style="white-space: pre-wrap">…</pre>', "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it("VS Code copy of a markdown file (mode=markdown, with text/html too): taken over", () => {
    const data = clipboard({
      "vscode-editor-data": JSON.stringify({ mode: "markdown" }),
      "text/html": "<div style='color:#000'>…</div>",
      "text/plain": MD_CRLF,
    });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it.each(["md", "mdx"])("other markdown-family modes of VS Code (%s) are taken over too", (mode) => {
    const data = clipboard({ "vscode-editor-data": JSON.stringify({ mode }), "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it("VS Code copy of code (mode=python): not taken over, keeping BlockNote's code block behaviour", () => {
    const data = clipboard({ "vscode-editor-data": JSON.stringify({ mode: "python" }), "text/plain": "print(1)\r\n" });

    expect(decideMarkdownPaste(data, false)).toBeNull();
  });

  it("vscode-editor-data isn't valid JSON: treated as absent, the normal rules apply and nothing throws", () => {
    const data = clipboard({ "vscode-editor-data": "{壞掉的", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBe(MD_LF);
  });

  it("clipboard carries blocknote/html (in-site copy): not taken over", () => {
    const data = clipboard({ "blocknote/html": "<p>hi</p>", "text/plain": MD_CRLF });

    expect(decideMarkdownPaste(data, false)).toBeNull();
  });

  it("caret inside a code block: not taken over (pasting there should be plain text anyway)", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": MD_CRLF }), true)).toBeNull();
  });

  it("empty plain text: not taken over", () => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": "" }), false)).toBeNull();
  });

  it.each(["   ", "\r\n\r\n", "\t"])("whitespace only (%o): not taken over, so the paste doesn't silently do nothing", (source) => {
    expect(decideMarkdownPaste(clipboard({ "text/plain": source }), false)).toBeNull();
    expect(
      decideMarkdownPaste(clipboard({ "vscode-editor-data": JSON.stringify({ mode: "markdown" }), "text/plain": source }), false),
    ).toBeNull();
  });

  it("no clipboardData: not taken over, and must not throw", () => {
    expect(decideMarkdownPaste(null, false)).toBeNull();
  });
});

interface FakeBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
}

describe("createMarkdownPasteHandler", () => {
  /**
   * `documentAfterInsert` is what matters for issue #94: what the document looks like **after** the paste has inserted. Without it `collectBlockIds(editor.document)` throws and `convertMermaid()` silently degrades to a no-op, so deleting both `convertMermaid()` calls in `paste.ts` would not fail the tests.
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
      pasteMarkdown: vi.fn(() => {
        if (throwOnPaste) throw new Error("paste boom");
        if (documentAfterInsert !== null) editor.document = documentAfterInsert;
      }),
      transact: vi.fn(<T,>(callback: (tr: never) => T): T => {
        if (throwOnTransact) throw new Error("transact boom");
        const resolved = { parent: { type: { spec: { code: inCodeBlock } } } };
        return callback({ selection: { $from: resolved, $to: resolved } } as never);
      }),
    };
    return editor;
  }

  function mermaidCodeBlock(id: string, code: string): FakeBlock {
    return { id, type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: code }] };
  }

  function pasteEvent(data: Record<string, string>): ClipboardEvent {
    return { clipboardData: clipboard(data) } as unknown as ClipboardEvent;
  }

  it("when taking over, calls pasteMarkdown (with the normalized content) and reports handled, without the default flow", () => {
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

  it("when not taking over, hands off to BlockNote's default flow unchanged", () => {
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
   * When handing back, one more thing must be said: BlockNote's default `prioritizeMarkdownOverHTML` is true, so plain text that looks like markdown overrides HTML, which is why a docs site's code snippet becomes a heading. When the HTML is already a code block, explicitly ask it to prefer HTML.
   */
  it("HTML is a single code block: when handing back, asks BlockNote to prefer HTML", () => {
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

  it("ordinary hand-back (HTML isn't a code block): no options, keeping BlockNote's default", () => {
    const editor = fakeEditor();
    const defaultPasteHandler = vi.fn(() => true);

    createMarkdownPasteHandler()({
      event: pasteEvent({ "blocknote/html": "<p>hi</p>", "text/plain": "hi" }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(defaultPasteHandler).toHaveBeenCalledWith(undefined);
  });

  it("caret inside a code block: handed to the default flow (BlockNote pastes plain text)", () => {
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

  it("the decision stage throws: falls back to the default flow", () => {
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
   * `defaultPasteHandler` can throw itself (BlockNote's `JSON.parse` on `vscode-editor-data` is unguarded). It must be called once: a second call would throw the same way with the same input, and the user would see the paste do nothing at all.
   */
  it("the default flow itself throws: it isn't called again (a retry would throw again)", () => {
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
   * `pasteMarkdown` can throw after part of the content was already inserted. Falling back to the default flow then would paste again on top of half the content, duplicating it.
   */
  it("pasteMarkdown throws: reports handled, no default flow (avoids a duplicate paste)", () => {
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

  // #94: a pasted ```mermaid becomes a diagram. The two insertion exits each have a `convertMermaid()` and both need a test: the default-flow one is the scenario `docs/diagrams.md` promotes (copying from an AI chat or a GitHub README, where the clipboard has both text/plain and text/html).

  it("markdown path: the ```mermaid code block inserted this time is converted to a mermaid block", () => {
    const editor = fakeEditor({
      documentBefore: [{ id: "old", type: "paragraph" }],
      documentAfterInsert: [{ id: "old", type: "paragraph" }, mermaidCodeBlock("new", "graph TD; A-->B;")],
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": "# 標題\n\n```mermaid\ngraph TD; A-->B;\n```\n" }),
      editor: editor as never,
      defaultPasteHandler: vi.fn(() => true),
    });

    // On the fake tr the helper's real implementation throws and the conversion's try/catch swallows it; the spy still records the call.
    expect(vi.mocked(replaceBlocksKeepColumns)).toHaveBeenCalledWith(editor, ["new"], [{ type: "mermaid", props: { code: "graph TD; A-->B;" } }]);
  });

  it("default-flow path (clipboard with text/html holding a single code block): converted as well", () => {
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
    expect(vi.mocked(replaceBlocksKeepColumns)).toHaveBeenCalledWith(editor, ["new"], [{ type: "mermaid", props: { code: "graph LR; P-->Q;" } }]);
  });

  it("mermaid code blocks that existed before the paste are not converted (the ones the user deliberately left as code)", () => {
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

    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  function codeBlockOf(id: string, language: string, text: string): FakeBlock {
    return { id, type: "codeBlock", props: { language }, content: [{ type: "text", text }] };
  }

  it("markdown path: the ```math code block inserted this time is converted to a math block", () => {
    const editor = fakeEditor({
      documentBefore: [{ id: "old", type: "paragraph" }],
      documentAfterInsert: [{ id: "old", type: "paragraph" }, codeBlockOf("new", "math", "\\frac{a_1}{b_1}")],
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": "# 標題\n\n```math\n\\frac{a_1}{b_1}\n```\n" }),
      editor: editor as never,
      defaultPasteHandler: vi.fn(() => true),
    });

    expect(vi.mocked(replaceBlocksKeepColumns)).toHaveBeenCalledWith(editor, ["new"], [{ type: "math", props: { tex: "\\frac{a_1}{b_1}" } }]);
  });

  it("default-flow path (text/html holding a language-math code block): converted as well", () => {
    const editor = fakeEditor({ documentBefore: [{ id: "old", type: "paragraph" }] });
    const defaultPasteHandler = vi.fn(() => {
      editor.document = [{ id: "old", type: "paragraph" }, codeBlockOf("new", "math", "E=mc^2")];
      return true;
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": "E=mc^2", "text/html": '<pre><code class="language-math">E=mc^2</code></pre>' }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replaceBlocksKeepColumns)).toHaveBeenCalledWith(editor, ["new"], [{ type: "math", props: { tex: "E=mc^2" } }]);
  });

  it("markdown path: a pasted latex code block stays a code block", () => {
    const editor = fakeEditor({
      documentBefore: [{ id: "old", type: "paragraph" }],
      documentAfterInsert: [{ id: "old", type: "paragraph" }, codeBlockOf("new", "latex", "\\sum_{i} w_i")],
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": "# 標題\n\n```latex\n\\sum_{i} w_i\n```\n" }),
      editor: editor as never,
      defaultPasteHandler: vi.fn(() => true),
    });

    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("default-flow path: a pasted language-latex code block stays a code block", () => {
    const editor = fakeEditor({ documentBefore: [{ id: "old", type: "paragraph" }] });
    const defaultPasteHandler = vi.fn(() => {
      editor.document = [{ id: "old", type: "paragraph" }, codeBlockOf("new", "latex", "\\sum_{i} w_i")];
      return true;
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": "\\sum_{i} w_i", "text/html": '<pre><code class="language-latex">\\sum_{i} w_i</code></pre>' }),
      editor: editor as never,
      defaultPasteHandler,
    });

    expect(defaultPasteHandler).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("math code blocks that existed before the paste are not converted (only the newly inserted ones)", () => {
    const before: FakeBlock[] = [{ id: "old", type: "paragraph" }, codeBlockOf("kept", "math", "x^2")];
    const editor = fakeEditor({
      documentBefore: before,
      documentAfterInsert: [...before, { id: "new", type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": MD_CRLF }),
      editor: editor as never,
      defaultPasteHandler: vi.fn(() => true),
    });

    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });

  it("a pasted math code block with blank content is not converted", () => {
    const editor = fakeEditor({
      documentBefore: [{ id: "old", type: "paragraph" }],
      documentAfterInsert: [{ id: "old", type: "paragraph" }, codeBlockOf("new", "math", "  \n ")],
    });

    createMarkdownPasteHandler()({
      event: pasteEvent({ "text/plain": "# 標題\n\n```math\n \n```\n" }),
      editor: editor as never,
      defaultPasteHandler: vi.fn(() => true),
    });

    expect(vi.mocked(replaceBlocksKeepColumns)).not.toHaveBeenCalled();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type RealEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node type isn't available at value level in apps/web
type AnyNode = any;
const ALPHA: SiteLinkCandidate = { id: "11111111-1111-4111-8111-111111111111", title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" };

function siteRef(env: Partial<SiteLinkEnv> = {}): SiteLinkEnvRef {
  return { current: { origin: window.location.origin, notes: () => [ALPHA], schedule: () => {}, ...env } };
}

/**
 * Always mount: an unmounted tiptap `EditorState` carries no plugins (y-sync, input rule, autolink and this repo's conversion plugins are only installed at `createView()`), so conversion behaviour measured on a headless editor isn't the app's behaviour. `hook` defaults to the product's `createSiteLinkPasteHook(envRef)`. Mounted editors are registered in `mountedPasteEditors` and cleaned up by `cleanupPasteEditors` (afterEach) even when an assertion fails.
 */
const mountedPasteEditors: Array<{ editor: RealEditor; doc?: Y.Doc }> = [];
function cleanupPasteEditors(): void {
  for (const { editor, doc } of mountedPasteEditors.splice(0)) {
    editor.unmount();
    doc?.destroy();
  }
  document.body.replaceChildren();
}

function mountPasteEditor(
  envRef: SiteLinkEnvRef,
  collab = false,
  hook = createSiteLinkPasteHook(envRef),
  editorProps: Record<string, unknown> = {},
): { editor: RealEditor; container: HTMLElement; doc?: Y.Doc } {
  const extensions = [createSiteLinkConvertExtension({ envRef })];
  const pasteHandler = createMarkdownPasteHandler(hook);
  let doc: Y.Doc | undefined;
  const editor = (collab
    ? BlockNoteEditor.create(
        withCollaboration({
          schema: noteSchema,
          collaboration: { provider: { awareness: undefined }, fragment: (doc = new Y.Doc()).getXmlFragment(YDOC_FRAGMENT), user: { id: "u", name: "U", color: "#123456" } },
          pasteHandler,
          _tiptapOptions: { extensions, editorProps },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
        } as any),
      )
    : BlockNoteEditor.create({ schema: noteSchema, pasteHandler, _tiptapOptions: { extensions, editorProps } } as never)) as RealEditor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  attachTestElementRenderer(editor); // wikilink's toDOM needs it (see the helper's file header)
  mountedPasteEditors.push({ editor, doc });
  return { editor, container, doc };
}

function realPaste(editor: RealEditor, data: Record<string, string>): void {
  const clipboardData = { types: Object.keys(data), items: [], files: [], getData: (t: string) => data[t] ?? "" };
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  editor._tiptapEditor.view.dom.dispatchEvent(event);
}

function caretAfter(editor: RealEditor, word: string): void {
  const view = editor._tiptapEditor.view;
  let pos = -1;
  view.state.doc.descendants((n: { isText: boolean; text?: string }, p: number) => {
    if (pos === -1 && n.isText && String(n.text).includes(word)) pos = p + String(n.text).indexOf(word) + word.length;
    return pos === -1;
  });
  editor._tiptapEditor.commands.setTextSelection(pos);
}

function firstLinkRange(editor: RealEditor): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  editor._tiptapEditor.view.state.doc.descendants((n: AnyNode, p: number) => {
    if (range === null && n.isText && n.marks.some((m: AnyNode) => m.type.name === "link")) range = { from: p, to: p + n.nodeSize };
    return range === null;
  });
  return range!;
}

const types = (editor: RealEditor, i = 0) => (editor.document[i]!.content as Array<{ type: string }>).map((n) => n.type);
const typeHrefs = (editor: RealEditor, i = 0) => (editor.document[i]!.content as Array<{ type: string; href?: string }>).map((n) => [n.type, n.href]);
type InlineNode = { type: string; href?: string; props?: Record<string, string> };
const shape = (editor: RealEditor) =>
  editor.document
    .filter((b) => Array.isArray(b.content) && (b.content as unknown[]).length > 0)
    .map((b) => (b.content as InlineNode[]).map((n) => (n.type === "wikilink" ? [n.type, n.props] : [n.type, n.href])));

describe("#269 conversion of pasted on-site links (real editor, real DOM paste event)", () => {
  afterEach(cleanupPasteEditors);

  it("HTML <a> pasted inline mid-paragraph: replaced by a wikilink inside the same block (label = link text)", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello world" }]);
    const id = editor.document[0]!.id;
    caretAfter(editor, "hello ");
    realPaste(editor, { "text/html": '<a href="/n/alice/alpha">x</a>', "text/plain": "x" });
    expect(editor.document[0]!.id).toBe(id);
    expect(types(editor)).toEqual(["text", "wikilink", "text"]);
    expect((editor.document[0]!.content as Array<{ props?: Record<string, string> }>)[1]!.props).toEqual({ targetNoteId: ALPHA.id, snapshotTitle: "x", label: "x", anchorBlockId: "" });
  });

  it("markdown link (plain text) pasted inline mid-paragraph: replaced by a wikilink (text equal to the title -> empty label)", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello world" }]);
    caretAfter(editor, "hello ");
    realPaste(editor, { "text/plain": "[Alpha](/n/alice/alpha)" });
    expect(shape(editor)).toEqual([
      [
        ["text", undefined],
        ["wikilink", { targetNoteId: ALPHA.id, snapshotTitle: "Alpha", label: "", anchorBlockId: "" }],
        ["text", undefined],
      ],
    ]);
  });

  it("block-level paste (multi-paragraph HTML): on-site links in every paragraph are converted; external links untouched", () => {
    const { editor } = mountPasteEditor(siteRef());
    realPaste(editor, { "text/html": `<p><a href="/notes/${ALPHA.id}">a</a></p><p><a href="https://example.com/">b</a></p>`, "text/plain": "a\nb" });
    expect(shape(editor)).toEqual([
      [["wikilink", { targetNoteId: ALPHA.id, snapshotTitle: "a", label: "a", anchorBlockId: "" }]],
      [["link", "https://example.com/"]],
    ]);
  });

  it("PM level: link text with a bold fragment -> one wikilink with the label concatenated; two links with the same href are each converted and keep their own label", () => {
    const { editor } = mountPasteEditor(siteRef());
    realPaste(editor, { "text/html": '<p><a href="/n/alice/alpha"><b>粗</b>體</a> / <a href="/n/alice/alpha">另一段</a></p>', "text/plain": "粗體 / 另一段" });
    const block = editor.document.find((b) => Array.isArray(b.content) && (b.content as unknown[]).length > 0)!;
    const wls = (block.content as Array<{ type: string; props?: Record<string, string> }>).filter((n) => n.type === "wikilink");
    expect(wls.map((w) => w.props!.label)).toEqual(["粗體", "另一段"]);
  });

  it("when the conversion throws the paste proceeds as usual (the link stays, nothing is thrown to the DOM event)", () => {
    const { editor } = mountPasteEditor(siteRef({ notes: () => { throw new Error("cache boom"); } }));
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello " }]);
    caretAfter(editor, "hello ");
    // An exception thrown by a DOM event listener doesn't propagate out of `dispatchEvent` (jsdom, like browsers, reports it as the window's error event), so "doesn't throw to the DOM event" can only be measured by collecting window errors: `expect(() => realPaste(...)).not.toThrow()` is always green.
    const uncaught: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      uncaught.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      realPaste(editor, { "text/html": '<a href="/n/alice/alpha">x</a>', "text/plain": "x" });
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(uncaught).toEqual([]);
    expect(typeHrefs(editor)).toEqual([
      ["text", undefined],
      ["link", "/n/alice/alpha"],
    ]);
  });

  it("when taking the snapshot (hook.before) throws the paste proceeds as usual and this paste isn't converted", () => {
    const { editor } = mountPasteEditor(siteRef(), false, {
      before: () => {
        throw new Error("snapshot boom");
      },
      after: () => {},
    });
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello " }]);
    caretAfter(editor, "hello ");
    realPaste(editor, { "text/html": '<a href="/n/alice/alpha">x</a>', "text/plain": "x" });
    expect(typeHrefs(editor)).toEqual([
      ["text", undefined],
      ["link", "/n/alice/alpha"],
    ]);
  });

  it("duplicate content: the pasted `-[Alpha]` directly follows an identical existing `-[Alpha]` - findDiffEnd puts the end before the start (taken literally `[start, end.b]` is a point range), and only the pasted one is converted", () => {
    const envRef = siteRef();
    const real = createSiteLinkPasteHook(envRef);
    let naive: { start: number; endA: number; endB: number } | null = null;
    let before: AnyNode = null;
    const { editor } = mountPasteEditor(envRef, false, {
      before: (ed) => {
        before = (ed as RealEditor)._tiptapEditor.view.state.doc;
        return real.before(ed);
      },
      after: (ed, snapshot) => {
        const after = (ed as RealEditor)._tiptapEditor.view.state.doc;
        const end = before.content.findDiffEnd(after.content);
        naive = { start: before.content.findDiffStart(after.content), endA: end.a, endB: end.b };
        real.after(ed, snapshot);
      },
    });
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["-", { type: "link", href: "/n/alice/alpha", content: "Alpha" }, "end"] }]);
    const existing = firstLinkRange(editor);
    editor._tiptapEditor.commands.setTextSelection(existing.to);
    realPaste(editor, { "text/html": '-<a href="/n/alice/alpha">Alpha</a>', "text/plain": "-Alpha" });
    // The diff's end on the a side backs up to the paragraph start and the b side equals the start, i.e. the end of the existing link, so taken literally `[start, end.b]` is a point; collectSiteLinks' point range includes its endpoint and would collect the existing link and miss the pasted one.
    expect(naive).toEqual({ start: existing.to, endA: existing.from - 1, endB: existing.to });
    expect(typeHrefs(editor)).toEqual([
      ["text", undefined],
      ["link", "/n/alice/alpha"],
      ["text", undefined],
      ["wikilink", undefined],
      ["text", undefined],
    ]);
  });

  it("duplicate content pasted in front of existing identical content (pasting `-[Alpha]` into `X|-[Alpha]end`): disambiguated by the pre-paste caret (prosemirror-view findDiff's preferredPos) -> the pasted copy is converted, the existing one stays an ordinary link", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["X-", { type: "link", href: "/n/alice/alpha", content: "Alpha" }, "end"] }]);
    caretAfter(editor, "X");
    realPaste(editor, { "text/html": '-<a href="/n/alice/alpha">Alpha</a>', "text/plain": "-Alpha" });
    expect(typeHrefs(editor)).toEqual([
      ["text", undefined],
      ["wikilink", undefined],
      ["text", undefined],
      ["link", "/n/alice/alpha"],
      ["text", undefined],
    ]);
  });

  it("paste over a selection where the diff is only a deletion (point range): nothing is converted - an adjacent existing on-site link isn't collected", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [{ type: "link", href: "/n/alice/alpha", content: "Alpha" }, "YX"] }]);
    const existing = firstLinkRange(editor);
    editor._tiptapEditor.commands.setTextSelection({ from: existing.to, to: existing.to + 2 });
    realPaste(editor, { "text/plain": "X" });
    expect(typeHrefs(editor)).toEqual([
      ["link", "/n/alice/alpha"],
      ["text", undefined],
    ]);
  });
});

/**
 * #353: when pasting several paragraphs mid-paragraph, the second half of the split paragraph (with a new block id) is not within the conversion range: the range is what this paste inserted, not a diff of the document before and after. The existing link uses `/notes/<id>` and the pasted one `/n/alice/alpha`: both hit the cache but their hrefs differ, so PM doesn't merge two adjacent links into one.
 */
describe("#353 pasting several paragraphs mid-paragraph: existing ordinary on-site links aren't converted", () => {
  afterEach(cleanupPasteEditors);

  const NOTE_HREF = `/notes/${ALPHA.id}`;
  const H = { type: "link" as const, href: NOTE_HREF, content: "H" };
  const L = { type: "link" as const, href: NOTE_HREF, content: "L" };
  const a = (t: string) => `<a href="/n/alice/alpha">${t}</a>`;
  const TWO_HTML = { "text/html": `<p>X ${a("pa")}</p><p>Y ${a("pb")}</p>`, "text/plain": "X pa\nY pb" };
  const TWO_MD = { "text/plain": "X [pa](/n/alice/alpha)\n\nY [pb](/n/alice/alpha)" };

  function linkSeq(editor: RealEditor): string[] {
    const out: string[] = [];
    editor._tiptapEditor.view.state.doc.descendants((n: AnyNode) => {
      if (n.type.name === "wikilink") out.push(`wiki:${String(n.attrs.snapshotTitle)}`);
      else if (n.isText && n.marks.some((m: AnyNode) => m.type.name === "link")) out.push(`link:${String(n.text)}`);
      return true;
    });
    return out;
  }
  function select(editor: RealEditor, fromWord: string, toWord: string): void {
    const pos = (word: string, end: boolean) => {
      let p = -1;
      editor._tiptapEditor.view.state.doc.descendants((n: AnyNode, at: number) => {
        if (p === -1 && n.isText && String(n.text).includes(word)) p = at + String(n.text).indexOf(word) + (end ? word.length : 0);
        return p === -1;
      });
      return p;
    };
    editor._tiptapEditor.commands.setTextSelection({ from: pos(fromWord, false), to: pos(toWord, true) });
  }

  it.each([
    ["HTML", TWO_HTML],
    ["markdown", TWO_MD],
  ] as const)("the issue's example `[H] AAA| [L] BBB` pasting two paragraphs (%s): the pasted ones are converted, L in the split second half and H in the first half aren't", (_name, data) => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [H, " AAA ", L, " BBB"] }]);
    caretAfter(editor, "AAA");
    realPaste(editor, data);
    expect(linkSeq(editor)).toEqual(["link:H", "wiki:pa", "wiki:pb", "link:L"]);
    expect(shape(editor)).toHaveLength(2); // precondition: the paragraph really was split in two (the second half got a new block id)
  });

  it("the last paragraph is a nested list item (PM moves the existing content after the caret into the pasted last item with a ReplaceAroundStep) with the caret right before L: L isn't converted", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [H, " AAA ", L, " BBB"] }]);
    caretAfter(editor, "AAA ");
    realPaste(editor, { "text/html": `<p>X ${a("pa")}</p><ul><li>Y ${a("pb")}<ul><li>Z ${a("pc")}</li></ul></li></ul>`, "text/plain": "X" });
    expect(linkSeq(editor)).toEqual(["link:H", "wiki:pa", "wiki:pb", "wiki:pc", "link:L"]);
  });

  it("pasting two paragraphs at paragraph start: L of the original paragraph isn't converted", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [H] }, { type: "paragraph", content: ["AAA ", L] }]);
    editor.setTextCursorPosition(editor.document[1]!.id, "start");
    realPaste(editor, TWO_HTML);
    expect(linkSeq(editor)).toEqual(["link:H", "wiki:pa", "wiki:pb", "link:L"]);
  });

  it("pasting two paragraphs over a selection inside a paragraph (replacing it): H and L outside the selection aren't converted", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [H, " AAA BBB ", L, " CCC"] }]);
    select(editor, "AAA", "BBB");
    realPaste(editor, TWO_HTML);
    expect(linkSeq(editor)).toEqual(["link:H", "wiki:pa", "wiki:pb", "link:L"]);
  });

  it("pasting two paragraphs over a selection across paragraphs: H and L outside the selection aren't converted", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: [H, " AAA"] },
      { type: "paragraph", content: ["BBB ", L, " CCC"] },
    ]);
    select(editor, "AAA", "BBB");
    realPaste(editor, TWO_HTML);
    expect(linkSeq(editor)).toEqual(["link:H", "wiki:pa", "wiki:pb", "link:L"]);
  });

  it.each([
    ["two paragraphs of HTML", TWO_HTML],
    ["bare URL", { "text/plain": `${window.location.origin}/n/alice/alpha` }],
  ] as const)("the paste is blocked by handlePaste (like the note size limit: returns true, document unchanged) with a selection covering the existing L (%s): L isn't converted, document unchanged", (_name, data) => {
    const { editor } = mountPasteEditor(siteRef(), false, undefined, { handlePaste: () => true });
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: ["go AAA ", L, " BBB"] }]);
    const before = editor._tiptapEditor.view.state.doc;
    select(editor, "AAA", "BBB");
    realPaste(editor, data);
    expect(linkSeq(editor)).toEqual(["link:L"]);
    expect(editor._tiptapEditor.view.state.doc.eq(before)).toBe(true); // precondition: it really was blocked
  });

  it.each([
    // Cell selection (rows 1-2 of column 0): the cells between the two in document order; unselected cells (L included) don't count.
    ["cell selection", "cell"],
    // Caret inside a cell: prosemirror-tables pastes downward from that cell, so the cells pasted into go beyond the original selection.
    ["caret inside a cell", "caret"],
  ] as const)("pasting copied table cells into a table (prosemirror-tables' handlePaste, not the paste tr; %s): links in the cells pasted into are converted, L and existing links in cells not pasted into aren't", (_name, how) => {
    const { editor } = mountPasteEditor(siteRef());
    const cell = (content: unknown) => ({ type: "tableCell", content });
    const pa = [{ type: "link", href: "/n/alice/alpha", content: "pa" }];
    editor.replaceBlocks(editor.document, [
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: [cell(pa), cell("m"), cell("x")] }, { cells: [cell("q"), cell("n"), cell([L])] }, { cells: [cell("r"), cell("s"), cell("t")] }],
        },
      } as never,
    ]);
    const view = editor._tiptapEditor.view;
    const cells: number[] = [];
    view.state.doc.descendants((n: AnyNode, p: number) => {
      if (n.type.name === "tableCell") cells.push(p);
      return true;
    });
    // CellSelection is built through Selection's JSON registry (prosemirror-tables registers "cell"), so there's no direct dependency on prosemirror-tables.
    const Selection = Object.getPrototypeOf(view.state.selection.constructor) as { fromJSON(doc: AnyNode, json: unknown): AnyNode };
    const copied = Selection.fromJSON(view.state.doc, { type: "cell", anchor: cells[0], head: cells[3] }); // rows 0-1 of column 0: pa, q
    const html = view.serializeForClipboard(copied.content()).dom.innerHTML;
    if (how === "cell") view.dispatch(view.state.tr.setSelection(Selection.fromJSON(view.state.doc, { type: "cell", anchor: cells[3], head: cells[6] })));
    else editor._tiptapEditor.commands.setTextSelection(cells[3]! + 3);
    expect(view.state.selection.constructor.name).toBe(how === "cell" ? "CellSelection" : "TextSelection"); // precondition
    realPaste(editor, { "blocknote/html": html, "text/plain": "pa\nq" });
    // Row 0's pa is existing (not pasted into), row 1's first cell is the pasted pa, row 2's first cell is the pasted q.
    expect(linkSeq(editor)).toEqual(["link:pa", "wiki:pa", "link:L"]);
    // Precondition: it really pasted into two cells (not text stuffed into one); a wikilink is an atom and doesn't count towards textContent.
    expect(view.state.doc.textContent).toBe("pamxnLqst");
  });

  it("pasting one paragraph inline (no split): as before, only the pasted one is converted", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: [H, " AAA ", L, " BBB"] }]);
    caretAfter(editor, "AAA");
    realPaste(editor, { "text/html": a("pa"), "text/plain": "pa" });
    expect(linkSeq(editor)).toEqual(["link:H", "wiki:pa", "link:L"]);
    expect(shape(editor)).toHaveLength(1);
  });
});

/**
 * A paste has a single owner: pastes that go through a link AddMarkStep (a bare URL pasted over an empty selection, where tiptap's paste rule adds the link in an appended tr; a URL pasted over a selection, via Link's handlePaste -> setMark) are seen by both the AddMarkStep plugin and the paste hook for the same link. On a cache miss `schedule` must be called once (a per-action cap, so a late second call after undo doesn't convert it back); on a hit it converts once.
 */
describe("#269 a paste's conversion happens once (plugin x paste hook)", () => {
  afterEach(cleanupPasteEditors);

  function counting(notes: SiteLinkCandidate[]) {
    const calls: unknown[][] = [];
    return { envRef: siteRef({ notes: () => notes, schedule: (r) => void calls.push(r) }), calls };
  }

  it("empty selection pasting a bare same-origin URL, cache miss: stays an ordinary link, fallback scheduled once", async () => {
    const { envRef, calls } = counting([]);
    const { editor } = mountPasteEditor(envRef);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello " }]);
    caretAfter(editor, "hello ");
    const url = `${window.location.origin}/n/bob/secret`;
    realPaste(editor, { "text/plain": url });
    expect(typeHrefs(editor)).toEqual([
      ["text", undefined],
      ["link", url],
    ]);
    await Promise.resolve();
    expect(calls.map((r) => (r as Array<{ href: string }>).map((x) => x.href))).toEqual([[url]]);
  });

  it("empty selection pasting a bare same-origin URL, cache hit: converted to one wikilink, no fallback scheduled", async () => {
    const { envRef, calls } = counting([ALPHA]);
    const { editor } = mountPasteEditor(envRef);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello " }]);
    caretAfter(editor, "hello ");
    const url = `${window.location.origin}/n/alice/alpha`;
    realPaste(editor, { "text/plain": url });
    expect(shape(editor)).toEqual([
      [
        ["text", undefined],
        ["wikilink", { targetNoteId: ALPHA.id, snapshotTitle: url, label: "", anchorBlockId: "" }],
      ],
    ]);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it("same-origin URL pasted over a selection, cache miss: the selected text becomes an ordinary link, fallback scheduled once", async () => {
    const { envRef, calls } = counting([]);
    const { editor } = mountPasteEditor(envRef);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "go here now" }]);
    caretAfter(editor, "go ");
    const from = editor._tiptapEditor.view.state.selection.from;
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 4 });
    const url = `${window.location.origin}/n/bob/secret`;
    realPaste(editor, { "text/plain": url });
    expect(typeHrefs(editor)).toEqual([
      ["text", undefined],
      ["link", url],
      ["text", undefined],
    ]);
    await Promise.resolve();
    expect(calls.map((r) => (r as Array<{ href: string; text: string }>).map((x) => [x.href, x.text]))).toEqual([[[url, "here"]]]);
  });

  it("same-origin URL pasted over a selection, cache hit: converted to one wikilink (label = the selected text), no fallback scheduled", async () => {
    const { envRef, calls } = counting([ALPHA]);
    const { editor } = mountPasteEditor(envRef);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "go here now" }]);
    caretAfter(editor, "go ");
    const from = editor._tiptapEditor.view.state.selection.from;
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 4 });
    realPaste(editor, { "text/plain": `${window.location.origin}/n/alice/alpha` });
    expect(shape(editor)).toEqual([
      [
        ["text", undefined],
        ["wikilink", { targetNoteId: ALPHA.id, snapshotTitle: "here", label: "here", anchorBlockId: "" }],
        ["text", undefined],
      ],
    ]);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it("the plugin is handed back when the paste ends (after): a createLink right after in the same tick is converted as usual", () => {
    const { editor } = mountPasteEditor(siteRef());
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello " }]);
    caretAfter(editor, "hello ");
    realPaste(editor, { "text/plain": "x" });
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.createLink("/n/alice/alpha", "go");
    expect(types(editor)).toEqual(["text", "wikilink"]);
  });

  it("an exit throws (after isn't called): the in-progress paste marker is withdrawn in a microtask, and later createLinks are converted by the plugin as usual", async () => {
    const envRef = siteRef();
    const { editor } = mountPasteEditor(envRef);
    const handler = createMarkdownPasteHandler(createSiteLinkPasteHook(envRef));
    expect(() =>
      handler({
        event: { clipboardData: clipboard({ "blocknote/html": "<p>x</p>", "text/plain": "x" }) } as unknown as ClipboardEvent,
        editor: editor as never,
        defaultPasteHandler: () => {
          throw new Error("default boom");
        },
      }),
    ).toThrow("default boom");
    await Promise.resolve();
    editor.setTextCursorPosition(editor.document[0]!.id, "end");
    editor.createLink("/n/alice/alpha", "go");
    expect(types(editor)).toEqual(["wikilink"]);
  });
});

/** Paste row of the undo-after-conversion check: are the synchronous conversion and the paste merged into one step, so one Ctrl+Z makes the whole paste disappear. MEASURED is the expected value. */
const MEASURED_PASTE = { undoRemovesWholePaste: true } as const;

describe("#269 undo of a paste conversion (the measured results are the assertions)", () => {
  afterEach(cleanupPasteEditors); // unmount + doc.destroy() in afterEach, so cleanup happens even when an assertion fails
  it(`one Ctrl+Z removes the whole paste =${String(MEASURED_PASTE.undoRemovesWholePaste)}`, () => {
    const { editor } = mountPasteEditor(siteRef(), true);
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "hello " }]);
    const before = JSON.stringify(editor.document[0]!.content);
    const manager = collabUndoManager(editor)!;
    manager.stopCapturing();
    caretAfter(editor, "hello ");
    realPaste(editor, { "text/html": '<a href="/n/alice/alpha">x</a>', "text/plain": "x" });
    expect(types(editor)).toContain("wikilink");
    manager.undo();
    expect(JSON.stringify(editor.document[0]!.content) === before).toBe(MEASURED_PASTE.undoRemovesWholePaste);
  });
});
