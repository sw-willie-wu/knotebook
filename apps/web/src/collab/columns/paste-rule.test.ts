import { afterEach, describe, expect, it, vi } from "vitest";
import { Extension } from "@tiptap/core";
import { selectedFragmentToHTML } from "@blocknote/core";
import { COLUMN_LIST_TYPE } from "@knotebook/shared";
import { createPmPlugin } from "@/collab/pm-plugin";
import { P, integrity, mountEditor, row, shape, textPos, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { findNodeById } from "./position";
import {
  columnsTransformPasted,
  createColumnsPasteExtension,
  recordDropPoint,
  takeDropPoint,
  withColumnsDropPoint,
  type SliceLike,
  type ViewLike,
} from "./paste-rule";

// 貼上各情境的期望值逐字取自實際貼上的輸出（含單一欄、整列複製、複製欄的情境）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PM 的 Plugin／Node 在 apps/web 值層級拿不到
type Any = any;

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
  takeDropPoint();
});

function mount(content: PartialBlockLike[], opts?: { rule?: boolean; extensions?: unknown[] }): AnyEditor {
  const extensions = opts?.extensions ?? (opts?.rule === false ? [] : [createColumnsPasteExtension()]);
  const m = mountEditor(content, { extensions });
  cleanups.push(m.destroy);
  return m.editor;
}

const viewOf = (editor: AnyEditor) => editor.prosemirrorView! as unknown as ViewLike & Any;

/** 貼上前先叫 uniqueID 外掛的 paste handler（真貼上時它會先跑，讓貼進來的 id 重配）。 */
function arm(editor: AnyEditor): void {
  const view = editor.prosemirrorView!;
  for (const plugin of view.state.plugins.filter((p) => (p as Any).key.startsWith("uniqueID"))) (plugin.props.handleDOMEvents as Any).paste(view, new Event("paste"));
}

const widths = (editor: AnyEditor) =>
  (editor.document as Any[])
    .filter((b) => b.type === COLUMN_LIST_TYPE)
    .map((b) => b.children.map((c: Any) => c.props.width).join("/"))
    .join(",");

function rowCount(editor: AnyEditor): number {
  let n = 0;
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (node.type.name === COLUMN_LIST_TYPE) n += 1;
  });
  return n;
}

function sliceHasColumnList(slice: SliceLike): boolean {
  let has = false;
  (slice.content as Any).descendants((node: Any) => {
    if (node.type.name === COLUMN_LIST_TYPE) has = true;
  });
  return has;
}

/** 第一個 columnList 整個選起來，回 `blocknote/html`（站內複製整列）。 */
function copyFirstRow(editor: AnyEditor): string {
  const view = editor.prosemirrorView!;
  let rowPos = -1;
  view.state.doc.descendants((node, pos) => {
    if (rowPos < 0 && node.type.name === COLUMN_LIST_TYPE) rowPos = pos;
  });
  editor._tiptapEditor.commands.setNodeSelection(rowPos);
  return view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
}

const caret = (editor: AnyEditor, pos: number) => editor._tiptapEditor.commands.setTextSelection(pos);
const blockPos = (editor: AnyEditor, id: string) => findNodeById(editor.prosemirrorView!.state.doc as Any, id, "blockContainer")!.pos;

const MD = '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nX\n\n</div>\n<div data-kb-column style="flex:1.5">\n\nY\n\n</div>\n</div>\n';
const EXT = '<div data-kb-columns style="display:flex;gap:16px"><div data-kb-column style="flex:1"><p>X</p></div><div data-kb-column style="flex:1.5"><p>Y</p></div></div>';
const EXT_MIXED = "<p>intro</p>" + EXT + "<p>outro</p>";

/** paste7.mjs 的 W()。 */
const W = (): PartialBlockLike[] => [
  P("x", "x0"),
  P("", "e0"),
  P("abc", "t0"),
  withChildren(P("p", "p0"), [P("", "k1")]),
  row([[P("def", "a1"), P("", "e1")], [P("c", "c1")]], "row"),
  P("z", "z9"),
];

