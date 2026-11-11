/**
 * 直線放置與「放進空欄」的插入步驟。同一支函式先在預測的文件（只移除 X 之後的 state）上跑一次驗證，再在實際文件上跑一次；
 * 目標一律以 id 重找，兩次得到的步驟位置相同。
 *
 * 獨立成一個模組：`edge-drop.ts` 經模組 import 呼叫它，測試才能 `vi.spyOn` 攔到這兩次呼叫（同模組內的呼叫走區域綁定，攔不到）。
 */
import { COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMNS_MAX } from "@knotebook/shared";
import type { EditorView } from "prosemirror-view";
import { isEmptyParagraph, type EdgeSide } from "./drag-geometry";
import { findNodeById, type PMNodeLike } from "./position";
import { changedIndices } from "./widths";

type PMNode = EditorView["state"]["doc"];
type Transaction = EditorView["state"]["tr"];
type PMSelection = EditorView["state"]["selection"];

const BLOCK_CONTAINER = "blockContainer";

export type InsertPlan =
  /** 頂層 Y 換成新列：左緣 `[X｜Y]`、右緣 `[Y｜X]`；`widths` 依結果的欄序。 */
  | { kind: "newRow"; yId: string; side: EdgeSide; xNodes: PMNode[]; widths: [number, number] }
  /** 在列的某欄左／右插入裝著 X 的新欄；`widths` 是結果整列的欄寬（含新欄）。 */
  | { kind: "addColumn"; rowId: string; columnId: string; side: EdgeSide; xNodes: PMNode[]; widths: number[] }
  /** 欄裡唯一的空段落換成 X（`xNodes` 已攤平成 blockContainer）。 */
  | { kind: "replaceEmpty"; columnId: string; emptyId: string; xNodes: PMNode[] };

const find = (doc: PMNode, id: string, type: string): { node: PMNode; pos: number } | null =>
  findNodeById(doc as unknown as PMNodeLike, id, type) as { node: PMNode; pos: number } | null;

interface SelectionStatics {
  findFrom(pos: unknown, dir: number, textOnly?: boolean): PMSelection | null;
}

/** 選取的基底類別（`Selection`）：apps/web 拿不到 prosemirror-state 的值，從當下選取的原型鏈往上找。 */
export function selectionBase(sel: PMSelection): SelectionStatics {
  let ctor = sel.constructor as unknown as object;
  for (let parent = Object.getPrototypeOf(ctor); parent && parent !== Function.prototype; parent = Object.getPrototypeOf(ctor)) ctor = parent;
  return ctor as SelectionStatics;
}

/** `pos` 往後（找不到再往前）最近的文字選取。 */
export function textSelectionNear(sel: PMSelection, $pos: unknown): PMSelection | null {
  const base = selectionBase(sel);
  return base.findFrom($pos, 1, true) ?? base.findFrom($pos, -1, true);
}

/**
 * 游標放在 `pos`（第一個 X 的 blockContainer 之前）之後的第一個文字位置：文字 block 就是它的內容開頭。一律用文字選取、不用
 * NodeSelection（圖片這類沒有文字內容的 X 會落到下一個文字 block）。
 */
function selectStart(tr: Transaction, pos: number): void {
  const sel = textSelectionNear(tr.selection, tr.doc.resolve(pos + 1));
  if (sel) tr.setSelection(sel);
}

const allBlocks = (nodes: readonly PMNode[]): boolean => nodes.length > 0 && nodes.every((n) => n.type.name === BLOCK_CONTAINER);

