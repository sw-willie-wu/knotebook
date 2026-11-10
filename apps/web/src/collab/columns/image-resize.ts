/**
 * 欄內圖片的縮放把手。
 *
 * 原生把手（core `createResizableFileBlockWrapper`）不知道欄：上限是編輯器寬。欄內的把手改由這裡接手——在編輯器 DOM 上以
 * capture 攔下 `mousedown`／`touchstart` 並停止傳播，原生掛在把手元素上的 handler 就收不到。拖曳公式照原生（置中時位移乘 2、
 * 左把手反向），寬度夾在 [64, 4000]。不在欄內、或唯讀時不攔，原生照舊。
 *
 * - 可用寬 `Ck`＝圖片所在 block 的內容框寬（縮排子 block 裡的圖比欄窄）。拉到 `Ck` 以內只改圖。
 * - 拉超過 `Ck`：其他欄依各自超出最小寬度的餘裕比例讓出差額，餘裕用完就拉不動；欄寬只在預覽樣式表裡變（`createWidthPreview`）。
 * - 堆疊的列：欄寬就是列寬，上限＝列寬、不動欄。縮小圖片從不縮欄。
 * - 放開時以放開那一筆的位置再算一次：沒有位移不寫；否則 `previewWidth` 與有變的欄寬在同一個交易、自成一個撤銷步。
 * - Esc、`touchcancel`、卸載、拖曳中列的欄 id 序列變了（或圖片不在了）都會取消：不寫、清預覽、圖寬回到按下前。放開時已唯讀也不寫。
 */
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import type { BlockNoteEditor } from "@blocknote/core";
import { columnKindOf, columnMinWidth, type PMNodeLike } from "./layout";
import { findNodeById } from "./position";
import { asUndoStep } from "./undo-step";
import { createWidthPreview, writeColumnWidths } from "./width-preview";
import { expandColumnPixels, ratiosFromPixels } from "./widths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;

/** 同原生的下限。 */
const MIN_WIDTH_PX = 64;
/** `previewWidth` 能寫進文件、經 markdown 原樣寫回也不被拒的上限。 */
const MAX_WIDTH_PX = 4000;
/** 堆疊外掛（`layout-extension.ts` 的 `STACKED_ATTR`）掛在列上的屬性；不從那裡 import，那個檔 import 本檔，會成環。 */
const STACKED_SELECTOR = "[data-stacked]";

const clientXOf = (event: MouseEvent | TouchEvent): number =>
  "touches" in event ? (event.touches[0] ?? event.changedTouches[0])?.clientX ?? 0 : event.clientX;

/** 按下時量到的那一列：欄 id、各欄像素寬與最小寬度、圖片在第幾欄。 */
interface RowAtStart {
  rowId: string;
  columnIds: string[];
  px: number[];
  mins: number[];
  k: number;
}

function measureRow(editor: AnyEditor, rowEl: HTMLElement, column: HTMLElement): RowAtStart | null {
  const rowId = rowEl.getAttribute("data-id");
  if (!rowId) return null;
  const columnEls = Array.from(rowEl.children).filter((el): el is HTMLElement => el.getAttribute("data-node-type") === COLUMN_TYPE);
  const columnIds = columnEls.map((el) => el.getAttribute("data-id") ?? "");
  const k = columnEls.indexOf(column);
  if (k < 0 || columnIds.some((id) => !id)) return null;
  const hit = findNodeById(editor.prosemirrorState.doc as never, rowId, COLUMN_LIST_TYPE);
  if (!hit || hit.node.childCount !== columnEls.length) return null;
  const mins: number[] = [];
  (hit.node as unknown as PMNodeLike).forEach((col) => mins.push(columnMinWidth(columnKindOf(col))));
  return { rowId, columnIds, px: columnEls.map((el) => el.getBoundingClientRect().width), mins, k };
}

/** 文件裡這一列目前的欄 id；列不在（或不是並排列）→ null。 */
function columnIdsInDoc(editor: AnyEditor, rowId: string): string[] | null {
  const row = editor.getBlock(rowId) as { type?: string; children?: { id: string }[] } | undefined;
  if (!row || row.type !== COLUMN_LIST_TYPE || !row.children) return null;
  return row.children.map((c) => c.id);
}

const sameIds = (a: readonly string[] | null, b: readonly string[]) => !!a && a.length === b.length && a.every((id, i) => id === b[i]);

