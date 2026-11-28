/* eslint-disable @typescript-eslint/no-explicit-any -- tests reach into PM's view/transaction/step (types unavailable in apps/web) */
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

// Mounts a real editor with `buildNoteEditorOptions` (UniqueID, autolink, PasteRule and the site-link plugin all present) and sends real DOM events. toast is replaced by a spy.
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
  /** Ids present in the document from the start; when comparing, any other id counts as newly generated. */
  known: Set<string>;
  /** For each `handleDrop` chain call: the Y.Doc update count during that call. */
  handlerUpdates: number[];
  /** For each `handleDrop` chain call: the `editor.transact` call count during that call. */
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
 * Content is written to the Y.Doc before mount (initial content isn't in the undo stack). `handleDrop` is the product's `buildNoteEditorOptions` one, wrapped only by a counter; `handlers: false` = control editor: `handleDrop` replaced by a version that doesn't take over (doesn't call `edgeDrop`/`emptyColumnDrop`). The drag-source recorder is attached by the row layout extension on mount and removed on unmount.
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

/** Document JSON with newly generated ids (not in `known`) replaced by `?`. */
const normalized = (editor: AnyEditor, known: Set<string>) =>
  JSON.parse(JSON.stringify(editor.document), (key, value) => (key === "id" && !known.has(value) ? "?" : value));

const EDITOR_BOX: Box = [0, 0, 1000, 1000];

/**
 * jsdom rects are all 0. Values are looked up by `<data-node-type>:<data-id>` (`blockOuter:y1`, `columnList:r`, `column:rc0`); `columnList:*` / `column:*<i>` give a new row whose id isn't known and its i-th column. Mounted on the prototype and returning by identity: PM replaces elements when column widths or the document change, so a mock on a single element goes stale after the first write. The root `.bn-block-group` of `.bn-editor` returns a box enclosing all test coordinates: core SideMenu's capture drop on root uses it to decide whether the drop point is outside the editor box, and within 250px outside the box it first dispatches a synthetic event with the coordinates clamped into the box.
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

/** Row `id` (column ids `${id}c${i}`; `*` for a row whose id isn't known) spans x 0-600, y top-bottom; n equal-width columns with 24px gutters. */
function rowBoxes(id: string, top: number, bottom: number, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, top, 600, bottom] };
  for (let i = 0; i < n; i++) out[id === "*" ? `column:*${i}` : `column:${id}c${i}`] = [i * (width + 24), top, i * (width + 24) + width, bottom];
  return out;
}

const topBox = (id: string, top: number): Record<string, Box> => ({ [`blockOuter:${id}`]: [0, top, 600, top + 30] });

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

function drop(m: Mounted, pos: number, at: readonly [number, number], dataTransfer: unknown, extra: { ctrlKey?: boolean } = {}): DragEvent {
  m.view.posAtCoords = () => ({ pos, inside: -1 });
  const event = dropEvent(dataTransfer, at, extra);
  m.view.dom.dispatchEvent(event);
  m.editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true }));
  return event;
}

/** One drag-handle drag-drop: `drag` is the id of the dragged block, `range` gives a multi-selection range, `target` is the id of the block at the drop point (`posAtCoords` returns the start of its text). */
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

function expectOneRealCall(spy: MockInstance<any>): void {
  expect(spy).toHaveBeenCalledTimes(1);
  expect((spy.mock.calls[0]![2] as { synthetic?: boolean }).synthetic).not.toBe(true);
}

const stepsJSON = (m: Mounted, tr: any) =>
  JSON.parse(JSON.stringify(tr.steps.map((s: any) => s.toJSON())), (key, value) => (key === "id" && value !== null && !m.known.has(value) ? "?" : value));

function expectSameInsertSteps(m: Mounted, insert: Spies["insert"]): string[] {
  expect(insert).toHaveBeenCalledTimes(2);
  expect(insert.mock.results.map((r) => r.value)).toEqual([true, true]);
  const [predicted, actual] = insert.mock.calls.map((c) => stepsJSON(m, c[0]));
  expect(predicted.length).toBeGreaterThan(0);
  expect(actual).toEqual(predicted);
  return predicted.map((step: { stepType: string }) => step.stepType);
}

