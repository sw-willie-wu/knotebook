/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view／selection（型別在 apps/web 拿不到） */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager, keepCollabUndoAlive } from "@/collab/undo";
import type { EditorRef } from "@/components/wikilink/menu";
import { IMG, P, blockPos, cursorOf, integrity, pressKey, row, shape, startBlockDrag, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

// ⋮⋮ 拖放之後的撤銷與焦點（#428、#429、#430）。拖放的那顆編輯器（bob）以 `buildNoteEditorOptions` 的完整選項掛（`handleDrop` 串接、
// 拖曳來源記錄器都在）；另一顆（alice）是一般的共編編輯器，用來看共享文件。兩顆各自一份 Y.Doc，經 `Y.applyUpdate` 互傳。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  toastMock.mockReset();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };

type Box = readonly [left: number, top: number, right: number, bottom: number];
const ORIGINAL_RECT = Element.prototype.getBoundingClientRect;

/**
 * jsdom 的 rect 全是 0：落點那顆編輯器根層的 `.bn-block-group` 回包住所有測試座標的框（core SideMenu 以它找最近的編輯器），
 * 另一顆放到很遠；其餘元素照 `<data-node-type>:<data-id>` 查表。
 */
function mockRects(target: AnyEditor, boxes: Record<string, Box> = {}): void {
  const dom = target.prosemirrorView!.dom;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    let box: Box | undefined;
    if (this.classList.contains("bn-block-group") && this.parentElement?.classList.contains("bn-editor")) {
      box = this.parentElement === dom ? [0, 0, 1000, 1000] : [5000, 0, 6000, 1000];
    } else if (dom.contains(this)) {
      box = boxes[`${this.getAttribute("data-node-type")}:${this.getAttribute("data-id")}`];
    }
    return box ? new DOMRect(box[0], box[1], box[2] - box[0], box[3] - box[1]) : ORIGINAL_RECT.call(this);
  });
}

function rowBoxes(id: string, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, 100, 600, 300] };
  for (let i = 0; i < n; i++) out[`column:${id}c${i}`] = [i * (width + 24), 100, i * (width + 24) + width, 300];
  return out;
}

function makeEditor(doc: Y.Doc, name: string, full: boolean): AnyEditor {
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create(
    full
      ? buildNoteEditorOptions({
          doc,
          provider: { awareness: null } as never,
          user: { id: name, name },
          language: "en",
          translate: (k) => k,
          editorRef,
          noteId: "n",
          siteLinks: { current: null },
        })
      : withCollaboration({
          schema: noteSchema,
          collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: name, name, color: "hsl(0 65% 45%)" } },
        } as any),
  ) as any as AnyEditor;
  editorRef.current = editor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  // 同 NoteEditor 的 `useCollabUndoLifeline`：掛載之後接上撤銷的生命線。
  const disarm = full ? keepCollabUndoAlive(editor) : () => {};
  cleanups.push(() => {
    disarm();
    editor.unmount();
    el.remove();
    doc.destroy();
  });
  return editor;
}

/** alice（一般共編）寫入初始內容、同步給 bob（完整選項）；初始內容不在 bob 的撤銷堆疊裡。 */
async function pair(initial: PartialBlockLike[]) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const alice = makeEditor(d1, "alice", false);
  await tick();
  alice.replaceBlocks(alice.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const bob = makeEditor(d2, "bob", true);
  await tick();
  const sync = async () => {
    const u1 = Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2));
    const u2 = Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1));
    Y.applyUpdate(d2, u1);
    Y.applyUpdate(d1, u2);
    await tick();
  };
  /** 單向：只把 bob 的更新送給 alice（bob 這邊不跑任何 Y 交易）。 */
  const bobToAlice = () => Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
  /** 單向：只把 alice 的更新送給 bob。 */
  const aliceToBob = () => Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
  return { alice, bob, sync, bobToAlice, aliceToBob };
}

/** `id` 那個 block 第一個 textblock 的文字結尾（落點在它的下半部：PM 的 `dropPoint` 插在這個 block 之後）。 */
const textEnd = (editor: AnyEditor, id: string): number => {
  const pos = blockPos(editor, id);
  return pos + 2 + editor.prosemirrorView!.state.doc.nodeAt(pos)!.firstChild!.content.size;
};