type Place = (editor: AnyEditor) => unknown;
const PLACES: Record<string, Place> = {
  "top empty": (ed) => ed.setTextCursorPosition("e0", "start"),
  "top start": (ed) => ed.setTextCursorPosition("t0", "start"),
  "top end": (ed) => ed.setTextCursorPosition("t0", "end"),
  "top mid": (ed) => caret(ed, textPos(ed, "abc", 1)),
  "nested child": (ed) => ed.setTextCursorPosition("k1", "start"),
  "col empty": (ed) => ed.setTextCursorPosition("e1", "start"),
  "col mid": (ed) => caret(ed, textPos(ed, "def", 1)),
};

// [來源, 位置, shape, 欄寬]——paste7.mjs（COLCTX=2）輸出逐行。
const PR1: [string, string, string, string][] = [
  ["md", "top empty", "paragraph:x  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["md", "top start", "paragraph:x  paragraph  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["md", "top end", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["md", "top mid", "paragraph:x  paragraph  paragraph:a  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:bc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["md", "nested child", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph:X,paragraph:Y}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["md", "col empty", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph:X,paragraph:Y) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["md", "col mid", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:d,paragraph:X,paragraph:Y,paragraph:ef,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["ext", "top empty", "paragraph:x  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["ext", "top start", "paragraph:x  paragraph  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["ext", "top end", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["ext", "top mid", "paragraph:x  paragraph  paragraph:a  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:bc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["ext", "nested child", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph:X,paragraph:Y}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["ext", "col empty", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph:X,paragraph:Y) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["ext", "col mid", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:d,paragraph:X,paragraph:Y,paragraph:ef,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["extMixed", "top empty", "paragraph:x  paragraph:intro  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:outro  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["extMixed", "top start", "paragraph:x  paragraph  paragraph  paragraph:intro  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:outro  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["extMixed", "top end", "paragraph:x  paragraph  paragraph:abc  paragraph:intro  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:outro  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["extMixed", "top mid", "paragraph:x  paragraph  paragraph:a  paragraph:intro  ROW[COL(paragraph:X) | COL(paragraph:Y)]  paragraph:outro  paragraph:bc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1.5,1/1"],
  ["extMixed", "nested child", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph:intro,paragraph:X,paragraph:Y,paragraph:outro}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["extMixed", "col empty", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph:intro,paragraph:X,paragraph:Y,paragraph:outro) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["extMixed", "col mid", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:d,paragraph:intro,paragraph:X,paragraph:Y,paragraph:outro,paragraph:ef,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["internal", "top empty", "paragraph:x  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1,1/1"],
  ["internal", "top start", "paragraph:x  paragraph  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1,1/1"],
  ["internal", "top end", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1,1/1"],
  ["internal", "top mid", "paragraph:x  paragraph  paragraph:a  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:bc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1,1/1"],
  ["internal", "nested child", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph:def,paragraph,paragraph:c}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["internal", "col empty", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph:def,paragraph,paragraph:c) | COL(paragraph:c)]  paragraph:z", "1/1"],
  ["internal", "col mid", "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:d,paragraph:def,paragraph,paragraph:c,paragraph:ef,paragraph) | COL(paragraph:c)]  paragraph:z", "1/1"],
];

function pasteFrom(editor: AnyEditor, how: string, internalHtml: string): void {
  if (how === "md") editor.pasteMarkdown(MD);
  else if (how === "ext") editor.pasteHTML(EXT);
  else if (how === "extMixed") editor.pasteHTML(EXT_MIXED);
  else editor.pasteHTML(internalHtml, true);
}

describe("三種來源 × 位置：頂層貼入完整、非頂層攤平", () => {
  it.each(PR1)("%s @ %s", (how, place, expected, w) => {
    const editor = mount(W());
    const internalHtml = copyFirstRow(editor);
    PLACES[place]!(editor);
    arm(editor);
    pasteFrom(editor, how, internalHtml);
    expect(shape(editor)).toBe(expected);
    expect(widths(editor)).toBe(w);
    expect(integrity(editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
  });
});

/** copycol-fix.mjs／copycol2.mjs 的 W()。 */
const W2 = (): PartialBlockLike[] => [
  P("x", "x0"),
  P("", "e0"),
  P("abc", "t0"),
  row([[P("def", "a1"), P("ghi", "a2"), P("", "e1")], [P("c", "c1")]], "row"),
  P("z", "z9"),
];
const SELS: Record<string, (editor: AnyEditor) => [number, number]> = {
  "two blocks in col1 (de|f..gh|i)": (ed) => [textPos(ed, "def", 2), textPos(ed, "ghi", 2)],
  "whole def..ghi blocks": (ed) => [textPos(ed, "def", 0), textPos(ed, "ghi", 3)],
  "within def only": (ed) => [textPos(ed, "def", 1), textPos(ed, "def", 2)],
  "cross col1 mid -> col2 mid (de|f .. c)": (ed) => [textPos(ed, "def", 2), textPos(ed, "c", 1)],
  "top abc mid -> col1 mid (a|bc .. de|f)": (ed) => [textPos(ed, "abc", 1), textPos(ed, "def", 2)],
  "col2 c -> z below (c| .. z)": (ed) => [textPos(ed, "c", 0), textPos(ed, "z", 1)],
};
const PLACES2: Record<string, Place> = {
  "top empty": (ed) => ed.setTextCursorPosition("e0", "start"),
  "top end abc": (ed) => ed.setTextCursorPosition("t0", "end"),
  "col2 end c": (ed) => ed.setTextCursorPosition("c1", "end"),
  "col1 empty": (ed) => ed.setTextCursorPosition("e1", "start"),
};

/** 在 W2 上選取 → 走 core 的複製（`selectedFragmentToHTML`）→ 換位置 → `pasteHTML(raw)`。 */
function copyPaste(sel: string, place: string, rule: boolean): AnyEditor {
  const editor = mount(W2(), { rule });
  const [from, to] = SELS[sel]!(editor);
  editor._tiptapEditor.commands.setTextSelection({ from, to });
  const { clipboardHTML } = selectedFragmentToHTML(editor.prosemirrorView as Any, editor);
  PLACES2[place]!(editor);
  arm(editor);
  editor.pasteHTML(clipboardHTML, true);
  return editor;
}

// [選取, 位置, shape]——copycol-fix.mjs（COLCTX=2）的 [rule] 輸出；copycol2.mjs CORE=1 的 [core] 與之逐行相同。
const PR2: [string, string, string][] = [
  ["two blocks in col1 (de|f..gh|i)", "top empty", "paragraph:x  paragraph:f  paragraph:gh  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
  ["two blocks in col1 (de|f..gh|i)", "top end abc", "paragraph:x  paragraph  paragraph:abcf  paragraph:gh  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
  ["two blocks in col1 (de|f..gh|i)", "col2 end c", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:cf,paragraph:gh)]  paragraph:z"],
  ["two blocks in col1 (de|f..gh|i)", "col1 empty", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph:f,paragraph:gh) | COL(paragraph:c)]  paragraph:z"],
  ["whole def..ghi blocks", "top empty", "paragraph:x  paragraph:def  paragraph:ghi  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
  ["whole def..ghi blocks", "top end abc", "paragraph:x  paragraph  paragraph:abcdef  paragraph:ghi  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
  ["whole def..ghi blocks", "col2 end c", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:cdef,paragraph:ghi)]  paragraph:z"],
  ["whole def..ghi blocks", "col1 empty", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph:def,paragraph:ghi) | COL(paragraph:c)]  paragraph:z"],
  ["within def only", "top empty", "paragraph:x  paragraph:e  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
  ["within def only", "top end abc", "paragraph:x  paragraph  paragraph:abce  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
  ["within def only", "col2 end c", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:ce)]  paragraph:z"],
  ["within def only", "col1 empty", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph:e) | COL(paragraph:c)]  paragraph:z"],
];

describe("PR2 從欄內複製再貼上：與不裝規則時相同", () => {
  it.each(PR2)("%s @ %s", (sel, place, expected) => {
    const ruled = copyPaste(sel, place, true);
    expect(shape(ruled)).toBe(expected);
    expect(integrity(ruled).valid).toBe(true);
    expect(shape(copyPaste(sel, place, false))).toBe(expected);
  });
});

// copycol2.mjs 的 [rule] 輸出。順序：最後一欄中間到列下方、列上方到第 1 欄中間 → 不出現新的列；
// 第 1 欄中間到第 2 欄中間 → 頂層成為新的一列。
const PR3: [string, string, string, number][] = [
  ["col2 c -> z below (c| .. z)", "top empty", "paragraph:x  paragraph:c  paragraph:z  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z", 1],
  ["col2 c -> z below (c| .. z)", "col2 end c", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:cc,paragraph:z)]  paragraph:z", 1],
  ["top abc mid -> col1 mid (a|bc .. de|f)", "top empty", "paragraph:x  paragraph:bc  paragraph:de  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z", 1],
  ["top abc mid -> col1 mid (a|bc .. de|f)", "col2 end c", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:cbc,paragraph:de)]  paragraph:z", 1],
  ["cross col1 mid -> col2 mid (de|f .. c)", "top empty", "paragraph:x  ROW[COL(paragraph:f,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z", 2],
  ["cross col1 mid -> col2 mid (de|f .. c)", "col2 end c", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c,paragraph:f,paragraph:ghi,paragraph,paragraph:c)]  paragraph:z", 1],
];

describe("跨出欄邊界的選取", () => {
  it.each(PR3)("%s @ %s", (sel, place, expected, rows) => {
    const editor = copyPaste(sel, place, true);
    expect(shape(editor)).toBe(expected);
    expect(rowCount(editor)).toBe(rows);
    expect(integrity(editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
  });
});

describe("單欄外部 HTML 照一般 block 剖析", () => {
  const rest = "paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z";
  it.each([
    ["kb single col", '<div data-kb-columns style="display:flex;gap:16px"><div data-kb-column style="flex:1"><p>X</p></div></div>', `paragraph:x  paragraph:X  ${rest}`, "1/1"],
    ["lone kb column", '<div data-kb-column style="flex:1"><p>X</p></div>', `paragraph:x  paragraph:X  ${rest}`, "1/1"],
    [
      "kb 2 cols",
      '<div data-kb-columns style="display:flex;gap:16px"><div data-kb-column style="flex:1"><p>X</p></div><div data-kb-column style="flex:2"><p>Y</p></div></div>',
      `paragraph:x  ROW[COL(paragraph:X) | COL(paragraph:Y)]  ${rest}`,
      "1/2,1/1",
    ],
  ])("%s @ top empty", (_name, html, expected, w) => {
    const editor = mount(W());
    editor.setTextCursorPosition("e0", "start");
    arm(editor);
    editor.pasteHTML(html);
    expect(shape(editor)).toBe(expected);
    expect(widths(editor)).toBe(w);
  });
});

/** 外部兩欄 HTML 經 core（editorProps 的 transformPasted 先跑）之後、我們的規則會收到的 slice。 */
function rawExternalSlice(): SliceLike {
  let captured: SliceLike | null = null;
  const capture = Extension.create({
    name: "captureSlice",
    addProseMirrorPlugins() {
      return [
        createPmPlugin({
          props: {
            transformPasted(slice: SliceLike) {
              captured = slice;
              return slice;
            },
          },
        }) as never,
      ];
    },
  });
  const source = mount(W(), { extensions: [capture] });
  source.setTextCursorPosition("e0", "start");
  source.pasteHTML(EXT);
  expect(captured).not.toBeNull();
  return captured!;
}

const at = (pos: number) => ({ pos, inside: -1 });
const DROP_EVENT = { clientX: 1, clientY: 1 } as DragEvent;

describe("外部拖入：位置看落點、不看游標", () => {
  it("游標在欄內、落點在頂層 → 列完整（封閉 slice）", () => {
    const raw = rawExternalSlice();
    expect(raw.openStart).toBeGreaterThan(0);
    const editor = mount(W(), { rule: false });
    const view = viewOf(editor);
    const topEmpty = blockPos(editor, "e0") + 2;
    caret(editor, textPos(editor, "def", 1));
    vi.spyOn(view, "posAtCoords").mockReturnValue(at(topEmpty));
    recordDropPoint(view, DROP_EVENT);
    const out = columnsTransformPasted(raw, view);
    expect(out.openStart).toBe(0);
    expect(out.openEnd).toBe(0);
    expect(sliceHasColumnList(out)).toBe(true);
  });

  it("游標在頂層、落點在子 block 內 → 攤平", () => {
    const raw = rawExternalSlice();
    const editor = mount(W(), { rule: false });
    const view = viewOf(editor);
    editor.setTextCursorPosition("e0", "start");
    vi.spyOn(view, "posAtCoords").mockReturnValue(at(blockPos(editor, "k1") + 2));
    recordDropPoint(view, DROP_EVENT);
    expect(sliceHasColumnList(columnsTransformPasted(raw, view))).toBe(false);
  });
});

/** dropnest2.mjs 的 D()。 */
const D = (): PartialBlockLike[] => [
  P("x", "x0"),
  row([[P("a", "a1")], [P("b", "b1")]], "r1"),
  P("y", "y0"),
  row([[P("d", "d1"), P("e", "e1")], [P("f", "f1")]], "r2"),
  withChildren(P("p", "p0"), [P("k", "k1")]),
  P("z", "z9"),
];

describe("站內拖曳（view.dragging）", () => {
  function dragging(editor: AnyEditor): { view: Any; slice: SliceLike } {
    const view = viewOf(editor);
    const doc = view.state.doc;
    const from = findNodeById(doc, "x0", "blockContainer")!.pos;
    const r1 = findNodeById(doc, "r1", COLUMN_LIST_TYPE)!;
    const slice = doc.slice(from, r1.pos + r1.node.nodeSize);
    view.dragging = { slice, move: true };
    cleanups.push(() => {
      view.dragging = null;
    });
    return { view, slice };
  }

  it.each([
    ["子 block 文字內", (ed: AnyEditor) => blockPos(ed, "k1") + 2],
    ["子 block 之間（縮排群組內）", (ed: AnyEditor) => blockPos(ed, "k1")],
  ])("落點在%s → 攤平，不產生巢狀列", (_name, dropAt) => {
    const editor = mount(D(), { rule: false });
    const { view, slice } = dragging(editor);
    vi.spyOn(view, "posAtCoords").mockReturnValue(at(dropAt(editor)));
    recordDropPoint(view, DROP_EVENT);
    expect(sliceHasColumnList(columnsTransformPasted(slice, view))).toBe(false);
  });

  it("落點在頂層 → 原樣交還 PM（同一個 slice 物件）", () => {
    const editor = mount(D(), { rule: false });
    const { view, slice } = dragging(editor);
    vi.spyOn(view, "posAtCoords").mockReturnValue(at(blockPos(editor, "y0")));
    recordDropPoint(view, DROP_EVENT);
    expect(columnsTransformPasted(slice, view)).toBe(slice);
  });
});

describe("drop 落點的生命週期", () => {
  it("同步取得、取過即清、microtask 後清回 null", async () => {
    const editor = mount(W(), { rule: false });
    const view = viewOf(editor);
    vi.spyOn(view, "posAtCoords").mockReturnValue(at(5));
    recordDropPoint(view, DROP_EVENT);
    expect(takeDropPoint()).toBe(5);
    expect(takeDropPoint()).toBeNull();
    recordDropPoint(view, DROP_EVENT);
    await Promise.resolve();
    expect(takeDropPoint()).toBeNull();
  });

  it("posAtCoords 回 null（落在文件外）→ 沒有落點", () => {
    const editor = mount(W(), { rule: false });
    const view = viewOf(editor);
    vi.spyOn(view, "posAtCoords").mockReturnValue(null);
    recordDropPoint(view, DROP_EVENT);
    expect(takeDropPoint()).toBeNull();
  });
});

describe("withColumnsDropPoint", () => {
  type DropEvents = { drop: (view: unknown, event: DragEvent) => boolean; paste?: () => boolean };

  it("先記落點再交給原 handler，回傳值照原 handler", () => {
    const editor = mount(W(), { rule: false });
    const view = viewOf(editor);
    vi.spyOn(view, "posAtCoords").mockReturnValue(at(7));
    const seen: (number | null)[] = [];
    let result = true;
    const paste = () => false;
    const combined = withColumnsDropPoint<DropEvents>({
      paste,
      drop: () => {
        seen.push(takeDropPoint());
        return result;
      },
    });
    expect(combined.paste).toBe(paste);
    expect(combined.drop(view, DROP_EVENT)).toBe(true);
    result = false;
    expect(combined.drop(view, DROP_EVENT)).toBe(false);
    expect(seen).toEqual([7, 7]);
  });

  it("view 為 null（NoteEditor 測試的呼叫法）→ 不丟例外、不記落點", () => {
    const seen: (number | null)[] = [];
    const combined = withColumnsDropPoint<DropEvents>({
      drop: () => {
        seen.push(takeDropPoint());
        return true;
      },
    });
    expect(combined.drop(null, DROP_EVENT)).toBe(true);
    expect(seen).toEqual([null]);
  });
});

describe("PR9 5 欄的列貼在頂層", () => {
  it("照貼成一列 5 欄、不丟例外、不裁欄", () => {
    const source = mount([row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")], [P("d", "d1")], [P("e", "e1")]], "r5")], { rule: false });
    const html = copyFirstRow(source);
    const editor = mount(W());
    editor.setTextCursorPosition("e0", "start");
    arm(editor);
    expect(() => editor.pasteHTML(html, true)).not.toThrow();
    expect(shape(editor)).toBe(
      "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c) | COL(paragraph:d) | COL(paragraph:e)]  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph) | COL(paragraph:c)]  paragraph:z",
    );
    expect(integrity(editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
  });
});

describe("PR10 列貼進表格格子", () => {
  it("不丟例外、文件合法、表格裡沒有 columnList、兩欄文字進了該格", () => {
    const table: PartialBlockLike = {
      id: "t1",
      type: "table",
      content: { type: "tableContent", rows: [{ cells: ["aa", "bb"] }, { cells: ["cc", "dd"] }] },
    } as PartialBlockLike;
    const editor = mount([P("x", "x0"), table, P("z", "z9")]);
    caret(editor, textPos(editor, "aa", 1));
    arm(editor);
    expect(() => editor.pasteHTML(EXT)).not.toThrow();
    expect(integrity(editor).valid).toBe(true);
    expect(rowCount(editor)).toBe(0);
    // core 的 transformPasted（editorProps，先跑）把兩欄轉成行內＋換行，併進游標所在的格子。
    const cell = (editor.document[1] as Any).content.rows[0].cells[0];
    expect(cell.content.map((c: { text: string }) => c.text).join("")).toBe("aX\nYa");
  });
});

describe("含子 block 的列貼進欄內", () => {
  it("攤平時子 block 跟著它的父 block，不產生巢狀列", () => {
    const source = mount([row([[withChildren(P("m", "m1"), [P("n", "n1")])], [P("o", "o1")]], "rs")], { rule: false });
    const html = copyFirstRow(source);
    const editor = mount(W());
    editor.setTextCursorPosition("e1", "start");
    arm(editor);
    editor.pasteHTML(html, true);
    expect(shape(editor)).toBe(
      "paragraph:x  paragraph  paragraph:abc  paragraph:p{paragraph}  ROW[COL(paragraph:def,paragraph:m{paragraph:n},paragraph:o) | COL(paragraph:c)]  paragraph:z",
    );
    expect(integrity(editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
  });
});

describe("單獨一欄（Ctrl＋點欄整欄複製，concern 2）", () => {
  // 整欄 NodeSelection 的 slice 只有一個 column、沒有 columnList；不換掉的話 PM 會把它包成補了空欄的列，
  // 頂層貼上時長進段落的子 block（巢狀列；不裝規則時 `paragraph{ROW[COL(paragraph:c) | COL(paragraph)]}`）。
  it.each([
    ["top empty", "paragraph:x  paragraph:c  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
    ["top end abc", "paragraph:x  paragraph  paragraph:abc  paragraph:c  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c)]  paragraph:z"],
    ["col2 end c", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph) | COL(paragraph:c,paragraph:c)]  paragraph:z"],
    ["col1 empty", "paragraph:x  paragraph  paragraph:abc  ROW[COL(paragraph:def,paragraph:ghi,paragraph:c) | COL(paragraph:c)]  paragraph:z"],
  ])("貼到 %s → 平鋪成欄內的 block，不產生新列或巢狀列", (place, expected) => {
    const editor = mount(W2());
    const view = editor.prosemirrorView!;
    editor._tiptapEditor.commands.setNodeSelection(findNodeById(view.state.doc as Any, "rowc1", "column")!.pos);
    const { clipboardHTML } = selectedFragmentToHTML(view as Any, editor);
    PLACES2[place]!(editor);
    arm(editor);
    editor.pasteHTML(clipboardHTML, true);
    expect(shape(editor)).toBe(expected);
    expect(rowCount(editor)).toBe(1);
    expect(integrity(editor)).toEqual({ dupIds: 0, nullIds: 0, nestedRows: 0, valid: true });
  });
});
