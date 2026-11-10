/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view／transaction／step（型別在 apps/web 拿不到） */
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { COLUMN_TYPE, YDOC_FRAGMENT, canonicalColumnsLine, columnOpenTag } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import type { EditorRef } from "@/components/wikilink/menu";
import { createFakeDataTransfer } from "@/test/drag-fixtures";
import {
  IMG,
  P,
  blockPos,
  cursorOf,
  integrity,
  row,
  shape,
  startBlockDrag,
  textSelection,
  withChildren,
  type AnyEditor,
  type PartialBlockLike,
} from "@/test/columns-fixtures";
import { edgeTargetAt } from "./drag-geometry";
import { draggedBlocksOf } from "./drag-source";
import * as edgeDropModule from "./edge-drop";
import * as insertModule from "./edge-drop-insert";
import * as sizeGuardModule from "@/lib/note-size-guard";

// 以 `buildNoteEditorOptions` 掛真編輯器（UniqueID、autolink、PasteRule、站內連結外掛都在），送真 DOM 事件。toast 換成 spy。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");

type View = any;
type Box = readonly [left: number, top: number, right: number, bottom: number];

interface Mounted {
  editor: AnyEditor;
  view: View;
  container: HTMLElement;
  doc: Y.Doc;
  /** 文件裡一開始就有的 id（比對結果時，其他 id 一律當成新產生的）。 */
  known: Set<string>;
  /** 每次 `handleDrop` 串接被呼叫時，那次呼叫期間的 Y.Doc update 次數與 `editor.transact` 呼叫次數。 */
  handlerUpdates: number[];
  handlerTransacts: number[];
  updates(): number;
  destroy(): void;
}

let mounted: Mounted[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
  toastMock.mockReset();
  vi.restoreAllMocks();
});

function collectIds(blocks: readonly any[], out = new Set<string>()): Set<string> {
  for (const b of blocks) {
    out.add(b.id);
    collectIds(b.children ?? [], out);
  }
  return out;
}

/**
 * 內容先寫進 Y.Doc 再 mount（初始內容不在撤銷堆疊裡）。`handleDrop` 是 `buildNoteEditorOptions` 產品碼的那一支，外面只包一層計數；
 * `handlers: false`＝對照編輯器：`handleDrop` 換成不接手的版本（不呼叫 `edgeDrop`／`emptyColumnDrop`）。
 * 拖曳來源記錄器由列的版面 extension 在 mount 時掛上、unmount 時拆掉。
 */
function mount(content: PartialBlockLike[], opts: { handlers?: boolean; sizeGuard?: (bytes: number) => boolean } = {}): Mounted {
  const doc = new Y.Doc();
  const seed = BlockNoteEditor.create({ schema: noteSchema, initialContent: content }) as AnyEditor;
  blocksToYXmlFragment(seed, seed.document, doc.getXmlFragment(YDOC_FRAGMENT));
  const editorRef: EditorRef = { current: null };
  const options: any = buildNoteEditorOptions({
    doc,
    provider: { awareness: null } as never,
    user: { id: "u1", name: "Ann" },
    language: "en",
    translate: (k) => k,
    editorRef,
    noteId: "n",
    siteLinks: { current: null },
    sizeGuard: opts.sizeGuard,
  });
  let updates = 0;
  doc.on("update", () => void updates++);
  const handlerUpdates: number[] = [];
  const handlerTransacts: number[] = [];
  let transacts = 0;
  const props = options._tiptapOptions.editorProps;
  if (opts.handlers === false) {
    props.handleDrop = () => false;
  } else {
    const productDrop = props.handleDrop;
    props.handleDrop = (v: View, e: DragEvent, s: any, moved: boolean) => {
      const before = updates;
      const transactsBefore = transacts;
      const taken = productDrop(v, e, s, moved);
      handlerUpdates.push(updates - before);
      handlerTransacts.push(transacts - transactsBefore);
      return taken;
    };
  }
  const editor = BlockNoteEditor.create(options) as unknown as AnyEditor;
  editorRef.current = editor;
  const transact = editor.transact.bind(editor);
  editor.transact = ((run: any) => {
    transacts++;
    return transact(run);
  }) as AnyEditor["transact"];
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);
  let alive = true;
  const m: Mounted = {
    editor,
    view: editor.prosemirrorView,
    container,
    doc,
    known: collectIds(editor.document),
    handlerUpdates,
    handlerTransacts,
    updates: () => updates,
    destroy() {
      if (!alive) return;
      alive = false;
      editor.unmount();
      container.remove();
      doc.destroy();
      mounted = mounted.filter((x) => x !== m);
    },
  };
  mounted.push(m);
  return m;
}

/** 文件 JSON，新產生的 id（不在 `known` 裡）換成 `?`。 */
const normalized = (editor: AnyEditor, known: Set<string>) =>
  JSON.parse(JSON.stringify(editor.document), (key, value) => (key === "id" && !known.has(value) ? "?" : value));

const EDITOR_BOX: Box = [0, 0, 1000, 1000];

/**
 * jsdom 的 rect 全是 0。以 `<data-node-type>:<data-id>` 查表回值（`blockOuter:y1`、`columnList:r`、`column:rc0`）；
 * `columnList:*`／`column:*<i>` 給不知道 id 的新列與它的第 i 欄。掛在 prototype、依身分回值：欄寬或文件一變 PM 就換掉元素，
 * 掛在單一元素上的 mock 在第一次寫入後就失效。`.bn-editor` 的根 `.bn-block-group` 回一個包住所有測試座標的框：core SideMenu
 * 在 root 的 capture drop 以它判斷落點是否在編輯器框外，框外 250px 內會先發一筆座標夾進框內的合成事件。
 */
function mockRects(boxes: Record<string, Box>, opts: { editorBox?: boolean } = {}): void {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const type = this.getAttribute("data-node-type");
    let box = boxes[`${type}:${this.getAttribute("data-id")}`];
    if (!box && type === "columnList") box = boxes["columnList:*"];
    if (!box && type === COLUMN_TYPE && this.parentElement) {
      const index = Array.from(this.parentElement.children).filter((c) => c.getAttribute("data-node-type") === COLUMN_TYPE).indexOf(this);
      box = boxes[`column:*${index}`];
    }
    if (!box && opts.editorBox !== false && this.classList.contains("bn-block-group") && this.parentElement?.classList.contains("bn-editor")) {
      box = EDITOR_BOX;
    }
    return box ? new DOMRect(box[0], box[1], box[2] - box[0], box[3] - box[1]) : original.call(this);
  });
}

/** 列 `id`（欄 id `${id}c${i}`；`id` 為 `*` 時是不知道 id 的列）佔 x 0–600、y top–bottom，n 欄等寬、欄間 24px 溝。 */
function rowBoxes(id: string, top: number, bottom: number, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, top, 600, bottom] };
  for (let i = 0; i < n; i++) out[id === "*" ? `column:*${i}` : `column:${id}c${i}`] = [i * (width + 24), top, i * (width + 24) + width, bottom];
  return out;
}

const topBox = (id: string, top: number): Record<string, Box> => ({ [`blockOuter:${id}`]: [0, top, 600, top + 30] });

/** `id` 那個 blockContainer 內第一個 textblock 的開頭。 */
const textIn = (m: Mounted, id: string): number => blockPos(m.editor, id) + 2;

function dropEvent(dataTransfer: unknown, [x, y]: readonly [number, number], extra: { ctrlKey?: boolean; synthetic?: boolean } = {}): DragEvent {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: x });
  Object.defineProperty(event, "clientY", { value: y });
  Object.defineProperty(event, "ctrlKey", { value: !!extra.ctrlKey });
  Object.defineProperty(event, "altKey", { value: false });
  if (extra.synthetic) Object.defineProperty(event, "synthetic", { value: true });
  return event as DragEvent;
}

/** 對 `view.dom` dispatch drop（`posAtCoords` 固定回 `pos`），之後照瀏覽器在拖曳來源上補一個 dragend。 */
function drop(m: Mounted, pos: number, at: readonly [number, number], dataTransfer: unknown, extra: { ctrlKey?: boolean } = {}): DragEvent {
  m.view.posAtCoords = () => ({ pos, inside: -1 });
  const event = dropEvent(dataTransfer, at, extra);
  m.view.dom.dispatchEvent(event);
  m.editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true }));
  return event;
}

/** 一次 ⋮⋮ 拖放：`drag` 是被拖 block 的 id，`range` 給多選範圍，`target` 是落點所在 block 的 id（`posAtCoords` 回它的文字開頭）。 */
interface Gesture {
  drag: string;
  range?: readonly [string, string];
  target: string;
  at: readonly [number, number];
  boxes: Record<string, Box>;
  ctrlKey?: boolean;
}

