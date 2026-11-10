import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { COLUMN_TYPE, YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { COLUMN_GAP_PX } from "@/collab/columns/layout";
import { STACKED_ATTR } from "@/collab/columns/layout-extension";
import { writeColumnWidths } from "@/collab/columns/width-preview";
import { ratiosFromPixels } from "@/collab/columns/widths";
import { IMG, P, mountEditor, row, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { ColumnDividers } from "./ColumnDividers";
import { DRAG_ACTIVE_CLASS } from "./use-drag-active-class";

/**
 * 可手動觸發的 ResizeObserver 替身（同 `layout-extension.test.ts`）：`fire(el)` 先斷言 el 已被 observe，再呼叫觀察它的每一個 RO——
 * 直接對沒被 observe 的元素觸發，會讓「根本沒 observe」的接線缺陷空真。版面外掛（堆疊）也用同一個替身。
 */
const observed = new Set<Element>();
let instances: FakeResizeObserver[] = [];
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    instances.push(this);
  }
  observe(target: Element) {
    observed.add(target);
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
    if (!instances.some((ro) => ro.targets.has(target))) observed.delete(target);
  }
  disconnect() {
    for (const t of [...this.targets]) this.unobserve(t);
  }
}
function fire(el: Element) {
  expect(observed.has(el)).toBe(true);
  act(() => {
    for (const ro of instances) {
      if (ro.targets.has(el)) ro.callback([{ target: el } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver);
    }
  });
}

/** animation frame 由測試手動推進：位置重量都合併到下一個 frame，`flushFrames()` 之後才看得到。 */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function flushFrames() {
  act(() => {
    while (frames.size) {
      const batch = [...frames.values()];
      frames = new Map();
      for (const cb of batch) cb(0);
    }
  });
}

/**
 * jsdom 沒有版面：rect 依身分回值。欄的 width 一變 PM 就換掉欄元素，所以 mock 掛在 prototype、每次讀 rect 時依 `data-id` 查文件現值重算：
 * 各欄 px＝`w_i / Σw × (列寬 − 溝寬總和)`，再照 flex 的 min-width 把不到最小寬度的欄固定在最小寬度、其餘照比例分剩下的寬。
 * `fixed` 給某列固定的各欄像素寬（不看文件）。
 */
interface Layout {
  left: number;
  top: number;
  rowWidth: number;
  rowHeight: number;
  rowTops: Record<string, number>;
  fixed: Record<string, number[]>;
}
let layout: Layout;
let columnEl: HTMLElement;
let editorUnderTest: AnyEditor;

const MIN_TEXT = 200;
function flexPx(widths: readonly number[], available: number): number[] {
  const px: (number | null)[] = widths.map(() => null);
  for (;;) {
    const free = widths.map((_, i) => i).filter((i) => px[i] === null);
    const used = px.reduce<number>((a, b) => a + (b ?? 0), 0);
    const grow = free.reduce((a, i) => a + widths[i]!, 0);
    const share = free.map((i) => ((available - used) * widths[i]!) / grow);
    const under = free.filter((_, k) => share[k]! < MIN_TEXT);
    if (under.length === 0) {
      free.forEach((i, k) => (px[i] = share[k]!));
      return px as number[];
    }
    for (const i of under) px[i] = MIN_TEXT;
  }
}
function docWidths(rowId: string): number[] {
  const block = editorUnderTest.getBlock(rowId) as unknown as { children: { props: { width: number } }[] };
  return block.children.map((c) => c.props.width);
}
function columnPx(rowId: string): number[] {
  if (layout.fixed[rowId]) return layout.fixed[rowId]!;
  const widths = docWidths(rowId);
  return flexPx(widths, layout.rowWidth - COLUMN_GAP_PX * (widths.length - 1));
}
const rowTop = (rowId: string) => layout.top + (layout.rowTops[rowId] ?? 100);

function mockLayout(partial: Partial<Layout> = {}) {
  layout = { left: 40, top: 10, rowWidth: 1024, rowHeight: 120, rowTops: {}, fixed: {}, ...partial };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === columnEl) return new DOMRect(layout.left, layout.top, layout.rowWidth, 3000);
    const type = this.getAttribute("data-node-type");
    if (type === "columnList") return new DOMRect(layout.left, rowTop(this.getAttribute("data-id")!), layout.rowWidth, layout.rowHeight);
    if (type === COLUMN_TYPE) {
      const rowEl = this.parentElement!;
      const rowId = rowEl.getAttribute("data-id")!;
      const k = Array.from(rowEl.children).indexOf(this);
      const px = columnPx(rowId);
      const x = layout.left + px.slice(0, k).reduce((a, b) => a + b, 0) + COLUMN_GAP_PX * k;
      return new DOMRect(x, rowTop(rowId), px[k]!, layout.rowHeight);
    }
    return new DOMRect(0, 0, 0, 0);
  });
}

