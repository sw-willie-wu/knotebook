import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  DragHandleMenu,
  RemoveBlockItem,
  SideMenu,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
  type SideMenuProps,
} from "@blocknote/react";
import { absoluteUrl, blockLinkUrl, copyBlockLink } from "@/lib/copy-block-link";

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

/** 預設的四項（@blocknote/react 的 DragHandleMenu 預設 children，逐項照列）＋複製段落連結。 */
export function KnotebookDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <RemoveBlockItem>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
      <CopyBlockLinkItem />
    </DragHandleMenu>
  );
}

/** 模組層常數元件（身分穩定）：SideMenuController 以元件身分決定要不要重掛。 */
export function KnotebookSideMenu(props: SideMenuProps) {
  return <SideMenu {...props} dragHandleMenu={KnotebookDragHandleMenu} />;
}
