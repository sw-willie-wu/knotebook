import type { FC, MouseEvent } from "react";
import { mapTableCell } from "@blocknote/core";
import { TableHandlesExtension } from "@blocknote/core/extensions";
import {
  AddButton,
  DeleteButton,
  TableCellButton,
  TableHandle,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtension,
  useExtensionState,
  type TableCellButtonProps,
  type TableHandleProps,
} from "@blocknote/react";
import { applyColor } from "./apply-color";
import { ColorMenuBody, useColorMenu } from "./ColorMenuBody";
import { KnotebookColorPicker, type ColorSectionProps } from "./KnotebookColorPicker";
import { sectionProp, type ColorSection, type ColorTarget } from "./types";

/** 從面板按「返回」時要聚焦的項目（顏色子選單的觸發項）。儲存格選單與列／欄選單不會同時開，共用一個值。 */
const RETURN_KEY = "tbl-colors";

type TableTarget = Extract<ColorTarget, { kind: "cell" | "rowcol" }>;

function useTableHandlesState() {
  return useExtensionState(TableHandlesExtension, {
    selector: (s) => ({ block: s?.block, rowIndex: s?.rowIndex, colIndex: s?.colIndex }),
  });
}

/**
 * 「Colors」子選單：10 種內建色加「自訂…」，點「自訂…」把根選單的 dropdown 換成面板（須放在 `ColorMenuBody` 裡）。
 * 文字段、底色段各依編輯器的 `tables.cellTextColor`／`cellBackgroundColor` 決定顯不顯示，兩者都關時整項不顯示。
 * `target` 只帶 block id 與索引：套用時才讀最新的表格，面板開著時別人改的字不會被蓋掉。
 */
function TableColorsItem({ target, current }: { target: TableTarget; current: (section: ColorSection) => string }) {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const menu = useColorMenu()!;
  const { cellTextColor, cellBackgroundColor } = editor.settings.tables;
  if (!cellTextColor && !cellBackgroundColor) return null;

  const sectionProps = (section: ColorSection): ColorSectionProps => {
    const color = current(section);
    return {
      color,
      setColor: (c) => applyColor(editor, section, target, c),
      onCustom: (e: MouseEvent) =>
        menu.openPanel({ section, target, current: color, byKeyboard: e.detail === 0, returnTo: RETURN_KEY }),
    };
  };

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger data-kb-color-return={RETURN_KEY}>
          {dict.drag_handle.colors_menuitem}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown bn-color-picker-dropdown">
        <KnotebookColorPicker
          returnPrefix="tbl"
          text={cellTextColor ? sectionProps("text") : undefined}
          background={cellBackgroundColor ? sectionProps("background") : undefined}
        />
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/** 儲存格選單的顏色項：目前顏色是滑鼠所在那一格的 props。 */
function TableCellColorsItem() {
  const { block, rowIndex, colIndex } = useTableHandlesState();
  if (block === undefined || rowIndex === undefined || colIndex === undefined) return null;
  const cell = block.content.rows[rowIndex]?.cells[colIndex];
  if (!cell) return null;
  const props = mapTableCell(cell).props as Record<string, unknown>;
  return (
    <TableColorsItem
      target={{ kind: "cell", blockId: block.id, rowIndex, colIndex }}
      current={(section) => String(props[sectionProp(section)] ?? "default")}
    />
  );
}

/** 列／欄把手選單的顏色項：該列／欄每一格的值都相同才以第一格的值為目前顏色，否則當「自動」。 */
function TableRowColColorsItem({ orientation }: { orientation: "row" | "column" }) {
  const tableHandles = useExtension(TableHandlesExtension);
  const { block, rowIndex, colIndex } = useTableHandlesState();
  const index = orientation === "row" ? rowIndex : colIndex;
  if (block === undefined || index === undefined) return null;
  const cells = orientation === "row" ? tableHandles.getCellsAtRowHandle(block, index) : tableHandles.getCellsAtColumnHandle(block, index);
  if (cells.length === 0) return null;
  const values = (section: ColorSection) =>
    cells.map(({ cell }) => String((mapTableCell(cell).props as Record<string, unknown>)[sectionProp(section)] ?? "default"));
  return (
    <TableColorsItem
      target={{ kind: "rowcol", blockId: block.id, orientation, index }}
      current={(section) => {
        const [first, ...rest] = values(section);
        return rest.every((v) => v === first) ? first! : "default";
      }}
    />
  );
}

/**
 * 列／欄把手選單：刪除、兩個新增（BlockNote 的元件）與顏色項。標題列／欄切換不放：編輯器沒開 `headers`。
 * className 與 BlockNote 原本的列／欄選單相同，只有 `bn-table-handle-menu`，外觀不變。
 */
export function KnotebookTableHandleMenu({ orientation }: { orientation: "row" | "column" }) {
  const Components = useComponentsContext()!;
  return (
    <Components.Generic.Menu.Dropdown className="bn-table-handle-menu">
      <ColorMenuBody>
        <DeleteButton orientation={orientation} />
        {orientation === "row" ? (
          <>
            <AddButton orientation="row" side="above" />
            <AddButton orientation="row" side="below" />
          </>
        ) : (
          <>
            <AddButton orientation="column" side="left" />
            <AddButton orientation="column" side="right" />
          </>
        )}
        <TableRowColColorsItem orientation={orientation} />
      </ColorMenuBody>
    </Components.Generic.Menu.Dropdown>
  );
}

/** 儲存格選單：只有顏色項（拆格沒開）。className 與 BlockNote 原本的儲存格選單相同。 */
export function KnotebookTableCellMenu() {
  const Components = useComponentsContext()!;
  return (
    <Components.Generic.Menu.Dropdown className="bn-menu-dropdown bn-table-handle-menu">
      <ColorMenuBody>
        <TableCellColorsItem />
      </ColorMenuBody>
    </Components.Generic.Menu.Dropdown>
  );
}

// `TableHandle` 的 `tableHandleMenu` 型別是不帶 props 的 FC，但執行時會傳 `orientation`。
const tableHandleMenu = KnotebookTableHandleMenu as FC;

/** 模組層常數元件（身分穩定）：BlockNote 的列／欄把手，選單換成 `KnotebookTableHandleMenu`。 */
export function KnotebookTableHandle(props: TableHandleProps) {
  return <TableHandle {...props} tableHandleMenu={tableHandleMenu} />;
}

/** 模組層常數元件（身分穩定）：BlockNote 的儲存格把手，選單換成 `KnotebookTableCellMenu`。 */
export function KnotebookTableCellButton(props: TableCellButtonProps) {
  return <TableCellButton {...props} tableCellMenu={KnotebookTableCellMenu} />;
}