const cleanups: (() => void)[] = [];

beforeAll(() => {
  // jsdom 沒有 pointer capture。
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
});
beforeEach(async () => {
  await i18n.changeLanguage("en");
  observed.clear();
  instances = [];
  frames = new Map();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
  document.body.style.userSelect = "";
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.head.querySelectorAll("style[data-kb-col-preview]").forEach((s) => s.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * 掛一顆共編編輯器到 `columnEl`（分隔線的 container），浮層渲染在同一個 `columnEl` 裡（同筆記頁）。
 * `editable: false` 在 render 前把編輯器設成唯讀。
 */
function setup(
  content: PartialBlockLike[],
  opts: { editable?: boolean; layout?: Partial<Layout>; beforeRender?: () => void } = {},
) {
  columnEl = document.createElement("div");
  document.body.appendChild(columnEl);
  const m = mountEditor(content, { collab: true });
  editorUnderTest = m.editor;
  columnEl.appendChild(m.container);
  const host = document.createElement("div");
  columnEl.appendChild(host);
  mockLayout(opts.layout);
  if (opts.editable === false) m.editor.isEditable = false;
  opts.beforeRender?.();
  const view = render(<ColumnDividers container={columnEl} editor={m.editor} />, { container: host });
  cleanups.push(() => {
    view.unmount();
    m.destroy();
    columnEl.remove();
  });
  flushFrames();
  const editor = m.editor;
  const rowEl = (rowId: string) => editor.domElement!.querySelector<HTMLElement>(`[data-node-type="columnList"][data-id="${rowId}"]`)!;
  const separators = (rowId?: string) =>
    Array.from(columnEl.querySelectorAll<HTMLElement>('[role="separator"]')).filter((s) => !rowId || s.dataset.rowId === rowId);
  const columnOf = (id: string) => editor.domElement!.querySelector<HTMLElement>(`[data-node-type="column"][data-id="${id}"]`)!;
  return { editor, host, unmount: view.unmount, rowEl, separators, columnOf, viewDom: editor.domElement! };
}

const widths = docWidths;
const previewTables = () => document.head.querySelectorAll("style[data-kb-col-preview]");
/** 預覽表每一行的 `[欄 id, grow]`。 */
function previewRows(): [string, number][] {
  const text = previewTables()[0]!.textContent!;
  return text.split("\n").map((line) => {
    const m = /\[data-id="([^"]+)"\] \{ flex-grow: ([\d.]+) !important; \}/.exec(line)!;
    return [m[1]!, Number(m[2])];
  });
}

function countUpdates(editor: AnyEditor) {
  const doc = collabUndoManager(editor)!.doc;
  const spy = vi.fn();
  doc.on("update", spy);
  cleanups.push(() => doc.off("update", spy));
  return spy;
}

const down = (sep: HTMLElement, clientX = 500) => fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX });
const move = (clientX: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX });
const up = (clientX: number) => fireEvent.pointerUp(window, { pointerId: 1, clientX });

/** 兩欄文字、等寬的列 r；三欄文字的列 s。 */
const twoCols = (id = "r", w?: number[]) => row([[P("a")], [P("b")]], id, w);
const threeCols = (id = "s", w?: number[]) => row([[P("a")], [P("b")], [P("c")]], id, w);

