/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view／selection 內部物件（型別在 apps/web 拿不到） */
import { afterEach, describe, expect, it, vi } from "vitest";
import { P, mountEditor, row, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import {
  classifyEdge,
  columnAt,
  draggedFromSelection,
  edgeSideOf,
  edgeTargetAt,
  edgeZone,
  insideAny,
  isEmptyParagraph,
  rowsOf,
  type DraggedBlocks,
  type RowBox,
} from "./drag-geometry";
import { STACKED_ATTR } from "./layout-extension";
import { findNodeById } from "./position";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  vi.restoreAllMocks();
});

function mount(content: PartialBlockLike[]) {
  const mounted = mountEditor(content);
  cleanups.push(mounted.destroy);
  return { ...mounted, view: mounted.editor.prosemirrorView as any };
}

const posOf = (view: any, id: string): number => (findNodeById(view.state.doc, id) as { pos: number }).pos;
/** `id` 那個 blockContainer 內第一個 textblock 的開頭（游標位置）。 */
const textPosIn = (view: any, id: string): number => posOf(view, id) + 2;

type Box = readonly [left: number, top: number, right: number, bottom: number];

/**
 * jsdom 的 rect 全是 0：以 `<data-node-type>:<data-id>` 查表回值（`blockOuter:y1`、`columnList:r`、`column:rc0`）。
 * 掛在 prototype、依身分回值：欄寬或文件一變 PM 會換掉元素，掛在單一元素上的 mock 就失效。查不到的元素回原實作。
 */
function mockRects(boxes: Record<string, Box>): void {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes[`${this.getAttribute("data-node-type")}:${this.getAttribute("data-id")}`];
    return box ? new DOMRect(box[0], box[1], box[2] - box[0], box[3] - box[1]) : original.call(this);
  });
}

/** 列 `id`（欄 id `${id}c${i}`）佔 x 0–600、y top–bottom，n 欄等寬、欄間 24px 溝。 */
function rowBoxes(id: string, top: number, bottom: number, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, top, 600, bottom] };
  for (let i = 0; i < n; i++) out[`column:${id}c${i}`] = [i * (width + 24), top, i * (width + 24) + width, bottom];
  return out;
}

/**
 * core ⋮⋮ 的真路徑：⋮⋮ 替身掛在 `view.dom` 的父元素下（`editor.mount(el)` 讓 el 本身成為 `view.dom`），它的 dragstart 呼叫
 * `blockDragStart`，冒泡到 root 讓 SideMenu 設 `view.dragging`。`range` 給兩個 block id 時先把文字選取從前者拉到後者
 * （core 會轉成多選）。回傳 dragstart 那一刻的選取所判定的 X。
 */
function startBlockDrag(editor: AnyEditor, blockId: string, range?: readonly [string, string]): DraggedBlocks | null {
  const view = editor.prosemirrorView as any;
  if (range) {
    const TextSelection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPosIn(view, range[0]), textPosIn(view, range[1]))));
  }
  const data = new Map<string, string>();
  const dataTransfer = {
    get types() {
      return [...data.keys()];
    },
    setData: (t: string, v: string) => void data.set(t, v),
    getData: (t: string) => data.get(t) ?? "",
    clearData: () => data.clear(),
    setDragImage: () => {},
    items: [],
    files: [],
    effectAllowed: "uninitialized",
    dropEffect: "none",
  };
  const handle = document.createElement("div");
  editor.domElement!.parentElement!.appendChild(handle);
  handle.addEventListener("dragstart", (e) => (editor.getExtension("sideMenu") as any).blockDragStart(e, editor.getBlock(blockId)));
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  handle.dispatchEvent(event);
  handle.remove();
  expect(view.dragging).toBeTruthy();
  return draggedFromSelection(view.state.selection);
}

/** `posAtCoords` 的替身：固定回 `pos`（呼叫次數由回傳的 spy 斷言）。 */
const stubPosAtCoords = (view: any, pos: number) => vi.spyOn(view, "posAtCoords").mockReturnValue({ pos, inside: -1 });

