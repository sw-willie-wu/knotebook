import "@/i18n/comments-strings";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import type { CommentDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCommentList, useDeleteComment } from "@/api/comments";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { BlockAnchorContext } from "@/hooks/block-anchor-context";
import { useComments } from "@/lib/comments-context";
import { useBlockIds } from "./block-ids";
import { CommentComposer } from "./CommentComposer";
import { CommentItem } from "./CommentItem";

const EDGE_PX = 64;
const HIGHLIGHT_MS = 2000;

function findComment(root: HTMLElement | null, commentId: string): HTMLElement | null {
  for (const el of root?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? []) if (el.dataset.commentId === commentId) return el;
  return null;
}

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX;
}

interface ScrollSnapshot {
  firstId: string | null;
  lastId: string | null;
  scrollHeight: number;
  scrollTop: number;
  atBottom: boolean;
}

/**
 * The thread shared by the panel and the phone sheet. Oldest to newest, scrolled to the bottom; older pages load when scrolling up.
 * Opened at a comment (`target`) it shows a window around it and pages both ways. `onPassage` runs before a quote scrolls the note
 * (the sheet closes itself there, since it covers the note).
 */
export function CommentThread({ doc, onPassage }: { doc: Y.Doc; onPassage?: () => void }) {
  const { t } = useTranslation();
  const comments = useComments();
  const { noteId, target, targetSeq, reportTargetMissing, open, showNewest, clearDraftAnchor, readDraft, saveDraft, takeDraft, settleSentDraft, takeAnchorFocus } = comments;
  const id = noteId ?? "";
  const list = useCommentList(id, target, comments.enabled);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.comments) ?? [], [list.data]);
  const anchor = useContext(BlockAnchorContext);
  const blockIds = useBlockIds(doc, rows.some((c) => c.anchor !== null));
  const remove = useDeleteComment(id);

  const [draft] = useState(readDraft);
  const [replyTo, setReplyTo] = useState<CommentDto | null>(draft.replyTo);
  useEffect(() => {
    saveDraft({ replyTo });
  }, [replyTo, saveDraft]);
  const saveText = useCallback((text: string) => saveDraft({ text }), [saveDraft]);
  const [editing, setEditing] = useState<CommentDto | null>(null);
  const [deleting, setDeleting] = useState<CommentDto | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const editDirtyRef = useRef(false);
  const onEditDirty = useCallback((dirty: boolean) => {
    editDirtyRef.current = dirty;
  }, []);
  const newComposerRef = useRef<HTMLDivElement>(null);
  const editedIdRef = useRef<string | null>(null);
  // Set while a delete is confirmed: the comment to focus afterwards (null = the composer). Undefined = leave focus to the dialog.
  const afterDeleteFocusRef = useRef<string | null | undefined>(undefined);

  // An edit ending drops focus with its composer: give it back to the edited comment's Edit button, or to the composer when a reply is waiting.
  useEffect(() => {
    if (editing !== null) {
      editedIdRef.current = editing.id;
      return;
    }
    const endedId = editedIdRef.current;
    editedIdRef.current = null;
    if (endedId === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const button = replyTo === null ? findComment(scrollRef.current, endedId)?.querySelector<HTMLElement>("[data-action='edit']") : null;
    (button ?? newComposerRef.current?.querySelector<HTMLElement>("textarea"))?.focus({ preventScroll: true });
    // Only the end of an edit matters; a later reply change must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Only this code means the comment is gone; a note-level 404 (access lost, trashed) is the normal error state.
  const targetGone = target !== null && list.error instanceof ApiFail && list.error.code === "comment_not_found";
  useEffect(() => {
    if (targetGone) reportTargetMissing();
  }, [targetGone, reportTargetMissing]);

  // On the newest page the thread always reaches the newest comment, also after a refetch that stopped at the old page count.
  const { hasNextPage, isFetchingNextPage, isFetching, fetchNextPage, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage } = list;
  useEffect(() => {
    if (target === null && hasNextPage && !isFetching) void fetchNextPage();
  }, [target, hasNextPage, isFetching, fetchNextPage]);

  useEffect(() => {
    if (highlightId === null) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<ScrollSnapshot | null>(null);
  const positionedRef = useRef<string | null>(null);
  const positionKey = `${id}\n${target ?? ""}\n${targetSeq}`;
  const takeSnapshot = () => {
    const el = scrollRef.current;
    if (!el) return;
    snapshotRef.current = {
      firstId: rows[0]?.id ?? null,
      lastId: rows[rows.length - 1]?.id ?? null,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      atBottom: nearBottom(el),
    };
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = snapshotRef.current;
    const firstId = rows[0]?.id ?? null;
    const lastId = rows[rows.length - 1]?.id ?? null;
    if (positionedRef.current !== positionKey && rows.length > 0) {
      positionedRef.current = positionKey;
      const targetEl = target === null ? null : findComment(el, target);
      if (targetEl) {
        targetEl.scrollIntoView?.({ block: "center" });
        setHighlightId(target);
      } else {
        el.scrollTop = el.scrollHeight;
      }
    } else if (prev !== null) {
      // Older comments came in above: keep what was on screen where it was.
      if (prev.firstId !== firstId && prev.lastId === lastId) el.scrollTop = prev.scrollTop + (el.scrollHeight - prev.scrollHeight);
      else if (prev.lastId !== lastId && prev.atBottom) el.scrollTop = el.scrollHeight;
    }
    takeSnapshot();
    // takeSnapshot reads the same rows; listing it would rerun this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, positionKey, target]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    takeSnapshot();
    if (positionedRef.current !== positionKey) return;
    if (el.scrollTop < EDGE_PX && hasPreviousPage && !isFetchingPreviousPage) void fetchPreviousPage();
    if (target !== null && nearBottom(el) && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  };

  const scrollToComment = (commentId: string) => {
    const el = findComment(scrollRef.current, commentId);
    if (el) {
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      setHighlightId(commentId);
    } else {
      open({ commentId });
    }
  };

  const onQuote = (blockId: string) => {
    onPassage?.();
    anchor.requestAnchor(blockId);
  };

  const onNewDone = (saved: CommentDto | null) => {
    setReplyTo(null);
    if (saved === null) return;
    if (target !== null && hasNextPage) showNewest();
    // The composer posts at the bottom: show the new comment even if the list was scrolled up.
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const confirmDelete = () => {
    const victim = deleting;
    if (victim === null) return;
    const at = rows.findIndex((c) => c.id === victim.id);
    afterDeleteFocusRef.current = (rows[at + 1] ?? rows[at - 1])?.id ?? null;
    remove.mutate(victim.id, {
      onSuccess: () => {
        setDeleting(null);
        if (editing?.id === victim.id) setEditing(null);
        if (replyTo?.id === victim.id) setReplyTo(null);
      },
      onError: (err) => {
        afterDeleteFocusRef.current = undefined;
        setDeleting(null);
        toast({
          title: err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback"),
          variant: "destructive",
        });
      },
    });
  };

  const loading = list.isPending && !targetGone;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {comments.targetMissing && (
        <p role="status" data-testid="comments-target-missing" className="mx-3 mt-2 rounded-md bg-muted px-2 py-1 text-xs">
          {t("comments.targetMissing")}
        </p>
      )}
      <div ref={scrollRef} data-testid="comments-scroll" onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {hasPreviousPage && (
          <Button type="button" variant="ghost" size="sm" className="w-full" disabled={isFetchingPreviousPage} onClick={() => void fetchPreviousPage()}>
            {t("comments.loadOlder")}
          </Button>
        )}
        {list.isError && !targetGone && rows.length === 0 ? (
          <div role="alert" className="space-y-2 px-3 py-4 text-sm text-destructive">
            <p>{t("comments.loadFailed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
              {t("comments.retry")}
            </Button>
          </div>
        ) : !loading && rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{t("comments.empty")}</p>
        ) : (
          <ul aria-label={t("comments.title")} className="space-y-1">
            {rows.map((c) => (
              <CommentItem
                key={c.id}
                comment={c}
                blockIds={blockIds}
                highlighted={highlightId === c.id}
                onQuote={onQuote}
                onReplySummary={scrollToComment}
                onReply={(r) => {
                  // An edit with unsaved changes stays open; the reply composer takes over when it ends.
                  if (!editDirtyRef.current) setEditing(null);
                  setReplyTo(r);
                }}
                onEdit={(e) => {
                  setEditing(e);
                }}
                onDelete={setDeleting}
              />
            ))}
          </ul>
        )}
        {target !== null && hasNextPage && (
          <Button type="button" variant="ghost" size="sm" className="w-full" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {t("comments.loadNewer")}
          </Button>
        )}
      </div>
      {comments.newCommentsPending && (
        <div className="flex justify-center border-t border-border py-1.5">
          <Button type="button" size="sm" variant="outline" data-testid="comments-new" onClick={showNewest}>
            {t("comments.newComments")}
          </Button>
        </div>
      )}
      {/* The new-comment composer stays mounted (only hidden) while an edit is open, so its half-written text survives the edit. */}
      <div ref={newComposerRef} hidden={editing !== null}>
        <CommentComposer
          noteId={id}
          draftAnchor={comments.draftAnchor}
          onClearAnchor={clearDraftAnchor}
          replyTo={replyTo}
          editing={null}
          onDone={onNewDone}
          initialText={draft.text}
          onTextChange={saveText}
          onSendStart={takeDraft}
          onSendEnd={settleSentDraft}
          takeAnchorFocus={takeAnchorFocus}
        />
      </div>
      {editing !== null && (
        <CommentComposer key={editing.id} noteId={id} draftAnchor={null} onClearAnchor={clearDraftAnchor} replyTo={null} editing={editing} onDone={() => setEditing(null)} onDirtyChange={onEditDirty} />
      )}
      <Dialog open={deleting !== null} onOpenChange={(next) => !next && !remove.isPending && setDeleting(null)}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            const next = afterDeleteFocusRef.current;
            afterDeleteFocusRef.current = undefined;
            if (next === undefined) return;
            // The Delete button went away with its comment.
            event.preventDefault();
            const target = next === null ? null : findComment(scrollRef.current, next)?.querySelector<HTMLElement>("[role='group'] button");
            (target ?? newComposerRef.current?.querySelector<HTMLElement>("textarea"))?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("comments.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("comments.deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={remove.isPending}>
                {t("comments.cancel")}
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" disabled={remove.isPending} onClick={confirmDelete}>
              {t("comments.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