describe("S1 渲染", () => {
  it("S1 兩欄列一條、三欄列兩條；aria 與標籤", () => {
    const { separators } = setup([twoCols(), P("x"), threeCols()]);
    expect(separators("r").length).toBe(1);
    expect(separators("s").length).toBe(2);
    const sep = separators("r")[0]!;
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-label")).toBe("Resize columns");
    expect(sep.tabIndex).toBe(0);
    expect(sep.dataset.index).toBe("0");
    expect(separators("s").map((s) => s.dataset.index)).toEqual(["0", "1"]);
    expect(sep.closest(".kb-column-dividers")).not.toBeNull();
  });

  it("S1 列變成堆疊（data-stacked）→ 那一列沒有分隔線", () => {
    const { separators, rowEl } = setup([twoCols(), threeCols()]);
    expect(separators("r").length).toBe(1);
    Object.defineProperty(rowEl("r"), "clientWidth", { value: 300, configurable: true });
    fire(rowEl("r"));
    expect(rowEl("r").hasAttribute(STACKED_ATTR)).toBe(true);
    flushFrames();
    expect(separators("r").length).toBe(0);
    expect(separators("s").length).toBe(2);
  });

  it("S1 唯讀 → 沒有分隔線", () => {
    const { separators } = setup([twoCols(), threeCols()], { editable: false });
    expect(separators().length).toBe(0);
  });
});

describe("S2 指標拖曳", () => {
  it("S2 移動中只改預覽表（整列每欄一行、沒有 Y update）；放開時寫一次、一個撤銷步，寫入值與預覽逐欄相同；總和不是欄數的列整列正規化", () => {
    // 三欄各 0.6（總和 1.8 ≠ 3）、畫面三欄等寬 400px；拖第 1 條。
    const capture = vi.spyOn(HTMLElement.prototype, "setPointerCapture");
    const { editor, separators, columnOf } = setup([threeCols("s", [0.6, 0.6, 0.6])], { layout: { rowWidth: 1248 } });
    const updates = countUpdates(editor);
    const manager = collabUndoManager(editor)!;
    const stack = manager.undoStack.length;
    const sep = separators("s")[0]!;
    // 滑鼠按下的預設動作（把焦點移到分隔線、開始選字）被取消；指標事件照樣開始拖曳並 capture。
    expect(fireEvent.mouseDown(sep)).toBe(false);
    down(sep, 500);
    expect(capture).toHaveBeenCalledTimes(1);
    for (const d of [50, 100, 150]) move(500 + d);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(1);
    const rows = previewRows();
    expect(rows.map(([id]) => id)).toEqual(["sc0", "sc1", "sc2"]);
    const grows = rows.map(([, g]) => g);
    expect(grows).toEqual(ratiosFromPixels([550, 250, 400], [0, 1]));
    expect(grows[2]).toBe(1);
    // 預覽經樣式表到達欄元素，欄自己的 inline style 不動。
    expect(["sc0", "sc1", "sc2"].map((id) => Number(getComputedStyle(columnOf(id)).flexGrow))).toEqual(grows);
    expect(columnOf("sc0").getAttribute("style")).toMatch(/flex:\s*0\.6 1 0/);
    up(650);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(widths("s")).toEqual(grows);
    expect(previewTables().length).toBe(0);
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths("s")).toEqual([0.6, 0.6, 0.6]);
  });

  it("S2 放開那一筆的位置沒有 pointermove 報過 → 以放開的位置寫入", () => {
    const { separators } = setup([twoCols()]);
    down(separators("r")[0]!, 500);
    move(520);
    up(560);
    expect(widths("r")).toEqual(ratiosFromPixels([560, 440], [0, 1]));
    expect(widths("r")).toEqual([1.12, 0.88]);
    expect(previewTables().length).toBe(0);
  });

  it("S2 拖曳中 pointercancel → 取消：預覽表消失、user-select 還原、之後放開不寫", () => {
    const { editor, separators } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("");
    up(600);
    expect(updates).not.toHaveBeenCalled();
    expect(widths("r")).toEqual([1, 1]);
  });

  it("S2 只按一下（沒有移動）→ 不寫、沒有預覽表", () => {
    const { editor, separators } = setup([twoCols("r", [0.6, 1.4])]);
    const updates = countUpdates(editor);
    const sep = separators("r")[0]!;
    down(sep, 500);
    up(500);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r")).toEqual([0.6, 1.4]);
  });

  it("S2 拖曳中按 Esc → 取消：預覽表消失、之後放開也不寫", () => {
    const { editor, separators } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("");
    move(600);
    up(600);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r")).toEqual([1, 1]);
  });
});

