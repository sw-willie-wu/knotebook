import { useMemo } from "react";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import {
  FormattingToolbarController,
  useBlockNoteEditor,
  useEditorState,
  useExtensionState,
  type FloatingUIOptions,
} from "@blocknote/react";
import { selectionInsideAnchor } from "@/ai/selection";
import { activeAnchorOf, useAiSession } from "./AiSession";
import { AiToolbar } from "./AiToolbar";

/**
 * 框選 AI 的掛載點（#263 §5.3）：`NoteEditor` 把它當 `NoteEditorView` 的 children 傳進 `<BlockNoteView>`，它是 **formatting toolbar
 * controller 與 `SelectionAiBox` 的唯一擁有者**——`NoteEditorView` 不碰 AI context。
 *
 * 工具列壓制（D12）：`toolbarOpen = toolbarStoreOpen && !(boxOpen && selectionInsideTarget)`。`toolbarStoreOpen` 是上游 store
 * （pointerdown 期間恆為 false），**只用於這條壓制公式**；D12 的自動關閉用 `ai/selection.ts` 的 `toolbarWouldShow`（在 AiSession 裡）。
 * 覆寫 `useFloatingOptions.open` 即可收起：GenericPopover 以 floating 的 open 決定掛不掛（jsdom 探針實測，收合有約 270ms 轉場）。
 */
export function SelectionAiController() {
  const editor = useBlockNoteEditor();
  const { state } = useAiSession();
  const toolbarStoreOpen = useExtensionState(FormattingToolbarExtension, { editor });
  const anchor = activeAnchorOf(state);
  const boxOpen = state.phase !== "idle";
  const insideTarget = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current !== null && anchor !== null && current.transact((tr) => selectionInsideAnchor(tr, anchor.blockIds)),
  });
  const toolbarOpen = toolbarStoreOpen && !(boxOpen && insideTarget);
  // FormattingToolbarController 內部的 useMemo 以這個物件的身分為依賴——每次 render 新建會讓它每次重算。
  const floatingUIOptions = useMemo<FloatingUIOptions>(() => ({ useFloatingOptions: { open: toolbarOpen } }), [toolbarOpen]);

  return <FormattingToolbarController formattingToolbar={AiToolbar} floatingUIOptions={floatingUIOptions} />;
}
