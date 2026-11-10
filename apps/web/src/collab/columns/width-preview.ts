import { COLUMN_LIST_TYPE } from "@knotebook/shared";
import type { BlockNoteEditor } from "@blocknote/core";
import { changedIndices } from "./widths";
import { asUndoStep } from "./undo-step";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;

export interface WidthPreview {
  /** 整列每一欄的 flex-grow 預覽；每次呼叫都整張重寫。 */
  set(row: { columnIds: readonly string[]; grows: readonly number[] }): void;
  /** 移除預覽表；沒有預覽時呼叫也不丟例外。 */
  clear(): void;
}

/**
 * 拖曳期間的欄寬預覽：只改一張 `<style>`，不碰 ProseMirror 管的 DOM、不產生交易。
 * 直接改欄元素的 style 不會有交易，PM 之後會把它重繪回文件的值。表在第一次 `set` 才插進 head。
 */
export function createWidthPreview(doc: Document): WidthPreview {
  let style: HTMLStyleElement | null = null;
  const css = doc.defaultView?.CSS ?? CSS;
  const esc = (id: string) => css.escape(id);
  return {
    set({ columnIds, grows }) {
      if (grows.length !== columnIds.length) return;
      if (!style) {
        style = doc.createElement("style");
        style.setAttribute("data-kb-col-preview", "");
        doc.head.appendChild(style);
      }
      style.textContent = columnIds
        .map(
          (id, i) =>
            `.bn-editor [data-node-type="column"][data-id="${esc(id)}"] { flex-grow: ${grows[i]} !important; }`,
        )
        .join("\n");
    },
    clear() {
      style?.remove();
      style = null;
    },
  };
}

interface ColumnLike {
  id: string;
  props?: { width?: number };
}

/**
 * 把一列的欄寬寫進文件：只寫值有變的欄，加上可選的 `previewWidth`，全部在同一個 `editor.transact`。
 * 預設外包 `asUndoStep`（前後各 `stopCapturing`），自成一個撤銷步；鍵盤連按傳 `undoStep: false`，
 * 讓連按在 UndoManager 的合併時間窗內併成一步。列不在、欄數不同、或沒有任何變更時回 false 且不寫。
 */
export function writeColumnWidths(
  editor: AnyEditor,
  rowId: string,
  next: readonly number[],
  opts: { previewWidth?: { blockId: string; value: number }; undoStep?: boolean } = {},
): boolean {
  const row = editor.getBlock(rowId) as { type?: string; children?: ColumnLike[] } | undefined;
  const columns = row?.children;
  if (!row || row.type !== COLUMN_LIST_TYPE || !columns || columns.length !== next.length) return false;
  const current = columns.map((c) => c.props?.width ?? 1);
  const changed = changedIndices(current, next);
  if (changed.length === 0) return false;
  const write = () =>
    editor.transact(() => {
      for (const i of changed) editor.updateBlock(columns[i]!.id, { props: { width: next[i]! } });
      if (opts.previewWidth) editor.updateBlock(opts.previewWidth.blockId, { props: { previewWidth: opts.previewWidth.value } });
    });
  if (opts.undoStep === false) write();
  else asUndoStep(editor, write);
  return true;
}
