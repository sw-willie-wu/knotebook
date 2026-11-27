import "@/i18n/comments-strings";
import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as Y from "yjs";
import { NotePanelSwitch, consumeNotePanelSwitch } from "@/components/NotePanelSwitch";
import { Button } from "@/components/ui/button";
import { SAFE_INSETS } from "@/components/ui/safe-area";
import { useComments } from "@/lib/comments-context";
import { CommentThread } from "./CommentThread";

/**
 * Phones (< 640): the thread as a full page, opened from the ⋮ menu. Focus returns as in `VersionsSheet`: to the element focused at open,
 * or to `returnFocusRef` (the ⋮ trigger) when that one went away with the menu.
 */
export function CommentsSheet({ doc, returnFocusRef }: { doc: Y.Doc; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const { close, noteId } = useComments();
  const [returnFocus] = useState(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-testid="comments-sheet"
          className={`fixed inset-0 z-50 flex flex-col bg-card outline-none ${SAFE_INSETS}`}
          aria-describedby={undefined}
          // Same rule as the panel: Esc while a draft is typed would throw it away with the sheet.
          onEscapeKeyDown={(event) => {
            const active = document.activeElement;
            if (active instanceof HTMLTextAreaElement && active.value !== "") event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (consumeNotePanelSwitch()) {
              event.preventDefault();
              return;
            }
            const target = returnFocus?.isConnected ? returnFocus : returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button type="button" variant="ghost" size="sm" className="h-11" aria-label={t("comments.back")} onClick={close}>
              <span aria-hidden="true">‹</span> {t("comments.back")}
            </Button>
            <DialogPrimitive.Title className="text-sm font-semibold">{t("comments.title")}</DialogPrimitive.Title>
          </header>
          <NotePanelSwitch current="comments" />
          {/* The sheet covers the note: close it before the note scrolls to a quoted passage. */}
          <CommentThread key={noteId ?? ""} doc={doc} onPassage={close} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
