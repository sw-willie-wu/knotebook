import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import type { EditorRef } from "@/components/wikilink/menu";
import { P, blockPos, integrity, pressKey, row, shape, startBlockDrag, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import * as edgeDropModule from "./edge-drop";
import { createColumnEdgeKeymapExtension } from "./edge-keymap";
import { removeBlocksKeepColumns } from "./keep-columns";
import { findNodeById } from "./position";

// 媒體阻擋會呼叫 toast；完整選項的編輯器（`buildNoteEditorOptions`）才有，換成 spy 免得碰到真的 UI。
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");

// spec §13.1「雙用戶端（記錄現象）」、§5.5（D17、D25）。被測的是 y-prosemirror 與 core 的合併行為，不是本 PR 的碼——
// 「已知限制 D17」的案把實測值寫死；其餘（spec 的「安全」）紅了就是回歸。手法同 probe-collab/collab.mjs。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  toastMock.mockReset();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * 兩顆共編編輯器，各自一份 Y.Doc，經 `Y.applyUpdate` 互傳。預設兩顆都只掛列邊界的 keymap（`createColumnEdgeKeymapExtension`）；`full` 列出的那顆改用
 * `buildNoteEditorOptions` 的完整選項（`handleDrop` 串接、拖曳來源記錄器、DropCursor hook 都在），拖放才走產品的接手路徑。
 */
async function collabPair(initial: PartialBlockLike[], opts: { full?: readonly ("a" | "b")[] } = {}) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const make = (doc: Y.Doc, n: number): AnyEditor => {
    const editorRef: EditorRef = { current: null };
    const full = opts.full?.includes(n === 1 ? "a" : "b");
    const editor = BlockNoteEditor.create(
      full
        ? buildNoteEditorOptions({
            doc,
            provider: { awareness: null } as never,
            user: { id: `u${n}`, name: `User ${n}` },
            language: "en",
            translate: (k) => k,
            editorRef,
            noteId: "n",
            siteLinks: { current: null },
          })
        : withCollaboration({
            schema: noteSchema,
            collaboration: {
              provider: { awareness: undefined },
              fragment: doc.getXmlFragment(YDOC_FRAGMENT),
              user: { id: `u${n}`, name: `User ${n}`, color: "hsl(0 65% 45%)" },
            },
            _tiptapOptions: { extensions: [createColumnEdgeKeymapExtension({ editorRef })] },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
          } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    ) as any as AnyEditor;
    editorRef.current = editor;
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    cleanups.push(() => {
      editor.unmount();
      el.remove();
      doc.destroy();
    });
    return editor;
  };
  const a = make(d1, 1);
  await tick();
  a.replaceBlocks(a.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const b = make(d2, 2);
  await tick();
  const sync = async () => {
    const u1 = Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2));
    const u2 = Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1));
    Y.applyUpdate(d2, u1);
    Y.applyUpdate(d1, u2);
    await tick();
  };
  return { a, b, sync };
}

const allText = (editor: AnyEditor) => {
  let s = "";
  editor.prosemirrorView!.state.doc.descendants((n) => {
    if (n.isText) s += n.text + "|";
  });
  return s;
};

const typeText = (editor: AnyEditor, text: string) => {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.insertText(text));
};
const typeAtEnd = (editor: AnyEditor, id: string, text: string) => {
  editor.setTextCursorPosition(id, "end");
  typeText(editor, text);
};

/** 第 `index` 個表格格子的文字結尾打字（文件順序；2×2 表格 0＝左上、3＝右下）。 */
const typeInCell = (editor: AnyEditor, index: number, text: string) => {
  const view = editor.prosemirrorView!;
  const cells: number[] = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name === "tableCell" || n.type.name === "tableHeader") cells.push(pos);
  });
  const pos = cells[index]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Selection 類別從現行選取的 constructor 取（讀碼發現 13）
  const Sel = view.state.selection.constructor as any;
  const end = Sel.near(view.state.doc.resolve(pos + view.state.doc.nodeAt(pos)!.nodeSize - 1), -1);
  view.dispatch(view.state.tr.setSelection(end).insertText(text));
};