describe("S3b 兩欄最小寬度不同時的 aria 範圍", () => {
  it("S3b [圖片｜文字]（最小 96／200）→ aria-valuemin 依左欄的 96、aria-valuemax 依右欄的 200", () => {
    const { separators } = setup([row([[IMG("i")], [P("b")]], "r")], { layout: { fixed: { r: [300, 700] } } });
    const sep = separators("r")[0]!;
    const total = 300 + 700;
    expect(sep.getAttribute("aria-valuenow")).toBe(String(Math.round((300 / total) * 100)));
    expect(sep.getAttribute("aria-valuemin")).toBe(String(Math.round((96 / total) * 100)));
    expect(sep.getAttribute("aria-valuemax")).toBe(String(Math.round(((total - 200) / total) * 100)));
    expect([sep.getAttribute("aria-valuemin"), sep.getAttribute("aria-valuemax")]).toEqual(["10", "80"]);
  });
});

describe("S3 最小寬度與只改相鄰兩欄", () => {
  it("S3 拖到最小寬度停住：[300,300]、往左拖 500 → 寫入對應 [200,400]", () => {
    const { separators } = setup([twoCols()], { layout: { rowWidth: 624 } });
    down(separators("r")[0]!, 500);
    move(0);
    up(0);
    expect(widths("r")).toEqual(ratiosFromPixels([200, 400], [0, 1]));
    expect(widths("r")).toEqual([0.67, 1.33]);
  });

  it.each([
    [30, [0.61, 0.51]],
    [-50, [0.47, 0.65]],
  ] as const)("S3 捨入差只落在被拖的兩欄：[0.56｜0.56｜1.88]、畫面 [300,300,1001]，拖第 1 條 %i → 第 3 欄不動", (d, expected) => {
    const px = [300 + d, 300 - d, 1001];
    // 前提：各欄先四捨五入後加總不是 300（有捨入差要分配）。
    const sum = px.map((p) => Math.round(((3 * p) / 1601) * 100)).reduce((a, b) => a + b, 0);
    expect(sum).not.toBe(300);
    const { editor, separators } = setup([threeCols("r", [0.56, 0.56, 1.88])], {
      layout: { rowWidth: 1601 + 2 * COLUMN_GAP_PX, fixed: { r: [300, 300, 1001] } },
    });
    const update = vi.spyOn(editor, "updateBlock");
    down(separators("r")[0]!, 500);
    move(500 + d);
    up(500 + d);
    expect(widths("r")).toEqual([...expected, 1.88]);
    expect(update.mock.calls.map((c) => c[0])).not.toContain("rc2");
  });
});

describe("S4 鍵盤", () => {
  it("S4 快速連按兩次 → 一個撤銷步、undo 一次回到兩次之前；每次移 5% 的可用寬（50px）；aria 50→55→60、min／max 20／80", () => {
    const { editor, separators } = setup([twoCols()]);
    const manager = collabUndoManager(editor)!;
    const sep = separators("r")[0]!;
    expect([sep.getAttribute("aria-valuenow"), sep.getAttribute("aria-valuemin"), sep.getAttribute("aria-valuemax")]).toEqual(["50", "20", "80"]);
    act(() => sep.focus());
    const stack = manager.undoStack.length;
    const pxOfLeft = () => (widths("r")[0]! / 2) * (1024 - COLUMN_GAP_PX);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(pxOfLeft()).toBeCloseTo(550, 6);
    flushFrames();
    expect(separators("r")[0]!.getAttribute("aria-valuenow")).toBe("55");
    fireEvent.keyDown(separators("r")[0]!, { key: "ArrowRight" });
    expect(pxOfLeft()).toBeCloseTo(600, 6);
    flushFrames();
    expect(separators("r")[0]!.getAttribute("aria-valuenow")).toBe("60");
    expect(manager.undoStack.length).toBe(stack + 1);
    manager.undo();
    expect(widths("r")).toEqual([1, 1]);
  });

  it("S4 慢慢按（兩次間隔超過合併時間窗）→ 兩個撤銷步", async () => {
    const { editor, separators } = setup([twoCols()]);
    const manager = collabUndoManager(editor)!;
    const sep = separators("r")[0]!;
    act(() => sep.focus());
    const stack = manager.undoStack.length;
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    // UndoManager 以 lib0 綁定的原生 Date.now 判斷合併，fake timers 換不到，要真的等。
    await new Promise((r) => setTimeout(r, 600));
    flushFrames();
    fireEvent.keyDown(separators("r")[0]!, { key: "ArrowLeft" });
    expect(widths("r")).toEqual([0.8, 1.2]);
    expect(manager.undoStack.length).toBe(stack + 2);
  });

  it("S4 聚焦與失焦各切一次撤銷步，連按之間不切", () => {
    const { editor, separators } = setup([twoCols()]);
    const stop = vi.spyOn(collabUndoManager(editor)!, "stopCapturing");
    const sep = separators("r")[0]!;
    act(() => sep.focus());
    expect(stop).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(stop).toHaveBeenCalledTimes(1);
    act(() => sep.blur());
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

/** 另一個用戶端：同一份 Y 狀態的第二顆編輯器；`push()` 把它的變更送到受測的編輯器，`pull()` 反過來。 */
async function remotePeer(editor: AnyEditor) {
  const docA = collabUndoManager(editor)!.doc;
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  const peer = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: docB.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u2", name: "User 2", color: "hsl(200 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  ) as any as AnyEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  peer.mount(el);
  cleanups.push(() => {
    peer.unmount();
    el.remove();
    docB.destroy();
  });
  await new Promise((r) => setTimeout(r, 50));
  return {
    peer,
    push: () => act(() => Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)))),
    pull: () => act(() => Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)))),
  };
}