/** 對 `view.dom` dispatch drop（`posAtCoords` 固定回 `pos`）。 */
function dispatchDrop(editor: AnyEditor, dataTransfer: unknown, pos: number, at: readonly [number, number], extra: { ctrlKey?: boolean } = {}): DragEvent {
  const view = editor.prosemirrorView! as any;
  view.posAtCoords = () => ({ pos, inside: -1 });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: at[0] });
  Object.defineProperty(event, "clientY", { value: at[1] });
  Object.defineProperty(event, "ctrlKey", { value: !!extra.ctrlKey });
  Object.defineProperty(event, "altKey", { value: false });
  view.dom.dispatchEvent(event);
  return event as DragEvent;
}

/**
 * 瀏覽器在 ⋮⋮ 上送的 dragend：⋮⋮ 自己的 handler 呼叫 core `blockDragEnd`（它會讓編輯器失焦），之後冒泡到 document。
 * ⋮⋮ 替身掛在編輯器容器內（同 `startBlockDrag`）。
 */
function dragEndFromHandle(editor: AnyEditor): void {
  const handle = document.createElement("div");
  editor.domElement!.parentElement!.appendChild(handle);
  handle.addEventListener("dragend", () => (editor.getExtension("sideMenu") as unknown as { blockDragEnd(): void }).blockDragEnd());
  handle.dispatchEvent(new Event("dragend", { bubbles: true }));
  handle.remove();
}

/** ⋮⋮ 拖 `drag`（`range` 給多選）放到 `target` 的下半部；`beforeDrop` 在 dragstart 之後、drop 之前跑。 */
async function blockDrop(
  editor: AnyEditor,
  g: { drag: string; range?: readonly [string, string]; target: string; at?: readonly [number, number]; boxes?: Record<string, Box>; ctrlKey?: boolean },
  beforeDrop?: () => Promise<void>,
): Promise<DragEvent> {
  mockRects(editor, g.boxes);
  const { dataTransfer } = startBlockDrag(editor, g.drag, { range: g.range });
  await beforeDrop?.();
  const event = dispatchDrop(editor, dataTransfer, textEnd(editor, g.target), g.at ?? [300, 150], { ctrlKey: g.ctrlKey });
  dragEndFromHandle(editor);
  return event;
}

const ids = (editor: AnyEditor): string[] => editor.document.map((b) => b.id);
const selectionType = (editor: AnyEditor): string => editor.prosemirrorView!.state.selection.toJSON().type;

/** 頁面錯誤的替身：y-prosemirror 在 Y 觀察者裡丟的例外會從 `undo()` 冒出來。 */
function undoOnce(editor: AnyEditor): void {
  expect(pressKey(editor, "z", { ctrlKey: true }), "Ctrl+Z 有 handler 接手").toBe(true);
}

const XROWZ = () => [P("x", "x1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")];

