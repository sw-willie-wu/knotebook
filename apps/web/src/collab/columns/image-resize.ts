/**
 * 欄內圖片的縮放把手。
 *
 * 原生把手（core `createResizableFileBlockWrapper`）不知道欄：上限是編輯器寬。欄內的把手改由這裡接手——在編輯器 DOM 上以
 * capture 攔下 `mousedown`／`touchstart` 並停止傳播，原生掛在把手元素上的 handler 就收不到。拖曳公式照原生（置中時位移乘 2），
 * 寬度夾在 [64, 欄內容寬]：不擴欄。只按一下不寫入；放開才寫一次 `previewWidth`，自成一個撤銷步（一次調寬）。
 * 不在欄內、或唯讀時不攔，原生照舊。
 */
import { COLUMN_TYPE } from "@knotebook/shared";
import type { BlockNoteEditor } from "@blocknote/core";
import { asUndoStep } from "./undo-step";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;

/** 同原生的下限。 */
const MIN_WIDTH_PX = 64;

const clientXOf = (event: MouseEvent | TouchEvent): number =>
  "touches" in event ? (event.touches[0] ?? event.changedTouches[0])?.clientX ?? 0 : event.clientX;

export function attachColumnImageResize(editor: AnyEditor, dom: HTMLElement, signal: AbortSignal): void {
  const onDown = (event: MouseEvent | TouchEvent) => {
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>(".bn-resize-handle") : null;
    if (!handle || !editor.isEditable) return;
    const column = handle.closest<HTMLElement>(`[data-node-type="${COLUMN_TYPE}"]`);
    const wrapper = handle.closest<HTMLElement>(".bn-file-block-content-wrapper");
    const id = wrapper?.closest(".bn-block-outer")?.getAttribute("data-id");
    if (!column || !wrapper || !id) return;
    event.stopPropagation();
    event.preventDefault();

    const block = editor.getBlock(id) as { props?: { textAlignment?: string } } | undefined;
    const factor = block?.props?.textAlignment === "center" ? 2 : 1;
    const fromLeft = handle.style.left !== "";
    const startX = clientXOf(event);
    const initial = wrapper.getBoundingClientRect().width;
    const max = column.clientWidth || Number.MAX_VALUE;
    let width = initial;
    let moved = false;

    const drag = new AbortController();
    signal.addEventListener("abort", () => drag.abort(), { once: true, signal: drag.signal });
    const onMove = (e: MouseEvent | TouchEvent) => {
      const delta = clientXOf(e) - startX;
      if (delta !== 0) moved = true;
      width = Math.min(Math.max(initial + (fromLeft ? -delta : delta) * factor, MIN_WIDTH_PX), max);
      wrapper.style.width = `${width}px`;
    };
    const onUp = () => {
      drag.abort();
      if (moved) asUndoStep(editor, () => editor.updateBlock(id, { props: { previewWidth: Math.round(width) } }));
    };
    window.addEventListener("mousemove", onMove, { signal: drag.signal });
    window.addEventListener("touchmove", onMove, { signal: drag.signal });
    window.addEventListener("mouseup", onUp, { signal: drag.signal });
    window.addEventListener("touchend", onUp, { signal: drag.signal });
  };
  dom.addEventListener("mousedown", onDown, { capture: true, signal });
  dom.addEventListener("touchstart", onDown, { capture: true, signal });
}
