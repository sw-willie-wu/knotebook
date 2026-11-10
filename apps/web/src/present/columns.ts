import { shouldStack, type ColumnKind } from "@/collab/columns/layout";

/**
 * 簡報投影片裡的並排：依投影片內容寬標記要堆疊的列，規則與常數同編輯器（`layout.ts`）。
 * 只寫 `data-stacked`、不寫 style；樣式在 present.css。只在渲染時量（controller 的三個呼叫點），不跟視窗縮放重算。
 */
const ROW_SELECTOR = "[data-kb-columns]";
const COLUMN_SELECTOR = ":scope > [data-kb-column]";
const STACKED_ATTR = "data-stacked";

function columnKind(column: Element): ColumnKind {
  const children = Array.from(column.children);
  return children.length > 0 && children.every((child) => child.matches("figure, img")) ? "image" : "text";
}

/** 依投影片內容寬標記要堆疊的列（同編輯器的規則與常數）。欄的種類：直接子元素全是 figure／img → image。availableWidth ≤ 0 → 不動。 */
export function markStackedColumnRows(root: ParentNode, availableWidth: number): void {
  if (!(availableWidth > 0)) return;
  for (const row of Array.from(root.querySelectorAll(ROW_SELECTOR))) {
    const kinds = Array.from(row.querySelectorAll(COLUMN_SELECTOR)).map(columnKind);
    row.toggleAttribute(STACKED_ATTR, shouldStack(kinds, availableWidth));
  }
}

/** 對一張投影片的 body 量寬再標：body 必須已掛在文件上（isConnected），否則不動。 */
export function restackSlideBody(body: HTMLElement): void {
  if (!body.isConnected) return;
  markStackedColumnRows(body, body.clientWidth);
}