describe("#428 橫線放進既有欄之後立刻 Ctrl+Z", () => {
  it.each([
    ["z 放到 a 下方（進第 1 欄）", "a1", "paragraph:x  ROW[COL(paragraph:a,paragraph:z) | COL(paragraph:b)]"],
    ["z 放到 b 下方（進第 2 欄）", "b1", "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:z)]"],
  ] as const)("%s → 放下後不是 NodeSelection；一下 Ctrl+Z 就還原、不丟例外、本機與共享文件相同、id 不變", async (_label, target, moved) => {
    const { alice, bob, sync } = await pair(XROWZ());
    const before = shape(bob);
    const beforeIds = ids(bob);
    await blockDrop(bob, { drag: "z1", target, at: [target === "a1" ? 150 : 450, 150], boxes: rowBoxes("r", 2) });
    expect(shape(bob)).toBe(moved);
    expect.soft(selectionType(bob), "放下後的選取").toBe("text");
    expect.soft(cursorOf(bob)).toBe("z@0");
    await sync();
    expect(shape(alice)).toBe(moved);

    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe(before);
    expect(ids(bob)).toEqual(beforeIds);
    await sync();
    expect(shape(alice)).toBe(before);
    expect(integrity(bob)).toEqual(CLEAN);

    // 重做：撤銷時 y-prosemirror 留著「放下之前」的選取，重做以它還原。
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(moved);
    await sync();
    expect(shape(alice)).toBe(moved);
  });

  it("z 放進第 1 欄 → Ctrl+Z 之後立刻 Ctrl+Shift+Z（中間沒有任何 Y 交易）→ 不丟例外、回到放下後、兩邊相同", async () => {
    // 撤銷之後 y-prosemirror 留著這一步「放下之前」的選取，下一筆非本機編輯的 Y 交易（這裡是重做）以它還原；
    // 中間若有任何 Y 交易（例如同步），它就被用掉了，所以這一案兩下之間不同步。
    const { alice, bob, sync } = await pair(XROWZ());
    await blockDrop(bob, { drag: "z1", target: "a1", at: [150, 150], boxes: rowBoxes("r", 2) });
    const moved = shape(bob);
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(moved);
    await sync();
    expect(shape(alice)).toBe(moved);
  });

  it("頂層排序（x y z 拖 x 到 z 下方）→ 一下 Ctrl+Z 還原、id 不變、只多一步撤銷", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const manager = collabUndoManager(bob)!;
    const stack = manager.undoStack.length;
    await blockDrop(bob, { drag: "x1", target: "z1" });
    expect(shape(bob)).toBe("paragraph:y  paragraph:z  paragraph:x");
    expect(ids(bob)).toEqual(["y1", "z1", "x1"]);
    expect.soft(selectionType(bob)).toBe("text");
    expect(manager.undoStack.length).toBe(stack + 1);
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
    expect(ids(bob)).toEqual(["x1", "y1", "z1"]);
  });

  it("打完字馬上排序、排完馬上打字（都在 500ms 內）→ 排序自成一步：Ctrl+Z 依序撤掉後打的字、排序、先打的字", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const view = bob.prosemirrorView!;
    bob.setTextCursorPosition("y1", "end");
    view.dispatch(view.state.tr.insertText("Q"));
    await blockDrop(bob, { drag: "x1", target: "z1" });
    expect(shape(bob)).toBe("paragraph:yQ  paragraph:z  paragraph:x");
    view.dispatch(view.state.tr.insertText("R"));
    expect(shape(bob)).toBe("paragraph:yQ  paragraph:z  paragraph:Rx");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:yQ  paragraph:z  paragraph:x");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:yQ  paragraph:z");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
  });

  it("多選拖曳（a b 拖到 c 下方）→ 放下後是跨兩段的文字選取（再拖一次仍是兩個 block）、一下 Ctrl+Z 還原", async () => {
    const { bob } = await pair([P("a", "a1"), P("b", "b1"), P("c", "c1"), P("d", "d1")]);
    await blockDrop(bob, { drag: "a1", range: ["a1", "b1"], target: "c1" });
    expect(shape(bob)).toBe("paragraph:c  paragraph:a  paragraph:b  paragraph:d");
    const sel = bob.prosemirrorView!.state.selection;
    expect(sel.toJSON().type).toBe("text");
    expect(sel.$from.parent.textContent).toBe("a");
    expect(sel.$to.parent.textContent).toBe("b");
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:d");
    expect(ids(bob)).toEqual(["a1", "b1", "c1", "d1"]);
  });

  it.each([
    ["橫線排序（x 拖到 z 下方）", { drag: "x1", target: "z1" }, "paragraph:y  paragraph:z  paragraph:x"],
    ["直線建列（x 拖到 z 右緣）", { drag: "x1", target: "z1", at: [590, 165] as const, boxes: { "blockOuter:z1": [0, 150, 600, 180] as Box } }, "paragraph:y  ROW[COL(paragraph:z) | COL(paragraph:x)]  paragraph"],
  ] as const)("%s → 撤銷再重做：重做之後是游標，不是整塊選取 x 原位的 y", async (_label, g, moved) => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, g);
    expect(shape(bob)).toBe(moved);
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
    pressKey(bob, "z", { ctrlKey: true, shiftKey: true });
    expect(shape(bob)).toBe(moved);
    expect(selectionType(bob)).toBe("text");
  });
});

