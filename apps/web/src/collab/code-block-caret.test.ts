import { afterEach, describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "./schema";
import { CARET_INSIDE_ATTR, createCodeBlockCaretExtension } from "./code-block-caret";

// 掛真編輯器（同 `site-link-convert.test.tsx` 的手法）：decoration 要真的落到 block content 的 DOM 上，
// `index.css` 的 `[data-caret-inside]` 才吃得到——只測 `caretCodeBlockDecorations` 的回傳值證明不了這一段。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

function mount(withExtension = true): { editor: AnyEditor; container: HTMLElement } {
  const editor = BlockNoteEditor.create({
    schema: noteSchema,
    initialContent: [
      { type: "paragraph", content: "above" },
      { type: "codeBlock", props: { language: "typescript" }, content: "const a = 1;" },
      { type: "paragraph", content: "below" },
    ],
    _tiptapOptions: { extensions: withExtension ? [createCodeBlockCaretExtension()] : [] },
  } as never) as AnyEditor;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  return { editor, container };
}

const codeBlockEl = (container: HTMLElement) => container.querySelector('.bn-block-content[data-content-type="codeBlock"]')!;
/** tiptap 的 focusEvents 外掛聽 DOM 的 focus／blur：設 `editor.isFocused` 並 dispatch 一筆 tr（decorations 才重算）。 */
const focus = (editor: AnyEditor) => editor._tiptapEditor.view.dom.dispatchEvent(new FocusEvent("focus"));
const blur = (editor: AnyEditor) => editor._tiptapEditor.view.dom.dispatchEvent(new FocusEvent("blur"));

describe("code block 的 caret 訊號（data-caret-inside）", () => {
  let editor: AnyEditor;
  let container: HTMLElement;
  afterEach(() => {
    editor.unmount();
    container.remove();
  });

  it("游標在 code block 裡且編輯器有焦點 → 那塊 block content 掛上屬性；移到別段就拿掉", () => {
    ({ editor, container } = mount());
    focus(editor);
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR), "游標還在第一段，不該掛").toBe(false);

    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR), "游標進了程式碼，語言下拉要叫得出來").toBe(true);

    editor.setTextCursorPosition(editor.document[2]!.id, "start");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR), "游標離開了，控制項不該留在那塊程式碼上").toBe(false);
    // 只認 codeBlock：游標在一般段落時整份文件都不該有這個屬性。
    expect(container.querySelectorAll(`[${CARET_INSIDE_ATTR}]`), "段落不是 code block，不該被標記").toHaveLength(0);
  });

  it("編輯器失焦 → 拿掉（游標還留在原處，但控制項不該一直浮在那塊程式碼上）", () => {
    ({ editor, container } = mount());
    focus(editor);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(true);

    blur(editor);
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(false);
  });

  it("唯讀 → 不掛（下拉是 disabled 的純文字標籤，沒有東西可叫出來）", () => {
    ({ editor, container } = mount());
    focus(editor);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    editor.isEditable = false;
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(false);
  });

  it("對照組：不掛 extension 就沒有這個屬性（屬性確實是本外掛給的，不是 BlockNote 自帶）", () => {
    ({ editor, container } = mount(false));
    focus(editor);
    editor.setTextCursorPosition(editor.document[1]!.id, "end");
    expect(codeBlockEl(container).hasAttribute(CARET_INSIDE_ATTR)).toBe(false);
  });
});
