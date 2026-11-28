import "@/i18n/upload-list-strings";
import { useEffect, useId, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { cn } from "@/lib/utils";
import { precheckMessage } from "@/uploads/precheck";
import { dismissUpload, type UploadItem } from "@/uploads/upload-queue-store";
import { isUploadRetryable, uploadRetryWaitMs } from "@/uploads/upload-rules";

interface UploadListProps {
  items: readonly UploadItem[];
  /** Called after following a note link, so the panel closes without taking focus back from the note. */
  onNavigate: () => void;
  layout: "popover" | "sheet";
}

const NOTE_QUERY_PREFIXES = [["note"], ["note-by-path"], ["note-by-group-path"]] as const;

/** Only what is already cached: the note being uploaded to was open when the upload started. */
function cachedNoteTitle(queryClient: QueryClient, noteId: string): string | undefined {
  const listed = queryClient.getQueryData<NoteDto[]>(["notes"])?.find((n) => n.id === noteId);
  if (listed) return listed.title;
  for (const queryKey of NOTE_QUERY_PREFIXES) {
    for (const [, note] of queryClient.getQueriesData<NoteDto>({ queryKey })) if (note?.id === noteId) return note.title;
  }
  return undefined;
}

function itemPercent(item: UploadItem): number {
  if (item.status === "writing" || item.size === 0) return 100;
  return Math.floor((Math.min(item.loaded, item.size) / item.size) * 100);
}

function retry(id: string): void {
  // Every item was created by the runner, so this resolves from a module that is already loaded.
  void import("@/uploads/upload-runner").then((m) => m.retryUpload(id)).catch(() => {});
}

export function UploadList({ items, onNavigate, layout }: UploadListProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul ref={listRef} tabIndex={-1} aria-label={t("uploadList.title")} className={cn("space-y-1 outline-none", layout === "popover" ? "py-1" : "p-1")}>
        {items.map((item) => (
          <UploadRow
            key={item.id}
            item={item}
            onNavigate={onNavigate}
            // The row's own button goes away with what it did; the list keeps focus inside the panel.
            onActed={() => listRef.current?.focus()}
          />
        ))}
      </ul>
    </div>
  );
}

function UploadRow({ item, onNavigate, onActed }: { item: UploadItem; onNavigate: () => void; onActed: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const nameId = useId();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const running = item.status === "uploading" || item.status === "writing";
  const percent = itemPercent(item);
  const retryable = isUploadRetryable(item);
  const waitMs = retryable ? uploadRetryWaitMs(item) : 0;
  useEffect(() => {
    if (waitMs <= 0) return;
    const timer = setTimeout(tick, waitMs % 1000 || 1000);
    return () => clearTimeout(timer);
  }, [waitMs]);

  const title = cachedNoteTitle(queryClient, item.noteId);
  const noteLabel = title === undefined ? t("uploadList.someNote") : title.trim() === "" ? t("note.titlePlaceholder") : title;
  const reason = item.precheck
    ? precheckMessage(item, item.precheck, t)
    : item.error
      ? t(`errors.${item.error.code}`, { defaultValue: t("errors.fallback") })
      : undefined;

  return (
    <li data-testid="upload-row" className="space-y-1 rounded-md px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span id={nameId} className="min-w-0 flex-1 truncate font-medium">
          {item.fileName}
        </span>
        {running ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">{percent}%</span>
        ) : (
          <button
            type="button"
            aria-label={t("uploadList.dismissLabel", { name: item.fileName })}
            onClick={() => {
              dismissUpload(item.id);
              onActed();
            }}
            className="shrink-0 rounded text-brand-on-soft underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
          >
            {t("uploadList.dismiss")}
          </button>
        )}
      </div>
      {running && (
        <div
          role="progressbar"
          aria-label={t("uploadList.progress", { name: item.fileName })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1 rounded-full bg-brand-soft"
        >
          <div className="h-1 rounded-full bg-brand" style={{ width: `${percent}%` }} />
        </div>
      )}
      {item.status === "writing" && <p className="text-muted-foreground">{t("uploadList.saving")}</p>}
      {item.status === "unplaced" && <p className="text-destructive">{t("uploadList.placeGone")}</p>}
      {item.status === "failed" && reason !== undefined && <p className="text-destructive">{reason}</p>}
      <p className="text-muted-foreground">
        {t("uploadList.inNote")}{" "}
        <Link to={`/notes/${encodeURIComponent(item.noteId)}`} onClick={onNavigate} className="underline underline-offset-2 hover:text-foreground">
          {noteLabel}
        </Link>
        {retryable && (
          <>
            {" · "}
            <button
              type="button"
              disabled={waitMs > 0 || item.retrying}
              aria-label={waitMs > 0 || item.retrying ? undefined : t("uploadList.retryLabel", { name: item.fileName })}
              aria-describedby={waitMs > 0 || item.retrying ? nameId : undefined}
              onClick={() => {
                retry(item.id);
                onActed();
              }}
              className="rounded text-brand-on-soft underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60 pointer-coarse:min-h-11"
            >
              {item.retrying
                ? t("uploadList.checking")
                : waitMs > 0
                  ? t("uploadList.retryWait", { seconds: Math.ceil(waitMs / 1000) })
                  : t("uploadList.retry")}
            </button>
          </>
        )}
      </p>
    </li>
  );
}
