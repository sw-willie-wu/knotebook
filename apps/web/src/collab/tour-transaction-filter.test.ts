import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { registerEditor, setDemoTransactionFilter } from "@/lib/tour-bridge";
import { createTourTransactionFilterExtension } from "./tour-transaction-filter";
import { isTourTransactionFilterOn, setTourTransactionFilter, TOUR_TRANSACTION_META } from "./tour-filter-flag";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror 節點型別在 apps/web 值層級拿不到
type Any = any;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** 共編編輯器（自己一份 Y.Doc），掛上過濾 extension 並 mount：未 mount 的編輯器沒有 PM 外掛。 */
function mountEditor(doc: Y.Doc, extensions = [createTourTransactionFilterExtension()]): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      _tiptapOptions: { extensions },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  ) as any as AnyEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  cleanups.push(() => {
    editor.unmount();
    el.remove();
  });
  return editor;
}

async function setup(text = "hello"): Promise<{ doc: Y.Doc; editor: AnyEditor }> {
  const doc = new Y.Doc();
  cleanups.push(() => doc.destroy());
  const editor = mountEditor(doc);
  await tick();
  editor.replaceBlocks(editor.document, [{ type: "paragraph", content: text }]);
  return { doc, editor };
}

function texts(editor: AnyEditor): string[] {
  return editor.document.map((b: { content?: unknown }) =>
    Array.isArray(b.content) ? b.content.map((n: { text?: string }) => n.text ?? "").join("") : "",
  );
}

