import { useTranslation } from "react-i18next";
import { getFormattingToolbarItems, useBlockNoteEditor, useComponentsContext, useEditorState } from "@blocknote/react";
import { Sparkles } from "@/components/ui/icons";
import { useAiSession } from "./AiSession";

/**
 * 自訂 formatting toolbar（#263 §5.1）：`getFormattingToolbarItems()` 的預設按鈕原樣復原，尾端追加一顆 AI icon 鈕——按下開框選 AI 框
 * （`session.open()`），工具列那排由框取代（壓制在 `SelectionAiController`）。舊版的下拉清單整段拿掉：它用 `position:absolute` 畫在
 * `.bn-toolbar` 裡，而 mantine 的 `.bn-toolbar` 是 `overflow-x:auto`，展開就變成工具列的垂直溢出（spec §1）。
 *
 * 顯示條件：可編輯、有可用動作、且 `getSelection()` 不是 undefined——NodeSelection（選到圖片／檔案區塊）時它回 undefined，
 * 不渲染 AI 項，避免按了沒反應的死鈕。串流中停用（S2）。`useAiSession()` 能直接用：toolbar 經 `editor.portalElement` 的 React portal
 * 渲染，context 穿透 portal。
 */
export function AiToolbar() {
  const Components = useComponentsContext()!;
  const { t } = useTranslation();
  const editor = useBlockNoteEditor();
  const { actions, editable, state, open } = useAiSession();
  const hasBlockSelection = useEditorState({ editor, selector: ({ editor: current }) => current?.getSelection() !== undefined });

  return (
    <Components.FormattingToolbar.Root className="bn-toolbar bn-formatting-toolbar">
      {getFormattingToolbarItems()}
      {editable && actions.length > 0 && hasBlockSelection && (
        <Components.FormattingToolbar.Button
          mainTooltip={t("ai.toolbar.trigger")}
          label={t("ai.toolbar.trigger")}
          icon={<Sparkles aria-hidden="true" className="h-4 w-4" />}
          isDisabled={state.phase === "streaming"}
          onClick={() => open()}
        />
      )}
    </Components.FormattingToolbar.Root>
  );
}
