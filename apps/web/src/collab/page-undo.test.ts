/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view／selection（型別在 apps/web 拿不到） */
import { afterEach, describe, expect, it } from "vitest";
import { P, blockPos, mountEditor, shape } from "@/test/columns-fixtures";
import { collabUndoManager, keepCollabUndoAlive } from "./undo";
import { attachPageUndoShortcut, pageUndoYields, undoActionOf, undoKeyOf } from "./page-undo";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const key = (k: string, mods: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });

describe("undoActionOf", () => {
  // 表格裡放鍵與修飾鍵、在案內才建事件：vitest 會序列化 it.each 的參數，jsdom 的事件物件序列化不完。
  it.each([
    ["Ctrl+Z", "z", {}, { ctrlKey: true }, "undo"],
    ["Ctrl+Shift+Z", "Z", {}, { ctrlKey: true, shiftKey: true }, "redo"],
    ["Ctrl+Y", "y", {}, { ctrlKey: true }, "redo"],
    ["Cmd+Z（不是 Mac）", "z", {}, { metaKey: true }, null],
    ["Z（沒有修飾鍵）", "z", {}, {}, null],
    ["Ctrl+Alt+Z", "z", {}, { ctrlKey: true, altKey: true }, null],
    ["Ctrl+Shift+Y", "Y", {}, { ctrlKey: true, shiftKey: true }, null],
    ["Ctrl+S", "s", {}, { ctrlKey: true }, null],
    ["俄文配置的 Ctrl+Z（key 是 я）", "я", { code: "KeyZ" }, { ctrlKey: true }, "undo"],
    ["俄文配置的 Ctrl+Y（key 是 н）", "н", { code: "KeyY" }, { ctrlKey: true }, "redo"],
    ["希臘文配置的 Ctrl+Z（key 是 ζ）", "ζ", { code: "KeyZ" }, { ctrlKey: true }, "undo"],
    ["Dvorak 在 Z 的位置按 Ctrl（key 是 ;）", ";", { code: "KeyZ" }, { ctrlKey: true }, null],
    ["BÉPO 在 Z 的位置按 Ctrl（key 是 à）", "à", { code: "KeyZ" }, { ctrlKey: true }, null],
    ["AZERTY 在 Z 的位置按 Ctrl（key 是 w）", "w", { code: "KeyZ" }, { ctrlKey: true }, null],
    ["QWERTZ 在 Z 的位置按 Ctrl（key 是 y）", "y", { code: "KeyZ" }, { ctrlKey: true }, "redo"],
    ["Dvorak 的 Ctrl+Z（key 是 z，在 / 的位置）", "z", { code: "Slash" }, { ctrlKey: true }, "undo"],
  ] as const)("其他平台：%s → %s", (_label, k, code, mods, expected) => {
    expect(undoActionOf(key(k, { ...code, ...mods }), false)).toBe(expected);
  });

  it.each([
    ["Cmd+Z", "z", { metaKey: true }, "undo"],
    ["Cmd+Shift+Z", "Z", { metaKey: true, shiftKey: true }, "redo"],
    ["Cmd+Y（瀏覽器的歷史記錄）", "y", { metaKey: true }, null],
    ["Ctrl+Z", "z", { ctrlKey: true }, null],
  ] as const)("Mac：%s → %s", (_label, k, mods, expected) => {
    expect(undoActionOf(key(k, mods), true)).toBe(expected);
  });

  it.each([
    ["Ctrl+Z", "z", { ctrlKey: true }, "undo"],
    ["Cmd+Z", "z", { metaKey: true }, "undo"],
    ["Cmd+Y", "y", { metaKey: true }, "redo"],
    ["Ctrl+S", "s", { ctrlKey: true }, null],
  ] as const)("undoKeyOf 不分平台：%s → %s", (_label, k, mods, expected) => {
    expect(undoKeyOf(key(k, mods))).toBe(expected);
  });
});

/** 共編編輯器，內容先寫進 Y.Doc（不在撤銷堆疊裡），再打一個字成為一步撤銷；焦點移到 `<body>`。 */
function setup(opts: { enabled?: boolean } = {}) {
  const mounted = mountEditor([P("x", "x1"), P("y", "y1")], { collab: true });
  cleanups.push(mounted.destroy);
  const editor = mounted.editor;
  // 同 NoteEditor 的 `useCollabUndoLifeline`：掛載之後接上撤銷的生命線。
  cleanups.push(keepCollabUndoAlive(editor));
  let enabled = opts.enabled ?? true;
  cleanups.push(attachPageUndoShortcut(editor, () => enabled));
  const manager = collabUndoManager(editor)!;
  editor.setTextCursorPosition("y1", "end");
  const view = editor.prosemirrorView as any;
  view.dispatch(view.state.tr.insertText("Q"));
  manager.stopCapturing();
  (document.activeElement as HTMLElement | null)?.blur();
  return { editor, view, manager, setEnabled: (v: boolean) => (enabled = v) };
}

/** 在 `target` 上送一次 keydown（冒泡到 window）。 */
function press(target: EventTarget, event: KeyboardEvent): KeyboardEvent {
  target.dispatchEvent(event);
  return event;
}

function addElement(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  cleanups.push(() => host.remove());
  return host.firstElementChild as HTMLElement;
}