describe("S5 拖曳中遠端改了列", () => {
  it("S5 遠端刪掉整列 → 放開時不寫、預覽表消失", async () => {
    const { editor, separators } = setup([P("x", "x0"), twoCols()]);
    const { peer, push } = await remotePeer(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    peer.removeBlocks(["r"]);
    push();
    expect(editor.getBlock("r")).toBeUndefined();
    const updates = countUpdates(editor);
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
  });

  it("S5 遠端加了一欄（欄 id 序列變了）→ 放開時不寫、預覽表消失", async () => {
    const { editor, separators } = setup([twoCols()]);
    const { peer, push } = await remotePeer(editor);
    down(separators("r")[0]!, 500);
    move(560);
    peer.insertBlocks([{ type: COLUMN_TYPE, props: { width: 1 }, children: [P("n")] }] as never, "rc1", "after");
    push();
    expect((editor.getBlock("r") as unknown as { children: unknown[] }).children.length).toBe(3);
    const updates = countUpdates(editor);
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r").slice(0, 2)).toEqual([1, 1]);
  });

  it("S5b 按下第 2 條分隔線後，遠端調了第 1 條並同步過來 → 放開時第 1 欄保留遠端的值，只有分隔線兩側那兩欄照拖曳結果寫", async () => {
    // 三欄各 400px、文件 [1,1,1]。
    const { editor, separators } = setup([threeCols("r")], { layout: { rowWidth: 1248 } });
    const { peer, push, pull } = await remotePeer(editor);
    const manager = collabUndoManager(editor)!;
    const stack = manager.undoStack.length;
    down(separators("r")[1]!, 500);
    move(540);
    expect(writeColumnWidths(peer, "r", [1.2, 0.8, 1])).toBe(true);
    push();
    flushFrames();
    expect(widths("r")).toEqual([1.2, 0.8, 1]);
    expect(previewTables().length).toBe(1);
    const update = vi.spyOn(editor, "updateBlock");
    up(580);
    // 按下時量的像素 [400, 480, 320] → [1, 1.2, 0.8]；第 1 欄被遠端改過，不蓋回 1。
    expect(ratiosFromPixels([400, 480, 320], [1, 2])).toEqual([1, 1.2, 0.8]);
    expect(widths("r")).toEqual([1.2, 1.2, 0.8]);
    expect(update.mock.calls.map((c) => c[0])).toEqual(["rc1", "rc2"]);
    expect(manager.undoStack.length).toBe(stack + 1);
    expect(previewTables().length).toBe(0);
    pull();
    expect((peer.getBlock("r") as unknown as { children: { props: { width: number } }[] }).children.map((c) => c.props.width)).toEqual([1.2, 1.2, 0.8]);
  });

  it("S5 遠端把一欄換成新的一欄（欄數不變、id 序列變了）→ 放開時不寫、預覽表消失", async () => {
    const { editor, separators } = setup([threeCols("r")], { layout: { rowWidth: 1248 } });
    const { peer, push } = await remotePeer(editor);
    down(separators("r")[0]!, 500);
    move(560);
    peer.transact(() => {
      peer.insertBlocks([{ id: "rnew", type: COLUMN_TYPE, props: { width: 1 }, children: [P("n")] }] as never, "rc2", "after");
      peer.removeBlocks(["rc2"]);
    });
    push();
    expect((editor.getBlock("r") as unknown as { children: { id: string }[] }).children.map((c) => c.id)).toEqual(["rc0", "rc1", "rnew"]);
    const updates = countUpdates(editor);
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(previewTables().length).toBe(0);
    expect(widths("r")).toEqual([1, 1, 1]);
  });
});

describe("S6 拖放進行中分隔線不吃指標", () => {
  /** 從 index.css 原樣抽出含 `.kb-dragging` 的規則（同 `use-drag-active-class.test.tsx`）。 */
  const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\r\n/g, "\n");
  function dragRules(): string {
    const out: string[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const selectors = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (selectors.includes(`.${DRAG_ACTIVE_CLASS}`)) out.push(`${selectors} {${m[2]}}`);
    }
    return out.join("\n");
  }

  it("S6 欄上有 kb-dragging → 每條分隔線本身（帶 pointer-events-auto）computed 是 none；拿掉後回到 auto", () => {
    // jsdom 不載 Tailwind：注入兩個 utility 的效果，分隔線才真的帶著明寫的 auto（只關外層的話它照樣吃指標）。
    const style = document.createElement("style");
    style.textContent = `.pointer-events-none { pointer-events: none; }\n.pointer-events-auto { pointer-events: auto; }\n${dragRules()}`;
    document.head.appendChild(style);
    cleanups.push(() => style.remove());
    const { separators } = setup([twoCols(), threeCols()]);
    const all = separators();
    expect(all.length).toBe(3);
    const pe = () => all.flatMap((s) => [s, ...Array.from(s.querySelectorAll<HTMLElement>("*"))]).map((el) => getComputedStyle(el).pointerEvents);
    expect(pe().every((v) => v === "auto")).toBe(true);
    columnEl.classList.add(DRAG_ACTIVE_CLASS);
    expect(pe().every((v) => v === "none")).toBe(true);
    columnEl.classList.remove(DRAG_ACTIVE_CLASS);
    expect(pe().every((v) => v === "auto")).toBe(true);
  });
});