/** 第一個 textblock 結尾的位置。 */
function endOfFirstText(editor: AnyEditor): number {
  let end = -1;
  editor._tiptapEditor.state.doc.descendants((node: Any, pos: number) => {
    if (end !== -1) return false;
    if (node.isTextblock) {
      end = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  return end;
}

/** 文件裡每個 blockContainer 的 id 屬性（沒有 id 時是 null）。 */
function blockIds(editor: AnyEditor): unknown[] {
  const ids: unknown[] = [];
  editor._tiptapEditor.state.doc.descendants((node: Any) => {
    if (node.type.name === "blockContainer") ids.push(node.attrs.id);
    return true;
  });
  return ids;
}

/** 在最外層 blockGroup 尾端插入第一個 block 的複本，但 id 是 null：BlockNote 的 UniqueID 會用附加交易補上。 */
function appendBlockWithoutId(state: Any): Any {
  const group = state.doc.firstChild;
  const first = group.firstChild;
  const copy = first.type.create({ ...first.attrs, id: null }, first.content);
  return state.tr.insert(1 + group.content.size, copy);
}

/** 一般打字的形：一筆 insertText 交易。 */
function typeAtEnd(editor: AnyEditor, text: string, meta?: [string, unknown]): void {
  const view = editor._tiptapEditor.view;
  const tr = view.state.tr.insertText(text, endOfFirstText(editor));
  if (meta) tr.setMeta(meta[0], meta[1]);
  view.dispatch(tr);
}

describe("導覽交易過濾（帶 Y.Doc 共編的真編輯器）", () => {
  it("F1 開關關著：一般 insertText 照常寫入，也寫進 Y.Doc", async () => {
    const { doc, editor } = await setup();
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    const before = Y.encodeStateVector(doc);
    typeAtEnd(editor, " world");
    expect(texts(editor)).toEqual(["hello world"]);
    expect(Y.encodeStateVector(doc)).not.toEqual(before);
  });

  it("F1 開關記在編輯器實例上：另一個編輯器開著，這一個照常寫入", async () => {
    const { editor: a } = await setup();
    const { editor: b } = await setup();
    setTourTransactionFilter(b._tiptapEditor, true);
    typeAtEnd(a, "a");
    typeAtEnd(b, "b");
    expect(texts(a)).toEqual(["helloa"]);
    expect(texts(b)).toEqual(["hello"]);
  });

  it("F2 開著：一般 insertText、帶 composition meta 的交易都被擋，文件與 Y.Doc 不變", async () => {
    const { doc, editor } = await setup();
    setTourTransactionFilter(editor._tiptapEditor, true);
    const before = Y.encodeStateVector(doc);
    typeAtEnd(editor, "x");
    typeAtEnd(editor, "測", ["composition", 1]);
    expect(texts(editor)).toEqual(["hello"]);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it("F2 開著：只改選取的交易放行", async () => {
    const { editor } = await setup();
    const end = endOfFirstText(editor);
    editor._tiptapEditor.commands.setTextSelection(end);
    setTourTransactionFilter(editor._tiptapEditor, true);
    editor._tiptapEditor.commands.setTextSelection(end - 2);
    expect(editor._tiptapEditor.state.selection.from).toBe(end - 2);
    expect(texts(editor)).toEqual(["hello"]);
  });

  it("F2 開著：帶導覽 meta 的改文件交易放行", async () => {
    const { editor } = await setup();
    setTourTransactionFilter(editor._tiptapEditor, true);
    typeAtEnd(editor, "!", [TOUR_TRANSACTION_META, true]);
    expect(texts(editor)).toEqual(["hello!"]);
  });

  it("F3 開著：另一個 Y.Doc 的 update 套進來（y-sync$）→ 內容照常出現", async () => {
    const { doc: d1, editor: a } = await setup();
    const d2 = new Y.Doc();
    cleanups.push(() => d2.destroy());
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const b = mountEditor(d2, []);
    await tick();
    expect(texts(b)).toEqual(["hello"]);

    setTourTransactionFilter(a._tiptapEditor, true);
    typeAtEnd(b, " from B");
    expect(texts(b)).toEqual(["hello from B"]);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    await tick();
    expect(texts(a)).toEqual(["hello from B"]);
    // 對照：同一個編輯器自己打的字仍被擋，證明上面那筆是靠 y-sync$ 放行的。
    typeAtEnd(a, "x");
    expect(texts(a)).toEqual(["hello from B"]);
  });

  it("F2 開著：帶導覽 meta 插入沒有 id 的 block → 補 id 的附加交易照樣放行；不帶 meta 的插入仍被擋", async () => {
    const { editor } = await setup();
    const tiptap = editor._tiptapEditor;
    setTourTransactionFilter(tiptap, true);
    tiptap.view.dispatch(appendBlockWithoutId(tiptap.state));
    expect(blockIds(editor)).toHaveLength(1);
    tiptap.view.dispatch(appendBlockWithoutId(tiptap.state).setMeta(TOUR_TRANSACTION_META, true));
    const ids = blockIds(editor);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("F3 開著：遠端套進一個沒有 id 的 block → 本機補上 id（附加交易跟著遠端同步放行）", async () => {
    const { doc: d1, editor: a } = await setup();
    const d2 = new Y.Doc();
    cleanups.push(() => d2.destroy());
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    setTourTransactionFilter(a._tiptapEditor, true);

    // 不經編輯器的寫入者：直接在 Y 裡加一個沒有 id 屬性的 block。
    const group = d2.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
    const block = new Y.XmlElement("blockContainer");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("remote")]);
    block.insert(0, [paragraph]);
    group.insert(group.length, [block]);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    await tick();

    expect(texts(a)).toEqual(["hello", "remote"]);
    const ids = blockIds(a);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("F4 開關切換多次：state.plugins 數量與身分不變，不呼叫 registerPlugin／unregisterPlugin", async () => {
    const { editor } = await setup();
    const tiptap = editor._tiptapEditor;
    const register = vi.spyOn(tiptap, "registerPlugin");
    const unregister = vi.spyOn(tiptap, "unregisterPlugin");
    const before = [...tiptap.state.plugins];
    for (const on of [true, false, true, false, true]) {
      setTourTransactionFilter(tiptap, on);
      typeAtEnd(editor, "x");
    }
    setTourTransactionFilter(tiptap, false);
    const after = tiptap.state.plugins;
    expect(after).toHaveLength(before.length);
    after.forEach((plugin: unknown, i: number) => expect(plugin).toBe(before[i]));
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    // 開、關、開、關、開各打一次：只有兩次關著時打的字進文件，開關切換多次後仍然有效。
    expect(texts(editor)).toEqual(["helloxx"]);
  });
});

describe("導覽交易過濾：經登記處開關", () => {
  it("F5 setDemoTransactionFilter 的 id 與登記的不同 → 不生效；相同 → 生效", async () => {
    const { editor } = await setup();
    const unregister = registerEditor("note-1", editor);
    cleanups.push(unregister);
    expect(setDemoTransactionFilter("other", true)).toBe(false);
    typeAtEnd(editor, "a");
    expect(texts(editor)).toEqual(["helloa"]);

    expect(setDemoTransactionFilter("note-1", true)).toBe(true);
    typeAtEnd(editor, "b");
    expect(texts(editor)).toEqual(["helloa"]);
    expect(setDemoTransactionFilter("note-1", false)).toBe(true);
    typeAtEnd(editor, "c");
    expect(texts(editor)).toEqual(["helloac"]);
  });

  it("F6 撤登記後開關關掉，打字照常寫入", async () => {
    const { editor } = await setup();
    const unregister = registerEditor("note-1", editor);
    setDemoTransactionFilter("note-1", true);
    typeAtEnd(editor, "a");
    expect(texts(editor)).toEqual(["hello"]);
    unregister();
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    typeAtEnd(editor, "b");
    expect(texts(editor)).toEqual(["hellob"]);
  });

  it("F6 編輯器已卸載後才撤登記：不拋錯、開關關掉", async () => {
    const { editor } = await setup();
    const unregister = registerEditor("note-1", editor);
    setDemoTransactionFilter("note-1", true);
    editor.unmount();
    expect(() => unregister()).not.toThrow();
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
  });
});
