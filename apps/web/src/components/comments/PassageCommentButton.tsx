import "@/i18n/comment-toolbar-strings";
import { useTranslation } from "react-i18next";
import { useBlockNoteEditor, useComponentsContext } from "@blocknote/react";
import { MessageSquare } from "@/components/ui/icons";
import { useComments } from "@/lib/comments-context";
import { passageOf } from "./passage";

/** `range` is read at click time; null leaves the panel closed. */
export function PassageCommentButton({ range }: { range: () => { from: number; to: number } | null }) {
  const Components = useComponentsContext()!;
  const { t } = useTranslation();
  const editor = useBlockNoteEditor();
  const comments = useComments();
  const label = t("commentToolbar.comment");
  return (
    <Components.FormattingToolbar.Button
      mainTooltip={label}
      label={label}
      icon={<MessageSquare aria-hidden="true" className="h-4 w-4" />}
      onClick={() => {
        const current = range();
        const passage = current === null ? null : passageOf(editor.prosemirrorState.doc, current.from, current.to);
        if (passage !== null) comments.open({ draftAnchor: passage });
      }}
    />
  );
}
