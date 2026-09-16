import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { collabUndoManager } from "./undo";
import { noteSchema } from "./schema";
import { createMarkdownLinkExtension, MAX_LINK_SCAN } from "./markdown-link";
import type { EditorRef } from "@/components/wikilink/menu";

/**
 * ProseMirror EditorView：Task 1 已驗證 `@tiptap/pm`/`prosemirror-view` 這些路徑從
 * apps/web 直接 import 會 MODULE_NOT_FOUND，且 Vite/vitest 在 transform 階段就炸
 * （不是執行期）。型別只能經 `@tiptap/core` 傳遞取得，這裡直接用 `any` 走 repo 既有的
 * 互通慣例（同 `AnyEditor`）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 理由見上方註解
type AnyView = any;

/**
 * ⚠ **不要沿用 `NoteEditor.test.ts` 的 `typeInput`**：它是該檔 `describe` 內未匯出的
 * 區域函式，且本體直接呼叫 `buildNoteEditorOptions` 的 `editorProps.handleTextInput`
 * ——那條完全繞過 input rule 的 plugin 鏈（規則掛在 `inputRulesPlugin` 的
 * `props.handleTextInput`，dist `:4166`）。照它做的測試永遠測不到本檔要驗的規則。
 *
 * 這支才是讓 editorProps 與所有 plugin 依序有機會處理的正確驅動方式：走
 * `view.someProp("handleTextInput", …)`，座標一律取自 `view.state.selection`（不自己傳
 * 位置——這個 repo 曾因為沒同步 selection 而誤判並寫進 CHANGELOG，事後才翻案，見專案
 * memory `knotebook-wikilink-trigger`）。
 */
function typeChar(view: AnyView, ch: string): void {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f: (v: AnyView, f: number, t: number, c: string) => boolean | void) =>
    f(view, from, to, ch),
  );
  if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}

function typeString(view: AnyView, s: string): void {
  for (const ch of s) typeChar(view, ch);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * 掛載一顆**非共編**的真編輯器，接上本檔要測的 markdown 連結 extension。headless 下
 * `SuggestionMenu.openSuggestionMenu` 會 early-return（Step 9d-2 要用到 mounted），
 * 所以一律 `mount()`。
 *
 * ⚠ 這支 helper 本身**同時是 INV-4 的執行期守衛**：`@tiptap/core` 若跟 BlockNote 解到
 * 不同實例，`createMarkdownLinkExtension` 建出的 `Extension`/`InputRule` 對 BlockNote
 * 內部用來註冊 `addInputRules` 的那套機制而言就是「不認識的異物」——規則會靜默不觸發、
 * 零型別錯誤，只有下面這些「掛真編輯器、真的打字、斷言真的轉換」的測試會紅。
 */
function mountedEditor(): { editor: AnyEditor; editorRef: EditorRef; container: HTMLElement } {
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    _tiptapOptions: { extensions: [createMarkdownLinkExtension({ editorRef })] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNoteEditorOptions 的完整型別要求完整 schema 三元組
  } as any) as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, editorRef, container };
}

/** 掛載一顆**共編**的真編輯器（withCollaboration + 自己的 Y.Doc），Step 9d-4 撤銷語意
 * 測量要用真的 Yjs `UndoManager`——非共編沒有它（`history` extension 不存在，見 spec §2.6）。 */
function mountedCollabEditor(): { doc: Y.Doc; editor: AnyEditor; container: HTMLElement } {
  const doc = new Y.Doc();
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      _tiptapOptions: { extensions: [createMarkdownLinkExtension({ editorRef })] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整 schema 三元組
    } as any),
  ) as AnyEditor;
  editorRef.current = editor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { doc, editor, container };
}

describe("createMarkdownLinkExtension：input rule 觸發（掛真編輯器，逐字元模擬）", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("hello [a](https://x.com) → 整份文件精確斷言（不是「有沒有出現 link」——off-by-one 見 §9b 註）", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;

    typeString(view, "hello [a](https://x.com)");

    // ⚠ 整份文件精確斷言：若 handler 誤用 matchedLength 往左反推位置（而不是用
    // `run()` 給的 range），「hello 」的空格會被多吃一格，變成 `[{"text":"hello"},{link}]`
    // ——這條斷言會抓到那個 off-by-one（見 brief Step 9b 的說明）。
    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "hello ", styles: {} },
      {
        type: "link",
        href: "https://x.com",
        content: [{ type: "text", text: "a", styles: {} }],
      },
    ]);
  });
});

