import { useEffect } from "react";

/** 任何拖放進行中掛在 `columnEl` 上；`index.css` 以它關掉編輯器外浮層（⋮⋮、分隔線）的指標命中。 */
export const DRAG_ACTIVE_CLASS = "kb-dragging";

/**
 * 拖放進行中在 `columnEl` 掛 {@link DRAG_ACTIVE_CLASS}。⋮⋮ 與分隔線都在 `view.dom` 外，沒有元素對 dragover 呼叫 `preventDefault`，
 * 指標停在它們上面時 drop 不被接受（站內拖曳失效，外部檔案被瀏覽器直接開啟）；關掉命中後事件落到底下的編輯器。
 *
 * - 加：`document` capture 的 `dragenter`。作業系統或別的視窗拖進來的內容不會在本文件觸發 dragstart，只聽 dragstart 攔不到。
 *   `dragover`（拖曳中持續觸發）也加：中途若有一筆 `pointermove` 把 class 誤清，下一次 dragover 就補回來。
 * - 清：`document` capture 的 `drop`、`dragend`，以及 class 在時的第一個 `pointermove`——HTML5 拖放期間瀏覽器不送指標移動事件，
 *   出現就代表拖放已結束（包括拖出視窗、沒有放下）。不聽 `dragleave`：新元素的 dragenter 先於舊元素的 dragleave，
 *   `relatedTarget` 在各瀏覽器不一定有值，誤判一次就會在拖曳中途拿掉 class。
 * - 卸載或 `columnEl` 換掉時移除監聽、清掉 class。
 */
export function useDragActiveClass(columnEl: HTMLElement | null): void {
  useEffect(() => {
    if (!columnEl) return;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    const add = () => columnEl.classList.add(DRAG_ACTIVE_CLASS);
    const remove = () => columnEl.classList.remove(DRAG_ACTIVE_CLASS);
    document.addEventListener("dragenter", add, options);
    document.addEventListener("dragover", add, options);
    document.addEventListener("drop", remove, options);
    document.addEventListener("dragend", remove, options);
    document.addEventListener(
      "pointermove",
      () => {
        if (columnEl.classList.contains(DRAG_ACTIVE_CLASS)) remove();
      },
      options,
    );
    return () => {
      controller.abort();
      remove();
    };
  }, [columnEl]);
}