describe("#429 多選拖曳途中有協作者打字", () => {
  it("a b 拖到 c 下方，拖曳中 alice 在 d 打字（bob 的多選退化成文字選取）→ a b 整塊搬走、沒有空段落、兩邊相同", async () => {
    const { alice, bob, sync } = await pair([P("a", "a1"), P("b", "b1"), P("c", "c1"), P("d", "d1")]);
    await blockDrop(bob, { drag: "a1", range: ["a1", "b1"], target: "c1" }, async () => {
      expect(selectionType(bob), "前提：dragstart 後是多選").not.toBe("text");
      alice.setTextCursorPosition("d1", "end");
      alice.prosemirrorView!.dispatch(alice.prosemirrorView!.state.tr.insertText("Q"));
      await sync();
      expect(shape(bob)).toContain("paragraph:dQ");
      expect(selectionType(bob), "前提：遠端更新之後多選退化成文字選取").toBe("text");
    });
    expect(shape(bob)).toBe("paragraph:c  paragraph:a  paragraph:b  paragraph:dQ");
    expect(ids(bob)).toEqual(["c1", "a1", "b1", "d1"]);
    expect(integrity(bob)).toEqual(CLEAN);
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    expect(ids(alice)).toEqual(ids(bob));

    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:dQ");
    expect(ids(bob)).toEqual(["a1", "b1", "c1", "d1"]);
    await sync();
    expect(shape(alice)).toBe(shape(bob));
  });
});

/** 以 `fromJSON({ type: "node" })` 在 `pos` 建 NodeSelection（apps/web 拿不到 prosemirror-state 的值）。 */
function selectNode(editor: AnyEditor, pos: number): void {
  const view = editor.prosemirrorView! as any;
  let base = view.state.selection.constructor;
  for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
  view.dispatch(view.state.tr.setSelection(base.fromJSON(view.state.doc, { type: "node", anchor: pos })));
  expect(selectionType(editor), "前提：NodeSelection").toBe("node");
}