describe("S7 位置追蹤", () => {
  it("S7 列上方的內容長高、整列往下推（文件沒變）：view.dom 的 RO 觸發 → 分隔線跟著移", () => {
    const { separators, viewDom } = setup([P("x", "x0"), twoCols()]);
    const sep = separators("r")[0]!;
    expect(sep.style.top).toBe("100px");
    expect(sep.style.left).toBe(`${(1024 - COLUMN_GAP_PX) / 2}px`);
    layout.rowTops.r = 340;
    fire(viewDom);
    flushFrames();
    expect(separators("r")[0]!.style.top).toBe("340px");
    expect(separators("r")[0]!.style.left).toBe(`${(1024 - COLUMN_GAP_PX) / 2}px`);
  });

  it("S7 版面變了但沒有任何 RO 觸發 → pointerenter 時重量、更新位置", () => {
    const { separators } = setup([P("x", "x0"), twoCols()]);
    layout.rowTops.r = 260;
    expect(separators("r")[0]!.style.top).toBe("100px");
    fireEvent.pointerEnter(separators("r")[0]!);
    expect(separators("r")[0]!.style.top).toBe("260px");
  });

  it("S7 位置已偏時 pointerdown 只更新位置、不開始拖曳；位置對了再按才開始", () => {
    const capture = vi.spyOn(HTMLElement.prototype, "setPointerCapture");
    const { separators } = setup([P("x", "x0"), twoCols()]);
    layout.rowTops.r = 260;
    down(separators("r")[0]!, 500);
    expect(capture).not.toHaveBeenCalled();
    expect(separators("r")[0]!.style.top).toBe("260px");
    move(560);
    expect(previewTables().length).toBe(0);
    up(560);
    down(separators("r")[0]!, 500);
    expect(capture).toHaveBeenCalledTimes(1);
    move(560);
    expect(previewTables().length).toBe(1);
    up(560);
  });

  it("S7 不聽捲動", () => {
    // 編輯器自己的監聽不算：spy 在編輯器掛好之後、分隔線浮層 render 之前才裝；React 在 render 的根容器上掛的事件委派（含 scroll）也不算。
    let add: ReturnType<typeof vi.spyOn> | undefined;
    let onWindow: ReturnType<typeof vi.spyOn> | undefined;
    const { separators, host } = setup([twoCols()], {
      beforeRender: () => {
        add = vi.spyOn(EventTarget.prototype, "addEventListener");
        onWindow = vi.spyOn(window, "addEventListener");
      },
    });
    fireEvent.pointerEnter(separators("r")[0]!);
    down(separators("r")[0]!, 500);
    move(520);
    up(520);
    const types = [...add!.mock.calls.filter((_, i) => add!.mock.contexts[i] !== host), ...onWindow!.mock.calls].map((c) => c[0]);
    expect(types).toContain("resize");
    expect(types).toContain("pointermove");
    expect(types).not.toContain("scroll");
  });
});

