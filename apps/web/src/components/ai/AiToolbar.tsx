import { useTranslation } from "react-i18next";
import { getFormattingToolbarItems, useBlockNoteEditor, useComponentsContext, useEditorState } from "@blocknote/react";
import { Sparkles } from "@/components/ui/icons";
import { KnotebookBlockTypeSelect } from "@/components/editor/KnotebookBlockTypeSelect";
import { KnotebookFileDeleteButton } from "@/components/editor/KnotebookFileDeleteButton";
import { KnotebookColorStyleButton } from "@/components/editor/colors/KnotebookColorStyleButton";
import { PassageCommentButton } from "@/components/comments/PassageCommentButton";
import { passageOf } from "@/components/comments/passage";
import { isNonTextSelection } from "@/ai/selection";
import { useComments } from "@/lib/comments-context";
import { useAiSession } from "./AiSession";

/**
 * The AI button opens the selection AI box (`session.open()`), which replaces the toolbar row (suppressed in
 * `SelectionAiController`). No dropdown: one drawn with `position:absolute` inside `.bn-toolbar` overflows vertically
 * because mantine's `.bn-toolbar` is `overflow-x:auto`.
 *
 * A NodeSelection (image/file block) makes `getSelection()` return undefined, so the button is hidden; it would do nothing.
 * Cross-column or whole-row selections render it as usual (`open()` widens the anchor to the whole row). `useAiSession()` works here
 * because the toolbar renders through `editor.portalElement`'s React portal and context passes through portals.
 *
 * The file-delete button (`fileDeleteButton`) is replaced because the native one uses `editor.removeBlocks`, which
 * collapses a column when its image is deleted. The color button (`colorStyleButton`) is replaced to add a custom color beyond the 10
 * built-in ones per section (#378). The block type select (`blockTypeSelect`) is replaced so a multi-block selection
 * changes only blocks that are menu item types, and tables, images etc. aren't wiped (#464).
 *
 * The Comment button is left out for image, file and cell selections: they have no text to quote.
 */
export function AiToolbar() {
  const Components = useComponentsContext()!;
  const { t } = useTranslation();
  const editor = useBlockNoteEditor();
  const { actions, editable, state, open } = useAiSession();
  const hasBlockSelection = useEditorState({
    editor,
    selector: ({ editor: current }) => current?.getSelection() !== undefined,
  });
  const commentsEnabled = useComments().enabled;
  const hasTextSelection = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current !== null &&
      current.transact((tr) => !tr.selection.empty && !isNonTextSelection(tr) && (passageOf(tr.doc, tr.selection.from, tr.selection.to)?.quote ?? "") !== ""),
  });

  return (
    <Components.FormattingToolbar.Root className="bn-toolbar bn-formatting-toolbar">
      {getFormattingToolbarItems().map((el) =>
        el.key === "fileDeleteButton" ? (
          <KnotebookFileDeleteButton key="fileDeleteButton" />
        ) : el.key === "colorStyleButton" ? (
          <KnotebookColorStyleButton key="colorStyleButton" />
        ) : el.key === "blockTypeSelect" ? (
          <KnotebookBlockTypeSelect key="blockTypeSelect" />
        ) : (
          el
        ),
      )}
      {editable && actions.length > 0 && hasBlockSelection && (
        <Components.FormattingToolbar.Button
          mainTooltip={t("ai.toolbar.trigger")}
          label={t("ai.toolbar.trigger")}
          icon={<Sparkles aria-hidden="true" className="h-4 w-4" />}
          isDisabled={state.phase === "streaming"}
          onClick={() => open()}
        />
      )}
      {editable && commentsEnabled && hasTextSelection && <PassageCommentButton range={() => editor.prosemirrorState.selection} />}
    </Components.FormattingToolbar.Root>
  );
}
