/**
 * ⋮⋮ 拖到 block 左右緣時的直線判斷：被拖的 X 是什麼、指標下的目標 Y 是誰、在左緣還是右緣、這次放下該不該變成建列／加欄。
 *
 * 幾何（rect、`posAtCoords`）與文件判斷分開：`edgeSideOf`、`columnAt`、`classifyEdge` 是純函式；`edgeTargetAt` 把畫面上的
 * rect 讀進來後交給它們。DropCursor 畫線與 drop 交易都呼叫同一支 `edgeTargetAt`，畫的與放的才會一致。
 *
 * PM 的 Node／Selection 值層級在 apps/web 拿不到（見 `pm-plugin.ts`）；型別從 apps/web 直接依賴的 prosemirror-view 取，
 * 判斷一律用 duck typing（core 的 `MultipleNodeSelection` 也不在公開出口）。
 */
import { defaultProps } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMNS_MAX } from "@knotebook/shared";
import type { EditorView } from "prosemirror-view";
import { findNodeById, type PMNodeLike } from "./position";

type PMNode = EditorView["state"]["doc"];
type PMSelection = EditorView["state"]["selection"];

const BLOCK_CONTAINER = "blockContainer";
/** 堆疊外掛（`layout-extension.ts` 的 `STACKED_ATTR`）掛在列上的屬性；不從那裡 import，免得它之後引用本檔時成環。 */
const STACKED_ATTR = "data-stacked";
const ROW_SELECTOR = `[data-node-type="${COLUMN_LIST_TYPE}"]`;

export type EdgeSide = "left" | "right";

/** dragstart 那一刻記下的 X。`hasRows`：X 含頂層列（不做直線；放進空欄時攤平成各欄的 block）。 */
export interface DraggedBlocks {
  readonly ids: readonly string[];
  readonly kind: "node" | "multi";
  readonly hasRows: boolean;
}

export type EdgeTarget =
  /** Y 原位置換成新列；`pos`＝Y 之前（DropCursor 以 `nodeDOM(pos)` 畫線）。 */
  | { kind: "newRow"; yId: string; side: EdgeSide; pos: number }
  /** 在列的某欄左／右插入新欄；`pos`＝目標欄之前。 */
  | { kind: "addColumn"; rowId: string; columnId: string; side: EdgeSide; pos: number };

export interface ColumnBox {
  id: string;
  pos: number;
  left: number;
  right: number;
}

export interface RowBox {
  id: string;
  pos: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  stacked: boolean;
  columns: ColumnBox[];
}

export type EdgeHit =
  /** 頂層 Y（`yPos`＝Y 之前）。 */
  | { kind: "top"; yPos: number; side: EdgeSide }
  /** 列裡的第 `colIndex` 欄。 */
  | { kind: "column"; rowId: string; colIndex: number; side: EdgeSide };

/** 左右緣區的寬：框寬的 20%，夾在 [24, 64] px。 */
export function edgeZone(boxWidth: number): number {
  return Math.min(64, Math.max(24, 0.2 * boxWidth));
}

/**
 * `[左, 左+z)` → 左、`(右−z, 右]` → 右，其餘 null。框外不算左緣：⋮⋮ 在 block 左側的框外（頂層在編輯器左內距、欄內在溝裡），
 * 平常上下拖曳排序時指標就停在那裡，框外若算左緣，每次排序都會出直線。
 */
export function edgeSideOf(box: { left: number; right: number }, x: number): EdgeSide | null {
  const z = edgeZone(box.right - box.left);
  if (x >= box.left && x < box.left + z) return "left";
  if (x > box.right - z && x <= box.right) return "right";
  return null;
}

/**
 * 指標在哪一個未堆疊列的 rect 內、以 x 落在哪一欄（溝 → `colIndex: null`）；不在任何未堆疊列內 → null。
 * 列內一律以 x 對欄的 rect 定欄：各欄頂端對齊，短欄下方的空白也屬於那一欄；PM 的 `posAtCoords` 在那裡可能吸到旁邊那欄的字。
 */
export function columnAt(rows: readonly RowBox[], x: number, y: number): { row: RowBox; colIndex: number | null } | null {
  for (const row of rows) {
    if (row.stacked || y < row.top || y > row.bottom || x < row.left || x > row.right) continue;
    const index = row.columns.findIndex((col) => x >= col.left && x <= col.right);
    return { row, colIndex: index < 0 ? null : index };
  }
  return null;
}

/** 畫面上每一列（`view.dom` 內的 columnList 元素）與它的欄的 rect；`pos` 是節點之前的位置。 */
export function rowsOf(view: EditorView): RowBox[] {
  const rows: RowBox[] = [];
  view.dom.querySelectorAll<HTMLElement>(ROW_SELECTOR).forEach((el) => {
    const id = el.getAttribute("data-id");
    if (!id) return;
    const rect = el.getBoundingClientRect();
    const columns: ColumnBox[] = [];
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      const colId = child.getAttribute("data-id");
      if (child.getAttribute("data-node-type") !== COLUMN_TYPE || !colId) continue;
      const colRect = child.getBoundingClientRect();
      // 欄與列的 DOM 本身就是 contentDOM：offset 0 是節點內容的開頭，減 1 才是節點之前。
      columns.push({ id: colId, pos: view.posAtDOM(child, 0) - 1, left: colRect.left, right: colRect.right });
    }
    rows.push({
      id,
      pos: view.posAtDOM(el, 0) - 1,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      stacked: el.hasAttribute(STACKED_ATTR),
      columns,
    });
  });
  return rows;
}