describe("G1 左右緣區與列內定欄（純幾何）", () => {
  it("G1 edgeZone：0.2×框寬夾在 [24, 64]", () => {
    expect([100, 200, 320, 1000].map(edgeZone)).toEqual([24, 40, 64, 64]);
  });

  it("G1 edgeSideOf：左緣區 [左, 左+z)、右緣區 (右−z, 右]，框外不算", () => {
    const box = { left: 0, right: 100 };
    const cases: Array<[number, "left" | "right" | null]> = [
      [0, "left"],
      [23, "left"],
      [24, null],
      [-1, null],
      [76, null],
      [77, "right"],
      [100, "right"],
      [101, null],
    ];
    for (const [x, side] of cases) expect([x, edgeSideOf(box, x)]).toEqual([x, side]);
  });

  // [長欄｜短欄]：列高 400，短欄內容只到 50；欄框的上下一律用列高，所以短欄下方的空白仍屬短欄。
  const rows: RowBox[] = [
    {
      id: "r",
      pos: 0,
      top: 0,
      bottom: 400,
      left: 0,
      right: 600,
      stacked: false,
      columns: [
        { id: "long", pos: 1, left: 0, right: 288 },
        { id: "short", pos: 20, left: 312, right: 600 },
      ],
    },
  ];

  it("G1 columnAt：短欄下方的空白以 x 定在短欄；溝 → colIndex null；列外 → null", () => {
    expect(columnAt(rows, 600 - 5, 300)).toEqual({ row: rows[0], colIndex: 1 });
    expect(columnAt(rows, 300, 300)).toEqual({ row: rows[0], colIndex: null });
    expect(columnAt(rows, 300, 401)).toBeNull();
    expect(columnAt(rows, 601, 300)).toBeNull();
  });

  it("G1 columnAt：堆疊的列不算", () => {
    expect(columnAt([{ ...rows[0]!, stacked: true }], 600 - 5, 300)).toBeNull();
  });
});