/**
 * A taken-over drop: the handler is called once, the two `buildInsert` calls agree, the undo stack gains one step. Returns `undo()`: one undo returns to before the drop.
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
 * A drop that isn't taken over: run `act` on the editor under test, assert both handlers return false and `buildInsert` is never called; then mount the control editors one at a time and do the same, results equal (after normalizing new ids). Control editors aren't mounted together: with two on one document, core treats the non-target drag source as "dragged to another editor" and deletes its selection.
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

describe("top-level row creation", () => {
  it.each([
    ["right", 590, "ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y"],
    ["left", 5, "ROW[COL(paragraph:z) | COL(paragraph:x)]  paragraph:y"],
  ] as const)("x y z, drag z to x's %s edge -> row created, caret at the start of z, editor focused, one undo step", (_side, x, expected) => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const drop1 = takenDrop(m, () => dragDrop(m, { drag: "z1", target: "x1", at: [x, 115], boxes: topBox("x1", 100) }));
    expect(shape(m.editor)).toBe(expected);
    expect(cursorOf(m.editor)).toBe("z@0");
    expect(document.activeElement).toBe(m.view.dom);
    expect(widthsOf(m.editor, 0)).toEqual([1, 1]);
    drop1.undo();
  });
});

describe("adding a column to a block outside a row", () => {
  const content = () => [row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")];
  it.each([
    ["b's right edge", "b1", 590, "ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:z)]"],
    ["a's left edge", "a1", 5, "ROW[COL(paragraph:z) | COL(paragraph:a) | COL(paragraph:b)]"],
    ["a's right edge", "a1", 280, "ROW[COL(paragraph:a) | COL(paragraph:z) | COL(paragraph:b)]"],
    ["b's left edge", "b1", 320, "ROW[COL(paragraph:a) | COL(paragraph:z) | COL(paragraph:b)]"],
  ] as const)("[a|b], drag z to %s -> three columns, each width 1, one undo step", (_label, target, x, expected) => {
    const m = mount(content());
    const d = takenDrop(m, () => dragDrop(m, { drag: "z1", target, at: [x, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe(expected);
    expect(cursorOf(m.editor)).toBe("z@0");
    expect(widthsOf(m.editor, 0)).toEqual([1, 1, 1]);
    expect(d.insertSteps).toEqual(["replace"]); // existing column widths unchanged -> no attribute written
    d.undo();
  });
});

describe("creating a row by dragging out of a column", () => {
  it("[a|b,q] drag q to x's right edge -> [x|q], the original row [a|b]", () => {
    const m = mount([P("x", "x1"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "q1", target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:q)]  ROW[COL(paragraph:a) | COL(paragraph:b)]");
    d.undo();
  });

  it.each([
    [2, "ROW[COL(paragraph:a) | COL(paragraph)]"],
    [3, "ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph:c)]"],
  ] as const)("dragging away the only block of a column in a %i-column row -> source column keeps an empty paragraph, column count unchanged", (n, expectedSource) => {
    const cols = n === 2 ? [[P("a", "a1")], [P("b", "b1")]] : [[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]];
    const m = mount([P("x", "x1"), row(cols, "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "b1", target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:x) | COL(paragraph:b)]  ${expectedSource}`);
    d.undo();
  });
});

describe("moving between columns of one row, and no-ops", () => {
  it("[a,c|b] drag c to b's right edge -> [a|b|c]", () => {
    const m = mount([row([[P("a", "a1"), P("c", "c1")], [P("b", "b1")]], "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "c1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c)]");
    d.undo();
  });

  it("[a|b] drag b to a's right edge -> not taken over, result equals the control editor", () => {
    expectSameAsControl([row([[P("a", "a1")], [P("b", "b1")]], "r")], (m) =>
      dragDrop(m, { drag: "b1", target: "a1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 2) }),
    );
  });

  it("[a|b|c] drag c to a's left edge -> [c|a|b|empty]", () => {
    const m = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "c1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 100, 300, 3) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:c) | COL(paragraph:a) | COL(paragraph:b) | COL(paragraph)]");
    expect(widthsOf(m.editor, 0)).toEqual([1, 1, 1, 1]);
    d.undo();
  });
});

describe("multi-selection", () => {
  it("two selected in the same column -> enter new columns in order", () => {
    const m = mount([P("x", "x1"), row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")]);
    takenDrop(m, () => dragDrop(m, { drag: "a1", range: ["a1", "b1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:a,paragraph:b)]  ROW[COL(paragraph:c) | COL(paragraph:d)]");
  });

  it("two selected at top level -> enter new columns in order", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1"), P("w", "w1")]);
    takenDrop(m, () => dragDrop(m, { drag: "y1", range: ["y1", "z1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:y,paragraph:z)]  paragraph:w");
  });

  it("multi-selection across columns -> not taken over, result equals the control editor", () => {
    expectSameAsControl([P("x", "x1"), row([[P("a", "a1")], [P("d", "d1")]], "r")], (m) =>
      dragDrop(m, { drag: "a1", range: ["a1", "d1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) }),
    );
  });
});

describe("row with 4 columns", () => {
  it("dragging top-level z to a column edge of a 4-column row -> not taken over, result equals the control editor", () => {
    expectSameAsControl([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]], "r"), P("z", "z1")], (m) =>
      dragDrop(m, { drag: "z1", target: "b1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 4) }),
    );
  });
});

describe("new row becomes the last block", () => {
  it("x y: drag x to y's right edge -> an empty paragraph is added after the row", () => {
    const m = mount([P("x", "x1"), P("y", "y1")]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:y) | COL(paragraph:x)]  paragraph");
    expect(integrity(m.editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
    d.undo();
  });
});

describe("invariants", () => {
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

  it("row creation: the id set gains only the new row and two columns, X's props and child blocks unchanged, no nested rows, column widths in canonical form", () => {
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

  it("adding a column: the id set gains only the new column, X unchanged, column widths in canonical form", () => {
    const m = mount(content());
    const before = Object.fromEntries(xIds.map((id) => [id, m.editor.getBlock(id)]));
    const beforeIds = collectIds(m.editor.document);
    takenDrop(m, () => dragDrop(m, { drag: "r1", range: ["r1", "k1"], target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe("paragraph:y  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:red,image,paragraph:k{paragraph:k2})]  paragraph:t");
    check(m, before, beforeIds, 1);
  });
});

describe("one undo step", () => {
  it("the undo stack gains one step; one undo returns to before the drop", () => {
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

describe("after the drop", () => {
  it("view.dragging is cleared and the drop is preventDefault'ed; later horizontal-line drops work as usual (the column elements have been replaced)", () => {
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

/** `naturalWidth`/`naturalHeight`/`complete` are looked up by the id of the block holding the `<img>`; not found -> 0x0, incomplete. */
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