describe("筆記頁的撤銷快捷鍵", () => {
  it("焦點在 <body>：Ctrl+Z 撤銷一步、preventDefault、焦點移回編輯器；Ctrl+Shift+Z、Ctrl+Y 各重做一步", () => {
    const { editor, view, manager } = setup();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
    expect(document.activeElement).toBe(document.body);
    const stack = manager.undoStack.length;
    const e = press(document.body, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
    expect(manager.undoStack.length).toBe(stack - 1);
    expect(document.activeElement).toBe(view.dom);

    view.dom.blur();
    expect(press(document.body, key("Z", { ctrlKey: true, shiftKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
    press(document.body, key("z", { ctrlKey: true }));
    view.dom.blur();
    expect(press(document.body, key("y", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("焦點在按鈕上、沒有東西可撤或可重做：焦點留在按鈕上、文件不動", () => {
    const { editor, view, manager } = setup();
    press(document.body, key("z", { ctrlKey: true }));
    expect(manager.undoStack.length, "前提：撤銷堆疊空了").toBe(0);
    view.dom.blur();
    const el = addElement("<button>share</button>");
    el.focus();
    press(el, key("z", { ctrlKey: true }));
    expect(document.activeElement, "撤銷：焦點不動").toBe(el);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
    press(el, key("y", { ctrlKey: true }));
    expect(shape(editor), "前提：重做一步").toBe("paragraph:x  paragraph:yQ");
    expect(document.activeElement, "有東西可重做：焦點移回編輯器").toBe(view.dom);
    el.focus();
    expect(manager.redoStack.length, "前提：重做堆疊空了").toBe(0);
    press(el, key("y", { ctrlKey: true }));
    expect(document.activeElement, "重做：焦點不動").toBe(el);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it.each([
    ["按鈕", "<button>share</button>"],
    ["勾選框（編輯器外，例如設定頁）", '<input type="checkbox" />'],
    ["單選鈕", '<input type="radio" />'],
    ["input 按鈕", '<input type="button" value="b" />'],
    ["滑桿", '<input type="range" />'],
    ["顏色 input", '<input type="color" />'],
    ["欄間分隔線（role=separator）", '<div role="separator" tabindex="0" aria-orientation="vertical"></div>'],
  ])("焦點在%s上（沒有自己的文字撤銷）：照樣撤銷", (_label, html) => {
    const { editor } = setup();
    const el = addElement(html);
    el.focus();
    expect(document.activeElement).toBe(el); // 前提
    expect(press(el, key("z", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
  });

  it.each([
    ["input（例如標題框）", '<input value="title" />'],
    ["textarea", "<textarea>t</textarea>"],
    ["select", "<select><option>a</option></select>"],
    ["編輯器以外的 contenteditable", '<div contenteditable="true">t</div>'],
  ])("焦點在 %s：不撤銷、不 preventDefault", (_label, html) => {
    const { editor } = setup();
    const el = addElement(html);
    el.focus();
    expect(document.activeElement).toBe(el); // 前提
    const e = press(el, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("按鍵在編輯器裡：只有編輯器的鍵位撤一步，冒泡上來不再撤一次", () => {
    const { editor, view, manager } = setup();
    view.dispatch(view.state.tr.insertText("R"));
    manager.stopCapturing();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQR"); // 前提：兩步
    view.focus();
    press(view.dom.querySelector(".bn-inline-content")!, key("z", { ctrlKey: true }));
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("按鍵目標在編輯器裡、編輯器的鍵位沒有東西可撤（沒 preventDefault）：不攔、不撤", () => {
    const { editor, view } = setup();
    press(document.body, key("z", { ctrlKey: true }));
    expect(shape(editor)).toBe("paragraph:x  paragraph:y"); // 前提：撤銷堆疊空了
    const e = press(view.dom.querySelector(".bn-inline-content")!, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
  });

  it.each([
    ["對話框", '<div role="dialog"></div>'],
    ["警示對話框", '<div role="alertdialog"></div>'],
    ["選單", '<div role="menu"></div>'],
    ["下拉清單", '<div role="listbox"></div>'],
    ["AI 框", '<div role="region" data-kb-ai-box=""></div>'],
    ["自訂顏色面板", '<div class="kb-color-panel"></div>'],
  ])("%s開著：不撤銷、不 preventDefault", (_label, html) => {
    const { editor } = setup();
    addElement(html);
    const e = press(document.body, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("輸入法組字中：不撤銷、不 preventDefault", () => {
    const { editor } = setup();
    const e = press(document.body, key("z", { ctrlKey: true, isComposing: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("事件已被處理過（defaultPrevented）：不撤銷", () => {
    const { editor } = setup();
    const e = key("z", { ctrlKey: true });
    e.preventDefault();
    expect(pageUndoYields(e)).toBe(true);
    press(document.body, e);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("唯讀：不撤銷、不 preventDefault", () => {
    const { editor } = setup();
    editor.isEditable = false;
    const e = press(document.body, key("z", { ctrlKey: true }));
    expect(e.defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });

  it("呼叫端關掉（簡報模式、版本預覽）：不撤銷；再打開就撤銷", () => {
    const { editor, setEnabled } = setup({ enabled: false });
    expect(press(document.body, key("z", { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
    setEnabled(true);
    expect(press(document.body, key("z", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(shape(editor)).toBe("paragraph:x  paragraph:y");
  });

  it("選取是要被撤銷移走的 block 的 NodeSelection：撤銷不丟例外、文件還原（#428 同一個雷）", () => {
    const { editor, view, manager } = setup();
    editor.insertBlocks([P("n", "n1")], "y1", "after");
    manager.stopCapturing();
    const Sel = (() => {
      let base = view.state.selection.constructor;
      for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
      return base;
    })();
    view.dispatch(view.state.tr.setSelection(Sel.fromJSON(view.state.doc, { type: "node", anchor: blockPos(editor, "n1") })));
    expect(view.state.selection.toJSON().type).toBe("node"); // 前提
    view.dom.blur();
    expect(() => press(document.body, key("z", { ctrlKey: true }))).not.toThrow();
    expect(shape(editor)).toBe("paragraph:x  paragraph:yQ");
  });
});
