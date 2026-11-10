/**
 * ⋮⋮ 拖曳的 X 在 dragstart 那一刻記下（per-view），dragover／drop 一律讀這份記錄，不讀當下選取：拖曳中途只要有遠端更新，
 * y-prosemirror 就會把多選還原成文字選取，看當下選取的判準會悄悄失效。
 *
 * - 監聽 `document` 的 bubble `dragstart`：core 的 ⋮⋮ 與 SideMenu 根層的 dragstart 都已跑完，選取已設成被拖的 block。
 * - 只記可編輯、事件來源在這顆編輯器容器內（`editor.domElement.parentElement`，同 core `isWithinEditor` 與 tiptap PasteRule
 *   的判準）且沒被 `preventDefault` 的 dragstart；其他 dragstart 一律記 null。被取消的 dragstart 不會開始拖放，之後也不會有
 *   dragend，若照記，舊的 X 會一直留著，下一次外部拖入就會被當成 ⋮⋮ 拖曳。
 * - 清除：`document` capture `dragend`、下一次 dragstart 覆寫，以及 drop handler 串接跑完時由呼叫端 `clearDraggedBlocks`。
 *   不在 capture `drop` 清：capture 先於 `view.dom` 上的 drop handler，清了 `handleDrop` 就讀不到；在那裡排 microtask 也不行，
 *   原生事件的 microtask 在每個 listener 之間就會跑。
 */
import type { BlockNoteEditor } from "@blocknote/core";
import type { EditorView } from "prosemirror-view";
import { draggedFromSelection, type DraggedBlocks } from "./drag-geometry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;

const recorded = new WeakMap<EditorView, DraggedBlocks | null>();

/** `dom` 是編輯器掛載的元素（extension `mount` 的參數）；判斷來源用 `editor.domElement.parentElement`，React 下就是 `bn-container`。 */
export function attachDragSourceRecorder(editor: AnyEditor, dom: HTMLElement, signal: AbortSignal): void {
  document.addEventListener(
    "dragstart",
    (event) => {
      const view = editor.prosemirrorView as EditorView | undefined;
      if (!view) return;
      const inside = !!editor.domElement?.parentElement?.contains(event.target as Node);
      recorded.set(view, editor.isEditable && inside && !event.defaultPrevented ? draggedFromSelection(view.state.selection) : null);
    },
    { signal },
  );
  document.addEventListener(
    "dragend",
    () => {
      const view = editor.prosemirrorView as EditorView | undefined;
      if (view) clearDraggedBlocks(view);
    },
    { capture: true, signal },
  );
}

export function draggedBlocksOf(view: EditorView): DraggedBlocks | null {
  return recorded.get(view) ?? null;
}

export function clearDraggedBlocks(view: EditorView): void {
  recorded.delete(view);
}