// ── §4.1 文件端守衛（gate I-2）：拒絕方向與正向方向都要 ──────────────────────────
describe("§4.1 文件端守衛：範圍內帶 mark 不觸發、範圍外的 mark 不影響觸發", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("拒絕方向案 1：「[ ＋粗體 a ＋ ](https://x.com」打 ) → 不轉換，粗體還在（範圍內含 mark）", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    editor.insertInlineContent(["[", { type: "text", text: "a", styles: { bold: true } }, "](https://x.com"]);
    typeChar(view, ")");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "[", styles: {} },
      { type: "text", text: "a", styles: { bold: true } },
      { type: "text", text: "](https://x.com)", styles: {} },
    ]);
  });

  it("拒絕方向案 2：孤兒 [ ＋既有 link 再打 ](https://z.com) → 不轉換（唯一擋得下來的是這條守衛——resolveTrailingMarkdownLink 會回命中、run() 的位置驗證也會通過）", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    typeString(view, "[[c](https://x.com)");
    // 中繼態：SuggestionMenu 的內建偵測在 block 開頭吃掉第一個 [ 開選單，第二個 [
    // 留在文件——形成「孤兒 [ ＋ link(c)」（spec §2.7／§4.1 的形）。
    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "[", styles: {} },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "c", styles: {} }] },
    ]);

    typeString(view, "](https://z.com)");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "[", styles: {} },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "c", styles: {} }] },
      { type: "text", text: "](https://z.com)", styles: {} },
    ]);
  });

  it("正向方向：粗體緊鄰但在範圍外（editor.replaceBlocks 明寫成兩個 node）→ 必須照常觸發", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    // ⚠ 這一案的構造方式承重、照字面「打字」造不出來：接在粗體後面打的字本身就是
    // 粗體（stored marks），會讓語法整段落在範圍內、被守衛正確拒絕。brief Step 9b
    // 實測過三種構造，這裡挑的是其中一種——**不是唯一造得出來的**（見下一案
    // `unsetMark` 那條，那條更貼近真實使用者操作：打完粗體按 Ctrl+B 關掉再打連結）。
    editor.replaceBlocks(
      [editor.document[0]!],
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "粗", styles: { bold: true } },
            { type: "text", text: "[a](https://x.com", styles: {} },
          ],
        } as never,
      ],
    );
    editor._tiptapEditor.commands.setTextSelection(view.state.doc.content.size - 1);

    typeChar(view, ")");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "粗", styles: { bold: true } },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "a", styles: {} }] },
    ]);
  });

  it("正向方向（更貼近真實使用者）：打完粗體按 Ctrl+B 關掉（unsetMark）再逐字打連結 → 必須照常觸發", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    // 這是審查指出的反例：`insertInlineContent` 一段粗體文字後、用
    // `unsetMark("bold")` 關掉 stored mark（等同使用者打完粗體按 Ctrl+B），再逐字
    // 打連結語法——比上一案的 `replaceBlocks` 構造更貼近真實輸入路徑。
    editor.insertInlineContent([{ type: "text", text: "粗", styles: { bold: true } }]);
    editor._tiptapEditor.commands.unsetMark("bold");

    typeString(view, "[a](https://x.com)");

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: "粗", styles: { bold: true } },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "a", styles: {} }] },
    ]);
  });
});

// ── Step 9d：spec 要求但前面步驟沒涵蓋的四條 ──────────────────────────────────
describe("Step 9d-1：MAX_LINK_SCAN 與截短後的左界重守衛", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("段落遠超 MAX_LINK_SCAN、尾端合法連結 → 仍要觸發", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    const filler = "x".repeat(600);

    typeString(view, `${filler}[a](https://x.com)`);

    expect(editor.document[0]!.content).toEqual([
      { type: "text", text: filler, styles: {} },
      { type: "link", href: "https://x.com", content: [{ type: "text", text: "a", styles: {} }] },
    ]);
  });

  it("截短後 recon 剛好頂到左界 → 不得觸發（截短重新製造的左界盲點）", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    // ⚠ 從 `MAX_LINK_SCAN` 推導，不寫死數字——審查抓到的缺口：寫死 483/500 時，把
    // 常數改成 400 這一檔仍全綠（邊界案靜默退化成「反正解析不出連結」，因為 pad 沒
    // 跟著常數變小，markdown 長度不再等於新常數，測的東西早就不是這條左界盲點了）。
    // "[" + pad + "](https://x.com)" 共 pad.length + 17 個字元，要讓整條 markdown
    // 恰好等於 MAX_LINK_SCAN，pad 長度就是 `MAX_LINK_SCAN - 17`。
    const pad = "a".repeat(MAX_LINK_SCAN - 17);
    const prefix = "b".repeat(51);
    const markdown = `[${pad}](https://x.com)`;
    expect(markdown.length).toBe(MAX_LINK_SCAN);

    typeString(view, `${prefix}${markdown}`);

    // 沒有觸發：整段仍是純文字。
    expect(editor.document[0]!.content).toEqual([{ type: "text", text: `${prefix}${markdown}`, styles: {} }]);
  });
});