const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };
const AB = () => [P("x", "x0"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z9")];

describe("雙用戶端（記錄現象，spec §13.1、§5.5）", () => {
  it("CO1（安全）：A 在第 1 欄打字、B 在第 2 欄結尾 Enter 再打字 → 兩邊都保有兩人的字、列仍是合法兩欄", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.setTextCursorPosition("b1", "end");
    expect(pressKey(b, "Enter")).toBe(true);
    typeText(b, "BBB");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).toContain("AAA");
      expect(allText(e)).toContain("BBB");
      expect(integrity(e)).toEqual(CLEAN);
    }
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph:aAAA) | COL(paragraph:b,paragraph:BBB)]  paragraph:z");
    expect(shape(b)).toBe(shape(a));
  });

  it("CO2（已知限制 D17）：A 在第 1 欄打字、B 同時在 b 開頭 Backspace（D24 攤平）→ A 的字消失", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.setTextCursorPosition("b1", "start");
    expect(pressKey(b, "Backspace")).toBe(true);
    expect(shape(b)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).not.toContain("AAA");
      expect(integrity(e)).toEqual(CLEAN);
    }
    expect(shape(a)).toBe("paragraph:x  paragraph:a  paragraph:b  paragraph:z");
    expect(shape(b)).toBe(shape(a));
  });

  it("CO3（已知限制 D17）：同一欄兩個 block 被兩人分別刪掉（D25 方式）→ 整列被 y-prosemirror 刪掉", async () => {
    const { a, b, sync } = await collabPair([P("x", "x0"), row([[P("a", "a1"), P("q", "q1")], [P("b", "b1")]], "r"), P("z", "z9")]);
    removeBlocksKeepColumns(a, ["a1"]);
    removeBlocksKeepColumns(b, ["q1"]);
    expect(shape(a)).toBe("paragraph:x  ROW[COL(paragraph:q) | COL(paragraph:b)]  paragraph:z");
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
    await sync();
    for (const e of [a, b]) {
      expect(shape(e)).toBe("paragraph:x  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });

  it("CO4（安全）：欄內 2×2 表格，A 在左上格、B 在右下格各打字 → 兩格都有各自的字、列與表格合法", async () => {
    const table: PartialBlockLike = {
      id: "t1",
      type: "table",
      content: { type: "tableContent", rows: [{ cells: ["c00", "c01"] }, { cells: ["c10", "c11"] }] },
    };
    const { a, b, sync } = await collabPair([P("x", "x0"), row([[table], [P("b", "b1")]], "r"), P("z", "z9")]);
    typeInCell(a, 0, "_A");
    typeInCell(b, 3, "_B");
    await sync();
    for (const e of [a, b]) {
      expect(allText(e)).toBe("x|c00_A|c01|c10|c11_B|b|z|");
      expect(shape(e)).toBe("paragraph:x  ROW[COL(table) | COL(paragraph:b)]  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });

  it("CO5（安全）：A 在第 1 欄打字、B 同時加第 3 欄並在列下方加一段 → 字還在、列有 3 欄、下方段落在", async () => {
    const { a, b, sync } = await collabPair(AB());
    typeAtEnd(a, "a1", "AAA");
    b.transact((tr) => {
      const list = findNodeById(tr.doc, "r", "columnList")!;
      const column = tr.doc.type.schema.nodes.column!.createAndFill()!;
      tr.insert(list.pos + list.node.nodeSize - 1, column);
    });
    expect(shape(b)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph)]  paragraph:z");
    b.insertBlocks([P("below", "n1")], "r", "after");
    await sync();
    for (const e of [a, b]) {
      expect(shape(e)).toBe("paragraph:x  ROW[COL(paragraph:aAAA) | COL(paragraph:b) | COL(paragraph)]  paragraph:below  paragraph:z");
      expect(integrity(e)).toEqual(CLEAN);
    }
  });
});

// ─── ⋮⋮ 拖放與對方同時打字 ─────────────────────────────────────────────────────────────

type Box = readonly [left: number, top: number, right: number, bottom: number];

/** 在任何 spy 掛上之前取：同一案裡會換落點編輯器、重掛 mock，fallback 不能取到 spy 自己。 */
const ORIGINAL_RECT = Element.prototype.getBoundingClientRect;

/**
 * jsdom 的 rect 全是 0。只對落點那顆編輯器（`target`）裡的元素以 `<data-node-type>:<data-id>` 查表回值：兩顆編輯器的 id 相同，
 * 不限範圍的話另一顆也會吃到同一張表。各編輯器根層的 `.bn-block-group`：落點那顆回包住所有測試座標的框，另一顆放在 x 5000 之後
 * （遠超過 core SideMenu 的 250px 範圍）。core 在 root 的 capture drop 以這個框找最近的編輯器：最近的不是落點那顆時，它會把落點那顆
 * 當成「拖到別的編輯器」處理；座標在框外 250px 內時，會先發一筆座標夾進框內的合成事件。掛在 prototype、依身分回值：
 * 文件一變 PM 就換掉元素，掛在單一元素上的 mock 會失效。
 */
function mockRects(target: AnyEditor, boxes: Record<string, Box>): void {
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

/** 列 `id`（欄 id `${id}c${i}`）佔 x 0–600、y 100–300，n 欄等寬、欄間 24px 溝。 */
function rowBoxes(id: string, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, 100, 600, 300] };
  for (let i = 0; i < n; i++) out[`column:${id}c${i}`] = [i * (width + 24), 100, i * (width + 24) + width, 300];
  return out;
}

const topBox = (id: string, top: number): Record<string, Box> => ({ [`blockOuter:${id}`]: [0, top, 600, top + 30] });

interface Gesture {
  /** 被拖 block 的 id。 */
  drag: string;
  /** 落點所在 block 的 id（`posAtCoords` 回它的文字開頭）。 */
  target: string;
  at: readonly [number, number];
  boxes: Record<string, Box>;
}

/**
 * `editor` 上一次 ⋮⋮ 拖放：真 dragstart（core `blockDragStart`，冒泡到 document 讓拖曳來源記錄器記下 X）→ 對 `view.dom` dispatch drop
 * → 照瀏覽器在拖曳來源上補 dragend。`posAtCoords` 固定回 `target` 的文字開頭（jsdom 沒有版面）。
 */
function dragDrop(editor: AnyEditor, g: Gesture): DragEvent {
  mockRects(editor, g.boxes);
  const { dataTransfer } = startBlockDrag(editor, g.drag);
  const view = editor.prosemirrorView!;
  const pos = blockPos(editor, g.target) + 2;
  view.posAtCoords = () => ({ pos, inside: -1 });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: g.at[0] });
  Object.defineProperty(event, "clientY", { value: g.at[1] });
  Object.defineProperty(event, "ctrlKey", { value: false });
  Object.defineProperty(event, "altKey", { value: false });
  view.dom.dispatchEvent(event);
  editor.domElement!.parentElement!.dispatchEvent(new Event("dragend", { bubbles: true }));
  return event as DragEvent;
}

type Handler = "edgeDrop" | "emptyColumnDrop";

/**
 * `dropper` 以產品的 `handleDrop` 接手一次拖放、`typist` 同時在 `typeIn` 結尾打 `text`（兩邊都還沒收到對方的更新），再互相同步。
 * 斷言：`dropper` 的 `handleDrop` 是完整選項那一支、`handler` 恰被呼叫一次且收到的不是合成事件、它接手了；`typist` 的選取不受拖放影響。
 */
async function dropWhileTyping(
  pair: { sync: () => Promise<void> },
  dropper: AnyEditor,
  gesture: Gesture,
  typist: AnyEditor,
  typeIn: string,
  text: string,
  handler: Handler = "edgeDrop",
): Promise<void> {
  expect(dropper.prosemirrorView!.someProp("handleDrop", (f) => f)).toBeTypeOf("function");
  const spy: MockInstance = vi.spyOn(edgeDropModule, handler);
  typist.setTextCursorPosition(typeIn, "end");
  const typistSelection = typist.prosemirrorView!.state.selection.toJSON();
  const event = dragDrop(dropper, gesture);
  expect(spy).toHaveBeenCalledTimes(1);
  expect((spy.mock.calls[0]![2] as { synthetic?: boolean }).synthetic).not.toBe(true);
  expect(spy.mock.results[0]!.value).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  expect(typist.prosemirrorView!.state.selection.toJSON()).toEqual(typistSelection);
  spy.mockRestore();
  typeText(typist, text);
  await pair.sync();
}

/** 兩邊文件相同、id 不重複不缺、沒有巢狀列、`doc.check()` 過。 */
function expectSameAndClean(a: AnyEditor, b: AnyEditor): void {
  expect(shape(b)).toBe(shape(a));
  expect(allText(b)).toBe(allText(a));
  for (const e of [a, b]) expect(integrity(e)).toEqual(CLEAN);
}

/** 文字含 `text` 的 block 的 id（記錄對方的字落在哪裡；找不到 → "gone"）。 */
function blockHolding(editor: AnyEditor, text: string): string {
  let id = "gone";
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (node.type.name === "blockContainer" && node.firstChild?.textContent.includes(text)) id = String(node.attrs.id);
  });
  return id;
}