function newRow(tr: Transaction, plan: Extract<InsertPlan, { kind: "newRow" }>): boolean {
  const y = find(tr.doc, plan.yId, BLOCK_CONTAINER);
  if (!y || tr.doc.resolve(y.pos).depth !== 1 || !allBlocks(plan.xNodes)) return false;
  const { nodes } = tr.doc.type.schema;
  const xFirst = plan.side === "left";
  const [w0, w1] = plan.widths;
  const xCol = nodes[COLUMN_TYPE]!.createChecked({ width: xFirst ? w0 : w1 }, plan.xNodes);
  const yCol = nodes[COLUMN_TYPE]!.createChecked({ width: xFirst ? w1 : w0 }, y.node);
  const row = nodes[COLUMN_LIST_TYPE]!.createChecked(null, xFirst ? [xCol, yCol] : [yCol, xCol]);
  tr.replaceWith(y.pos, y.pos + y.node.nodeSize, row);
  // 文件結尾的列用鍵盤出不去，後面補一個空段落（同 `/grid`）。
  const after = y.pos + row.nodeSize;
  const $after = tr.doc.resolve(after);
  if ($after.index() === $after.parent.childCount) {
    tr.insert(after, nodes[BLOCK_CONTAINER]!.createChecked(null, nodes["paragraph"]!.create()));
  }
  const xColPos = xFirst ? y.pos + 1 : y.pos + 1 + yCol.nodeSize;
  selectStart(tr, xColPos + 1);
  return true;
}

function addColumn(tr: Transaction, plan: Extract<InsertPlan, { kind: "addColumn" }>): boolean {
  const found = find(tr.doc, plan.rowId, COLUMN_LIST_TYPE);
  if (!found || !allBlocks(plan.xNodes)) return false;
  const row = found.node;
  if (row.childCount >= COLUMNS_MAX || plan.widths.length !== row.childCount + 1) return false;
  let colPos = found.pos + 1;
  let k = -1;
  for (let i = 0; i < row.childCount; i++) {
    if (row.child(i).attrs.id === plan.columnId) {
      k = i;
      break;
    }
    colPos += row.child(i).nodeSize;
  }
  if (k < 0) return false;
  const newIndex = plan.side === "left" ? k : k + 1;
  const insertPos = plan.side === "left" ? colPos : colPos + row.child(k).nodeSize;
  const before: number[] = [];
  row.forEach((col) => void before.push(col.attrs.width as number));
  const existingAfter = plan.widths.filter((_, i) => i !== newIndex);
  const { nodes } = tr.doc.type.schema;
  const newCol = nodes[COLUMN_TYPE]!.createChecked({ width: plan.widths[newIndex] }, plan.xNodes);
  tr.insert(insertPos, newCol);
  // 只改值有變的既有欄（屬性變更，不重建欄的子樹）。插入不改列的起點，以列的 id 重新走一遍算位置。
  const changed = new Set(changedIndices(before, existingAfter));
  if (changed.size > 0) {
    const rowAfter = tr.doc.nodeAt(found.pos)!;
    let pos = found.pos + 1;
    for (let i = 0, j = 0; i < rowAfter.childCount; i++) {
      const col = rowAfter.child(i);
      if (i !== newIndex) {
        if (changed.has(j)) tr.setNodeAttribute(pos, "width", existingAfter[j]);
        j++;
      }
      pos += col.nodeSize;
    }
  }
  selectStart(tr, insertPos + 1);
  return true;
}

function replaceEmpty(tr: Transaction, plan: Extract<InsertPlan, { kind: "replaceEmpty" }>): boolean {
  const found = find(tr.doc, plan.columnId, COLUMN_TYPE);
  if (!found || !allBlocks(plan.xNodes)) return false;
  const column = found.node;
  const empty = column.firstChild;
  if (column.childCount !== 1 || !empty || empty.attrs.id !== plan.emptyId || !isEmptyParagraph(empty)) return false;
  const from = found.pos + 1;
  tr.replaceWith(from, from + empty.nodeSize, plan.xNodes);
  selectStart(tr, from);
  return true;
}

/** 把插入步驟加到 `tr`、設好游標。目標不見、不再合法或組步驟時丟例外 → false（此時 `tr` 可能已有部分步驟，呼叫端要丟掉它）。 */
export function buildInsert(tr: Transaction, plan: InsertPlan): boolean {
  try {
    if (plan.kind === "newRow") return newRow(tr, plan);
    if (plan.kind === "addColumn") return addColumn(tr, plan);
    return replaceEmpty(tr, plan);
  } catch {
    return false;
  }
}