describe("automatic equal height", () => {
  const previewWidths = (m: Mounted, ids: string[]) => ids.map((id) => (m.editor.getBlock(id) as any).props.previewWidth);

  it("precondition: the image block has an <img> on screen", () => {
    const m = mount([IMG("i1"), IMG("i2")]);
    expect(m.view.dom.querySelectorAll("img").length).toBe(2);
  });

  it("200x100 and 100x100 create a row -> column widths [1.33, 0.67], previewWidth unchanged", () => {
    const m = mount([IMG("i1"), IMG("i2", 300), P("t", "t1")]);
    mockImages({ i1: [200, 100], i2: [100, 100] });
    const before = previewWidths(m, ["i1", "i2"]);
    takenDrop(m, () => dragDrop(m, { drag: "i2", target: "i1", at: [590, 115], boxes: topBox("i1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(image) | COL(image)]  paragraph:t");
    expect(widthsOf(m.editor, 0)).toEqual([1.33, 0.67]);
    expect(previewWidths(m, ["i1", "i2"])).toEqual(before);
  });

  it("a third image adds a column -> the whole row is recomputed from aspect ratios", () => {
    const m = mount([row([[IMG("i1")], [IMG("i2")]], "r"), IMG("i3"), P("t", "t1")]);
    mockImages({ i1: [200, 100], i2: [100, 100], i3: [100, 200] });
    const before = previewWidths(m, ["i1", "i2", "i3"]);
    const d = takenDrop(m, () => dragDrop(m, { drag: "i3", target: "i2", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(d.insertSteps).toEqual(["replace", "attr", "attr"]); // new column plus the widths of the two existing columns
    expect(shape(m.editor)).toBe("ROW[COL(image) | COL(image) | COL(image)]  paragraph:t");
    expect(widthsOf(m.editor, 0)).toEqual([1.71, 0.86, 0.43]);
    expect(previewWidths(m, ["i1", "i2", "i3"])).toEqual(before);
  });

  it("one image has naturalWidth 0 -> [1, 1]", () => {
    const m = mount([IMG("i1"), IMG("i2"), P("t", "t1")]);
    mockImages({ i1: [200, 100], i2: [0, 100] });
    takenDrop(m, () => dragDrop(m, { drag: "i2", target: "i1", at: [590, 115], boxes: topBox("i1", 100) }));
    expect(widthsOf(m.editor, 0)).toEqual([1, 1]);
  });

  it("image + paragraph -> [1, 1]", () => {
    const m = mount([P("x", "x1"), IMG("i2"), P("t", "t1")]);
    mockImages({ i2: [200, 100] });
    takenDrop(m, () => dragDrop(m, { drag: "i2", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(image)]  paragraph:t");
    expect(widthsOf(m.editor, 0)).toEqual([1, 1]);
  });
});

describe("horizontal-line drop into an empty column replaces the empty paragraph", () => {
  /** [a|E] and top-level z: z is dropped by horizontal line into column 2 (x in the middle of the column, not at the left/right edges), `posAtCoords` lands on E. */
  const emptyContent = (e: PartialBlockLike = { id: "e1", type: "paragraph", content: [] } as PartialBlockLike) => [
    row([[P("a", "a1")], [e]], "r"),
    P("z", "z1"),
  ];
  const intoEmpty: Gesture = { drag: "z1", target: "e1", at: [450, 200], boxes: rowBoxes("r", 100, 300, 2) };

  it("first drag b away by vertical line leaving an empty column, then drop top-level z into it -> [a|z], caret in z, one undo step back to before z was dropped", () => {
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

  it("top-level z dropped into [a|empty] -> [a|z], the empty paragraph is gone", () => {
    const m = mount(emptyContent());
    const d = takenDrop(m, () => dragDrop(m, intoEmpty), "empty");
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:z)]");
    expect(collectIds(m.editor.document).has("e1")).toBe(false);
    d.undo();
  });

  const notEmpty: Array<[string, PartialBlockLike]> = [
    ["has text", P("t", "e1")],
    ["has child blocks", withChildren({ id: "e1", type: "paragraph", content: [] } as PartialBlockLike, [P("k", "k1")])],
    ["non-default text color", { id: "e1", type: "paragraph", props: { textColor: "red" }, content: [] } as PartialBlockLike],
    ["non-default background color", { id: "e1", type: "paragraph", props: { backgroundColor: "blue" }, content: [] } as PartialBlockLike],
    ["non-default alignment", { id: "e1", type: "paragraph", props: { textAlignment: "center" }, content: [] } as PartialBlockLike],
  ];
  it.each(notEmpty)("column paragraph: %s -> not replaced, result equals the control editor", (_label, e) => {
    expectSameAsControl(emptyContent(e), (m) => dragDrop(m, intoEmpty));
  });

  it("column has two blocks (one an empty paragraph) -> not replaced, result equals the control editor", () => {
    expectSameAsControl([row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike, P("c", "c1")]], "r"), P("z", "z1")], (m) =>
      dragDrop(m, intoEmpty),
    );
  });

  it("X containing a row (multi-selection of top-level p and a row [c|d]) dropped into another row's empty column -> p, c, d in the column, ids unchanged, no nested rows", () => {
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

  it("text drag -> not replaced, result equals the control editor", () => {
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
      expect(draggedBlocksOf(view)).toBeNull(); // precondition: a text selection records no X
      view.dragging = { slice: view.state.selection.content(), move: true };
      dataTransfer.setData("text/plain", "z");
      drop(m, textIn(m, "e1"), intoEmpty.at, dataTransfer);
    });
  });

  it("copy drag -> not replaced, result equals the control editor", () => {
    expectSameAsControl(emptyContent(), (m) => dragDrop(m, { ...intoEmpty, ctrlKey: true }));
  });

  it("external HTML -> not replaced, result equals the control editor", () => {
    expectSameAsControl(emptyContent(), (m) => {
      mockRects(intoEmpty.boxes);
      drop(m, textIn(m, "e1"), intoEmpty.at, { types: ["text/html", "text/plain"], getData: (t: string) => (t === "text/html" ? "<p>ext</p>" : "ext"), items: [], files: [] });
    });
  });

  it("file -> not replaced (handleDrop isn't consulted)", () => {
    const m = mount(emptyContent());
    const s = spies();
    mockRects(intoEmpty.boxes);
    const file = new File(["x"], "a.zip", { type: "application/zip" });
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

  it("synthetic event -> emptyColumnDrop returns false, no transaction sent", () => {
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
    expect(edgeDropModule.emptyColumnDrop(m.editor, m.view, dropEvent(createFakeDataTransfer(["blocknote/html"]), intoEmpty.at), m.view.dragging.slice)).toBe(true);
  });

  it("dragging the empty paragraph itself -> not replaced, result equals the control editor", () => {
    expectSameAsControl(emptyContent(), (m) => dragDrop(m, { ...intoEmpty, drag: "e1" }));
  });

  it("multi-selection of top-level p and a row [c|empty] dropped back into that row's own empty column -> not replaced, no transaction sent, result equals the control editor, id set unchanged", () => {
    const content = [P("p", "p1"), row([[P("c", "c1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r")];
    let idsBefore: Set<string> | null = null;
    let idsAfter: Set<string> | null = null;
    const m = expectSameAsControl(content, (x) => {
      mockRects(intoEmpty.boxes);
      const { dataTransfer } = startBlockDrag(x.editor, "p1", { range: ["p1", "e1"] });
      expect(draggedBlocksOf(x.view)).toEqual({ ids: ["p1", "r"], kind: "multi", hasRows: true }); // precondition
      idsBefore ??= collectIds(x.editor.document);
      drop(x, textIn(x, "e1"), intoEmpty.at, dataTransfer);
      idsAfter ??= collectIds(x.editor.document);
    });
    expect(m.handlerTransacts).toEqual([0]);
    expect(m.handlerUpdates).toEqual([0]);
    expect(idsAfter).toEqual(idsBefore);
  });

  describe("pre-validation fails -> nothing is sent", () => {
    // `buildInsert` fails on the predicted document (simulated: after removing only X, E is no longer an empty paragraph). After the handler returns false PM's default drop runs and that would write to Yjs, so only updates during the handler call are counted. The later `blockMoveDrop` is replaced by a version that doesn't take over: what's counted here is how many writes the first two sent, and the control editor also uses PM's default drop.
    const noMoveTakeover = () => vi.spyOn(edgeDropModule, "blockMoveDrop").mockReturnValue(false);

    it("empty column: emptyColumnDrop returns false, buildInsert called once, no Y update during the handler, result equals the control editor", () => {
      const m = expectSameAsControl(emptyContent(), (x) => dragDrop(x, intoEmpty), {
        insertCalls: 1,
        before: (s) => {
          s.insert.mockReturnValueOnce(false);
          noMoveTakeover();
        },
        after: (s) => expect(s.empty.mock.results.map((r) => r.value)).toEqual([false]),
      });
      expect(m.handlerUpdates).toEqual([0]);
    });

    it("vertical line: edgeDrop returns false, buildInsert called once, no Y update during the handler, result equals the control editor", () => {
      const m = expectSameAsControl(
        [P("x", "x1"), P("y", "y1"), P("z", "z1")],
        (x) => dragDrop(x, { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }),
        {
          insertCalls: 1,
          before: (s) => {
            s.insert.mockReturnValueOnce(false);
            noMoveTakeover();
          },
        },
      );
      expect(m.handlerUpdates).toEqual([0]);
    });
  });
});

const URL_Y = "see https://y.example/b now";
const URL_M = "mid https://m.example/c";
const URL_X = "go https://x.example/a";

describe("vertical-line drop doesn't run the paste rule", () => {
  it("first row creation on a freshly mounted editor: URLs in X, Y and the middle blocks don't become links", () => {
    const m = mount([P(URL_Y, "y1"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    const before = linkMarks(m);
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:${URL_Y}) | COL(paragraph:${URL_X})]  paragraph:${URL_M}  paragraph:t`);
    expect(linkMarks(m)).toEqual(before);
  });

  it("first column add on a freshly mounted editor: URLs in X, the column and the middle blocks don't become links", () => {
    const m = mount([row([[P(URL_Y, "a1")], [P(URL_M, "b1")]], "r"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    const before = linkMarks(m);
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:${URL_Y}) | COL(paragraph:${URL_M}) | COL(paragraph:${URL_X})]  paragraph:${URL_M}  paragraph:t`);
    expect(linkMarks(m)).toEqual(before);
  });
});

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

describe("vertical-line drop after an external link drag-in", () => {
  it("drag an external link in first, then create a row -> link marks are the same before and after the drop", () => {
    const m = mount([P(URL_Y, "y1"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    externalLinkDrop(m, textIn(m, "t1") + 1);
    const before = linkMarks(m);
    expect(before.map((l) => l.href)).toContain("https://ext.example/z"); // precondition: an external drag-in still converts to a link as usual
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(linkMarks(m)).toEqual(before);
  });

  it("drag an external link in first, then add a column -> link marks are the same before and after the drop", () => {
    const m = mount([row([[P(URL_Y, "a1")], [P(URL_M, "b1")]], "r"), P(URL_M, "m1"), P(URL_X, "x1"), P("t", "t1")]);
    externalLinkDrop(m, textIn(m, "t1") + 1);
    const before = linkMarks(m);
    expect(before.map((l) => l.href)).toContain("https://ext.example/z");
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(linkMarks(m)).toEqual(before);
  });
});

describe("external drag-in after a vertical-line drop", () => {
  it("external drag-in of BlockNote HTML carrying an existing data-id -> ids stay unique after insertion", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1"), P("t", "t1")]);
    takenDrop(m, () => dragDrop(m, { drag: "z1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }));
    const html = m.editor.blocksToFullHTML([m.editor.getBlock("t1")!]);
    expect(html).toContain('data-id="t1"'); // precondition: the HTML carries an id that already exists in the document
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
    expect(m.editor.document.length).toBe(blocksBefore + 1); // precondition: a block really was inserted
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y  paragraph:t  paragraph:t");
  });
});

describe("vertical-line drop and drop into an empty column don't autolink", () => {
  const URL_END = "go https://x.example/a";
  const URL_END_Y = "see https://y.example/b";

  // The first block has no URL: when a document first loads, autolink checks the last character of the first textblock (unrelated to drag-drop).
  it("row creation: X and Y are paragraphs ending with a URL -> no new links", () => {
    const m = mount([P("first", "f1"), P(URL_END_Y, "y1"), P("m", "m1"), P(URL_END, "x1"), P("t", "t1")]);
    expect(linkMarks(m)).toEqual([]); // precondition
    takenDrop(m, () => dragDrop(m, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }));
    expect(shape(m.editor)).toBe(`paragraph:first  ROW[COL(paragraph:${URL_END_Y}) | COL(paragraph:${URL_END})]  paragraph:m  paragraph:t`);
    expect(linkMarks(m)).toEqual([]);
  });

  it("column add: X is two paragraphs, the first ends with a URL -> no new links", () => {
    const m = mount([row([[P("a", "a1")], [P("b", "b1")]], "r"), P(URL_END, "x1"), P("then", "x2"), P("t", "t1")]);
    takenDrop(m, () => dragDrop(m, { drag: "x1", range: ["x1", "x2"], target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) }));
    expect(shape(m.editor)).toBe(`ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:${URL_END},paragraph:then)]  paragraph:t`);
    expect(linkMarks(m)).toEqual([]);
  });

  it("drop into an empty column: X is two paragraphs, the first ends with a URL -> no new links", () => {
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

describe("dragging an already selected image directly", () => {
  it("NodeSelection of the image blockContent dragged to x's right edge: core cancels dragstart -> no X recorded, not taken over, result equals the control editor", () => {
    expectSameAsControl([P("x", "x1"), IMG("img1"), P("t", "t1")], (m) => {
      mockRects(topBox("x1", 100));
      const view = m.view;
      const Selection = Object.getPrototypeOf(view.state.selection.constructor);
      const imgPos = blockPos(m.editor, "img1");
      view.dispatch(view.state.tr.setSelection(Selection.fromJSON(view.state.doc, { type: "node", anchor: imgPos + 1 })));
      expect(view.state.selection.node.type.name).toBe("image"); // precondition: the selection is the blockContent
      view.posAtCoords = () => ({ pos: imgPos + 1, inside: -1 });
      const dataTransfer = createFakeDataTransfer([], { store: true });
      const start = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
      (view.nodeDOM(imgPos) as HTMLElement).querySelector("img")!.dispatchEvent(start);
      expect(start.defaultPrevented).toBe(true);
      expect(view.state.selection.node.type.name).toBe("blockContainer"); // core widens the selection to the whole block
      expect(view.dragging).toBeTruthy();
      expect(draggedBlocksOf(view)).toBeNull();
      drop(m, textIn(m, "x1"), [590, 115], dataTransfer);
    });
  });

  it("control: with the image already selected, grabbing its drag handle to x's right edge -> row created as usual, one undo step", () => {
    const m = mount([P("x", "x1"), IMG("img1"), P("t", "t1")]);
    const view = m.view;
    const Selection = Object.getPrototypeOf(view.state.selection.constructor);
    view.dispatch(view.state.tr.setSelection(Selection.fromJSON(view.state.doc, { type: "node", anchor: blockPos(m.editor, "img1") + 1 })));
    expect(view.state.selection.node.type.name).toBe("image"); // precondition: the selection is the blockContent
    const d = takenDrop(m, () => dragDrop(m, { drag: "img1", target: "x1", at: [590, 115], boxes: topBox("x1", 100) }));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(image)]  paragraph:t");
    d.undo();
  });
});

describe("editor turns read-only mid-drag", () => {
  // Call the handler directly: when the view isn't editable PM doesn't run drop's editHandlers at all, so going through dispatch never calls handleDrop.
  it("row-creation geometry: read-only -> edgeDrop returns false and no Y update; once editable again the same geometry is taken over", () => {
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

  it("empty-column geometry: read-only -> emptyColumnDrop returns false and no Y update; once editable again the same geometry is taken over", () => {
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

describe("redo after undo", () => {
  it("x y z, drag z to x's right edge -> undo -> redo once -> document back to after the drop (column widths and ids both present)", () => {
    const m = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    dragDrop(m, zToXRight);
    const after = m.editor.document;
    const manager = collabUndoManager(m.editor)!;
    manager.undo();
    expect(shape(m.editor)).toBe("paragraph:x  paragraph:y  paragraph:z");
    manager.redo();
    expect(m.editor.document).toEqual(after);
  });

  it("two images create a row (widths by aspect ratio) -> undo -> redo once -> document back to after the drop", () => {
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
  { name: "z to x's right edge", content: three, g: zToX, vertical: true },
  { name: "z to x's left edge", content: three, g: { ...zToX, at: [5, 115] }, vertical: true },
  { name: "z to b's right edge", content: twoCols, g: inTwoCols("b1", 590), vertical: true },
  { name: "z to a's left edge", content: twoCols, g: inTwoCols("a1", 5), vertical: true },
  { name: "z to a's right edge", content: twoCols, g: inTwoCols("a1", 280), vertical: true },
  { name: "z to b's left edge", content: twoCols, g: inTwoCols("b1", 320), vertical: true },
  {
    name: "q from a column to x's right edge",
    content: () => [P("x", "x1"), row([[P("a", "a1")], [P("b", "b1"), P("q", "q1")]], "r")],
    g: { drag: "q1", target: "x1", at: [590, 15], boxes: topBox("x1", 0) },
    vertical: true,
  },
  {
    name: "c to b's right edge",
    content: () => [row([[P("a", "a1"), P("c", "c1")], [P("b", "b1")]], "r")],
    g: { drag: "c1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 100, 300, 2) },
    vertical: true,
  },
  {
    name: "no-op: b to a's right edge",
    content: () => [row([[P("a", "a1")], [P("b", "b1")]], "r")],
    g: { drag: "b1", target: "a1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 2) },
    vertical: false,
  },
  {
    name: "c to a's left edge",
    content: () => [row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")],
    g: { drag: "c1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 100, 300, 3) },
    vertical: true,
  },
  {
    name: "same-column multi-selection to x's right edge",
    content: () => [P("x", "x1"), row([[P("a", "a1"), P("b", "b1"), P("c", "c1")], [P("d", "d1")]], "r")],
    g: { drag: "a1", range: ["a1", "b1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) },
    vertical: true,
  },
  {
    name: "multi-selection across columns",
    content: () => [P("x", "x1"), row([[P("a", "a1")], [P("d", "d1")]], "r")],
    g: { drag: "a1", range: ["a1", "d1"], target: "x1", at: [590, 15], boxes: topBox("x1", 0) },
    vertical: false,
  },
  {
    name: "row with 4 columns",
    content: () => [row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")]], "r"), P("z", "z1")],
    g: { drag: "z1", target: "b1", at: [280, 200], boxes: rowBoxes("r", 100, 300, 4) },
    vertical: false,
  },
  { name: "no vertical line: synthetic event", content: three, g: zToX, synthetic: true, vertical: false },
  { name: "no vertical line: copy drag", content: three, g: { ...zToX, ctrlKey: true }, vertical: false },
  { name: "no vertical line: read-only", content: three, g: zToX, tweak: (m) => void (m.editor.isEditable = false), vertical: false },
  {
    name: "no vertical line: no recorded X (cleared by dragend)",
    content: three,
    g: zToX,
    tweak: (m) => void m.editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true })),
    vertical: false,
  },
  { name: "no vertical line: not dragging", content: three, g: zToX, tweak: (m) => void (m.view.dragging = null), vertical: false },
  { name: "no vertical line: Y is X itself", content: three, g: { ...zToX, drag: "x1" }, vertical: false },
  {
    name: "no vertical line: Y is the second of multi-selection X",
    content: three,
    g: { drag: "x1", range: ["x1", "y1"], target: "y1", at: [590, 115], boxes: topBox("y1", 100) },
    vertical: false,
  },
  {
    name: "no vertical line: X contains a row",
    content: () => [P("p", "p1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")],
    g: { drag: "p1", range: ["p1", "a1"], target: "y1", at: [590, 415], boxes: topBox("y1", 400) },
    vertical: false,
  },
  { name: "no vertical line: not in a left/right edge zone", content: three, g: { ...zToX, at: [300, 115] }, vertical: false },
  { name: "no vertical line: in the gutter", content: twoCols, g: inTwoCols("a1", 300), vertical: false },
];

describe("edgeTargetAt says vertical line <=> edgeDrop takes over", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
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

/** Drag-drop event; coordinates defined with `configurable: true` (a drop in the gutter rewrites the coordinates on the event). */
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
 * Dispatches a dragover on `view.dom` (`posAtCoords` always returns `pos`). Core's DropCursor attaches the line to `view.dom.offsetParent`; jsdom has no offsetParent, so the mounted container is returned instead.
 */
function dragOver(m: Mounted, pos: number, at: readonly [number, number], dataTransfer: unknown): DragEvent {
  Object.defineProperty(m.view.dom, "offsetParent", { get: () => m.container, configurable: true });
  m.view.posAtCoords = () => ({ pos, inside: -1 });
  const event = dragEventAt("dragover", dataTransfer, at);
  m.view.dom.dispatchEvent(event);
  return event;
}

const cursorEl = (m: Mounted) => m.container.querySelector<HTMLElement>(".prosemirror-dropcursor-vertical, .prosemirror-dropcursor-block-horizontal");

function expectOneRealHookCall(hook: MockInstance<typeof edgeDropModule.computeDropPosition>): void {
  expect(hook).toHaveBeenCalledTimes(1);
  expect((hook.mock.calls[0]![0].event as { synthetic?: boolean }).synthetic).not.toBe(true);
}

describe("DropCursor: the vertical line is drawn at the target's left/right edge, everything else follows core's horizontal line", () => {
  it.each([
    ["top-level x's right edge", three, zToX, "block-vertical-right", ".bn-block-outer"],
    ["a in a column, left edge", twoCols, inTwoCols("a1", 5), "block-vertical-left", '[data-node-type="column"]'],
  ] as const)("drag z to %s -> vertical line, nodeDOM(pos) is the target's box", (_label, content, g, orientation, targetSelector) => {
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

  it("drag z to the middle of x (not at the left/right edge) -> core's horizontal line", () => {
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

describe("in-site drag carrying a media data URL", () => {
  it("drag handle drags z to x's right edge with a data-URL image in dataTransfer -> media blocking toast, document unchanged, edgeDrop never called", () => {
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

describe("external drag-in shows no vertical line", () => {
  it("external HTML dragged to x's right edge -> DropCursor draws no vertical line, edgeDrop returns false, insertion as today", () => {
    const hook = vi.spyOn(edgeDropModule, "computeDropPosition");
    const m = mount(three());
    const s = spies();
    mockRects(zToX.boxes);
    expect(m.view.dragging).toBeNull(); // precondition: external drag-in
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

describe("file drop in the gutter", () => {
  // [a|b]: row y 100-300, columns 0-288 and 312-600 (gutter 288-312), a and b each occupy 100-140 at the column top (midline 120).
  const content = () => [row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")];
  const boxes: Record<string, Box> = { ...rowBoxes("r", 100, 300, 2), "blockOuter:a1": [0, 100, 288, 140], "blockOuter:b1": [312, 100, 600, 140] };

  /** Returns pos by coordinates: in the gutter -> between the two columns of the row; column 2 -> b's text; column 1 -> a's text. Core asks again with the modified coordinates. */
  function posByCoords(m: Mounted): void {
    m.view.posAtCoords = ({ left }: { left: number; top: number }) => {
      const rowPos = blockPos(m.editor, "r");
      if (left > 288 && left < 312) return { pos: rowPos + 1 + m.view.state.doc.nodeAt(rowPos).child(0).nodeSize, inside: -1 };
      return { pos: textIn(m, left >= 312 ? "b1" : "a1"), inside: -1 };
    };
  }

  /** A drop carrying only a png file (or the given `dataTransfer`); returns the event and the exception a listener threw during dispatch (jsdom reports them as the window's error event). */
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
    ["upper half", 110, [456, 110], "ROW[COL(paragraph:a) | COL(image,paragraph:b)]  paragraph:z"],
    ["lower half", 135, [456, 130], "ROW[COL(paragraph:a) | COL(paragraph:b,image)]  paragraph:z"],
  ] as const)("in the gutter nearer column 2, y in b's %s -> coordinates moved into b's box, image inserted on b's side, drop preventDefault'ed", async (_half, y, moved, expected) => {
    const m = mount(content());
    const s = spies();
    mockRects(boxes);
    posByCoords(m);
    const upload = vi.fn(() => Promise.resolve("/api/uploads/new"));
    (m.editor as any).uploadFile = upload;
    const { event, errors } = fileDrop(m, [305, y]);
    expect(errors).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(s.edge).not.toHaveBeenCalled(); // files only: PM never consults handleDrop
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(shape(m.editor)).toBe(expected);
    const image = (m.editor.document[0] as any).children[1].children.find((b: any) => b.type === "image");
    expect(image.props.url).toBe("/api/uploads/new");
    expect([event.clientX, event.clientY]).toEqual(moved);
  });

  it("drop point inside a column -> coordinates unchanged, image inserted after b as core does", async () => {
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

  it("drag-handle horizontal-line drag into the gutter -> coordinates moved to the nearest block of the nearest column before PM drops, z lands in column 2", () => {
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

  it("drag handle to column 2's left edge zone but posAtCoords lands between the columns -> add a column by vertical line, coordinates unchanged", () => {
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

  it("drop in the gutter carrying text/html and Files (text representation before Files) -> coordinates unchanged", () => {
    const m = mount(content());
    mockRects(boxes);
    posByCoords(m);
    // `files` is empty: with files present media blocking would stop it first on "carries a text representation", never reaching this decision.
    const dataTransfer = { types: ["text/html", "Files"], files: [], items: [], getData: (t: string) => (t === "text/html" ? "<p>ext</p>" : "") };
    const { event, errors } = fileDrop(m, [305, 135], dataTransfer);
    expect(errors).toEqual([]);
    expect([event.clientX, event.clientY]).toEqual([305, 135]);
  });

  describe("stacked rows: columns share the same x range, the nearest column is decided by y", () => {
    // [a|b|c] stacked into three bands: columns y 100-180, 192-272, 284-364 (12px between bands), x all 0-600; a, b, c each take 40px at the column top.
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
      ["between bands 2 and 3, nearer band 3", [300, 280]],
      ["right of the row, level with column 3", [605, 300]],
    ] as const)("file dropped %s -> image inserted before c", async (_label, at) => {
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

describe("size limit and vertical-line drop", () => {
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

  it("size limit returns true: external drag-in is blocked, document unchanged; after edgeDrop/emptyColumnDrop both return false the size handleDrop is called once", () => {
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

  it("size limit returns true: drag-handle vertical-line drop still happens, size handleDrop isn't called", () => {
    const sizeDrop = spySizeDrop();
    const m = mount(three(), { sizeGuard: () => true });
    takenDrop(m, () => dragDrop(m, zToX));
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y");
    expect(sizeDrop).not.toHaveBeenCalled();
  });

  it("size limit returns true: drag-handle drop into an empty column still happens, size handleDrop isn't called", () => {
    const sizeDrop = spySizeDrop();
    const m = mount([row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r"), P("z", "z1")], { sizeGuard: () => true });
    takenDrop(m, () => dragDrop(m, { drag: "z1", target: "e1", at: [450, 200], boxes: rowBoxes("r", 100, 300, 2) }), "empty");
    expect(shape(m.editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:z)]");
    expect(sizeDrop).not.toHaveBeenCalled();
  });

  it("drag-handle horizontal-line drop (edgeDrop/emptyColumnDrop both return false) -> blockMoveDrop takes over the move, size handleDrop isn't called (moves don't estimate size)", () => {
    const sizeDrop = spySizeDrop();
    const guard = vi.fn(() => true);
    const m = mount(three(), { sizeGuard: guard });
    const s = spies();
    const move = vi.spyOn(edgeDropModule, "blockMoveDrop");
    dragDrop(m, { ...zToX, at: [300, 115] });
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(false);
    expect(move.mock.results.map((r) => r.value)).toEqual([true]);
    expect(sizeDrop).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(shape(m.editor)).not.toContain("ROW");
  });

  it("Ctrl copy-drag (PM's default drop) -> blockMoveDrop doesn't take over, size handleDrop is called once, nothing is placed when it returns true", () => {
    const sizeDrop = spySizeDrop();
    const guard = vi.fn(() => true);
    const m = mount(three(), { sizeGuard: guard });
    const move = vi.spyOn(edgeDropModule, "blockMoveDrop");
    const before = shape(m.editor);
    dragDrop(m, { ...zToX, at: [300, 115], ctrlKey: true });
    expect(move.mock.results.map((r) => r.value)).toEqual([false]);
    expect(sizeDrop).toHaveBeenCalledTimes(1);
    expect(sizeDrop.mock.calls[0]![3]).toBe(false);
    expect(guard).toHaveBeenCalledTimes(1);
    expect(shape(m.editor)).toBe(before);
  });
});

describe("handleDrop clears the recorded dragged blocks when done", () => {
  it.each([
    ["vertical-line drop (taken over)", [590, 115], true],
    ["horizontal-line drop (edgeDrop doesn't take over)", [300, 115], false],
  ] as const)("%s: after drop and before dragend the record is already null", (_label, at, taken) => {
    const m = mount(three());
    const s = spies();
    mockRects(zToX.boxes);
    const { dataTransfer } = startBlockDrag(m.editor, "z1");
    expect(draggedBlocksOf(m.view)).not.toBeNull(); // precondition
    m.view.posAtCoords = () => ({ pos: textIn(m, "x1"), inside: -1 });
    m.view.dom.dispatchEvent(dropEvent(dataTransfer, at));
    expectOneRealCall(s.edge);
    expect(s.edge.mock.results[0]!.value).toBe(taken);
    expect(draggedBlocksOf(m.view)).toBeNull();
  });
});