describe("G1b 未堆疊的列內以 x 定欄，不經 posAtCoords", () => {
  function setup() {
    const m = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects(rowBoxes("r", 100, 300, 2)); // rc0 0–288、rc1 312–600
    const dragged = startBlockDrag(m.editor, "z1");
    const spy = stubPosAtCoords(m.view, textPosIn(m.view, "a1")); // 故意回第 1 欄的位置
    return { ...m, dragged, spy };
  }

  it("G1b posAtCoords 回第 1 欄、x 在第 2 欄右緣區 → 第 2 欄右側加欄，posAtCoords 零呼叫", () => {
    const { view, dragged, spy } = setup();
    expect(edgeTargetAt(view, { clientX: 590, clientY: 280 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc1",
      side: "right",
      pos: posOf(view, "rc1"),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("G1b x 在溝裡 → null，posAtCoords 零呼叫", () => {
    const { view, dragged, spy } = setup();
    expect(edgeTargetAt(view, { clientX: 300, clientY: 200 }, dragged)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("G1b 同一組座標，列堆疊 → 改走 posAtCoords（呼叫一次）", () => {
    const { view, dragged, spy } = setup();
    // 堆疊外掛在 jsdom 量不到寬度；這裡直接掛上它寫的屬性，同步讀完（PM 的 MutationObserver 在 microtask 才處理）。
    view.dom.querySelector('[data-node-type="columnList"]').setAttribute(STACKED_ATTR, "");
    edgeTargetAt(view, { clientX: 590, clientY: 280 }, dragged);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("G1b rowsOf：列與欄的 pos 是節點之前的位置（posAtDOM(el, 0) − 1），讀得到堆疊屬性", () => {
    const { view } = setup();
    const [box] = rowsOf(view);
    expect(box).toMatchObject({ id: "r", pos: posOf(view, "r"), top: 100, bottom: 300, left: 0, right: 600, stacked: false });
    expect(box!.columns).toEqual([
      { id: "rc0", pos: posOf(view, "rc0"), left: 0, right: 288 },
      { id: "rc1", pos: posOf(view, "rc1"), left: 312, right: 600 },
    ]);
    view.dom.querySelector('[data-node-type="columnList"]').setAttribute(STACKED_ATTR, "");
    expect(rowsOf(view)[0]!.stacked).toBe(true);
  });
});

describe("G2 合格的目標 block（不在未堆疊列內，經 posAtCoords）", () => {
  const stack = (view: any) => view.dom.querySelector('[data-node-type="columnList"]').setAttribute(STACKED_ATTR, "");

  it("G2 頂層 block → 以它的 .bn-block-outer 為框，建列", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(editor, "z1");
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 10, clientY: 115 }, dragged)).toEqual({ kind: "newRow", yId: "y1", side: "left", pos: posOf(view, "y1") });
  });

  it("G2 欄的直接子 block（堆疊的列）→ 以所在欄為框，加欄", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects({ "column:rc1": [0, 200, 600, 260] });
    const dragged = startBlockDrag(editor, "z1");
    stack(view);
    stubPosAtCoords(view, textPosIn(view, "b1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 230 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc1",
      side: "right",
      pos: posOf(view, "rc1"),
    });
  });

  it("G2 欄內縮排的子 block → 落到該欄的直接子 block，以欄判定", () => {
    const { editor, view } = mount([row([[withChildren(P("a", "a1"), [P("a2", "a2")])], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects({ "column:rc0": [0, 100, 600, 190] });
    const dragged = startBlockDrag(editor, "z1");
    stack(view);
    stubPosAtCoords(view, textPosIn(view, "a2"));
    expect(edgeTargetAt(view, { clientX: 5, clientY: 150 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc0",
      side: "left",
      pos: posOf(view, "rc0"),
    });
  });

  it("G2 頂層 block 的子 block → 落到頂層 block", () => {
    const { editor, view } = mount([withChildren(P("p", "p1"), [P("q", "q1")]), P("z", "z1")]);
    mockRects({ "blockOuter:p1": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "z1");
    stubPosAtCoords(view, textPosIn(view, "q1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 150 }, dragged)).toEqual({ kind: "newRow", yId: "p1", side: "right", pos: posOf(view, "p1") });
  });

  const table = (id: string): PartialBlockLike =>
    ({ id, type: "table", content: { type: "tableContent", rows: [{ cells: ["k", "l"] }] } }) as PartialBlockLike;
  /** 表格第一格的文字開頭。 */
  const cellPos = (view: any, tableId: string): number => {
    let pos = -1;
    view.state.doc.nodeAt(posOf(view, tableId)).descendants((n: any, p: number) => {
      if (pos < 0 && n.isText) pos = posOf(view, tableId) + 1 + p;
    });
    return pos;
  };

  it("G2 頂層表格的格子 → 落到表格 block", () => {
    const { editor, view } = mount([table("t1"), P("z", "z1")]);
    mockRects({ "blockOuter:t1": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "z1");
    stubPosAtCoords(view, cellPos(view, "t1"));
    expect(view.state.doc.resolve(cellPos(view, "t1")).parent.type.name).toBe("tableParagraph"); // 前提：落點真的在格子裡
    expect(edgeTargetAt(view, { clientX: 590, clientY: 130 }, dragged)).toEqual({ kind: "newRow", yId: "t1", side: "right", pos: posOf(view, "t1") });
  });

  it("G2 欄內表格的格子 → 落到表格所在的欄", () => {
    const { editor, view } = mount([row([[table("t1")], [P("b", "b1")]], "r"), P("z", "z1")]);
    mockRects({ "column:rc0": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "z1");
    stack(view);
    stubPosAtCoords(view, cellPos(view, "t1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 130 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc0",
      side: "right",
      pos: posOf(view, "rc0"),
    });
  });

  it("G2 posAtCoords 回 null 或丟例外 → null", () => {
    const { editor, view } = mount([P("x", "x1"), P("z", "z1")]);
    const dragged = startBlockDrag(editor, "z1");
    vi.spyOn(view, "posAtCoords").mockReturnValue(null);
    expect(edgeTargetAt(view, { clientX: 5, clientY: 5 }, dragged)).toBeNull();
    vi.spyOn(view, "posAtCoords").mockImplementation(() => {
      throw new Error("posAtCoords");
    });
    expect(edgeTargetAt(view, { clientX: 5, clientY: 5 }, dragged)).toBeNull();
  });
});

describe("G3 不出直線", () => {
  /** 基準：頂層 [x, y, z]，⋮⋮ 拖 z 到 y 的右緣區 → 建列。下面每案只改一個條件。 */
  function base() {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(m.editor, "z1");
    stubPosAtCoords(m.view, textPosIn(m.view, "y1"));
    return { ...m, dragged, event: { clientX: 590, clientY: 115 } };
  }

  it("G3 基準：拖 z 到 y 右緣 → 建列（下面各案的對照）", () => {
    const { view, dragged, event } = base();
    expect(edgeTargetAt(view, event, dragged)).toEqual({ kind: "newRow", yId: "y1", side: "right", pos: posOf(view, "y1") });
  });

  it("G3 合成事件（座標被夾進框內的那一筆）→ null", () => {
    const { view, dragged, event } = base();
    expect(edgeTargetAt(view, { ...event, synthetic: true }, dragged)).toBeNull();
  });

  it("G3 複製拖（非 mac 按 Ctrl）→ null；mac 上 Ctrl 不算、Alt 才算", () => {
    const { view, dragged, event } = base();
    expect(edgeTargetAt(view, { ...event, ctrlKey: true }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { ...event, altKey: true }, dragged)).not.toBeNull();
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    cleanups.push(() => delete (navigator as any).platform);
    expect(navigator.platform).toBe("MacIntel");
    expect(edgeTargetAt(view, { ...event, altKey: true }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { ...event, ctrlKey: true }, dragged)).not.toBeNull();
  });

  it("G3 編輯器唯讀 → null", () => {
    const { editor, view, dragged, event } = base();
    editor.isEditable = false;
    expect(view.editable).toBe(false);
    expect(edgeTargetAt(view, event, dragged)).toBeNull();
  });

  it("G3 沒有記下的 X（dragged == null）→ null", () => {
    const { view, event } = base();
    expect(edgeTargetAt(view, event, null)).toBeNull();
  });

  it("G3 不在拖曳中（view.dragging == null）→ null", () => {
    const { view, dragged, event } = base();
    view.dragging = null;
    expect(edgeTargetAt(view, event, dragged)).toBeNull();
  });

  it("G3 X 含欄 → draggedFromSelection 回 null；手動帶欄 id 的 X 也回 null", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 400, 600, 430] });
    const dragged = startBlockDrag(editor, "y1", ["y1", "z1"]);
    expect(dragged).toEqual({ ids: ["y1", "z1"], kind: "multi", hasRows: false });
    const MultipleNodeSelection = view.state.selection.constructor;
    const rc0 = posOf(view, "rc0");
    const overColumn = MultipleNodeSelection.create(view.state.doc, rc0, rc0 + view.state.doc.nodeAt(rc0).nodeSize);
    expect(overColumn.nodes.map((n: any) => n.type.name)).toEqual(["column"]); // 前提：真的是只含欄的多選
    expect(draggedFromSelection(overColumn)).toBeNull();
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, { ids: ["rc0"], kind: "multi", hasRows: false })).toBeNull();
  });

  it("G3 X 含列（多選頂層 p 與列）→ hasRows，null", () => {
    const { editor, view } = mount([P("p", "p1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")]);
    mockRects({ "blockOuter:y1": [0, 400, 600, 430] });
    const dragged = startBlockDrag(editor, "p1", ["p1", "a1"]);
    expect(dragged).toEqual({ ids: ["p1", "r"], kind: "multi", hasRows: true });
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, { ...dragged!, ids: ["p1"], hasRows: false })).not.toBeNull(); // 對照：只拖 p
  });

  it("G3 跨欄多選（兩端父節點不同）→ draggedFromSelection 回 null", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("d", "d1")]], "r"), P("y", "y1")]);
    const dragged = startBlockDrag(editor, "a1", ["a1", "d1"]);
    const sel = view.state.selection;
    expect(sel.toJSON().type).toBe("multiple-node"); // 前提：core 把跨欄的文字選取轉成多選
    expect(sel.$from.sameParent(sel.$to)).toBe(false);
    expect(dragged).toBeNull();
    mockRects({ "blockOuter:y1": [0, 400, 600, 430] });
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 415 }, dragged)).toBeNull();
  });

  it("G3 頂層 Y 就是 X → null", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(editor, "y1");
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 115 }, dragged)).toBeNull();
  });

  it("G3 頂層 Y 是多選 X 的第二個 → null", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    mockRects({ "blockOuter:y1": [0, 100, 600, 130] });
    const dragged = startBlockDrag(editor, "x1", ["x1", "y1"]);
    expect(dragged).toEqual({ ids: ["x1", "y1"], kind: "multi", hasRows: false });
    stubPosAtCoords(view, textPosIn(view, "y1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 115 }, dragged)).toBeNull();
  });

  it("G3 指標在 X 的子 block 上（合格 Y 落到 X 本身）→ null", () => {
    const { editor, view } = mount([withChildren(P("p", "p1"), [P("q", "q1")]), P("z", "z1")]);
    mockRects({ "blockOuter:p1": [0, 100, 600, 160] });
    const dragged = startBlockDrag(editor, "p1");
    stubPosAtCoords(view, textPosIn(view, "q1"));
    expect(edgeTargetAt(view, { clientX: 590, clientY: 150 }, dragged)).toBeNull();
  });

  it("G3 列已 4 欄 → null（對照：3 欄加得進去）", () => {
    const four = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]], "r"), P("z", "z1")]);
    mockRects(rowBoxes("r", 100, 300, 4)); // rc1 156–288
    const dragged4 = startBlockDrag(four.editor, "z1");
    expect(edgeTargetAt(four.view, { clientX: 280, clientY: 200 }, dragged4)).toBeNull();
    four.destroy();
    cleanups = cleanups.filter((c) => c !== four.destroy);
    vi.restoreAllMocks();

    const three = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r"), P("z", "z1")]);
    mockRects(rowBoxes("r", 100, 300, 3)); // rc1 208–392
    const dragged3 = startBlockDrag(three.editor, "z1");
    expect(edgeTargetAt(three.view, { clientX: 385, clientY: 200 }, dragged3)).toMatchObject({ kind: "addColumn", columnId: "rc1", side: "right" });
  });

  // 三欄列 [a｜b｜c]（rc0 0–184、rc1 208–392、rc2 416–600），X＝b（第 2 欄的全部）：插在第 2 欄左右緣、左鄰欄右緣、右鄰欄左緣
  // 都只會多一個空欄。對照：第 2 欄多一個 b2、X 仍是 b → 同一組座標照出直線。
  const noOps: Array<[string, number, string, "left" | "right"]> = [
    ["第 2 欄左緣", 210, "rc1", "left"],
    ["第 2 欄右緣", 390, "rc1", "right"],
    ["左鄰欄右緣", 182, "rc0", "right"],
    ["右鄰欄左緣", 418, "rc2", "left"],
  ];
  it.each(noOps)("G3 等於沒動：X 是某欄的全部，插在%s → null（對照：該欄還有別的 block 時照出）", (_label, x, columnId, side) => {
    const whole = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 3));
    const dragged = startBlockDrag(whole.editor, "b1");
    expect(edgeTargetAt(whole.view, { clientX: x, clientY: 200 }, dragged)).toBeNull();
    whole.destroy();
    cleanups = cleanups.filter((c) => c !== whole.destroy);
    vi.restoreAllMocks();

    const partial = mount([row([[P("a", "a1")], [P("b", "b1"), P("b2", "b2")], [P("c", "c1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 3));
    const dragged2 = startBlockDrag(partial.editor, "b1");
    expect(edgeTargetAt(partial.view, { clientX: x, clientY: 200 }, dragged2)).toMatchObject({ kind: "addColumn", columnId, side });
  });

  it("G3 等於沒動：[a｜b] 拖 b 到 a 右緣 → null", () => {
    const { editor, view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 2));
    const dragged = startBlockDrag(editor, "b1");
    expect(edgeTargetAt(view, { clientX: 280, clientY: 200 }, dragged)).toBeNull();
    expect(edgeTargetAt(view, { clientX: 5, clientY: 200 }, dragged)).toMatchObject({ kind: "addColumn", columnId: "rc0", side: "left" }); // 對照
  });

  it("G3 欄內目標以欄為單位：[a,b,c｜d] 多選 a、b，指標在第 1 欄右緣區、壓在 a 與 c 上 → 同一個目標", () => {
    const { editor, view } = mount([row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 2));
    const dragged = startBlockDrag(editor, "a1", ["a1", "b1"]);
    expect(dragged).toEqual({ ids: ["a1", "b1"], kind: "multi", hasRows: false });
    const onA = edgeTargetAt(view, { clientX: 280, clientY: 110 }, dragged);
    const onC = edgeTargetAt(view, { clientX: 280, clientY: 170 }, dragged);
    expect(onA).toEqual({ kind: "addColumn", rowId: "r", columnId: "rc0", side: "right", pos: posOf(view, "rc0") });
    expect(onC).toEqual(onA);
  });

  it("G3 判準吃記下的 X、不讀當下選取：多選退化成文字選取後仍出直線", () => {
    const { editor, view } = mount([row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")]);
    mockRects(rowBoxes("r", 100, 300, 2));
    const dragged = startBlockDrag(editor, "a1", ["a1", "b1"]);
    expect(dragged).toEqual({ ids: ["a1", "b1"], kind: "multi", hasRows: false });
    const Selection = Object.getPrototypeOf(view.state.selection.constructor);
    const text = Selection.fromJSON(view.state.doc, { type: "text", anchor: textPosIn(view, "a1"), head: textPosIn(view, "b1") });
    view.dispatch(view.state.tr.setSelection(text));
    expect(view.state.selection.toJSON().type).toBe("text"); // 前提：當下選取已不是多選
    expect(draggedFromSelection(view.state.selection)).toBeNull();
    expect(edgeTargetAt(view, { clientX: 280, clientY: 170 }, dragged)).toEqual({
      kind: "addColumn",
      rowId: "r",
      columnId: "rc0",
      side: "right",
      pos: posOf(view, "rc0"),
    });
  });
});

describe("DS draggedFromSelection", () => {
  it("DS1 ⋮⋮ 拖單一 block → node", () => {
    const { editor } = mount([P("x", "x1"), P("y", "y1")]);
    expect(startBlockDrag(editor, "y1")).toEqual({ ids: ["y1"], kind: "node", hasRows: false });
  });

  it("DS2 不是 blockContainer 的 NodeSelection、文字選取 → null", () => {
    const { view } = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")]);
    const Selection = Object.getPrototypeOf(view.state.selection.constructor);
    const rowSel = Selection.fromJSON(view.state.doc, { type: "node", anchor: posOf(view, "r") });
    expect(rowSel.node.type.name).toBe("columnList");
    expect(draggedFromSelection(rowSel)).toBeNull();
    const contentSel = Selection.fromJSON(view.state.doc, { type: "node", anchor: posOf(view, "y1") + 1 });
    expect(contentSel.node.type.name).toBe("paragraph");
    expect(draggedFromSelection(contentSel)).toBeNull();
    expect(draggedFromSelection(Selection.fromJSON(view.state.doc, { type: "text", anchor: textPosIn(view, "y1"), head: textPosIn(view, "y1") }))).toBeNull();
  });

  it("DS3 欄內兩個 block 的多選 → multi、依文件順序", () => {
    const { editor } = mount([row([[P("a", "a1"), P("b", "b1")], [P("d", "d1")]], "r")]);
    expect(startBlockDrag(editor, "a1", ["a1", "b1"])).toEqual({ ids: ["a1", "b1"], kind: "multi", hasRows: false });
  });
});

describe("EP 空段落與子樹判定", () => {
  const container = (props: Record<string, unknown> | undefined, extra?: Partial<PartialBlockLike>): PartialBlockLike =>
    ({ id: "e1", type: "paragraph", content: [], ...(props ? { props } : {}), ...extra }) as PartialBlockLike;
  const isEmpty = (block: PartialBlockLike): boolean => {
    const { view } = mount([P("x", "x1"), block]);
    return isEmptyParagraph(view.state.doc.nodeAt(posOf(view, "e1")));
  };

  it("EP1 空段落 → true", () => expect(isEmpty(container(undefined))).toBe(true));
  it("EP1 有字 → false", () => expect(isEmpty(P("e", "e1"))).toBe(false));
  it("EP1 有子 block → false", () => expect(isEmpty(container(undefined, { children: [P("k", "k1")] }))).toBe(false));
  it("EP1 文字色非預設 → false", () => expect(isEmpty(container({ textColor: "red" }))).toBe(false));
  it("EP1 背景色非預設 → false", () => expect(isEmpty(container({ backgroundColor: "blue" }))).toBe(false));
  it("EP1 對齊非預設 → false", () => expect(isEmpty(container({ textAlignment: "center" }))).toBe(false));
  it("EP1 型別是標題 → false", () => expect(isEmpty({ id: "e1", type: "heading", props: { level: 1 }, content: [] } as PartialBlockLike)).toBe(false));

  it("EP2 insideAny：[起點, 終點)", () => {
    expect(insideAny(5, [[0, 10]])).toBe(true);
    expect(insideAny(0, [[0, 10]])).toBe(true);
    expect(insideAny(10, [[0, 10]])).toBe(false);
    expect(insideAny(15, [[0, 10], [12, 20]])).toBe(true);
    expect(insideAny(5, [])).toBe(false);
  });
});

describe("CE classifyEdge 的頂層目標", () => {
  it("CE1 yPos 不是頂層 blockContainer 之前 → null", () => {
    const { view } = mount([withChildren(P("p", "p1"), [P("q", "q1")]), P("z", "z1")]);
    const dragged: DraggedBlocks = { ids: ["z1"], kind: "node", hasRows: false };
    expect(classifyEdge(view.state.doc, dragged, { kind: "top", yPos: posOf(view, "p1"), side: "left" })).toMatchObject({ kind: "newRow", yId: "p1" });
    expect(classifyEdge(view.state.doc, dragged, { kind: "top", yPos: posOf(view, "q1"), side: "left" })).toBeNull();
  });

  it("CE2 X 的 id 在當下文件找不到 → null", () => {
    const { view } = mount([P("y", "y1"), P("z", "z1")]);
    const hit = { kind: "top", yPos: posOf(view, "y1"), side: "right" } as const;
    expect(classifyEdge(view.state.doc, { ids: ["z1"], kind: "node", hasRows: false }, hit)).not.toBeNull();
    expect(classifyEdge(view.state.doc, { ids: ["z1", "gone"], kind: "multi", hasRows: false }, hit)).toBeNull();
  });

  it("CE3 X 標了 hasRows → null（對照：同一組 id 不標 hasRows 時建列）", () => {
    const { view } = mount([P("p", "p1"), P("y", "y1")]);
    const hit = { kind: "top", yPos: posOf(view, "y1"), side: "right" } as const;
    expect(classifyEdge(view.state.doc, { ids: ["p1"], kind: "multi", hasRows: false }, hit)).toMatchObject({ kind: "newRow", yId: "y1" });
    expect(classifyEdge(view.state.doc, { ids: ["p1"], kind: "multi", hasRows: true }, hit)).toBeNull();
  });
});