describe("#428 撤銷當下的選取是 NodeSelection", () => {
  it("撤銷堆疊是空的：Ctrl+Z 不動選取，圖片仍是 NodeSelection", async () => {
    const { bob } = await pair([P("x", "x1"), IMG("i1")]);
    expect(collabUndoManager(bob)!.undoStack.length, "前提：沒有東西可撤").toBe(0);
    selectNode(bob, blockPos(bob, "i1"));
    pressKey(bob, "z", { ctrlKey: true });
    expect(selectionType(bob)).toBe("node");
    expect(shape(bob)).toBe("paragraph:x  image");
  });

  it.each([
    ["x 複製到 z 下方（文件結尾）", XROWZ, { drag: "x1", target: "z1" }, "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z  paragraph:x"],
    ["z 複製到 a 下方（第 1 欄結尾）", XROWZ, { drag: "z1", target: "a1", at: [150, 150] as const, boxes: rowBoxes("r", 2) }, "paragraph:x  ROW[COL(paragraph:a,paragraph:z) | COL(paragraph:b)]  paragraph:z"],
  ] as const)("Ctrl 複製拖：%s → 焦點在編輯器，不點直接 Ctrl+Z → 一步、不丟例外、本機與共享文件相同", async (_label, content, g, copied) => {
    const { alice, bob, sync } = await pair(content());
    const before = shape(bob);
    const manager = collabUndoManager(bob)!;
    await blockDrop(bob, { ...g, ctrlKey: true });
    expect(shape(bob)).toBe(copied);
    expect(document.activeElement, "焦點在編輯器").toBe(bob.prosemirrorView!.dom);
    const stack = manager.undoStack.length;
    expect(() => undoOnce(bob)).not.toThrow();
    expect(manager.undoStack.length).toBe(stack - 1);
    expect(shape(bob)).toBe(before);
    await sync();
    expect(shape(alice)).toBe(before);
    expect(integrity(bob)).toEqual(CLEAN);
  });

  it.each([
    ["圖片的 block", 0],
    ["圖片本身", 1],
  ] as const)("選取%s（NodeSelection）、撤銷把剛插入的圖片移走 → 不丟例外、本機與共享文件相同", async (_label, offset) => {
    const { alice, bob, sync } = await pair([P("x", "x1"), P("y", "y1")]);
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.insertBlocks([IMG("i1")], "y1", "after");
    manager.stopCapturing();
    await sync();
    expect(shape(alice)).toBe("paragraph:x  paragraph:y  image");
    selectNode(bob, blockPos(bob, "i1") + offset);
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x  paragraph:y");
    await sync();
    expect(shape(alice)).toBe("paragraph:x  paragraph:y");
  });

  it.each([
    ["Ctrl+Shift+Z", { ctrlKey: true, shiftKey: true }, "z"],
    ["Ctrl+Y", { ctrlKey: true }, "y"],
  ] as const)("重做（%s）時是 NodeSelection、重做把那個 block 移走 → 不丟例外", async (_label, mods, key) => {
    const { alice, bob, sync } = await pair([P("x", "x1"), P("y", "y1")]);
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.removeBlocks(["y1"]);
    manager.stopCapturing();
    expect(shape(bob)).toBe("paragraph:x");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y");
    await sync();
    selectNode(bob, blockPos(bob, "y1"));
    expect(() => pressKey(bob, key, mods)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x");
    await sync();
    expect(shape(alice)).toBe("paragraph:x");
  });
});

describe("#428 撤銷步驟記下的「操作前選取」是 NodeSelection（撤銷之後的下一筆 Y 交易以它還原）", () => {
  const IMAGE_AT_END = () => [P("x", "x1"), IMG("i1")];
  const IMAGE_AT_COLUMN_END = () => [P("x", "x1"), row([[P("a", "a1"), IMG("i1")], [P("b", "b1")]], "r")];
  const without = (content: "end" | "column") =>
    content === "end" ? "paragraph:x" : "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]";

  /** 選取圖片（NodeSelection）→ Backspace 刪掉 → Ctrl+Z 還原。 */
  function deleteSelectedImageThenUndo(bob: AnyEditor, where: "end" | "column"): void {
    selectNode(bob, blockPos(bob, "i1"));
    expect(pressKey(bob, "Backspace"), "Backspace 有 handler 接手").toBe(true);
    expect(shape(bob), "前提：圖片刪掉了").toBe(without(where));
    undoOnce(bob);
    expect(shape(bob), "前提：撤銷後圖片回來").toContain("image");
  }

  it.each([
    ["文件結尾", IMAGE_AT_END, "end"],
    ["第 1 欄的最後一個 block", IMAGE_AT_COLUMN_END, "column"],
  ] as const)("圖片在%s：選取 → Backspace → Ctrl+Z → 立刻 Ctrl+Shift+Z → 不丟例外、重做生效、本機與共享文件相同", async (_label, content, where) => {
    const { alice, bob, sync } = await pair(content());
    // alice 寫入內容之後選取停在最後插入的圖片上；這一案只看 bob 的撤銷，先把 alice 的游標放到文字裡。
    alice.setTextCursorPosition("x1", "end");
    deleteSelectedImageThenUndo(bob, where);
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(without(where));
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    expect(integrity(bob)).toEqual(CLEAN);
  });

  it.each([
    ["文件結尾", IMAGE_AT_END, "end"],
    ["第 1 欄的最後一個 block", IMAGE_AT_COLUMN_END, "column"],
  ] as const)("圖片在%s：選取 → Backspace → Ctrl+Z，接著收到協作者刪掉那張圖的遠端更新（bob 這邊中間沒有別的 Y 交易）→ 不丟例外、兩邊相同；之後打字、撤銷照常", async (_label, content, where) => {
    const { alice, bob, sync, bobToAlice, aliceToBob } = await pair(content());
    alice.setTextCursorPosition("x1", "end");
    deleteSelectedImageThenUndo(bob, where);
    expect(() => bobToAlice()).not.toThrow();
    await tick();
    expect(shape(alice), "前提：alice 看到圖片回來").toContain("image");
    alice.removeBlocks(["i1"]);
    expect(() => aliceToBob()).not.toThrow();
    await tick();
    expect(shape(bob)).toBe(without(where));
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.setTextCursorPosition("x1", "end");
    bob.prosemirrorView!.dispatch(bob.prosemirrorView!.state.tr.insertText("Q"));
    expect(shape(bob)).toContain("paragraph:xQ");
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe(without(where));
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    expect(integrity(bob)).toEqual(CLEAN);
  });
});

describe("拖曳途中協作者在被拖的 block 打字（docs/known-limitations.md）", () => {
  /** bob 按住 z 的 ⋮⋮；alice 在 z 結尾打 Q、同步給 bob；bob 放下。 */
  async function dragWhileAliceTypesInZ(content: PartialBlockLike[], g: Parameters<typeof blockDrop>[1]) {
    const p = await pair(content);
    await blockDrop(p.bob, g, async () => {
      p.alice.setTextCursorPosition("z1", "end");
      p.alice.prosemirrorView!.dispatch(p.alice.prosemirrorView!.state.tr.insertText("Q"));
      await p.sync();
      expect(shape(p.bob), "前提：bob 收到 alice 打的字").toContain("paragraph:zQ");
    });
    await p.sync();
    expect(shape(p.alice)).toBe(shape(p.bob));
    return p;
  }

  it("放到另一個 block 上方或下方（橫線）：落下的是拖曳開始時的內容，alice 打的字不見", async () => {
    const { bob } = await dragWhileAliceTypesInZ([P("x", "x1"), P("y", "y1"), P("z", "z1")], { drag: "z1", target: "x1" });
    expect(shape(bob)).toBe("paragraph:x  paragraph:z  paragraph:y");
  });

  it("放到另一個 block 旁邊（直線建列）：落下的是放下當下的內容，alice 打的字留著", async () => {
    const { bob } = await dragWhileAliceTypesInZ([P("x", "x1"), P("y", "y1"), P("z", "z1")], {
      drag: "z1",
      target: "x1",
      at: [590, 115],
      boxes: { "blockOuter:x1": [0, 100, 600, 130] },
    });
    expect(shape(bob)).toBe("ROW[COL(paragraph:x) | COL(paragraph:zQ)]  paragraph:y");
  });

  it("放進空欄：落下的是放下當下的內容，alice 打的字留著", async () => {
    const { bob } = await dragWhileAliceTypesInZ([row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r"), P("z", "z1")], {
      drag: "z1",
      target: "e1",
      at: [450, 200],
      boxes: rowBoxes("r", 2),
    });
    expect(shape(bob)).toBe("ROW[COL(paragraph:a) | COL(paragraph:zQ)]");
  });
});

describe("#430 ⋮⋮ 放下之後焦點留在編輯器", () => {
  it.each([
    ["橫線排序", { drag: "x1", target: "z1" }, "paragraph:y  paragraph:z  paragraph:x"],
    ["直線建列", { drag: "z1", target: "x1", at: [590, 115] as const, boxes: { "blockOuter:x1": [0, 100, 600, 130] as Box } }, "ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y"],
  ] as const)("%s：⋮⋮ 的 dragend 讓編輯器失焦之後焦點拉回編輯器，游標在被拖 block 開頭；直接 Ctrl+Z 一下還原", async (_label, g, moved) => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, g);
    expect(shape(bob)).toBe(moved);
    expect(document.activeElement).toBe(bob.prosemirrorView!.dom);
    expect(selectionType(bob)).toBe("text");
    expect(cursorOf(bob)).toBe(`${g.drag[0]}@0`);
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
  });

  it("⋮⋮ 拖出去沒有放進編輯器 → dragend 之後不搶焦點", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    cleanups.push(() => input.remove());
    mockRects(bob);
    startBlockDrag(bob, "x1");
    input.focus();
    dragEndFromHandle(bob);
    expect(document.activeElement).toBe(input);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
  });

  it("上一次 ⋮⋮ 放下之後，一次與 ⋮⋮ 無關的 dragend（例如側欄連結）不搶焦點", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, { drag: "x1", target: "z1" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    cleanups.push(() => input.remove());
    input.focus();
    input.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl 複製拖（PM 預設的放置）照舊：複製一份、原本的留著", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, { drag: "x1", target: "z1", ctrlKey: true });
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z  paragraph:x");
  });
});