describe("S8 觸控", () => {
  const stubPointer = (coarse: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

  it("S8 (pointer: coarse) → 命中區佔滿溝（24px）、未 hover／未聚焦就帶淡色常顯標記", () => {
    stubPointer(true);
    const { separators } = setup([twoCols()]);
    const sep = separators("r")[0]!;
    expect(sep.style.width).toBe(`${COLUMN_GAP_PX}px`);
    expect(sep.hasAttribute("data-touch")).toBe(true);
    expect(document.activeElement).not.toBe(sep);
  });

  it("S8 滑鼠（非 coarse）→ 命中區 8px、沒有常顯標記", () => {
    stubPointer(false);
    const { separators } = setup([twoCols()]);
    const sep = separators("r")[0]!;
    expect(sep.style.width).toBe("8px");
    expect(sep.hasAttribute("data-touch")).toBe(false);
  });
});

describe("S-RF 拖曳中途的意外", () => {
  it("S-RF2 拖曳中卸載 → 預覽表移除、body 的 user-select 還原、之後的指標事件不寫", () => {
    document.body.style.userSelect = "text";
    const { editor, separators, unmount } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    expect(document.body.style.userSelect).toBe("none");
    unmount();
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("text");
    move(600);
    up(600);
    expect(previewTables().length).toBe(0);
    expect(updates).not.toHaveBeenCalled();
  });

  it("S-RF3 拖曳中列變成堆疊 → 分隔線消失、預覽表消失、user-select 還原，之後放開不寫", () => {
    const { editor, separators, rowEl } = setup([twoCols()]);
    const updates = countUpdates(editor);
    down(separators("r")[0]!, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    Object.defineProperty(rowEl("r"), "clientWidth", { value: 300, configurable: true });
    fire(rowEl("r"));
    expect(rowEl("r").hasAttribute(STACKED_ATTR)).toBe(true);
    flushFrames();
    expect(separators("r").length).toBe(0);
    expect(previewTables().length).toBe(0);
    expect(document.body.style.userSelect).toBe("");
    up(560);
    expect(updates).not.toHaveBeenCalled();
    expect(widths("r")).toEqual([1, 1]);
  });

  it.each([
    ["文件寬度與畫面成比例", [0.4, 1.6]],
    ["文件比最小寬度還窄、畫面被最小寬度撐住", [0.3, 1.7]],
  ] as const)("S-RF4 左欄已在最小寬度（%s），按 ← → 沒有 Y update、撤銷堆疊不變", (_label, start) => {
    const { editor, separators } = setup([twoCols("r", [...start])]);
    const manager = collabUndoManager(editor)!;
    const sep = separators("r")[0]!;
    expect(sep.getAttribute("aria-valuenow")).toBe("20");
    act(() => sep.focus());
    const stack = manager.undoStack.length;
    const updates = countUpdates(editor);
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(updates).not.toHaveBeenCalled();
    expect(manager.undoStack.length).toBe(stack);
    expect(widths("r")).toEqual([...start]);
  });
});