/**
 * dragstart 那一刻的選取 → X。只有 block 拖曳（core ⋮⋮ 設的 `NodeSelection`／多選）才算：
 * - `NodeSelection` 且節點是 blockContainer → `node`。
 * - 有 `nodes` 陣列（core 的多選）、兩端同一父節點、節點全是 blockContainer → `multi`；頂層的 columnList 也收，標 `hasRows`。
 *   兩端在不同欄時 core 的 `nodes` 只收第一欄的 block、不含欄，只看 `nodes` 偵測不到，所以另外比對兩端的父節點。
 * - 含欄、非頂層的列、其他型別、文字選取 → null。
 */
export function draggedFromSelection(sel: PMSelection): DraggedBlocks | null {
  const single = (sel as { node?: PMNode }).node;
  if (single) {
    const id = single.attrs.id;
    return single.type.name === BLOCK_CONTAINER && typeof id === "string" && id ? { ids: [id], kind: "node", hasRows: false } : null;
  }
  const nodes = (sel as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes) || nodes.length === 0 || !sel.$from.sameParent(sel.$to)) return null;
  const topLevel = sel.$from.depth === 1;
  const ids: string[] = [];
  let hasRows = false;
  for (const node of nodes as PMNode[]) {
    const id = node.attrs.id;
    if (typeof id !== "string" || !id) return null;
    if (node.type.name === COLUMN_LIST_TYPE && topLevel) hasRows = true;
    else if (node.type.name !== BLOCK_CONTAINER) return null;
    ids.push(id);
  }
  return { ids, kind: "multi", hasRows };
}

const DEFAULT_KEYS = ["textColor", "backgroundColor", "textAlignment"] as const;

/** blockContainer 只有一個空的 paragraph、沒有子 block、顏色與對齊都是預設值。有任何非預設屬性就不算空（使用者可能刻意設了格式）。 */
export function isEmptyParagraph(node: PMNode): boolean {
  if (node.type.name !== BLOCK_CONTAINER || node.childCount !== 1) return false;
  const content = node.firstChild!;
  if (content.type.name !== "paragraph" || content.content.size !== 0) return false;
  return DEFAULT_KEYS.every((key) => (content.attrs[key] ?? defaultProps[key].default) === defaultProps[key].default);
}

/** `pos` 落在任一個 `[起點, 終點)` 內。 */
export function insideAny(pos: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([from, to]) => pos >= from && pos < to);
}

/** X 恰好是列裡某一欄的全部 block → 那欄的 index；否則 -1。 */
function wholeColumnOf(row: PMNode, ids: readonly string[]): number {
  for (let i = 0; i < row.childCount; i++) {
    const col = row.child(i);
    if (col.childCount !== ids.length) continue;
    let same = true;
    col.forEach((block, _offset, j) => {
      if (block.attrs.id !== ids[j]) same = false;
    });
    if (same) return i;
  }
  return -1;
}

/**
 * 指標命中的 Y 與緣 → 建列／加欄，或 null（照現行橫線）。null 的情形：X 含列、X 有任一個 id 在當下文件找不到、
 * 頂層 Y 就是 X 之一或在 X 的子樹內、列已滿欄、以及「等於沒動」——X 恰好是某欄 C 的全部 block，而插入點緊鄰 C
 * （C 的左緣、C 的右緣、左鄰欄的右緣、右鄰欄的左緣），照做只會多一個空欄。
 * X 是目標欄的一部分（但不是全部）時照常出直線：結果是 X 從那欄移到旁邊的新欄。
 */
export function classifyEdge(doc: PMNode, dragged: DraggedBlocks, hit: EdgeHit): EdgeTarget | null {
  if (dragged.hasRows || dragged.ids.length === 0) return null;
  const ranges: Array<readonly [number, number]> = [];
  for (const id of dragged.ids) {
    const found = findNodeById(doc as unknown as PMNodeLike, id, BLOCK_CONTAINER);
    if (!found) return null;
    ranges.push([found.pos, found.pos + found.node.nodeSize]);
  }

  if (hit.kind === "top") {
    const y = doc.nodeAt(hit.yPos);
    const yId = y?.attrs.id;
    if (!y || y.type.name !== BLOCK_CONTAINER || doc.resolve(hit.yPos).depth !== 1 || typeof yId !== "string") return null;
    if (insideAny(hit.yPos, ranges)) return null;
    return { kind: "newRow", yId, side: hit.side, pos: hit.yPos };
  }

  const found = findNodeById(doc as unknown as PMNodeLike, hit.rowId, COLUMN_LIST_TYPE);
  if (!found) return null;
  const row = found.node as unknown as PMNode;
  if (insideAny(found.pos, ranges) || row.childCount >= COLUMNS_MAX) return null;
  if (hit.colIndex < 0 || hit.colIndex >= row.childCount) return null;
  const column = row.child(hit.colIndex);
  const columnId = column.attrs.id;
  if (typeof columnId !== "string") return null;

  const source = wholeColumnOf(row, dragged.ids);
  if (source >= 0) {
    const k = hit.colIndex;
    const noOp =
      (k === source && hit.side === "left") ||
      (k === source && hit.side === "right") ||
      (k === source - 1 && hit.side === "right") ||
      (k === source + 1 && hit.side === "left");
    if (noOp) return null;
  }

  let pos = found.pos + 1;
  for (let i = 0; i < hit.colIndex; i++) pos += row.child(i).nodeSize;
  return { kind: "addColumn", rowId: hit.rowId, columnId, side: hit.side, pos };
}

