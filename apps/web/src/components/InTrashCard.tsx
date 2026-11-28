import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { usePurgeTrash, useRestoreTrash, useTrashPreview } from "@/api/trash";
import { SidebarDrawerButton } from "@/components/AppShell";
import { BackToListButton } from "@/components/BackToListButton";
import { TrashPreviewEditor } from "@/components/TrashPreviewEditor";
import { PurgeConfirmDialog, toastTrashFailure, toastTrashResult } from "@/components/sidebar/trash-dialogs";
import { ARTICLE_COLUMN_PADDING, ARTICLE_TEXT_INSET, articleColumn } from "@/components/ui/article-column";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Trash } from "@/components/ui/icons";
import { RotateCcw } from "@/components/ui/icons-extra";
import { toast } from "@/components/ui/toast";
import { useSidebarTabActions } from "@/lib/sidebar-tab";
import { trashDetailLine, trashItemTitle, trashResultMessage } from "@/lib/trash-display";
import { cn } from "@/lib/utils";

export interface InTrashCardProps {
  noteId: string;
  /** Called after Restore finishes (with the restored NoteDto, or null when skipped). */
  onRestored: (restored: NoteDto | null) => void;
  /** Called after Delete permanently finishes. */
  onPurged?: () => void;
  /** Called once per noteId when GET /api/trash/:id returns 404. `afterLoad` is true if the preview had already loaded before vanishing. */
  onNotFound?: (info: { afterLoad: boolean }) => void;
  /** Whether to show the "Go to trash" action button (true on direct note URLs; omitted on /trash/:id). */
  showGoToTrash?: boolean;
}

/**
 * Read-only preview card for a note in the trash, shared by direct trashed-note URLs (NotePage `in_trash`)
 * and `/trash/:id` (TrashPreviewPage). Must render inside AppShell children (`SidebarDrawerButton` and `showTab`).
 * Only users with trash permission receive `in_trash` or 200 from `GET /api/trash/:id`.
 */
export function InTrashCard({ noteId, onRestored, onPurged, onNotFound, showGoToTrash = true }: InTrashCardProps) {
  const { t, i18n } = useTranslation();
  const { showTab } = useSidebarTabActions();
  const preview = useTrashPreview(noteId);
  const restore = useRestoreTrash();
  const purge = usePurgeTrash();
  const [purgeOpen, setPurgeOpen] = useState(false);
  const purgeButtonRef = useRef<HTMLButtonElement>(null);
  const hadDataRef = useRef(false);
  const notifiedNotFoundForRef = useRef<string | null>(null);
  const onNotFoundRef = useRef(onNotFound);
  onNotFoundRef.current = onNotFound;

  // Reset per-note tracking when switching directly between two trashed notes without remounting.
  const prevNoteIdRef = useRef(noteId);
  if (prevNoteIdRef.current !== noteId) {
    prevNoteIdRef.current = noteId;
    hadDataRef.current = false;
    notifiedNotFoundForRef.current = null;
  }

  if (preview.data !== undefined) {
    hadDataRef.current = true;
  }

  const isNotFound = preview.isError && preview.error instanceof ApiFail && preview.error.status === 404;
  useEffect(() => {
    if (!isNotFound || notifiedNotFoundForRef.current === noteId) return;
    notifiedNotFoundForRef.current = noteId;
    onNotFoundRef.current?.({ afterLoad: hadDataRef.current });
  }, [isNotFound, noteId]);

  const busy = restore.isPending || purge.isPending;

  const handleRestore = async () => {
    try {
      const result = await restore.mutateAsync([noteId]);
      const found = result.restored.find((note) => note.id === noteId) ?? null;
      if (found === null) {
        toast({ title: trashResultMessage("restore", 0, result.skipped.length, t), variant: "destructive" });
      }
      onRestored(found);
    } catch (err) {
      toastTrashFailure("restore", err, t);
    }
  };

  const handlePurge = async () => {
    try {
      const result = await purge.mutateAsync([noteId]);
      toastTrashResult("purge", result, t);
      setPurgeOpen(false);
      onPurged?.();
    } catch (err) {
      toastTrashFailure("purge", err, t);
      setPurgeOpen(false);
    }
  };

  const locale = i18n.language;
  const detailLine = preview.data ? trashDetailLine(preview.data, { now: preview.dataUpdatedAt, t, locale }) : null;

  let content: ReactNode;
  if (preview.isPending || isNotFound) {
    content = <p className={cn(ARTICLE_TEXT_INSET, "text-sm text-muted-foreground")}>{t("app.loading")}</p>;
  } else if (preview.isError && !preview.data) {
    const errText =
      preview.error instanceof ApiFail
        ? t(`errors.${preview.error.code}`, { defaultValue: t("errors.fallback") })
        : t("errors.fallback");
    content = (
      <p role="alert" className={cn(ARTICLE_TEXT_INSET, "text-sm text-destructive")}>
        {errText}
      </p>
    );
  } else if (preview.data) {
    content = <TrashPreviewEditor noteId={noteId} ydoc={preview.data.ydoc} />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          cardSurface,
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-sm:min-h-svh max-sm:overflow-visible max-sm:rounded-none max-sm:border-0 max-sm:pb-[env(safe-area-inset-bottom)]",
        )}
      >
        <header className="flex items-center gap-2 border-b border-border px-5 py-3 sm:gap-3 max-sm:px-3 max-sm:pt-[calc(0.75rem+env(safe-area-inset-top))]">
          <BackToListButton />
          <SidebarDrawerButton />
          {preview.data ? (
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{preview.data.title}</h1>
          ) : (
            <div aria-hidden="true" className="min-h-7 min-w-0 flex-1" />
          )}
          <span className="inline-flex shrink-0 items-center rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {t("trash.previewReadonly")}
          </span>
        </header>

        <div
          data-testid="trash-preview-banner"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-brand-soft px-5 py-2.5 text-sm max-sm:px-4"
        >
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-brand-on-soft">{t("trash.inTrashTitle")}</h2>
            {detailLine !== null && (
              <p
                className="mt-0.5 truncate text-xs text-muted-foreground"
                title={preview.data ? trashItemTitle(preview.data, { t, locale }) : undefined}
              >
                {detailLine}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="brand" size="sm" disabled={busy} onClick={() => void handleRestore()}>
              <RotateCcw aria-hidden="true" className="h-4 w-4" />
              {t("trash.restore")}
            </Button>
            <Button
              ref={purgeButtonRef}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setPurgeOpen(true)}
            >
              <Trash aria-hidden="true" className="h-4 w-4" />
              {t("trash.purge")}
            </Button>
            {showGoToTrash && (
              <Button type="button" variant="outline" size="sm" onClick={() => showTab("trash")}>
                <Trash aria-hidden="true" className="h-4 w-4" />
                {t("trash.goToTrash")}
              </Button>
            )}
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto sm:[scrollbar-gutter:stable]">
          <div className={cn(articleColumn("standard"), ARTICLE_COLUMN_PADDING, "py-6")}>{content}</div>
        </div>

        <PurgeConfirmDialog
          count={1}
          open={purgeOpen}
          pending={purge.isPending}
          onConfirm={() => void handlePurge()}
          onOpenChange={setPurgeOpen}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (purgeButtonRef.current?.isConnected) purgeButtonRef.current.focus();
          }}
        />
      </div>
    </div>
  );
}
