import "@/i18n/notifications-strings";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { NotificationDto } from "@knotebook/shared";
import { markNotificationsSeen, setUnreadCountToZero, useClearNotifications, useDeleteNotification, useNotificationList } from "@/api/notifications-list";
import { Avatar } from "@/components/Avatar";
import { authorName, fullTime, relativeTime } from "@/components/comments/comment-format";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

interface NotificationListProps {
  userId: string;
  /** Called after navigating to a comment, so the panel closes without taking focus back from the note. */
  onNavigate: () => void;
  layout: "popover" | "sheet";
}

export function NotificationList({ userId, onNavigate, layout }: NotificationListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useNotificationList(userId);
  const remove = useDeleteNotification(userId);
  const clear = useClearNotifications(userId);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clearAllRef = useRef<HTMLButtonElement>(null);
  // `isNew` is relative to the last seen mark, which this panel moves forward; rows that were new when they first appeared stay marked until it closes.
  const newIds = useRef(new Set<string>());

  const notifications = list.data?.pages.flatMap((p) => p.notifications) ?? [];
  for (const n of notifications) if (n.isNew) newIds.current.add(n.id);

  // Mark seen only after the list has loaded: a row that arrived between opening and loading would otherwise be marked seen without ever being shown.
  // Posted again only when the newest row is newer than the last one posted for: refetches and "show older" must not move the mark.
  const newest = list.data?.pages[0]?.notifications[0];
  const newestAt = newest === undefined ? Number.NEGATIVE_INFINITY : Date.parse(newest.createdAt);
  const postedAt = useRef<number | null>(null);
  const settled = list.isSuccess && !list.isFetching;
  useEffect(() => {
    if (!settled) return;
    if (postedAt.current !== null && newestAt <= postedAt.current) return;
    postedAt.current = newestAt;
    void markNotificationsSeen().then(
      () => setUnreadCountToZero(queryClient, userId),
      () => {
        postedAt.current = null;
      },
    );
  }, [settled, newestAt, queryClient, userId]);

  function open(n: NotificationDto): void {
    if (!n.canOpen || n.noteId === null || n.commentId === null) return;
    void navigate(`/notes/${encodeURIComponent(n.noteId)}?comment=${encodeURIComponent(n.commentId)}`);
    onNavigate();
  }

  const empty = list.isSuccess && notifications.length === 0;
  const failed = list.isError && !list.isFetching && list.data === undefined;

  return (
    <div ref={rootRef} tabIndex={-1} data-testid="notification-list-root" className="flex min-h-0 flex-1 flex-col outline-none">
      <div className={cn("flex items-center gap-2 border-b border-border px-3 py-2", layout === "popover" && "-mx-1 -mt-1")}>
        {layout === "popover" ? <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("notifications.title")}</h2> : <span className="flex-1" />}
        <Button
          ref={clearAllRef}
          type="button"
          variant="ghost"
          size="sm"
          disabled={notifications.length === 0 || clear.isPending}
          onClick={() => setConfirmingClear(true)}
        >
          {t("notifications.clearAll")}
        </Button>
      </div>

      {confirmingClear && (
        <div role="group" aria-label={t("notifications.clearTitle")} className={cn("space-y-2 border-b border-border bg-muted px-3 py-2", layout === "popover" && "-mx-1")}>
          <p className="text-sm font-medium">{t("notifications.clearTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("notifications.clearBody")}</p>
          <div className="flex justify-end gap-2">
            {/* Cancel first so the safe action is the first stop for a keyboard user. */}
            <Button type="button" variant="outline" size="sm" autoFocus
              onClick={() => {
                setConfirmingClear(false);
                clearAllRef.current?.focus();
              }}
            >
              {t("notifications.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={clear.isPending}
              onClick={() =>
                clear.mutate(undefined, {
                  onSettled: () => {
                    setConfirmingClear(false);
                    rootRef.current?.focus();
                  },
                })
              }
            >
              {t("notifications.clearConfirm")}
            </Button>
          </div>
        </div>
      )}
      {clear.isError && (
        <p role="alert" className={cn("px-3 py-2 text-xs text-destructive", layout === "popover" && "px-2")}>
          {t("notifications.clearFailed")}
        </p>
      )}
      {remove.isError && (
        <p role="alert" className={cn("px-3 py-2 text-xs text-destructive", layout === "popover" && "px-2")}>
          {t("notifications.deleteFailed")}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isPending}>
        {list.isPending && <p className={cn("p-3 text-sm text-muted-foreground", layout === "popover" && "p-2")}>{t("notifications.loading")}</p>}
        {failed && (
          <div role="alert" className={cn("space-y-2 p-3 text-sm", layout === "popover" && "p-2")}>
            <p>{t("notifications.loadFailed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
              {t("notifications.retry")}
            </Button>
          </div>
        )}
        {empty && <p className={cn("p-3 text-sm text-muted-foreground", layout === "popover" && "p-2")}>{t("notifications.empty")}</p>}
        {notifications.length > 0 && (
          <ul ref={listRef} tabIndex={-1} aria-label={t("notifications.list")} className={cn("outline-none", layout !== "popover" && "p-1")}>
            {notifications.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                isNew={newIds.current.has(n.id)}
                onOpen={() => open(n)}
                onDelete={() => remove.mutate(n.id, { onSuccess: () => listRef.current?.focus() })}
              />
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="p-2">
            <Button type="button" variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t("notifications.loadMore")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationRow({ n, isNew, onOpen, onDelete }: { n: NotificationDto; isNew: boolean; onOpen: () => void; onDelete: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const agentActor = n.actor.agentLabel !== null;
  const who = authorName({ authorHandle: n.actor.handle, authorDisplayName: n.actor.displayName, agentLabel: n.actor.agentLabel });
  const what = n.kind === "mention" ? t("notifications.mentioned", { who }) : t("notifications.replied", { who });
  const body = (
    <>
      <Avatar name={agentActor ? n.actor.handle : who} avatar={n.actor.avatar} size={28} kind={agentActor ? "agent" : "user"} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 text-sm">{what}</span>
          {isNew && (
            <span data-testid="notification-new" className="shrink-0 rounded-full bg-brand-soft px-1.5 text-[10px] font-semibold text-brand">
              {t("notifications.new")}
            </span>
          )}
        </span>
        {n.agentLabel !== null && (
          <span data-testid="notification-agent" className="block text-xs text-[#7c3aed] dark:text-[#a78bfa]">
            {t("notifications.forAgent", { label: n.agentLabel })}
          </span>
        )}
        {n.canOpen ? (
          <>
            <span data-testid="notification-note" className="block truncate text-xs font-medium text-muted-foreground">
              {n.noteTitle === null || n.noteTitle.trim() === "" ? t("note.titlePlaceholder") : n.noteTitle}
            </span>
            {n.excerpt !== null && n.excerpt !== "" && <span className="line-clamp-2 block break-words text-xs text-muted-foreground">{n.excerpt}</span>}
          </>
        ) : (
          <span data-testid="notification-no-access" className="block text-xs italic text-muted-foreground">
            {t("notifications.cantOpen")}
          </span>
        )}
        <time dateTime={n.createdAt} title={fullTime(n.createdAt, lang)} className="block text-xs text-muted-foreground">
          {relativeTime(n.createdAt, lang)}
        </time>
      </span>
    </>
  );

  return (
    <li data-testid="notification" data-notification-id={n.id} data-new={isNew ? "" : undefined} className="group relative flex items-start rounded-md hover:bg-accent">
      {n.canOpen ? (
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 gap-2 rounded-md px-2 py-2 pr-9 text-left pointer-coarse:pr-12">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 gap-2 px-2 py-2 pr-9 pointer-coarse:pr-12">{body}</div>
      )}
      <button
        type="button"
        aria-label={t("notifications.delete")}
        title={t("notifications.delete")}
        onClick={onDelete}
        className="absolute right-1 top-1.5 flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
