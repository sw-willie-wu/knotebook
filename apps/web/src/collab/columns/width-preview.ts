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

/** `writeColumnWidths` 的 `since`：`next` 是從哪一組欄寬算出來的，以及哪幾欄是這次操作本身要改的。 */
export interface WidthsSince {
  /** 開始操作時文件裡的欄寬（與 `next` 同長）。 */
  base: readonly number[];
  /** 一定照 `next` 寫的欄（分隔線兩側那兩欄）。 */
  own: readonly number[];
}

/**
 * 把一列的欄寬寫進文件：只寫值有變的欄，加上可選的 `previewWidth`，全部在同一個 `editor.transact`。
 * 預設外包 `asUndoStep`（前後各 `stopCapturing`），自成一個撤銷步；鍵盤連按傳 `undoStep: false`，
 * 讓連按在 UndoManager 的合併時間窗內併成一步。列不在、欄數不同、或沒有任何變更時回 false 且不寫。
 *
 * `since`：操作期間文件可能被別人改過（拖分隔線時對方調了同一列的別條分隔線）。`own` 以外的欄，現值已經不等於 `base`
 * 的就不寫、保留別人的值；現值仍等於 `base` 的照 `next` 寫（總和不是欄數的列靠這個整列正規化，與預覽一致）。
 */
export function writeColumnWidths(
  editor: AnyEditor,
  rowId: string,
  next: readonly number[],
  opts: { previewWidth?: { blockId: string; value: number }; undoStep?: boolean; since?: WidthsSince } = {},
): boolean {
  const row = editor.getBlock(rowId) as { type?: string; children?: ColumnLike[] } | undefined;
  const columns = row?.children;
  if (!row || row.type !== COLUMN_LIST_TYPE || !columns || columns.length !== next.length) return false;
  const current = columns.map((c) => c.props?.width ?? 1);
  const since = opts.since;
  const changed = changedIndices(current, next).filter(
    (i) => !since || since.own.includes(i) || since.base[i] === current[i],
  );
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
