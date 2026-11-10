import { useCallback } from "react";
import { blockHasType } from "@blocknote/core";
import { useBlockNoteEditor, useComponentsContext, useDictionary, useEditorState } from "@blocknote/react";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { Trash } from "@/components/ui/icons";

/**
 * 工具列的檔案刪除鈕（取代 `@blocknote/react` 的 `FileDeleteButton`，`AiToolbar` 以 key `fileDeleteButton` 換掉）：
 * 顯示條件照原生（可編輯、選取恰一個 block、該 block 有字串 `url` prop），刪除改走 `keep-columns.ts` 的 helper——刪欄內的圖不收欄。
 * 圖示用自家 `Trash`：原生的圖示來自 apps/web 摸不到的 `react-icons`。
 */
export function KnotebookFileDeleteButton() {
  const dict = useDictionary();
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();

  const block = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current.isEditable) return undefined;
      const selected = current.getSelection()?.blocks || [current.getTextCursorPosition().block];
      if (selected.length !== 1) return undefined;
      const only = selected[0]!;
      if (!blockHasType(only, current, only.type, { url: "string" })) return undefined;
      return only;
    },
  });

  const onClick = useCallback(() => {
    if (block === undefined) return;
    editor.focus();
    removeBlocksKeepColumns(editor, [block.id]);
  }, [block, editor]);

  if (block === undefined) return null;
  const tooltip = dict.formatting_toolbar.file_delete.tooltip[block.type] || dict.formatting_toolbar.file_delete.tooltip["file"];
  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      data-kb-file-delete=""
      label={tooltip}
      mainTooltip={tooltip}
      icon={<Trash className="h-4 w-4" />}
      onClick={onClick}
    />
  );
}