/** 同 prosemirror-view `browser.mac`（iOS／iPadOS 也算），但每次呼叫才讀 navigator。 */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const safari = /Apple Computer/.test(navigator.vendor);
  const ios = safari && (/Mobile\/\w+/.test(navigator.userAgent) || navigator.maxTouchPoints > 2);
  return ios || /Mac/.test(navigator.platform);
}

type PointerLike = { clientX: number; clientY: number; ctrlKey?: boolean; altKey?: boolean; synthetic?: boolean };

/** 同 PM 的 `dragMoves`：先問 `dragCopies` prop，沒人回答時看複製拖的修飾鍵（mac 是 Alt，其他是 Ctrl）。 */
function dragMoves(view: EditorView, event: PointerLike): boolean {
  let copy: boolean | undefined;
  view.someProp("dragCopies", (test) => {
    copy = copy || test(event as DragEvent);
  });
  return copy != null ? !copy : !event[isMac() ? "altKey" : "ctrlKey"];
}

type QualifiedY =
  | { kind: "top"; pos: number }
  | { kind: "column"; rowId: string; colIndex: number; colPos: number };

/**
 * 由 `pos` 往外找第一個合格的 blockContainer：頂層 block，或某欄的直接子 block（目標以那欄判定）。
 * 縮排子 block、表格格子本身不合格，落到它們最近的合格祖先。
 */
function qualifiedYAt(doc: PMNode, pos: number): QualifiedY | null {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d >= 2; d--) {
    if ($pos.node(d).type.name !== BLOCK_CONTAINER) continue;
    if (d === 2) return { kind: "top", pos: $pos.before(d) };
    if ($pos.node(d - 1).type.name === COLUMN_TYPE) {
      const rowId = $pos.node(d - 2).attrs.id;
      if (typeof rowId !== "string") return null;
      return { kind: "column", rowId, colIndex: $pos.index(d - 2), colPos: $pos.before(d - 1) };
    }
  }
  return null;
}

/**
 * 這次 dragover／drop 的直線目標；null＝照現行橫線。只看 dragstart 記下的 `dragged`，不讀當下選取：拖曳中途只要有遠端更新，
 * y-prosemirror 就會把多選還原成文字選取。
 *
 * 先擋：唯讀、不在拖曳中、沒有記下的 X、合成事件（core SideMenu 把框外的落點夾進框內再發一次，座標恰好落在左緣區）、複製拖。
 * 1. 指標在未堆疊列的 rect 內 → 以 x 定欄（不經 `posAtCoords`），溝 → null。
 * 2. 否則以 `posAtCoords` 找合格 Y：頂層 Y 的框是它的 `.bn-block-outer`（`nodeDOM(Y 之前)`），欄內 Y 的框是所在欄。
 * 3. 交給 `classifyEdge`。
 */
export function edgeTargetAt(view: EditorView, event: PointerLike, dragged: DraggedBlocks | null): EdgeTarget | null {
  if (!view.editable || view.dragging == null || dragged == null || event.synthetic === true) return null;
  if (!dragMoves(view, event)) return null;
  const { clientX: x, clientY: y } = event;
  const doc = view.state.doc;

  const inRow = columnAt(rowsOf(view), x, y);
  if (inRow) {
    if (inRow.colIndex === null) return null;
    const side = edgeSideOf(inRow.row.columns[inRow.colIndex]!, x);
    return side && classifyEdge(doc, dragged, { kind: "column", rowId: inRow.row.id, colIndex: inRow.colIndex, side });
  }

  let pos: number | undefined;
  try {
    pos = view.posAtCoords({ left: x, top: y })?.pos;
  } catch {
    return null;
  }
  if (pos === undefined) return null;
  const target = qualifiedYAt(doc, pos);
  if (!target) return null;
  const el = view.nodeDOM(target.kind === "top" ? target.pos : target.colPos);
  if (!(el instanceof HTMLElement)) return null;
  const side = edgeSideOf(el.getBoundingClientRect(), x);
  if (!side) return null;
  return target.kind === "top"
    ? classifyEdge(doc, dragged, { kind: "top", yPos: target.pos, side })
    : classifyEdge(doc, dragged, { kind: "column", rowId: target.rowId, colIndex: target.colIndex, side });
}
