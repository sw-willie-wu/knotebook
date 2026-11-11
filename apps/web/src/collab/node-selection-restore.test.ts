/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view／selection（型別在 apps/web 拿不到） */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { IMG, P, blockPos, integrity, pressKey, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

// y-prosemirror 以相對位置還原選取時，存的是 NodeSelection、而那個節點已經不在原位（被刪掉、被撤銷或重做移走），
// 原版直接 `NodeSelection.create`，位置後面沒有節點就丟 `reading 'nodeSize'`。例外丟在 Y 的觀察者裡：Y.Doc 已經改了、
// 編輯器卻沒更新，本機與共享文件從此不一致（#428）。`patches/y-prosemirror@1.3.7.patch` 讓它改用附近的文字選取。
//
// 這支只用一般的共編編輯器（沒有 app 的選項、沒有撤銷的生命線），所以守的就是那份修補：y-prosemirror 升級、修補沒套上時這裡會紅。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };

function makeEditor(doc: Y.Doc, name: string): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: name, name, color: "hsl(0 65% 45%)" } },
    } as any),
  ) as any as AnyEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  cleanups.push(() => {
    editor.unmount();
    el.remove();
    doc.destroy();
  });
  return editor;
}

/** alice 寫入初始內容、同步給 bob；兩邊各自一份 Y.Doc，經 `Y.applyUpdate` 互傳。 */
async function pair(initial: PartialBlockLike[]) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const alice = makeEditor(d1, "alice");
  await tick();
  alice.replaceBlocks(alice.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const bob = makeEditor(d2, "bob");
  await tick();
  const aliceToBob = () => Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
  const bobToAlice = () => Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
  /** 編輯器顯示的文件與它自己那份 Y.Doc 相同。 */
  const viewMatchesYDoc = (editor: AnyEditor, doc: Y.Doc) => {
    const view = editor.prosemirrorView!;
    return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(YDOC_FRAGMENT), view.state.schema).eq(view.state.doc);
  };
  return { alice, bob, d1, d2, aliceToBob, bobToAlice, viewMatchesYDoc };
}

const selectionType = (editor: AnyEditor): string => editor.prosemirrorView!.state.selection.toJSON().type;

/** 以 `fromJSON({ type: "node" })` 在 `pos` 建 NodeSelection（apps/web 拿不到 prosemirror-state 的值）。 */
function selectNode(editor: AnyEditor, pos: number): void {
  const view = editor.prosemirrorView! as any;
  let base = view.state.selection.constructor;
  for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
  view.dispatch(view.state.tr.setSelection(base.fromJSON(view.state.doc, { type: "node", anchor: pos })));
  expect(selectionType(editor), "前提：NodeSelection").toBe("node");
}

const IMAGE_AT_END = () => [P("x", "x1"), IMG("i1")];
const IMAGE_AT_COLUMN_END = () => [P("x", "x1"), row([[P("a", "a1"), IMG("i1")], [P("b", "b1")]], "r")];
const BLOCK_AT_END = () => [P("x", "x1"), P("y", "i1")];

describe("協作者刪掉你選取（NodeSelection）的 block", () => {
  it.each([
    ["文件結尾的圖片", IMAGE_AT_END, 0, "paragraph:x"],
    ["文件結尾的圖片（選取圖片本身）", IMAGE_AT_END, 1, "paragraph:x"],
    ["第 1 欄最後一個 block 的圖片", IMAGE_AT_COLUMN_END, 0, "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]"],
    ["文件結尾的段落（整個 block）", BLOCK_AT_END, 0, "paragraph:x"],
  ] as const)("%s：bob 刪掉它 → alice 收到更新不丟例外、畫面與共享文件相同、之後打字兩邊一致", async (_label, content, offset, without) => {
    const { alice, bob, d1, aliceToBob, bobToAlice, viewMatchesYDoc } = await pair(content());
    selectNode(alice, blockPos(alice, "i1") + offset);
    bob.removeBlocks(["i1"]);
    expect(shape(bob)).toBe(without);
    expect(() => bobToAlice()).not.toThrow();
    await tick();
    expect(shape(alice)).toBe(without);
    expect(viewMatchesYDoc(alice, d1)).toBe(true);
    expect(selectionType(alice)).toBe("text");
    expect(integrity(alice)).toEqual(CLEAN);
    alice.setTextCursorPosition("x1", "end");
    alice.prosemirrorView!.dispatch(alice.prosemirrorView!.state.tr.insertText("T"));
    aliceToBob();
    await tick();
    expect(shape(bob)).toBe(without.replace("paragraph:x", "paragraph:xT"));
    expect(shape(alice)).toBe(shape(bob));
  });

  it("選取的圖片還在（協作者改的是別處）→ 收到更新之後仍是那張圖片的 NodeSelection", async () => {
    const { alice, bob, d1, bobToAlice, viewMatchesYDoc } = await pair(IMAGE_AT_END());
    const at = blockPos(alice, "i1");
    selectNode(alice, at);
    bob.setTextCursorPosition("x1", "end");
    bob.prosemirrorView!.dispatch(bob.prosemirrorView!.state.tr.insertText("Q"));
    expect(() => bobToAlice()).not.toThrow();
    await tick();
    expect(shape(alice)).toBe("paragraph:xQ  image");
    expect(viewMatchesYDoc(alice, d1)).toBe(true);
    const sel = alice.prosemirrorView!.state.selection as any;
    expect(sel.toJSON().type).toBe("node");
    expect(sel.node.attrs.id).toBe("i1");
    expect(sel.from).toBe(at + 1);
  });
});

describe("撤銷與重做還原的 NodeSelection 指到已移走的 block", () => {
  it.each([
    ["文件結尾", IMAGE_AT_END, "paragraph:x"],
    ["第 1 欄的最後一個 block", IMAGE_AT_COLUMN_END, "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]"],
  ] as const)("圖片在%s：選取 → Backspace → Ctrl+Z → 立刻 Ctrl+Shift+Z → 不丟例外、重做生效、本機與共享文件相同", async (_label, content, without) => {
    const { alice, bob, d2, bobToAlice, viewMatchesYDoc } = await pair(content());
    selectNode(bob, blockPos(bob, "i1"));
    expect(pressKey(bob, "Backspace")).toBe(true);
    expect(shape(bob)).toBe(without);
    expect(() => pressKey(bob, "z", { ctrlKey: true })).not.toThrow();
    expect(shape(bob)).toContain("image");
    // 撤銷之後留著「刪除之前」的選取（圖片的 NodeSelection），重做在圖片又被移走之後以它還原。
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(without);
    expect(viewMatchesYDoc(bob, d2)).toBe(true);
    bobToAlice();
    await tick();
    expect(shape(alice)).toBe(without);
    expect(integrity(bob)).toEqual(CLEAN);
  });

  it("選取剛插入的圖片（NodeSelection）時撤銷把它移走 → 不丟例外、本機與共享文件相同", async () => {
    const { alice, bob, d2, bobToAlice, viewMatchesYDoc } = await pair([P("x", "x1"), P("y", "y1")]);
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.insertBlocks([IMG("i1")], "y1", "after");
    manager.stopCapturing();
    selectNode(bob, blockPos(bob, "i1"));
    expect(() => pressKey(bob, "z", { ctrlKey: true })).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x  paragraph:y");
    expect(viewMatchesYDoc(bob, d2)).toBe(true);
    bobToAlice();
    await tick();
    expect(shape(alice)).toBe("paragraph:x  paragraph:y");
  });
});