describe("Step 9d-2：建議選單開著時不觸發（D7）", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("openSuggestionMenu(\"[[\") 後打完整串 → 文件不出現 link", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;

    editor.getExtension(SuggestionMenu)!.openSuggestionMenu("[[");
    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true);

    typeString(view, "[a](https://x.com)");

    const hasLink = (editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "link");
    expect(hasLink).toBe(false);
  });
});

describe("Step 9d-3：§9.1 的形——網址內未跳脫的 )", () => {
  let editor: AnyEditor;
  let container: HTMLElement;

  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("[a](https://x.com/foo)bar) → 短連結 ＋ 純文字 bar)，且與 pasteMarkdown 同一串的終態相等", () => {
    ({ editor, container } = mountedEditor());
    const view = editor._tiptapEditor.view;
    const input = "[a](https://x.com/foo)bar)";

    typeString(view, input);

    const typedContent = editor.document[0]!.content;
    expect(typedContent).toEqual([
      { type: "link", href: "https://x.com/foo", content: [{ type: "text", text: "a", styles: {} }] },
      { type: "text", text: "bar)", styles: {} },
    ]);

    const pasted = mountedEditor();
    try {
      pasted.editor.pasteMarkdown(input);
      expect(pasted.editor.document[0]!.content).toEqual(typedContent);
    } finally {
      pasted.editor.unmount();
      pasted.container.remove();
    }
  });
});

/**
 * Step 9d-4（spec §10.2／§11 棒 2）：對**我們自己的規則**跑「觸發 → Backspace →
 * Ctrl+Z」，量測結果與 spec §9.4（Task 1 對照組，一般 input rule 的既有現象）並列：
 *
 * | 情境 | Backspace 後 | 第 1 次 Ctrl+Z | 第 2 次 Ctrl+Z |
 * |---|---|---|---|
 * | 連續打字（無停頓） | 退回純文字 `hello [a](https://x.com)` | **整段清空**（不是回到純文字） | 仍空（無 stack 可撤） |
 * | 打完後停頓 ≥500ms 再 Backspace | 同上 | **連結重新出現** | 直接清空（見下方 ⚠） |
 *
 * ✅ **兩情境的 Backspace 行為與 §9.4 的一般 input rule 一致**（退回完整純文字）；
 * Ctrl+Z 的分格行為也與 §9.4 描述的機制（Yjs `captureTimeout` 合併窗口）一致——
 * **我們的規則沒有語意逆行的獨有現象，D11 維持有效，不作廢**。
 *
 * ⚠ 「停頓」情境的第 2 次 Ctrl+Z 量到的是**直接清空**、不是 §9.4 表格寫的「回到純
 * 文字」：那張表的三段式需要**前綴與觸發字元之間也停頓 >500ms**（spec §9.4 的警語
 * 「不要寫死次數」）才成立；這裡只在打完之後 `stopCapturing()` 一次，整段輸入仍合併
 * 成同一個 Yjs stack item，第 2 次 Ctrl+Z 因此直接撤掉那整格。這正是該警語所指的
 * 情況，不是我們的規則多了一種新行為。
 */
describe("Step 9d-4：我方規則的撤銷語意測量（觸發 → Backspace → Ctrl+Z，與 §9.4 對照組並列）", () => {
  it("連續打字（無停頓，真實連打節奏）：Backspace 退回純文字，Ctrl+Z 一次整段清空", () => {
    const { doc, editor, container } = mountedCollabEditor();
    const view = editor._tiptapEditor.view;
    const manager = collabUndoManager(editor)!;
    try {
      typeString(view, "hello [a](https://x.com)");
      expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "link")).toBe(true);

      editor._tiptapEditor.commands.undoInputRule();
      expect(editor.document[0]!.content).toEqual([{ type: "text", text: "hello [a](https://x.com)", styles: {} }]);

      manager.undo();
      expect(editor.document[0]!.content).toEqual([]);
    } finally {
      editor.unmount();
      container.remove();
      doc.destroy();
    }
  });

  it("打完停頓 ≥500ms 再 Backspace：Ctrl+Z 第一下讓連結重新出現（不是回到純文字）", () => {
    const { doc, editor, container } = mountedCollabEditor();
    const view = editor._tiptapEditor.view;
    const manager = collabUndoManager(editor)!;
    try {
      typeString(view, "hello [a](https://x.com)");
      manager.stopCapturing(); // 等價於使用者停頓 >500ms（spec §9.4 量測紀律）
      editor._tiptapEditor.commands.undoInputRule();
      expect(editor.document[0]!.content).toEqual([{ type: "text", text: "hello [a](https://x.com)", styles: {} }]);

      manager.undo();
      expect((editor.document[0]!.content as Array<{ type: string }>).some((n) => n.type === "link")).toBe(true);
    } finally {
      editor.unmount();
      container.remove();
      doc.destroy();
    }
  });
});
