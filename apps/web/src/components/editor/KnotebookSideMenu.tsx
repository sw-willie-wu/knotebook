import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  DragHandleButton,
  DragHandleMenu,
  SideMenu,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
  type FloatingUIOptions,
  type SideMenuProps,
} from "@blocknote/react";
import { COLUMN_TYPE } from "@knotebook/shared";
import { isInColumn, ungroupColumns } from "@/collab/columns/commands";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { blockIdsForMenuDelete } from "@/collab/columns/selection-delete";
import { absoluteUrl, blockLinkUrl, copyBlockLink } from "@/lib/copy-block-link";

/** #269：這篇筆記的 canonical 路徑（`canonicalNotePath(note)`）——NoteEditorView 提供；沒有（null）就不顯示複製項。 */
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

/** 「刪除」項：刪哪些 block 見 `collab/columns/selection-delete.ts`，刪除走 `keep-columns.ts` 的 helper（不收欄）。 */
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

/** 「取消並排」項：block 是某欄的直接子 block 才顯示。 */
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

/** 預設的四項（@blocknote/react 的 DragHandleMenu 預設 children，逐項照列；刪除項換成不收欄的版本）＋取消並排＋複製段落連結。 */
export function KnotebookDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <KeepColumnsDeleteItem>{dict.drag_handle.delete_menuitem}</KeepColumnsDeleteItem>
      <UngroupColumnsItem />
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
      <CopyBlockLinkItem />
    </DragHandleMenu>
  );
}

/**
 * 給 `SideMenuController` 的 `floatingUIOptions`：⋮⋮ 外面那層 popover（floating-ui 的 div，與 ⋮⋮ 同大小、z-index 20）掛 data 屬性，
 * 拖放中才關得到它的指標命中（`index.css` 的 `.kb-dragging`）。模組層常數：`SideMenuController` 的 `useMemo` 依賴它的身分。
 * 不放 `style`：`SideMenuController` 是 `{ style: { zIndex: 20 }, ...elementProps }`，傳了 `style` 就整個蓋掉 z-index。
 */
export const SIDE_MENU_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  elementProps: { "data-kb-side-menu-popover": "" } as FloatingUIOptions["elementProps"],
};

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
 * 欄內只放 ⋮⋮：欄的選單以欄左緣定位、落在 24px 溝裡，兩顆鈕（48px）會蓋進前一欄。
 */
export function KnotebookSideMenu(props: SideMenuProps) {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (block !== undefined && hasColumnAncestor(editor, block.id)) {
    return (
      // 外包一層標記：`SideMenu` 的根 className 寫死、不收 props，拖放中關指標命中（`index.css` 的 `.kb-dragging`）要靠這個選得到。
      <div data-kb-column-side-menu="">
        <SideMenu {...props}>
          <DragHandleButton {...props} dragHandleMenu={KnotebookDragHandleMenu} />
        </SideMenu>
      </div>
    );
  }
  return <SideMenu {...props} dragHandleMenu={KnotebookDragHandleMenu} />;
}
