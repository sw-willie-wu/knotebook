import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  DragHandleButton,
  DragHandleMenu,
  SideMenu,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
  type SideMenuProps,
} from "@blocknote/react";
import { COLUMN_TYPE } from "@knotebook/shared";
import { isInColumn, ungroupColumns } from "@/collab/columns/commands";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { blockIdsForMenuDelete } from "@/collab/columns/selection-delete";
import { absoluteUrl, blockLinkUrl, copyBlockLink } from "@/lib/copy-block-link";
import { ColorMenuBody } from "./colors/ColorMenuBody";
import { KnotebookBlockColorsItem } from "./colors/KnotebookBlockColorsItem";

/** #269 §10.3(a)：這篇筆記的 canonical 路徑（`canonicalNotePath(note)`）——NoteEditorView 提供；沒有（null）就不顯示複製項。 */
export const NotePathContext = createContext<string | null>(null);

function CopyBlockLinkItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const notePath = useContext(NotePathContext);
  const { t } = useTranslation();
  if (!block || notePath === null) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => void copyBlockLink(blockLinkUrl(absoluteUrl(notePath), block.id), t)}>
      {t("note.blockLink.copy")}
    </Components.Generic.Menu.Item>
  );
}

/** 「刪除」項：刪哪些 block 見 `collab/columns/selection-delete.ts`，刪除走 D25 helper（不收欄）。 */
function KeepColumnsDeleteItem({ children }: { children: ReactNode }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (block === undefined) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => removeBlocksKeepColumns(editor, blockIdsForMenuDelete(editor, block.id))}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}

/** 「取消並排」項（spec §7.2）：block 是某欄的直接子 block 才顯示。 */
function UngroupColumnsItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const { t } = useTranslation();
  if (block === undefined || !isInColumn(editor, block.id)) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => ungroupColumns(editor, block.id)}>
      {t("note.columns.ungroup")}
    </Components.Generic.Menu.Item>
  );
}

/**
 * 預設的四項（@blocknote/react 的 DragHandleMenu 預設 children，逐項照列；刪除項換成不收欄的版本、顏色項換成多了
 * 「自訂…」的版本）＋取消並排＋複製段落連結。整個內容包在 `ColorMenuBody` 裡：顏色子選單的「自訂…」把這個
 * dropdown 的內容換成自訂色面板。
 */
export function KnotebookDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <ColorMenuBody>
        <KeepColumnsDeleteItem>{dict.drag_handle.delete_menuitem}</KeepColumnsDeleteItem>
        <UngroupColumnsItem />
        <KnotebookBlockColorsItem>{dict.drag_handle.colors_menuitem}</KnotebookBlockColorsItem>
        <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
        <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
        <CopyBlockLinkItem />
      </ColorMenuBody>
    </DragHandleMenu>
  );
}

/** block 在某欄裡（任一層祖先是 column，含欄內巢狀子 block）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
function hasColumnAncestor(editor: BlockNoteEditor<any, any, any>, blockId: string): boolean {
  for (let parent = editor.getParentBlock(blockId); parent; parent = editor.getParentBlock(parent.id)) {
    if (parent.type === COLUMN_TYPE) return true;
  }
  return false;
}

/**
 * 模組層常數元件（身分穩定）：SideMenuController 以元件身分決定要不要重掛。
 * 欄內只放 ⋮⋮（spec §17 #3，Willie 2026-10-22）：欄的選單以欄左緣定位、落在 24px 溝裡，兩顆鈕（48px）會蓋進前一欄。
 */
export function KnotebookSideMenu(props: SideMenuProps) {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (block !== undefined && hasColumnAncestor(editor, block.id)) {
    return (
      <SideMenu {...props}>
        <DragHandleButton {...props} dragHandleMenu={KnotebookDragHandleMenu} />
      </SideMenu>
    );
  }
  return <SideMenu {...props} dragHandleMenu={KnotebookDragHandleMenu} />;
}
