import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";

/**
 * 並排排版的位置判斷（純函式；`edge-keymap.ts` 用，驗證與拖放也會用）。
 * PM 的 Node／ResolvedPos 型別在 apps/web 值層級拿不到，這裡用只列出用得到欄位的寬鬆型別。
 */

export interface PMNodeLike {
  type: { name: string };
  attrs: { readonly [key: string]: unknown };
  childCount: number;
  nodeSize: number;
  firstChild: PMNodeLike | null;
  lastChild: PMNodeLike | null;
  child(index: number): PMNodeLike;
  isTextblock: boolean;
  descendants(f: (node: PMNodeLike, pos: number) => boolean | void): void;
}

export interface ResolvedPosLike {
  depth: number;
  node(depth?: number): PMNodeLike;
  index(depth?: number): number;
  before(depth?: number): number;
}

/** 位置是否在頂層：$pos 的祖先（depth ≥ 2）中沒有 column、columnList、或非根 blockGroup。 */
export function isTopLevelPosition($pos: ResolvedPosLike): boolean {
  for (let d = 2; d <= $pos.depth; d++) {
    const name = $pos.node(d).type.name;
    if (name === COLUMN_TYPE || name === COLUMN_LIST_TYPE || name === "blockGroup") return false;
  }
  return true;
}

export interface ColumnContext {
  listDepth: number;
  colDepth: number;
  /** columnList 節點起點（`$pos.before(listDepth)`）。 */
  listPos: number;
  colIndex: number;
  blockIndex: number;
  list: PMNodeLike;
  col: PMNodeLike;
  block: PMNodeLike;
}

/** 游標所在的「欄的直接子 block」：$pos.depth === colDepth + 2（在該 block 的 blockContent 內）才回，否則 null。 */
export function columnContextOf($pos: ResolvedPosLike): ColumnContext | null {
  let colDepth = -1;
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === COLUMN_TYPE) {
      colDepth = d;
      break;
    }
  }
  if (colDepth < 0 || $pos.depth !== colDepth + 2) return null;
  const listDepth = colDepth - 1;
  const col = $pos.node(colDepth);
  const blockIndex = $pos.index(colDepth);
  return {
    listDepth,
    colDepth,
    listPos: $pos.before(listDepth),
    colIndex: $pos.index(listDepth),
    blockIndex,
    list: $pos.node(listDepth),
    col,
    block: col.child(blockIndex),
  };
}

/** 全文走訪（命中後只剪子樹、兄弟照走）：只在按鍵條件成立時跑，文件大小下可接受。 */
export function findNodeById(doc: PMNodeLike, id: string, type?: string): { node: PMNodeLike; pos: number } | null {
  let hit: { node: PMNodeLike; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.attrs.id === id && (!type || node.type.name === type)) {
      hit = { node, pos };
      return false;
    }
  });
  return hit;
}