type RowBlock = { id: string; children: Array<{ props: { width: number }; children: Array<{ content?: Array<{ text?: string }> }> }> };
const rowBlock = (editor: AnyEditor, rowId: string): RowBlock => editor.document.find((block) => block.id === rowId) as unknown as RowBlock;
const widthsOf = (editor: AnyEditor, rowId: string): number[] => rowBlock(editor, rowId).children.map((col) => col.props.width);

describe("雙用戶端：⋮⋮ 拖放時對方同時打字（B 以完整選項掛、走真 dragstart＋drop）", () => {
  // 記錄（jsdom 實測）：Y 被換成新列，A 在 Y 裡打的字跟著舊的 Y 消失（holder "gone"，合併後 `ROW[y｜x] z`）。
  it("CO6（記錄）：B 把 x 拖到 y 右緣建列 [y｜x]，A 同時在 y 打字 → 列合法、兩邊相同，記下 A 的字落在哪個 block", async () => {
    const pair = await collabPair([P("y", "y1"), P("x", "x1"), P("z", "z1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }, a, "y1", "AAA");
    expectSameAndClean(a, b);
    console.log("CO6 middle", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA") }));
  });

  // 記錄（jsdom 實測）：A 的字不在 y，出現在列後補的那個空段落（合併後 `ROW[y｜x]  paragraph:AAA`）。
  it("CO6（記錄）：新列是文件最後一個 block（列後補空段落），A 同時在 y 打字 → 列合法、兩邊相同，記下 A 的字落在哪個 block", async () => {
    const pair = await collabPair([P("x", "x1"), P("y", "y1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }, a, "y1", "AAA");
    expectSameAndClean(a, b);
    console.log("CO6 last", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA") }));
  });

  it("CO6b（安全）：頂層 [y, m, x]，B 把 x 拖到 y 右緣建列，A 同時在 m 打字 → m 保有 A 的字", async () => {
    const pair = await collabPair([P("y", "y1"), P("m", "m1"), P("x", "x1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "x1", target: "y1", at: [590, 115], boxes: topBox("y1", 100) }, a, "m1", "MM");
    expectSameAndClean(a, b);
    for (const e of [a, b]) {
      expect(blockHolding(e, "MM")).toBe("m1");
      expect(shape(e)).toBe("ROW[COL(paragraph:y) | COL(paragraph:x)]  paragraph:mMM");
    }
  });

  it("CO7（安全）：[a｜b] 外的 z 由 B 拖到 b 右緣加欄，A 同時在 a 打字 → 字在、三欄", async () => {
    const pair = await collabPair([row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "z1", target: "b1", at: [590, 200], boxes: rowBoxes("r", 2) }, a, "a1", "AAA");
    expectSameAndClean(a, b);
    for (const e of [a, b]) expect(shape(e)).toBe("ROW[COL(paragraph:aAAA) | COL(paragraph:b) | COL(paragraph:z)]");
  });

  it.each([
    ["既有欄寬不變", [1, 1], [1, 1, 1]],
    // 既有兩欄 0.4：1.2，新欄＝平均 0.8；整列正規化成總和 3 → [1, 0.5, 1.5]，既有兩欄的比例不變、值都改了。
    ["既有欄寬改變（不相等、總和不等於欄數，加欄後整列正規化）", [0.4, 1.2], [1, 0.5, 1.5]],
  ] as const)("CO7b（安全）：[X,a｜b]，B 把 X 拖成最左的新欄（%s），A 同時在 a 打字 → 字在", async (_label, widths, expected) => {
    const pair = await collabPair([row([[P("X", "X1"), P("a", "a1")], [P("b", "b1")]], "r", [...widths])], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "X1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 2) }, a, "a1", "AAA");
    expectSameAndClean(a, b);
    for (const e of [a, b]) {
      expect(shape(e)).toBe("ROW[COL(paragraph:X) | COL(paragraph:aAAA) | COL(paragraph:b)]");
      expect(widthsOf(e, "r")).toEqual(expected);
    }
  });

  // 記錄（jsdom 實測）：兩邊各自插入的新欄都留下，合併後 5 欄、欄寬全是 1，`doc.check()` 照過；超過單人拖曳的 4 欄上限
  // （單人拖到 4 欄的列只出橫線）。
  it("CO10（記錄）：兩人同時對 3 欄列的不同欄直線加欄 → 列合法、兩邊相同，記下欄數", async () => {
    const pair = await collabPair([P("p", "p1"), P("q", "q1"), row([[P("a", "a1")], [P("b", "b1")], [P("c", "c1")]], "r")], { full: ["a", "b"] });
    const { a, b } = pair;
    const spy = vi.spyOn(edgeDropModule, "edgeDrop");
    dragDrop(b, { drag: "p1", target: "c1", at: [590, 200], boxes: rowBoxes("r", 3) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0]!.value).toBe(true);
    dragDrop(a, { drag: "q1", target: "a1", at: [5, 200], boxes: rowBoxes("r", 3) });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.results[1]!.value).toBe(true);
    expect(shape(b)).toBe("paragraph:q  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c) | COL(paragraph:p)]");
    expect(shape(a)).toBe("paragraph:p  ROW[COL(paragraph:q) | COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c)]");
    await pair.sync();
    expectSameAndClean(a, b);
    const count = (a.document.find((block) => block.id === "r") as { children: unknown[] }).children.length;
    console.log("CO10", JSON.stringify({ shape: shape(a), columns: count, widths: widthsOf(a, "r") }));
  });

  // 記錄（jsdom 實測）：A 在空段落 E 打的字出現在取代它的 z 裡。字在 z 的前或後取決於兩邊 Y.Doc 的 clientID 大小
  // （`AAAz` 或 `zAAA`），每次跑都可能不同，所以只記錄、不斷言順序。
  it("CO11（記錄）：B 把 z 橫線放進空欄 E，A 同時在 E 打字 → 列合法、兩邊相同，記下 A 的字落在哪個 block", async () => {
    const pair = await collabPair([row([[P("a", "a1")], [P("", "e1")]], "r"), P("z", "z1")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "z1", target: "e1", at: [456, 200], boxes: rowBoxes("r", 2) }, a, "e1", "AAA", "emptyColumnDrop");
    expectSameAndClean(a, b);
    console.log("CO11 empty", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA") }));
  });

  // 記錄（jsdom 實測）：A 的字不在搬走的 X，出現在來源欄留下的空段落（合併後原列 `[a｜AAA]`，新列的 X 沒有 A 的字）。
  it("CO11（記錄）：B 把來源欄唯一的 X 直線拖走，A 同時在 X 打字 → 列合法、兩邊相同，記下 A 的字是否在來源欄留下的空段落", async () => {
    const pair = await collabPair([P("w", "w1"), row([[P("a", "a1")], [P("X", "X1")]], "r")], { full: ["b"] });
    const { a, b } = pair;
    await dropWhileTyping(pair, b, { drag: "X1", target: "w1", at: [590, 15], boxes: topBox("w1", 0) }, a, "X1", "AAA");
    expectSameAndClean(a, b);
    const sourceColumnText = rowBlock(a, "r").children[1]!.children.map((block) => (block.content ?? []).map((c) => c.text).join("")).join("|");
    console.log("CO11 source", JSON.stringify({ shape: shape(a), holder: blockHolding(a, "AAA"), sourceColumnText }));
  });
});