export function attachColumnImageResize(editor: AnyEditor, dom: HTMLElement, signal: AbortSignal): void {
  const onDown = (event: MouseEvent | TouchEvent) => {
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>(".bn-resize-handle") : null;
    if (!handle || !editor.isEditable) return;
    const column = handle.closest<HTMLElement>(`[data-node-type="${COLUMN_TYPE}"]`);
    const wrapper = handle.closest<HTMLElement>(".bn-file-block-content-wrapper");
    const content = wrapper?.closest<HTMLElement>(".bn-block-content");
    const id = wrapper?.closest(".bn-block-outer")?.getAttribute("data-id");
    const rowEl = column?.parentElement?.closest<HTMLElement>(`[data-node-type="${COLUMN_LIST_TYPE}"]`);
    const row = column && rowEl ? measureRow(editor, rowEl, column) : null;
    if (!column || !wrapper || !content || !id || !rowEl || !row) return;
    event.stopPropagation();
    event.preventDefault();

    const block = editor.getBlock(id) as { props?: { textAlignment?: string } } | undefined;
    const factor = block?.props?.textAlignment === "center" ? 2 : 1;
    const fromLeft = handle.style.left !== "";
    const startX = clientXOf(event);
    const initial = wrapper.getBoundingClientRect().width;
    const styleWidthBefore = wrapper.style.width;
    const stacked = rowEl.closest(STACKED_SELECTOR) !== null;
    // 堆疊時欄寬＝列寬；未排版（0）時不設上限，同原生。
    const stackedMax = rowEl.clientWidth || Number.MAX_VALUE;
    const ck = content.clientWidth;
    const preview = createWidthPreview(dom.ownerDocument);
    let width = initial;
    /** 最近一次算出的整列欄比例；沒有擴欄時是 null。 */
    let next: number[] | null = null;
    let moved = false;

    const apply = (clientX: number) => {
      const delta = clientX - startX;
      if (delta !== 0) moved = true;
      let w = Math.min(Math.max(initial + (fromLeft ? -delta : delta) * factor, MIN_WIDTH_PX), MAX_WIDTH_PX);
      next = null;
      if (stacked) w = Math.min(w, stackedMax);
      else if (w > ck) {
        const need = w - ck;
        const grown = expandColumnPixels(row.px, row.mins, row.k, need);
        if (grown.granted < need) w = ck + grown.granted;
        if (grown.granted > 0) next = ratiosFromPixels(grown.px);
      }
      width = w;
      wrapper.style.width = `${w}px`;
      if (next) preview.set({ columnIds: row.columnIds, grows: next });
      else preview.clear();
    };

    const drag = new AbortController();
    /**
     * 結束拖曳：`commit` 為 true、有位移、仍可編輯才寫；一律清預覽。列的欄 id 序列變了或圖片不在了，文件一變就由下面的
     * `onChange` 取消，走不到這裡的寫入。
     */
    const finish = (commit: boolean) => {
      if (drag.signal.aborted) return;
      drag.abort();
      offChange?.();
      if (commit && moved && editor.isEditable) {
        const value = Math.round(width);
        // 沒有擴欄、或算出的比例與文件現值相同時 `writeColumnWidths` 不寫，改成只寫 `previewWidth`（同樣自成一個撤銷步）。
        if (!(next && writeColumnWidths(editor, row.rowId, next, { previewWidth: { blockId: id, value } }))) {
          asUndoStep(editor, () => editor.updateBlock(id, { props: { previewWidth: value } }));
        }
      } else {
        // 沒寫入（取消、或只按一下）：`apply` 已經把 inline 寬設成量到的顯示寬，要還原，否則圖片停在被擠窄的寬度。
        wrapper.style.width = styleWidthBefore;
      }
      preview.clear();
    };

    // 拖曳中文件變了（例如另一端刪了一欄）：量到的欄寬已不對，取消。
    const offChange = editor.onChange(() => {
      if (!sameIds(columnIdsInDoc(editor, row.rowId), row.columnIds) || !editor.getBlock(id)) finish(false);
    }) as (() => void) | undefined;
    signal.addEventListener("abort", () => finish(false), { once: true, signal: drag.signal });
    const listen = { signal: drag.signal };
    const onMove = (e: MouseEvent | TouchEvent) => apply(clientXOf(e));
    // 放開那一筆的位置不一定有 move 報過，所以先以它再算一次。
    const onUp = (e: MouseEvent | TouchEvent) => {
      apply(clientXOf(e));
      finish(true);
    };
    window.addEventListener("mousemove", onMove, listen);
    window.addEventListener("touchmove", onMove, listen);
    window.addEventListener("mouseup", onUp, listen);
    window.addEventListener("touchend", onUp, listen);
    window.addEventListener("touchcancel", () => finish(false), listen);
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      },
      { ...listen, capture: true },
    );
  };
  dom.addEventListener("mousedown", onDown, { capture: true, signal });
  dom.addEventListener("touchstart", onDown, { capture: true, signal });
}
