import { mapTableCell, TableHandlesExtension, type BlockNoteEditor, type TableContent } from "@blocknote/core";
import { canonicalColor } from "@knotebook/shared";
import { ensureCustomColor } from "@/lib/custom-colors";
import { sectionProp, type ColorSection, type ColorTarget } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組走 repo 慣例
type AnyEditor = BlockNoteEditor<any, any, any>;

type TableTarget = Extract<ColorTarget, { kind: "cell" | "rowcol" }>;

/**
 * 表格儲存格或整列／整欄：每次都在套用當下讀最新的 block 再重建 rows，
 * 這樣共編者在面板開著時改的字不會被舊內容蓋掉。
 */
function applyToTable(editor: AnyEditor, prop: "textColor" | "backgroundColor", target: TableTarget, canon: string): boolean {
  const block = editor.getBlock(target.blockId);
  if (!block || block.type !== "table") return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 表格內容的泛型走 repo 慣例
  const content = block.content as TableContent<any, any>;
  const rows = content.rows.map((r) => ({ ...r, cells: r.cells.map((c) => mapTableCell(c)) }));
  let coords: { row: number; col: number }[];
  if (target.kind === "cell") {
    if (!rows[target.rowIndex]?.cells[target.colIndex]) return false;
    coords = [{ row: target.rowIndex, col: target.colIndex }];
  } else {
    const handles = editor.getExtension(TableHandlesExtension);
    if (!handles) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- block 泛型與 getCellsAt* 的參數型別不同
    const hit = target.orientation === "row" ? handles.getCellsAtRowHandle(block as any, target.index) : handles.getCellsAtColumnHandle(block as any, target.index);
    coords = hit.filter((h) => rows[h.row]?.cells[h.col]).map((h) => ({ row: h.row, col: h.col }));
  }
  if (coords.length === 0) return false;
  if (canon.startsWith("#")) ensureCustomColor("block", prop, canon);
  for (const { row, col } of coords) {
    const cell = rows[row]!.cells[col]!;
    cell.props = { ...cell.props, [prop]: canon };
  }
  editor.updateBlock(block, { type: "table", content: { ...content, rows } });
  editor.setTextCursorPosition(block);
  return true;
}

/**
 * 把顏色套到選取的行內文字或指定的 block。block 目標回 true 表示已寫入；值不是合法顏色、block 已不存在、
 * 或該種 block 沒有這個 prop 時回 false。儲存格與整列／整欄目標在 block 不是表格、或索引超出目前的列／欄範圍時也回 false。
 * 行內目標回 true 只表示已對目前選取送出套色（不檢查選取是否接受樣式）。不在這裡 focus。
 * 規則種類依實際套用的位置登記：行內只登記行內規則，block 與儲存格目標只登記 block 規則。
 */
export function applyColor(editor: AnyEditor, section: ColorSection, target: ColorTarget, value: string): boolean {
  const canon = canonicalColor(value);
  if (canon === null) return false;
  const prop = sectionProp(section);
  if (target.kind === "cell" || target.kind === "rowcol") return applyToTable(editor, prop, target, canon);
  if (target.kind === "block") {
    const block = editor.getBlock(target.blockId);
    // 該種 block 沒有這個 prop（例如 codeBlock 沒有 backgroundColor）時 updateBlock 不會寫入，這裡也不登記規則。
    if (!block || !(prop in block.props)) return false;
  }
  if (canon.startsWith("#")) ensureCustomColor(target.kind === "inline" ? "inline" : "block", prop, canon);
  if (target.kind === "inline") {
    if (canon === "default") editor.removeStyles({ [prop]: canon });
    else editor.addStyles({ [prop]: canon });
    return true;
  }
  editor.updateBlock(target.blockId, { props: { [prop]: canon } });
  return true;
}
