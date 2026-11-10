/**
 * 並排的版面規則：欄距、最小寬度與「整列堆疊」判斷。純函式，編輯器的堆疊外掛
 * （`layout-extension.ts`）與之後的簡報版面共用。
 *
 * ⚠ 三個像素常數與 `index.css` 的並排段落是同一份數值（`gap`、兩個 `min-width`），兩邊要一起改；`columns-css.guard.test.ts` 比對。
 * 數值來源：96／200 來自 UI 稿，24 是設計值（不是量測值）。
 */
import { COLUMN_TYPE } from "@knotebook/shared";

export const COLUMN_GAP_PX = 24;
export const COLUMN_MIN_TEXT_PX = 200;
export const COLUMN_MIN_IMAGE_PX = 96;

export type ColumnKind = "image" | "text";

/** 只取用得到的欄位——PM 的 Node 型別在 apps/web 值層級拿不到（見 `pm-plugin.ts`）。 */
export interface PMNodeLike {
  type: { name: string };
  attrs: Record<string, unknown>;
  childCount: number;
  firstChild: PMNodeLike | null;
  nodeSize: number;
  forEach(f: (node: PMNodeLike, offset: number) => void): void;
}

/**
 * 欄的每個直接 block 都是顯示預覽的圖片、且沒有子 block → `"image"`；其餘（含空欄、圖片底下縮排了文字、`showPreview:false`
 * 的圖片——畫成檔案列，簡報也匯出成 `<a>`）→ `"text"`。
 */
export function columnKindOf(column: PMNodeLike): ColumnKind {
  if (column.type.name !== COLUMN_TYPE || column.childCount === 0) return "text";
  let allImages = true;
  column.forEach((container) => {
    const content = container.firstChild;
    if (container.childCount !== 1 || content?.type.name !== "image" || content.attrs.showPreview === false) allImages = false;
  });
  return allImages ? "image" : "text";
}

export function columnMinWidth(kind: ColumnKind): number {
  return kind === "image" ? COLUMN_MIN_IMAGE_PX : COLUMN_MIN_TEXT_PX;
}

/** 各欄最小寬度總和＋溝寬總和 > available → 整列堆疊；available ≤ 0（未排版）→ false。 */
export function shouldStack(kinds: readonly ColumnKind[], available: number, gap: number = COLUMN_GAP_PX): boolean {
  if (!(available > 0)) return false;
  const needed = kinds.reduce((sum, kind) => sum + columnMinWidth(kind), 0) + gap * Math.max(0, kinds.length - 1);
  return needed > available;
}