function dragDrop(m: Mounted, g: Gesture): DragEvent {
  mockRects(g.boxes);
  const { dataTransfer } = startBlockDrag(m.editor, g.drag, { range: g.range });
  return drop(m, textIn(m, g.target), g.at, dataTransfer, { ctrlKey: g.ctrlKey });
}

interface Spies {
  edge: MockInstance<typeof edgeDropModule.edgeDrop>;
  empty: MockInstance<typeof edgeDropModule.emptyColumnDrop>;
  insert: MockInstance<typeof insertModule.buildInsert>;
}

function spies(): Spies {
  return {
    edge: vi.spyOn(edgeDropModule, "edgeDrop"),
    empty: vi.spyOn(edgeDropModule, "emptyColumnDrop"),
    insert: vi.spyOn(insertModule, "buildInsert"),
  };
}

/** handler 只被呼叫一次，收到的不是 core SideMenu 的合成事件。 */
function expectOneRealCall(spy: MockInstance<any>): void {
  expect(spy).toHaveBeenCalledTimes(1);
  expect((spy.mock.calls[0]![2] as { synthetic?: boolean }).synthetic).not.toBe(true);
}

const stepsJSON = (m: Mounted, tr: any) =>
  JSON.parse(JSON.stringify(tr.steps.map((s: any) => s.toJSON())), (key, value) => (key === "id" && value !== null && !m.known.has(value) ? "?" : value));

/** 兩次 `buildInsert`（預測的文件、實際文件）的步驟逐一相同；回傳那組步驟的 `stepType`。 */
function expectSameInsertSteps(m: Mounted, insert: Spies["insert"]): string[] {
  expect(insert).toHaveBeenCalledTimes(2);
  expect(insert.mock.results.map((r) => r.value)).toEqual([true, true]);
  const [predicted, actual] = insert.mock.calls.map((c) => stepsJSON(m, c[0]));
  expect(predicted.length).toBeGreaterThan(0);
  expect(actual).toEqual(predicted);
  return predicted.map((step: { stepType: string }) => step.stepType);
}

/**
 * 接手的放置：handler 只被呼叫一次、兩次 `buildInsert` 一致、撤銷堆疊多一步。回傳 `undo()`：撤銷一次回到放置前。
 */
function takenDrop(m: Mounted, act: () => DragEvent, handler: "edge" | "empty" = "edge") {
  const manager = collabUndoManager(m.editor)!;
  const before = m.editor.document;
  const stack = manager.undoStack.length;
  const s = spies();
  const event = act();
  expectOneRealCall(s.edge);
  expectOneRealCall(s[handler]);
  expect(s[handler].mock.results[0]!.value).toBe(true);
  const insertSteps = expectSameInsertSteps(m, s.insert);
  expect(manager.undoStack.length).toBe(stack + 1);
  expect(m.view.dragging).toBeNull();
  expect(event.defaultPrevented).toBe(true);
  s.edge.mockClear();
  s.empty.mockClear();
  s.insert.mockClear();
  return {
    event,
    spies: s,
    insertSteps,
    undo() {
      manager.undo();
      expect(m.editor.document).toEqual(before);
    },
  };
}

/**
 * 不接手的放置：在受測編輯器上做 `act`，斷言兩個 handler 都回 false、`buildInsert` 零呼叫；再依序掛對照編輯器做同一件事，
 * 結果（新 id 正規化後）相同。對照編輯器不同時掛：兩顆同在一份 document 時，core 會把非落點的拖曳來源當成「拖到別的編輯器」刪掉它的選取。
 */
function expectSameAsControl(
  content: PartialBlockLike[],
  act: (m: Mounted) => void,
  opts: { insertCalls?: number; before?: (s: Spies) => void; after?: (s: Spies) => void } = {},
): Mounted {
  const m = mount(content);
  const s = spies();
  opts.before?.(s);
  act(m);
  expectOneRealCall(s.edge);
  expect(s.edge.mock.results[0]!.value).toBe(false);
  for (const r of s.empty.mock.results) expect(r.value).toBe(false);
  expect(s.insert).toHaveBeenCalledTimes(opts.insertCalls ?? 0);
  opts.after?.(s);
  const got = normalized(m.editor, m.known);
  m.destroy();
  vi.restoreAllMocks();

  const control = mount(content, { handlers: false });
  act(control);
  expect(got).toEqual(normalized(control.editor, control.known));
  control.destroy();
  return m;
}

const widthsOf = (editor: AnyEditor, rowIndex: number): number[] =>
  (editor.document[rowIndex] as any).children.map((col: any) => col.props.width as number);

function linkMarks(m: Mounted): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  m.view.state.doc.descendants((node: any) => {
    if (!node.isText) return;
    for (const mark of node.marks) if (mark.type.name === "link") out.push({ text: node.text, href: mark.attrs.href });
  });
  return out;
}

// ─── D 組：直線放置 ───────────────────────────────────────────────────────────────

describe("D1 頂層建列", () => {
  it.each([
    ["右", 590, "ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y"],
    ["左", 5, "ROW[COL(paragraph:z) | COL(paragraph:x)]  paragraph:y"],
  ] as const)("D1 x y z 拖 z 到 x %s緣 → 建列、游標在 z 開頭、編輯器取得焦點、一步撤銷", (_side, x, expected) => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const drop1 = takenDrop(m, () => dragDrop(m, { drag: "z1", target: "x1", at: [x, 115], boxes: topBox("x1", 100) }));
    expect(shape(m.editor)).toBe(expected);
    expect(cursorOf(m.editor)).toBe("z@0");
    expect(document.activeElement).toBe(m.view.dom);
    expect(widthsOf(m.editor, 0)).toEqual([1, 1]);
    drop1.undo();
  });
});

