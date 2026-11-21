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
  type FloatingUIOptions,
  type SideMenuProps,
} from "@blocknote/react";
import { COLUMN_TYPE, readKnowledgeInfo } from "@knotebook/shared";
import { isInColumn, ungroupColumns } from "@/collab/columns/commands";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { blockIdsForMenuDelete } from "@/collab/columns/selection-delete";
import { isKnowledgeEligible } from "@/components/knowledge/commands";
import { KnowledgeControllerContext } from "@/components/knowledge/controller";
import { CircleInfo } from "@/components/ui/icons-extra";
import { absoluteUrl, blockLinkUrl, copyBlockLink } from "@/lib/copy-block-link";
import { ColorMenuBody } from "./colors/ColorMenuBody";
import { KnotebookBlockColorsItem } from "./colors/KnotebookBlockColorsItem";

/** The note's canonical path (`canonicalNotePath(note)`); null hides the copy-link item. */
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

/** Only offered where a controller is provided (an editable note); the form itself is in the lazy knowledge chunk. */
function KnowledgeInfoItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const controller = useContext(KnowledgeControllerContext);
  const { t } = useTranslation();
  if (!controller || !block || !isKnowledgeEligible(editor, block.id)) return null;
  const known = readKnowledgeInfo(block.props as Record<string, unknown>) !== null;
  return (
    <>
      <Components.Generic.Menu.Item
        className="bn-menu-item"
        icon={<CircleInfo className="h-4 w-4" />}
        onClick={() => controller.open(block.id, "edit", editor.prosemirrorView?.dom ?? null)}
      >
        {t(known ? "note.knowledge.menuEditItem" : "note.knowledge.menuItem")}
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Divider />
    </>
  );
}

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

/** Default items follow @blocknote/react's DragHandleMenu children one by one (Delete swapped for the no-column-collapse version, Colors for the one with "Custom…"). Everything is wrapped in `ColorMenuBody`: the colour submenu's "Custom…" swaps this dropdown's content for the custom colour panel. */
export function KnotebookDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <ColorMenuBody>
        <KnowledgeInfoItem />
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

/**
 * `floatingUIOptions` for `SideMenuController`: the outer floating-ui popover gets a data attribute so its pointer hit-testing can be disabled mid-drag (`.kb-dragging` in `index.css`).
 * Module-level: `SideMenuController`'s `useMemo` depends on its identity. No `style`: it would replace the default `zIndex: 20` wholesale.
 */
export const SIDE_MENU_FLOATING_OPTIONS: Partial<FloatingUIOptions> = {
  elementProps: { "data-kb-side-menu-popover": "" } as FloatingUIOptions["elementProps"],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
function hasColumnAncestor(editor: BlockNoteEditor<any, any, any>, blockId: string): boolean {
  for (let parent = editor.getParentBlock(blockId); parent; parent = editor.getParentBlock(parent.id)) {
    if (parent.type === COLUMN_TYPE) return true;
  }
  return false;
}

/**
 * Module-level for a stable identity: SideMenuController remounts when the component identity changes.
 * Only ⋮⋮ inside columns: the column menu anchors at the column's left edge in the 24px gutter, and the two buttons (48px together) would overlap the previous column.
 */
export function KnotebookSideMenu(props: SideMenuProps) {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (block !== undefined && hasColumnAncestor(editor, block.id)) {
    return (
      // Wrapper marker: `SideMenu`'s root className is fixed and takes no props, but `.kb-dragging` in `index.css` must be able to select it.
      <div data-kb-column-side-menu="">
        <SideMenu {...props}>
          <DragHandleButton {...props} dragHandleMenu={KnotebookDragHandleMenu} />
        </SideMenu>
      </div>
    );
  }
  return <SideMenu {...props} dragHandleMenu={KnotebookDragHandleMenu} />;
}