describe("D2 列外的 block 加欄", () => {
  const content = () => [row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")];
  it.each([
    ["b 右緣", "b1", 590, "ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:z)]"],
    ["a 左緣", "a1", 5, "ROW[COL(paragraph:z) | COL(paragraph:a) | COL(paragraph:b)]"],
    ["a 右緣", "a1", 280, "ROW[COL(paragraph:a) | COL(paragraph:z) | COL(paragraph:b)]"],
    ["b 左緣", "b1", 320, "ROW[COL(paragraph:a) | COL(paragraph:z) | COL(paragraph:b)]"],
  ] as const)("D2 [a｜b] 拖 z 到 %s → 三欄、欄寬各 1、一步撤銷", (_label, target, x, expected) => {
    const m = mount(content());
    const d = takenDrop(m, () => dragDrop(m, { drag: "z1", target, at: [x, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe(expected);
    expect(cursorOf(m.editor)).toBe("z@0");
    expect(widthsOf(m.editor, 0)).toEqual([1, 1, 1]);
    expect(d.insertSteps).toEqual(["replace"]); // 既有欄寬不變 → 不寫屬性
    d.undo();
  });
});

describe("D3 從欄裡拖出來建列", () => {
  it("D3 [a｜b,q] 拖 q 到 x 右緣 → [x｜q]，原列 [a｜b]", () => {
    const m = mount([P("x", "x1"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "q1", target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:q)]  ROW[COL(paragraph:a) | COL(paragraph:b)]");
    d.undo();
  });

  it.each([
    [2, "ROW[COL(paragraph:a) | COL(paragraph)]"],
    [3, "ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph:c)]"],
  ] as const)("D3 拖走 %i 欄列裡某欄唯一的 block → 來源欄留空段落、欄數不變", (n, expectedSource) => {
    const cols = n === 2 ? [[P("a", "a1")], [P("b", "b1")]] : [[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]];
    const m = mount([P("x", "x1"), row(cols, "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "b1", target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:x) | COL(paragraph:b)]  ${expectedSource}`);
    d.undo();
  });
});

describe("D4 同一列內換欄、等於沒動", () => {
  it("D4 [a,c｜b] 拖 c 到 b 右緣 → [a｜b｜c]", () => {
    const m = mount([row([[P("a", "a1"), P("c", "c1")], [P("b", "b1")]], "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "c1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c)]");
    d.undo();
  });

  it("D4 [a｜b] 拖 b 到 a 右緣 → 不接手，結果同對照編輯器", () => {
    expectSameAsControl([row([[P("a", "a1")], [P("b", "b1")]], "r")], (m) =>
      dragDrop(m, { drag: "b1", target: "a1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 2) }),
    );
  });

  it("D4 [a｜b｜c] 拖 c 到 a 左緣 → [c｜a｜b｜空]", () => {
    const m = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "c1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 100, 300, 3) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:c) | COL(paragraph:a) | COL(paragraph:b) | COL(paragraph)]");
    expect(widthsOf(m.editor, 0)).toEqual([1, 1, 1, 1]);
    d.undo();
  });
});

describe("D5 多選", () => {
  it("D5 同欄兩個多選 → 依序進新欄", () => {
    const m = mount([P("x", "x1"), row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")]);
    takenDrop(m, () => dragDrop(m, { drag: "a1", range: ["a1", "b1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:a,paragraph:b)]  ROW[COL(paragraph:c) | COL(paragraph:d)]");
  });

  it("D5 頂層兩個多選 → 依序進新欄", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1"), P("w", "w1")]);
    takenDrop(m, () => dragDrop(m, { drag: "y1", range: ["y1", "z1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:y,paragraph:z)]  paragraph:w");
  });

  it("D5 跨欄多選 → 不接手，結果同對照編輯器", () => {
    expectSameAsControl([P("x", "x1"), row([[P("a", "a1")], [P("d", "d1")]], "r")], (m) =>
      dragDrop(m, { drag: "a1", range: ["a1", "d1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) }),
    );
  });
});

describe("D6 4 欄的列", () => {
  it("D6 拖頂層 z 到 4 欄列的欄緣 → 不接手，結果同對照編輯器", () => {
    expectSameAsControl([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]], "r"), P("z", "z1")], (m) =>
      dragDrop(m, { drag: "z1", target: "b1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 4) }),
    );
  });
});

describe("D7 新列成為最後一個 block", () => {
  it("D7 x y 拖 x 到 y 右緣 → 列後補一個空段落", () => {
    const m = mount([P("x", "x1"), P("y", "y1")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:y) | COL(paragraph:x)]  paragraph");
    expect(integrity(m.editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
    d.undo();
  });
});

describe("D8 不變量", () => {
  const red = { id: "r1", type: "paragraph", props: { textColor: "red" }, content: [{ type: "text", text: "red", styles: {} }] } as PartialBlockLike;
  const content = () => [
    red,
    IMG("img1", 320),
    withChildren(P("k", "k1"), [P("k2", "k2")]),
    P("y", "y1"),
    row([[P("a", "a1")], [P("b", "b1")]], "r"),
    P("t", "t1"),
  ];
  const xIds = ["r1", "img1", "k1"];

  function check(m: Mounted, before: Record<string, unknown>, beforeIds: Set<string>, added: number): void {
    for (const id of xIds) expect(m.editor.getBlock(id)).toEqual(before[id]);
    const after = collectIds(m.editor.document);
    for (const id of beforeIds) expect(after.has(id)).toBe(true);
    expect(after.size - beforeIds.size).toBe(added);
    expect(integrity(m.editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
    for (const block of m.editor.document as any[]) {
      if (block.type !== "columnList") continue;
      for (const col of block.children) expect(canonicalColumnsLine(columnOpenTag(col.props.width))).toEqual({ width: col.props.width });
    }
  }

  it("D8 建列：id 集合只多新列與兩欄、X 的 props 與子 block 原樣、無巢狀列、欄寬是正規形", () => {
    const m = mount(content());
    const before = Object.fromEntries(xIds.map((id) => [id, m.editor.getBlock(id)]));
    expect((before.img1 as any).props.previewWidth).toBe(320);
    expect((before.r1 as any).props.textColor).toBe("red");
    const beforeIds = collectIds(m.editor.document);
    takenDrop(m, () => dragDrop(m, { drag: "r1", range: ["r1", "k1"], target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(shape(m.editor)).toBe(
      "ROW[COL(paragraph:y) | COL(paragraph:red,image,paragraph:k{paragraph:k2})]  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:t",
    );
    check(m, before, beforeIds, 3);
  });

  it("D8 加欄：id 集合只多新欄、X 原樣、欄寬是正規形", () => {
    const m = mount(content());
    const before = Object.fromEntries(xIds.map((id) => [id, m.editor.getBlock(id)]));
    const beforeIds = collectIds(m.editor.document);
    takenDrop(m, () => dragDrop(m, { drag: "r1", range: ["r1", "k1"], target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe("paragraph:y  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:red,image,paragraph:k{paragraph:k2})]  paragraph:t");
    check(m, before, beforeIds, 1);
  });
});

describe("D9 一步撤銷", () => {
  it("D9 撤銷堆疊只多一步，undo 一次回到放置前（各案另見 D1–D4、D12）", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const manager = collabUndoManager(m.editor)!;
    const before = m.editor.document;
    const stack = manager.undoStack.length;
    dragDrop(m, { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) });
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y");
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(m.editor.document).toEqual(before);
  });
});

describe("D10 放下之後", () => {
  it("D10 view.dragging 清掉、drop 被 preventDefault；之後的橫線拖放照常（欄元素已被換過）", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1"), P("w", "w1")]);
    const first = dragDrop(m, { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) });
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y  paragraph:w");
    expect(m.view.dragging).toBeNull();
    expect(first.defaultPrevented).toBe(true);

    const s = spies();
    dragDrop(m, { drag: "w1", target: "z1", at: [450, 200], boxes: rowBoxes("*", 100, 300, 2) });
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(false);
    expect(s.empty.mock.results[0]!.value).toBe(false);
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:w,paragraph:z)]  paragraph:y");
  });
});

/** `naturalWidth`／`naturalHeight`／`complete` 依 `<img>` 所在 block 的 id 查表；查不到的回 0×0、未完成。 */
function mockImages(sizes: Record<string, readonly [number, number]>): void {
  const sizeOf = (img: HTMLImageElement) => sizes[img.closest("[data-id]")?.getAttribute("data-id") ?? ""];
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(function (this: HTMLImageElement) {
    return sizeOf(this)?.[0] ?? 0;
  });
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockImplementation(function (this: HTMLImageElement) {
    return sizeOf(this)?.[1] ?? 0;
  });
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockImplementation(function (this: HTMLImageElement) {
    return sizeOf(this) !== undefined;
  });
}

describe("D11 自動等高", () => {
  const previewWidths = (m: Mounted, ids: string[]) => ids.map((id) => (m.editor.getBlock(id) as any).props.previewWidth);

  it("D11 前提：image block 在畫面上有 <img>", () => {
    const m = mount([IMG("i1"), IMG("i2")]);
    expect(m.view.dom.querySelectorAll("img").length).toBe(2);
  });

  it("D11 200×100 與 100×100 建列 → 欄寬 [1.33, 0.67]，previewWidth 不變", () => {
    const m = mount([IMG("i1"), IMG("i2", 300), P("t", "t1")]);
    mockImages({ i1: [200, 100], i2: [100, 100] });
    const before = previewWidths(m, ["i1", "i2"]);
    takenDrop(m, () => dragDrop(m, { drag: "i2", target: "i1", at: [590, 115], boxes: topBox("i1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(image) | COL(image)]  paragraph:t");
    expect(widthsOf(m.editor, 0)).toEqual([1.33, 0.67]);
    expect(previewWidths(m, ["i1", "i2"])).toEqual(before);
  });

  it("D11 第三張加欄 → 整列依寬高比重算", () => {
    const m = mount([row([[IMG("i1")], [IMG("i2")]], "r"), IMG("i3"), P("t", "t1")]);
    mockImages({ i1: [200, 100], i2: [100, 100], i3: [100, 200] });
    const before = previewWidths(m, ["i1", "i2", "i3"]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "i3", target: "i2", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(d.insertSteps).toEqual(["replace", "attr", "attr"]); // 新欄＋兩個既有欄的寬
    expect(shape(m.editor)).toBe("ROW[COL(image) | COL(image) | COL(image)]  paragraph:t");
    expect(widthsOf(m.editor, 0)).toEqual([1.71, 0.86, 0.43]);
    expect(previewWidths(m, ["i1", "i2", "i3"])).toEqual(before);
  });

  it("D11 其中一張 naturalWidth 為 0 → [1, 1]", () => {
    const m = mount([IMG("i1"), IMG("i2"), P("t", "t1")]);
    mockImages({ i1: [200, 100], i2: [0, 100] });
    takenDrop(m, () => dragDrop(m, { drag: "i2", target: "i1", at: [590, 115], boxes: topBox("i1", 100) }));
    expect(widthsOf(m.editor, 0)).toEqual([1, 1]);
  });

  it("D11 圖＋段落 → [1, 1]", () => {
    const m = mount([P("x", "x1"), IMG("i2"), P("t", "t1")]);
    mockImages({ i2: [200, 100] });
    takenDrop(m, () => dragDrop(m, { drag: "i2", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(image)]  paragraph:t");
    expect(widthsOf(m.editor, 0)).toEqual([1, 1]);
  });
});

// ─── D12：橫線放進空欄 ───────────────────────────────────────────────────────────

describe("D12 橫線放進空欄取代空段落", () => {
  /** [a｜E] 與頂層 z：z 橫線放進第 2 欄（x 在欄中間、不在左右緣），`posAtCoords` 落在 E。 */
  const emptyContent = (e: PartialBlockLike = { id: "e1", type: "paragraph", content: [] } as PartialBlockLike) => [
    row([[P("a", "a1")], [e]], "r"),
    P("z", "z1"),
  ];
  const intoEmpty: Gesture = { drag: "z1", target: "e1", at: [450, 200], boxes: rowBoxes("r", 100, 300, 2) };

  it("D12 先直線拖走 b 留下空欄，再把頂層 z 放進空欄 → [a｜z]、游標在 z、一步撤銷回到放 z 之前", () => {
    const m = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("x", "x1"), P("z", "z1")]);
    takenDrop(m, () => dragDrop(m, { drag: "b1", target: "x1", at: [590, 415], boxes: { ...rowBoxes("r", 100, 300, 2), ...topBox("x1", 400) } }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph:x) | COL(paragraph:b)]  paragraph:z");
    const emptyId = (m.editor.document[0] as any).children[1].children[0].id as string;
    const d = takenDrop(
      m,
      () => {
        mockRects(rowBoxes("r", 100, 300, 2));
        const { dataTransfer } = startBlockDrag(m.editor, "z1");
        return drop(m, textIn(m, emptyId), [450, 200], dataTransfer);
      },
      "empty",
    );
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:z)]  ROW[COL(paragraph:x) | COL(paragraph:b)]");
    expect(cursorOf(m.editor)).toBe("z@0");
    d.undo();
  });

  it("D12 頂層 z 放進 [a｜空] → [a｜z]、空段落不在了", () => {
    const m = mount(emptyContent());
    const d = takenDrop(m, () => dragDrop(m, intoEmpty), "empty");
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:z)]");
    expect(collectIds(m.editor.document).has("e1")).toBe(false);
    d.undo();
  });

  const notEmpty: Array<[string, PartialBlockLike]> = [
    ["有字", P("t", "e1")],
    ["有子 block", withChildren({ id: "e1", type: "paragraph", content: [] } as PartialBlockLike, [P("k", "k1")])],
    ["文字色非預設", { id: "e1", type: "paragraph", props: { textColor: "red" }, content: [] } as PartialBlockLike],
    ["背景色非預設", { id: "e1", type: "paragraph", props: { backgroundColor: "blue" }, content: [] } as PartialBlockLike],
    ["對齊非預設", { id: "e1", type: "paragraph", props: { textAlignment: "center" }, content: [] } as PartialBlockLike],
  ];
  it.each(notEmpty)("D12 欄裡的段落%s → 不取代，結果同對照編輯器", (_label, e) => {
    expectSameAsControl(emptyContent(e), (m) => dragDrop(m, intoEmpty));
  });

  it("D12 欄裡有兩個 block（其一是空段落）→ 不取代，結果同對照編輯器", () => {
    expectSameAsControl([row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike, P("c", "c1")]], "r"), P("z", "z1")], (m) =>
      dragDrop(m, intoEmpty),
    );
  });

  it("D12 X 含列（多選頂層 p 與列 [c｜d]）放進別列的空欄 → 欄內 p, c, d、id 不變、無巢狀列", () => {
    const m = mount([P("p", "p1"), row([[P("c", "c1")], [P("d", "d1")]], "s"), ...emptyContent().slice(0, 1)]);
    const beforeIds = collectIds(m.editor.document);
    const d = takenDrop(m, () => dragDrop(m, { ...intoEmpty, drag: "p1", range: ["p1", "c1"] }), "empty");
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:p,paragraph:c,paragraph:d)]");
    const col = (m.editor.document[0] as any).children[1].children.map((b: any) => b.id);
    expect(col).toEqual(["p1", "c1", "d1"]);
    const after = collectIds(m.editor.document);
    expect([...beforeIds].filter((id) => !after.has(id)).sort()).toEqual(["e1", "s", "sc0", "sc1"]);
    expect(integrity(m.editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
    d.undo();
  });

  it("D12 文字拖曳 → 不取代，結果同對照編輯器", () => {
    expectSameAsControl(emptyContent(), (m) => {
      mockRects(intoEmpty.boxes);
      const view = m.view;
      const from = textIn(m, "z1");
      view.dispatch(view.state.tr.setSelection(textSelection(m.editor, from, from + 1)));
      view.posAtCoords = () => ({ pos: from, inside: -1 });
      const dataTransfer = createFakeDataTransfer([], { store: true });
      const start = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
      view.dom.dispatchEvent(start);
      expect(draggedBlocksOf(view)).toBeNull(); // 前提：文字選取不記 X
      view.dragging = { slice: view.state.selection.content(), move: true };
      dataTransfer.setData("text/plain", "z");
      drop(m, textIn(m, "e1"), intoEmpty.at, dataTransfer);
    });
  });

  it("D12 複製拖 → 不取代，結果同對照編輯器", () => {
    expectSameAsControl(emptyContent(), (m) => dragDrop(m, { ...intoEmpty, ctrlKey: true }));
  });

  it("D12 外部 HTML → 不取代，結果同對照編輯器", () => {
    expectSameAsControl(emptyContent(), (m) => {
      mockRects(intoEmpty.boxes);
      drop(m, textIn(m, "e1"), intoEmpty.at, { types: ["text/html", "text/plain"], getData: (t: string) => (t === "text/html" ? "<p>ext</p>" : "ext"), items: [], files: [] });
    });
  });

  it("D12 檔案 → 不取代（handleDrop 不會被問到）", () => {
    const m = mount(emptyContent());
    const s = spies();
    mockRects(intoEmpty.boxes);
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    drop(m, textIn(m, "e1"), intoEmpty.at, {
      types: ["Files"],
      files: [file],
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      getData: () => "",
    });
    expect(s.empty).not.toHaveBeenCalled();
    expect(s.insert).not.toHaveBeenCalled();
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
  });

  it("D12 合成事件 → emptyColumnDrop 回 false、不送交易", () => {
    const m = mount(emptyContent());
    mockRects(intoEmpty.boxes);
    startBlockDrag(m.editor, "z1");
    const s = spies();
    const transact = vi.spyOn(m.editor, "transact");
    m.view.posAtCoords = () => ({ pos: textIn(m, "e1"), inside: -1 });
    const event = dropEvent(createFakeDataTransfer(["blocknote/html"]), intoEmpty.at, { synthetic: true });
    expect(edgeDropModule.emptyColumnDrop(m.editor, m.view, event, m.view.dragging.slice)).toBe(false);
    expect(transact).not.toHaveBeenCalled();
    expect(s.insert).not.toHaveBeenCalled();
    // 對照：同一組幾何、不是合成事件 → 接手
    expect(edgeDropModule.emptyColumnDrop(m.editor, m.view, dropEvent(createFakeDataTransfer(["blocknote/html"]), intoEmpty.at), m.view.dragging.slice)).toBe(true);
  });

  it("D12 拖空段落自己 → 不取代，結果同對照編輯器", () => {
    expectSameAsControl(emptyContent(), (m) => dragDrop(m, { ...intoEmpty, drag: "e1" }));
  });

  it("D12 多選頂層 p 與列 [c｜空]，放回那列自己的空欄 → 不取代、不送交易，結果同對照編輯器、id 集合不變", () => {
    const content = [P("p", "p1"), row([[P("c", "c1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r")];
    let idsBefore: Set<string> | null = null;
    let idsAfter: Set<string> | null = null;
    const m = expectSameAsControl(content, (x) => {
      mockRects(intoEmpty.boxes);
      const { dataTransfer } = startBlockDrag(x.editor, "p1", { range: ["p1", "e1"] });
      expect(draggedBlocksOf(x.view)).toEqual({ ids: ["p1", "r"], kind: "multi", hasRows: true }); // 前提
      idsBefore ??= collectIds(x.editor.document);
      drop(x, textIn(x, "e1"), intoEmpty.at, dataTransfer);
      idsAfter ??= collectIds(x.editor.document);
    });
    expect(m.handlerTransacts).toEqual([0]);
    expect(m.handlerUpdates).toEqual([0]);
    expect(idsAfter).toEqual(idsBefore);
  });

  describe("D12 預先驗證失敗 → 一筆都不送", () => {
    // 預測的文件上 `buildInsert` 不成立（模擬：E 在只移除 X 之後已不再是空段落）。handler 回 false 之後 PM 的預設 drop 照跑、
    // 那一筆會寫 Yjs，所以只數 handler 呼叫期間的 update。
    it("D12 空欄：emptyColumnDrop 回 false、buildInsert 只被呼叫一次、handler 期間沒有 Y update、結果同對照編輯器", () => {
      const m = expectSameAsControl(emptyContent(), (x) => dragDrop(x, intoEmpty), {
        insertCalls: 1,
        before: (s) => s.insert.mockReturnValueOnce(false),
        after: (s) => expect(s.empty.mock.results.map((r) => r.value)).toEqual([false]),
      });
      expect(m.handlerUpdates).toEqual([0]);
    });

    it("D12 直線：edgeDrop 回 false、buildInsert 只被呼叫一次、handler 期間沒有 Y update、結果同對照編輯器", () => {
      const m = expectSameAsControl(
        [P("x", "x1"), P("y", "y1"), P("z", "z1")],
        (x) => dragDrop(x, { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }),
        { insertCalls: 1, before: (s) => s.insert.mockReturnValueOnce(false) },
      );
      expect(m.handlerUpdates).toEqual([0]);
    });
  });
});

// ─── D13–D17：與其他拖放外掛的組合 ─────────────────────────────────────────────

const URL_Y = "see https://y.example/b now";
const URL_M = "mid https://m.example/c";
const URL_X = "go https://x.example/a";

describe("D13 直線放置不跑 paste rule", () => {
  it("D13 新掛的編輯器第一次建列：X、Y、中間 block 的網址都不變成連結", () => {
    const m = mount([P(URL_Y, "y1"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    const before = linkMarks(m);
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:${URL_Y}) | COL(paragraph:${URL_X})]  paragraph:${URL_M}  paragraph:t`);
    expect(linkMarks(m)).toEqual(before);
  });

  it("D13 新掛的編輯器第一次加欄：X、欄裡、中間 block 的網址都不變成連結", () => {
    const m = mount([row([[P(URL_Y, "a1")], [P(URL_M, "b1")]], "r"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    const before = linkMarks(m);
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:${URL_Y}) | COL(paragraph:${URL_M}) | COL(paragraph:${URL_X})]  paragraph:${URL_M}  paragraph:t`);
    expect(linkMarks(m)).toEqual(before);
  });
});

/** 外部拖入（`view.dragging` 為 null）：側欄連結的形。 */
function externalLinkDrop(m: Mounted, pos: number): void {
  mockRects({});
  const href = "https://ext.example/z";
  drop(m, pos, [300, 500], {
    types: ["text/uri-list", "text/plain"],
    getData: (t: string) => (t === "text/uri-list" || t === "text/plain" ? href : ""),
    items: [],
    files: [],
  });
}

describe("D14 外部連結拖入之後的直線放置", () => {
  it("D14 先拖入一個外部連結，再建列 → 放置前後 link mark 相同", () => {
    const m = mount([P(URL_Y, "y1"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    externalLinkDrop(m, textIn(m, "t1") + 1);
    const before = linkMarks(m);
    expect(before.map((l) => l.href)).toContain("https://ext.example/z"); // 前提：外部拖入照常轉成連結
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(linkMarks(m)).toEqual(before);
  });

  it("D14 先拖入一個外部連結，再加欄 → 放置前後 link mark 相同", () => {
    const m = mount([row([[P(URL_Y, "a1")], [P(URL_M, "b1")]], "r"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    externalLinkDrop(m, textIn(m, "t1") + 1);
    const before = linkMarks(m);
    expect(before.map((l) => l.href)).toContain("https://ext.example/z");
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(linkMarks(m)).toEqual(before);
  });
});

describe("D15 直線放置之後的外部拖入", () => {
  it("D15 外部拖入帶既有 data-id 的 BlockNote HTML → 插入後 id 不重複", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1"), P("t", "t1")]);
    takenDrop(m, () => dragDrop(m, { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }));
    const html = m.editor.blocksToFullHTML([m.editor.getBlock("t1")!]);
    expect(html).toContain('data-id="t1"'); // 前提：HTML 帶著文件裡既有的 id
    mockRects({});
    const blocksBefore = m.editor.document.length;
    drop(m, blockPos(m.editor, "t1"), [300, 500], {
      types: ["text/html", "text/plain"],
      getData: (t: string) => (t === "text/html" ? html : t === "text/plain" ? "t" : ""),
      items: [],
      files: [],
    });
    const ids: string[] = [];
    m.view.state.doc.descendants((node: any) => {
      if (node.attrs.id) ids.push(node.attrs.id);
    });
    expect(ids.filter((id) => id === "t1").length).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(m.editor.document.length).toBe(blocksBefore + 1); // 前提：真的插進了一個 block
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y  paragraph:t  paragraph:t");
  });
});

describe("D16 直線放置與放進空欄不 autolink", () => {
  const URL_END = "go https://x.example/a";
  const URL_END_Y = "see https://y.example/b";

  // 第一個 block 不放網址：文件第一次載入時 autolink 會檢查第一個 textblock 的最後一個字（與拖放無關）。
  it("D16 建列：X、Y 都是句尾網址的段落 → 沒有新連結", () => {
    const m = mount([P("first", "f1"), P(URL_END_Y, "y1"), P("m", "m1"), P(URL_END, "x1"), P("t", "t1")]);
    expect(linkMarks(m)).toEqual([]); // 前提
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(shape(m.editor)).toBe(`paragraph:first  ROW[COL(paragraph:${URL_END_Y}) | COL(paragraph:${URL_END})]  paragraph:m  paragraph:t`);
    expect(linkMarks(m)).toEqual([]);
  });

  it("D16 加欄：X 是兩個段落、第一段以網址結尾 → 沒有新連結", () => {
    const m = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P(URL_END, "x1"), P("then", "x2"), P("t", "t1")]);
    takenDrop(m, () => dragDrop(m, { drag: "x1", range: ["x1", "x2"], target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:${URL_END},paragraph:then)]  paragraph:t`);
    expect(linkMarks(m)).toEqual([]);
  });

  it("D16 放進空欄：X 是兩個段落、第一段以網址結尾 → 沒有新連結", () => {
    const m = mount([
      row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r"),
      P(URL_END, "x1"),
      P("then", "x2"),
      P("t", "t1"),
    ]);
    takenDrop(m, () => dragDrop(m, { drag: "x1", range: ["x1", "x2"], target: "e1", at: [450, 200], boxes: rowBoxes("r", 100, 300, 2) }), "empty");
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:a) | COL(paragraph:${URL_END},paragraph:then)]  paragraph:t`);
    expect(linkMarks(m)).toEqual([]);
  });
});

describe("D17 直接拖已選取的圖片", () => {
  it("D17 圖片 blockContent 的 NodeSelection 拖到 x 右緣：core 取消了 dragstart → 不記 X、不接手，結果同對照編輯器", () => {
    expectSameAsControl([P("x", "x1"), IMG("img1"), P("t", "t1")], (m) => {
      mockRects(topBox("x1", 100));
      const view = m.view;
      const Selection = Object.getPrototypeOf(view.state.selection.constructor);
      const imgPos = blockPos(m.editor, "img1");
      view.dispatch(view.state.tr.setSelection(Selection.fromJSON(view.state.doc, { type: "node", anchor: imgPos + 1 })));
      expect(view.state.selection.node.type.name).toBe("image"); // 前提：選的是 blockContent
      view.posAtCoords = () => ({ pos: imgPos + 1, inside: -1 });
      const dataTransfer = createFakeDataTransfer([], { store: true });
      const start = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
      (view.nodeDOM(imgPos) as HTMLElement).querySelector("img")!.dispatchEvent(start);
      expect(start.defaultPrevented).toBe(true);
      expect(view.state.selection.node.type.name).toBe("blockContainer"); // core 把選取擴成整個 block
      expect(view.dragging).toBeTruthy();
      expect(draggedBlocksOf(view)).toBeNull();
      drop(m, textIn(m, "x1"), [590, 115], dataTransfer);
    });
  });

  it("D17 對照：圖片已被選取時改抓它的 ⋮⋮ 拖到 x 右緣 → 照常建列、一步撤銷", () => {
    const m = mount([P("x", "x1"), IMG("img1"), P("t", "t1")]);
    const view = m.view;
    const Selection = Object.getPrototypeOf(view.state.selection.constructor);
    view.dispatch(view.state.tr.setSelection(Selection.fromJSON(view.state.doc, { type: "node", anchor: blockPos(m.editor, "img1") + 1 })));
    expect(view.state.selection.node.type.name).toBe("image"); // 前提：選的是 blockContent
    const d = takenDrop(m, () => dragDrop(m, { drag: "img1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(image)]  paragraph:t");
    d.undo();
  });
});

// ─── 拖曳中途變唯讀、撤銷後重做 ─────────────────────────────────────────────────

describe("ED-RF1 拖曳中途編輯器變唯讀", () => {
  // 直接呼叫 handler：PM 在 view 不可編輯時根本不跑 drop 的 editHandlers，走 dispatch 的話 handleDrop 不會被呼叫。
  it("ED-RF1 建列幾何：唯讀時 edgeDrop 回 false、沒有 Y update；回到可編輯時同一組幾何接手", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects(topBox("x1", 100));
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    m.view.posAtCoords = () => ({ pos: textIn(m, "x1"), inside: -1 });
    const event = dropEvent(dataTransfer, [590, 115]);
    m.editor.isEditable = false;
    const updates = m.updates();
    expect(edgeDropModule.edgeDrop(m.editor, m.view, event)).toBe(false);
    expect(m.updates()).toBe(updates);
    expect(shape(m.editor)).toBe("paragraph:x  paragraph:y  paragraph:z");
    m.editor.isEditable = true;
    expect(edgeDropModule.edgeDrop(m.editor, m.view, event)).toBe(true);
  });

  it("ED-RF1 空欄幾何：唯讀時 emptyColumnDrop 回 false、沒有 Y update；回到可編輯時同一組幾何接手", () => {
    const m = mount([row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r"), P("z", "z1")]);
    mockRects(rowBoxes("r", 100, 300, 2));
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    m.view.posAtCoords = () => ({ pos: textIn(m, "e1"), inside: -1 });
    const event = dropEvent(dataTransfer, [450, 200]);
    const slice = m.view.dragging.slice;
    m.editor.isEditable = false;
    const updates = m.updates();
    expect(edgeDropModule.emptyColumnDrop(m.editor, m.view, event, slice)).toBe(false);
    expect(m.updates()).toBe(updates);
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    m.editor.isEditable = true;
    expect(edgeDropModule.emptyColumnDrop(m.editor, m.view, event, slice)).toBe(true);
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:z)]");
  });
});

const zToXRight: Gesture = { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) };

describe("ED-RF5 撤銷後重做", () => {
  it("ED-RF5 x y z 拖 z 到 x 右緣 → undo → redo 一次 → 文件回到放置後（欄寬與 id 都在）", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    dragDrop(m, zToXRight);
    const after = m.editor.document;
    const manager = collabUndoManager(m.editor)!;
    manager.undo();
    expect(shape(m.editor)).toBe("paragraph:x  paragraph:y  paragraph:z");
    manager.redo();
    expect(m.editor.document).toEqual(after);
  });

  it("ED-RF5 兩張圖建列（欄寬依寬高比）→ undo → redo 一次 → 文件回到放置後", () => {
    const m = mount([IMG("i1"), IMG("i2"), P("t", "t1")]);
    mockImages({ i1: [200, 100], i2: [100, 100] });
    dragDrop(m, { drag: "i2", target: "i1", at: [590, 115], boxes: topBox("i1", 100) });
    const after = m.editor.document;
    expect(widthsOf(m.editor, 0)).toEqual([1.33, 0.67]);
    const manager = collabUndoManager(m.editor)!;
    manager.undo();
    expect(shape(m.editor)).toBe("image  image  paragraph:t");
    manager.redo();
    expect(m.editor.document).toEqual(after);
  });
});

// ─── H 組：DropCursor 與 drop 用同一個判斷 ────────────────────────────────────────

interface Scenario {
  name: string;
  content: () => PartialBlockLike[];
  g: Gesture;
  vertical: boolean;
  tweak?: (m: Mounted) => void;
  synthetic?: boolean;
}

const three = () => [P("x", "x1"), P("y", "y1"), P("z", "z1")];
const twoCols = () => [row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")];
const zToX: Gesture = { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) };
const inTwoCols = (target: string, x: number): Gesture => ({ drag: "z1", target, at: [x, 200], boxes: rowBoxes("r", 100, 300, 2) });

const scenarios: Scenario[] = [
  { name: "D1 z 到 x 右緣", content: three, g: zToX, vertical: true },
  { name: "D1 z 到 x 左緣", content: three, g: { ...zToX, at: [5, 115] }, vertical: true },
  { name: "D2 z 到 b 右緣", content: twoCols, g: inTwoCols("b1", 590), vertical: true },
  { name: "D2 z 到 a 左緣", content: twoCols, g: inTwoCols("a1", 5), vertical: true },
  { name: "D2 z 到 a 右緣", content: twoCols, g: inTwoCols("a1", 280), vertical: true },
  { name: "D2 z 到 b 左緣", content: twoCols, g: inTwoCols("b1", 320), vertical: true },
  {
    name: "D3 欄裡的 q 到 x 右緣",
    content: () => [P("x", "x1"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r")],
    g: { drag: "q1", target: "x1", at: [590, 15], boxes: topBox("x1", 0) },
    vertical: true,
  },
  {
    name: "D4 c 到 b 右緣",
    content: () => [row([[P("a", "a1"), P("c", "c1")], [P("b", "b1")]], "r")],
    g: { drag: "c1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) },
    vertical: true,
  },
  {
    name: "D4 等於沒動：b 到 a 右緣",
    content: () => [row([[P("a", "a1")], [P("b", "b1")]], "r")],
    g: { drag: "b1", target: "a1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 2) },
    vertical: false,
  },
  {
    name: "D4 c 到 a 左緣",
    content: () => [row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")],
    g: { drag: "c1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 100, 300, 3) },
    vertical: true,
  },
  {
    name: "D5 同欄多選到 x 右緣",
    content: () => [P("x", "x1"), row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")],
    g: { drag: "a1", range: ["a1", "b1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) },
    vertical: true,
  },
  {
    name: "D5 跨欄多選",
    content: () => [P("x", "x1"), row([[P("a", "a1")], [P("d", "d1")]], "r")],
    g: { drag: "a1", range: ["a1", "d1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) },
    vertical: false,
  },
  {
    name: "D6 4 欄的列",
    content: () => [row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]], "r"), P("z", "z1")],
    g: { drag: "z1", target: "b1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 4) },
    vertical: false,
  },
  { name: "不出直線：合成事件", content: three, g: zToX, synthetic: true, vertical: false },
  { name: "不出直線：複製拖", content: three, g: { ...zToX, ctrlKey: true }, vertical: false },
  { name: "不出直線：唯讀", content: three, g: zToX, tweak: (m) => void (m.editor.isEditable = false), vertical: false },
  {
    name: "不出直線：沒有記下的 X（dragend 清掉）",
    content: three,
    g: zToX,
    tweak: (m) => void m.editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true })),
    vertical: false,
  },
  { name: "不出直線：不在拖曳中", content: three, g: zToX, tweak: (m) => void (m.view.dragging = null), vertical: false },
  { name: "不出直線：Y 就是 X", content: three, g: { ...zToX, drag: "x1" }, vertical: false },
  {
    name: "不出直線：Y 是多選 X 的第二個",
    content: three,
    g: { drag: "x1", range: ["x1", "y1"], target: "y1", at: [590, 115], boxes: topBox("y1", 100) },
    vertical: false,
  },
  {
    name: "不出直線：X 含列",
    content: () => [P("p", "p1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")],
    g: { drag: "p1", range: ["p1", "a1"], target: "y1", at: [590, 415], boxes: topBox("y1", 400) },
    vertical: false,
  },
  { name: "不出直線：不在左右緣區", content: three, g: { ...zToX, at: [300, 115] }, vertical: false },
  { name: "不出直線：溝裡", content: twoCols, g: inTwoCols("a1", 300), vertical: false },
];

describe("H2 edgeTargetAt 說直線 ⇔ edgeDrop 接手", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("H2 %s", (_name, s) => {
    const m = mount(s.content());
    mockRects(s.g.boxes);
    const { dataTransfer } = startBlockDrag(m.editor, s.g.drag, { range: s.g.range });
    m.view.posAtCoords = () => ({ pos: textIn(m, s.g.target), inside: -1 });
    s.tweak?.(m);
    const event = dropEvent(dataTransfer, s.g.at, { ctrlKey: s.g.ctrlKey, synthetic: s.synthetic });
    const target = edgeTargetAt(m.view, event, draggedBlocksOf(m.view));
    expect(target !== null).toBe(s.vertical);
    expect(edgeDropModule.edgeDrop(m.editor, m.view, event)).toBe(s.vertical);
  });
});

// ─── H1：DropCursor 畫的線 ───────────────────────────────────────────────────────

/** 拖放事件；座標以 `configurable: true` 定義（溝裡的拖放會在事件上改寫座標）。 */
function dragEventAt(type: "dragover" | "drop", dataTransfer: unknown, [x, y]: readonly [number, number]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: x, configurable: true });
  Object.defineProperty(event, "clientY", { value: y, configurable: true });
  Object.defineProperty(event, "ctrlKey", { value: false });
  Object.defineProperty(event, "altKey", { value: false });
  return event as DragEvent;
}

/**
 * 對 `view.dom` dispatch dragover（`posAtCoords` 固定回 `pos`）。core DropCursor 把線掛在 `view.dom.offsetParent` 上，
 * jsdom 沒有 offsetParent，改回 mount 的 container。
 */
function dragOver(m: Mounted, pos: number, at: readonly [number, number], dataTransfer: unknown): DragEvent {
  Object.defineProperty(m.view.dom, "offsetParent", { get: () => m.container, configurable: true });
  m.view.posAtCoords = () => ({ pos, inside: -1 });
  const event = dragEventAt("dragover", dataTransfer, at);
  m.view.dom.dispatchEvent(event);
  return event;
}

const cursorEl = (m: Mounted) => m.container.querySelector<HTMLElement>(".prosemirror-dropcursor-vertical, .prosemirror-dropcursor-block-horizontal");

/** DropCursor hook 只被呼叫一次，收到的不是 core SideMenu 的合成事件。 */
function expectOneRealHookCall(hook: MockInstance<typeof edgeDropModule.computeDropPosition>): void {
  expect(hook).toHaveBeenCalledTimes(1);
  expect((hook.mock.calls[0]![0].event as { synthetic?: boolean }).synthetic).not.toBe(true);
}

describe("H1 DropCursor：直線畫在目標的左右緣，其餘照 core 的橫線", () => {
  it.each([
    ["頂層 x 右緣", three, zToX, "block-vertical-right", ".bn-block-outer"],
    ["欄內 a 左緣", twoCols, inTwoCols("a1", 5), "block-vertical-left", '[data-node-type="column"]'],
  ] as const)("H1 拖 z 到%s → 直線，nodeDOM(pos) 是目標的框", (_label, content, g, orientation, targetSelector) => {
    const hook = vi.spyOn(edgeDropModule, "computeDropPosition");
    const m = mount(content());
    mockRects(g.boxes);
    const { dataTransfer } = startBlockDrag(m.editor, g.drag);
    dragOver(m, textIn(m, g.target), g.at, dataTransfer);
    expectOneRealHookCall(hook);
    const result = hook.mock.results[0]!.value as { pos: number; orientation: string };
    expect(result.orientation).toBe(orientation);
    expect((m.view.nodeDOM(result.pos) as HTMLElement).matches(targetSelector)).toBe(true);
    const el = cursorEl(m);
    expect(el).not.toBeNull();
    expect(el!.classList.contains("prosemirror-dropcursor-vertical")).toBe(true);
    expect(el!.classList.contains(`prosemirror-dropcursor-${orientation}`)).toBe(true);
  });

  it("H1 拖 z 到 x 中間（不在左右緣）→ core 的橫線", () => {
    const hook = vi.spyOn(edgeDropModule, "computeDropPosition");
    const m = mount(three());
    mockRects(zToX.boxes);
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    dragOver(m, textIn(m, "x1"), [300, 115], dataTransfer);
    expectOneRealHookCall(hook);
    expect(hook.mock.results[0]!.value).toEqual(hook.mock.calls[0]![0].defaultPosition);
    const el = cursorEl(m);
    expect(el).not.toBeNull();
    expect(el!.classList.contains("prosemirror-dropcursor-block-horizontal")).toBe(true);
    expect(el!.classList.contains("prosemirror-dropcursor-vertical")).toBe(false);
  });
});

// ─── C 組：與既有拖放的組合 ────────────────────────────────────────────────────

describe("C1 站內拖曳帶媒體 data URL", () => {
  it("C1 ⋮⋮ 拖 z 到 x 右緣、dataTransfer 帶 data URL 圖 → 媒體阻擋 toast、文件不變、edgeDrop 零呼叫", () => {
    const m = mount(three());
    const s = spies();
    mockRects(zToX.boxes);
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    dataTransfer.setData("text/html", '<img src="data:image/png;base64,AAAA">');
    const before = shape(m.editor);
    drop(m, textIn(m, "x1"), zToX.at, dataTransfer);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(shape(m.editor)).toBe(before);
    expect(s.edge).not.toHaveBeenCalled();
    expect(s.empty).not.toHaveBeenCalled();
  });
});

const EXTERNAL_HTML = () => ({ types: ["text/html", "text/plain"], getData: (t: string) => (t === "text/html" ? "<p>ext</p>" : "ext"), items: [], files: [] });

describe("C2 外部拖入不出直線", () => {
  it("C2 外部 HTML 拖到 x 右緣 → DropCursor 不畫直線、edgeDrop 回 false、照現行插入", () => {
    const hook = vi.spyOn(edgeDropModule, "computeDropPosition");
    const m = mount(three());
    const s = spies();
    mockRects(zToX.boxes);
    expect(m.view.dragging).toBeNull(); // 前提：外部拖入
    dragOver(m, textIn(m, "x1"), zToX.at, EXTERNAL_HTML());
    expectOneRealHookCall(hook);
    expect(hook.mock.results[0]!.value).toEqual(hook.mock.calls[0]![0].defaultPosition);
    expect(m.container.querySelector(".prosemirror-dropcursor-vertical")).toBeNull();
    drop(m, textIn(m, "x1"), zToX.at, EXTERNAL_HTML());
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(false);
    expect(shape(m.editor)).not.toContain("ROW");
    expect(shape(m.editor)).toContain("paragraph:ext");
  });
});

describe("C4 溝裡的檔案拖放", () => {
  // [a｜b]：列 y 100–300、欄 0–288 與 312–600（溝 288–312），a、b 各佔欄頂 100–140（中線 120）。
  const content = () => [row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")];
  const boxes: Record<string, Box> = { ...rowBoxes("r", 100, 300, 2), "blockOuter:a1": [0, 100, 288, 140], "blockOuter:b1": [312, 100, 600, 140] };

  /** 依座標回 pos：溝裡 → 列內兩欄之間；第 2 欄 → b 的文字；第 1 欄 → a 的文字。core 會用改過的座標再問一次。 */
  function posByCoords(m: Mounted): void {
    m.view.posAtCoords = ({ left }: { left: number; top: number }) => {
      const rowPos = blockPos(m.editor, "r");
      if (left > 288 && left < 312) return { pos: rowPos + 1 + m.view.state.doc.nodeAt(rowPos).child(0).nodeSize, inside: -1 };
      return { pos: textIn(m, left >= 312 ? "b1" : "a1"), inside: -1 };
    };
  }

  /** 只帶一個 png 檔的 drop（或給定的 `dataTransfer`）；回傳事件與 dispatch 期間 listener 丟出的例外（jsdom 以 window 的 error 事件回報）。 */
  function fileDrop(m: Mounted, at: readonly [number, number], given?: unknown): { event: DragEvent; errors: unknown[] } {
    const file = new File(["x"], "pic.png", { type: "image/png" });
    const dataTransfer = given ?? { types: ["Files"], files: [file], items: [{ kind: "file", type: file.type, getAsFile: () => file }], getData: () => "" };
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => void errors.push(e.error);
    window.addEventListener("error", onError);
    const event = dragEventAt("drop", dataTransfer, at);
    try {
      m.view.dom.dispatchEvent(event);
    } finally {
      window.removeEventListener("error", onError);
    }
    return { event, errors };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  it.each([
    ["上半", 110, [456, 110], "ROW[COL(paragraph:a) | COL(image,paragraph:b)]  paragraph:z"],
    ["下半", 135, [456, 130], "ROW[COL(paragraph:a) | COL(paragraph:b,image)]  paragraph:z"],
  ] as const)("C4 溝裡偏第 2 欄、y 在 b 的%s → 座標改到 b 框內、圖片插在 b 的那一側、drop 被 preventDefault", async (_half, y, moved, expected) => {
    const m = mount(content());
    const s = spies();
    mockRects(boxes);
    posByCoords(m);
    const upload = vi.fn(() => Promise.resolve("/api/uploads/new"));
    (m.editor as any).uploadFile = upload;
    const { event, errors } = fileDrop(m, [305, y]);
    expect(errors).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(s.edge).not.toHaveBeenCalled(); // 只帶檔案：PM 不會問到 handleDrop
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(shape(m.editor)).toBe(expected);
    const image = (m.editor.document[0] as any).children[1].children.find((b: any) => b.type === "image");
    expect(image.props.url).toBe("/api/uploads/new");
    expect([event.clientX, event.clientY]).toEqual(moved);
  });

  it("C4 落點在欄內 → 不改座標，圖片照 core 插在 b 之後", async () => {
    const m = mount(content());
    mockRects(boxes);
    posByCoords(m);
    (m.editor as any).uploadFile = vi.fn(() => Promise.resolve("/api/uploads/new"));
    const { event, errors } = fileDrop(m, [450, 130]);
    expect(errors).toEqual([]);
    expect([event.clientX, event.clientY]).toEqual([450, 130]);
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:b,image)]  paragraph:z");
  });

  it("C4 ⋮⋮ 橫線拖進溝裡 → 座標在 PM 放置之前改到最近欄的最近 block，z 落在第 2 欄", () => {
    const m = mount(content());
    const s = spies();
    mockRects(boxes);
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    posByCoords(m);
    const event = dragEventAt("drop", dataTransfer, [305, 135]);
    m.view.dom.dispatchEvent(event);
    m.editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true }));
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(false);
    expect(shape(m.editor)).toMatch(/^ROW\[COL\(paragraph:a\) \| COL\([^)]*paragraph:z[^)]*\)\]/);
    expect([event.clientX, event.clientY]).toEqual([456, 130]);
  });

  it("C4 ⋮⋮ 拖到第 2 欄左緣區、posAtCoords 卻落在兩欄之間 → 照直線加欄，座標不改", () => {
    const m = mount(content());
    const s = spies();
    mockRects(boxes);
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    const rowPos = blockPos(m.editor, "r");
    m.view.posAtCoords = () => ({ pos: rowPos + 1 + m.view.state.doc.nodeAt(rowPos).child(0).nodeSize, inside: -1 });
    const event = dragEventAt("drop", dataTransfer, [316, 135]);
    m.view.dom.dispatchEvent(event);
    m.editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true }));
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(true);
    expect([event.clientX, event.clientY]).toEqual([316, 135]);
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:z) | COL(paragraph:b)]");
  });

  it("C4 溝裡的拖放帶 text/html 與 Files（文字表示排在 Files 前面）→ 不改座標", () => {
    const m = mount(content());
    mockRects(boxes);
    posByCoords(m);
    // `files` 為空：有檔案時媒體阻擋會先以「帶了文字表示」擋下，走不到這裡的判斷。
    const dataTransfer = { types: ["text/html", "Files"], files: [], items: [], getData: (t: string) => (t === "text/html" ? "<p>ext</p>" : "") };
    const { event, errors } = fileDrop(m, [305, 135], dataTransfer);
    expect(errors).toEqual([]);
    expect([event.clientX, event.clientY]).toEqual([305, 135]);
  });

  describe("C4 堆疊的列：各欄 x 範圍相同，最近的欄由 y 決定", () => {
    // [a｜b｜c] 堆疊成上下三段：欄 y 100–180、192–272、284–364（段間 12px），x 都是 0–600；a、b、c 各佔欄頂 40px。
    const stacked = () => [row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z1")];
    const stackedBoxes: Record<string, Box> = {
      "columnList:r": [0, 100, 600, 364],
      "column:rc0": [0, 100, 600, 180],
      "column:rc1": [0, 192, 600, 272],
      "column:rc2": [0, 284, 600, 364],
      "blockOuter:a1": [0, 100, 600, 140],
      "blockOuter:b1": [0, 192, 600, 232],
      "blockOuter:c1": [0, 284, 600, 324],
    };
    const blockAt: Array<[string, number, number]> = [
      ["a1", 100, 140],
      ["b1", 192, 232],
      ["c1", 284, 324],
    ];

    /** 落在某個 block 框內 → 它的文字；其餘（段間、列外側）→ 第 2、3 欄之間。 */
    function posStacked(m: Mounted): void {
      m.view.posAtCoords = ({ left, top }: { left: number; top: number }) => {
        const hit = left >= 0 && left <= 600 ? blockAt.find(([, t, b]) => top >= t && top <= b) : undefined;
        if (hit) return { pos: textIn(m, hit[0]), inside: -1 };
        const rowPos = blockPos(m.editor, "r");
        const row0 = m.view.state.doc.nodeAt(rowPos);
        return { pos: rowPos + 1 + row0.child(0).nodeSize + row0.child(1).nodeSize, inside: -1 };
      };
    }

    it.each([
      ["第 2、3 段之間偏第 3 段", [300, 280]],
      ["列右外側、與第 3 欄同高", [605, 300]],
    ] as const)("C4 檔案落在%s → 圖片插在 c 之前", async (_label, at) => {
      const m = mount(stacked());
      mockRects(stackedBoxes);
      posStacked(m);
      (m.editor as any).uploadFile = vi.fn(() => Promise.resolve("/api/uploads/new"));
      const { event, errors } = fileDrop(m, at);
      expect(errors).toEqual([]);
      await settle();
      expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:b) | COL(image,paragraph:c)]  paragraph:z");
      expect([event.clientX, event.clientY]).toEqual([300, 294]);
    });
  });
});

describe("C5 大小上限與直線放置", () => {
  /** 包住產品碼的 `createNoteSizePasteHandlers`，回傳它那支 `handleDrop` 的 spy；要在 mount 之前呼叫。 */
  function spySizeDrop() {
    const original = sizeGuardModule.createNoteSizePasteHandlers;
    const handleDrop = vi.fn();
    vi.spyOn(sizeGuardModule, "createNoteSizePasteHandlers").mockImplementation((guard) => {
      const handlers = original(guard);
      handleDrop.mockImplementation(handlers.handleDrop);
      return { ...handlers, handleDrop };
    });
    return handleDrop;
  }

  it("C5 大小上限回 true：外部拖入被擋、文件不變；edgeDrop／emptyColumnDrop 都回 false 之後 size 的 handleDrop 被呼叫一次", () => {
    const sizeDrop = spySizeDrop();
    const guard = vi.fn(() => true);
    const m = mount(three(), { sizeGuard: guard });
    const s = spies();
    mockRects(zToX.boxes);
    const before = shape(m.editor);
    drop(m, textIn(m, "x1"), zToX.at, EXTERNAL_HTML());
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(false);
    expect(s.empty.mock.results.map((r) => r.value)).toEqual([false]);
    expect(sizeDrop).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(shape(m.editor)).toBe(before);
  });

  it("C5 大小上限回 true：⋮⋮ 直線放置照做、size 的 handleDrop 不被呼叫", () => {
    const sizeDrop = spySizeDrop();
    const m = mount(three(), { sizeGuard: () => true });
    takenDrop(m, () => dragDrop(m, zToX));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y");
    expect(sizeDrop).not.toHaveBeenCalled();
  });

  it("C5 大小上限回 true：⋮⋮ 放進空欄照做、size 的 handleDrop 不被呼叫", () => {
    const sizeDrop = spySizeDrop();
    const m = mount([row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r"), P("z", "z1")], { sizeGuard: () => true });
    takenDrop(m, () => dragDrop(m, { drag: "z1", target: "e1", at: [450, 200], boxes: rowBoxes("r", 100, 300, 2) }), "empty");
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:z)]");
    expect(sizeDrop).not.toHaveBeenCalled();
  });

  it("C5 ⋮⋮ 橫線放置（edgeDrop／emptyColumnDrop 都回 false）→ size 的 handleDrop 被呼叫一次（搬移不估大小）、照 PM 搬移", () => {
    const sizeDrop = spySizeDrop();
    const guard = vi.fn(() => true);
    const m = mount(three(), { sizeGuard: guard });
    const s = spies();
    dragDrop(m, { ...zToX, at: [300, 115] });
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(false);
    expect(sizeDrop).toHaveBeenCalledTimes(1);
    expect(sizeDrop.mock.calls[0]![3]).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    expect(shape(m.editor)).not.toContain("ROW");
  });
});

describe("C6 handleDrop 跑完就清掉記下的被拖 block", () => {
  it.each([
    ["直線放置（接手）", [590, 115], true],
    ["橫線放置（不接手）", [300, 115], false],
  ] as const)("C6 %s：drop 之後、dragend 之前，記錄已經是 null", (_label, at, taken) => {
    const m = mount(three());
    const s = spies();
    mockRects(zToX.boxes);
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    expect(draggedBlocksOf(m.view)).not.toBeNull(); // 前提
    m.view.posAtCoords = () => ({ pos: textIn(m, "x1"), inside: -1 });
    m.view.dom.dispatchEvent(dropEvent(dataTransfer, at));
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(taken);
    expect(draggedBlocksOf(m.view)).toBeNull();
  });
});
