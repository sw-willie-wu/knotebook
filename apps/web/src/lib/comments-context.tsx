import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CommentDto } from "@knotebook/shared";
import {
  applyCommentChange,
  commentListKey,
  commentListsKey,
  commentUnreadKey,
  listHasComment,
  sessionUserId,
  markCommentsRead,
  type CommentChangeOp,
} from "@/api/comments";
import { PHONE_QUERY, isPhone } from "@/lib/layout-tiers";

// Independent of `VersionsProvider`, which is off for viewers: anyone who can read the note can comment. Without a provider it
// returns a no-op default (`enabled: false`), so every entry point renders only when `enabled`.

export type CommentsMode = "panel" | "sheet";
export interface CommentDraftAnchor {
  blockId: string;
  quote: string;
}
export interface CommentDraft {
  text: string;
  replyTo: CommentDto | null;
}
export interface SentCommentDraft {
  noteId: string;
  text: string;
  replyTo: CommentDto | null;
  anchor: CommentDraftAnchor | null;
}
const EMPTY_DRAFT: CommentDraft = { text: "", replyTo: null };
export interface OpenCommentsOptions {
  /** Opens the thread at this comment (a window around it) instead of the newest page. */
  commentId?: string;
  /** Attaches the next new comment to this passage. */
  draftAnchor?: CommentDraftAnchor;
}

export interface CommentsContextValue {
  enabled: boolean;
  noteId: string | null;
  mode: CommentsMode | null;
  panelOpen: boolean;
  /** Comment the thread is opened at; null = the newest page. */
  target: string | null;
  /** Changes on every `open({commentId})`, so opening the same comment again scrolls to it again. */
  targetSeq: number;
  /** The comment asked for no longer exists; the thread shows the newest page with a notice. */
  targetMissing: boolean;
  /** A comment was posted after the loaded window, which doesn't reach the newest comment. */
  newCommentsPending: boolean;
  draftAnchor: CommentDraftAnchor | null;
  /** This note's unsent comment, kept while the thread is closed or the version history is shown; read once when the thread mounts. */
  readDraft(): CommentDraft;
  saveDraft(patch: Partial<CommentDraft>): void;
  /**
   * A post takes the note's draft out of the store when it starts, so a thread reopened before the answer can't post it again, and
   * settles it when it ends (also after the thread unmounted): a failed post is put back if nothing was written since; text written
   * meanwhile keeps the sent comment's reply and passage.
   */
  takeDraft(noteId: string): void;
  settleSentDraft(sent: SentCommentDraft, posted: boolean): void;
  /** True once per `open({draftAnchor})`: a passage just picked takes the composer's focus, one restored on a note switch doesn't. */
  takeAnchorFocus(): boolean;
  open(opts?: OpenCommentsOptions): void;
  close(): void;
  showNewest(): void;
  reportTargetMissing(): void;
  clearDraftAnchor(): void;
}

const noop = () => {};
export const NOOP_COMMENTS: CommentsContextValue = {
  enabled: false,
  noteId: null,
  mode: null,
  panelOpen: false,
  target: null,
  targetSeq: 0,
  targetMissing: false,
  newCommentsPending: false,
  draftAnchor: null,
  readDraft: () => EMPTY_DRAFT,
  saveDraft: noop,
  takeDraft: noop,
  settleSentDraft: noop,
  takeAnchorFocus: () => false,
  open: noop,
  close: noop,
  showNewest: noop,
  reportTargetMissing: noop,
  clearDraftAnchor: noop,
};

const CommentsContext = createContext<CommentsContextValue>(NOOP_COMMENTS);

export function useComments(): CommentsContextValue {
  return useContext(CommentsContext);
}

export function CommentsProvider({ value, children }: { value: CommentsContextValue; children: ReactNode }) {
  return <CommentsContext.Provider value={value}>{children}</CommentsContext.Provider>;
}

/** The subset of `HocuspocusProvider` this needs; the server sends `{type: "comment", op, commentId}` as a stateless message. */
export interface CommentsLiveSource {
  on(event: "stateless", fn: (data: { payload: string }) => void): unknown;
  on(event: "synced", fn: () => void): unknown;
  off(event: "stateless", fn: (data: { payload: string }) => void): unknown;
  off(event: "synced", fn: () => void): unknown;
}

const OPS: readonly CommentChangeOp[] = ["created", "edited", "deleted", "cleared"];

export function parseCommentMessage(payload: string): { op: CommentChangeOp; commentId: string } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const { type, op, commentId } = msg as Record<string, unknown>;
  if (type !== "comment" || typeof commentId !== "string" || !OPS.includes(op as CommentChangeOp)) return null;
  return { op: op as CommentChangeOp, commentId };
}

const MARK_READ_DEBOUNCE_MS = 1000;

function withoutKey<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

export function useCommentsController({
  noteId,
  enabled,
  provider,
  onOpen,
}: {
  noteId: string | null;
  enabled: boolean;
  provider: CommentsLiveSource | null;
  /** Called before opening; NotePage closes the version history here so only one right-hand panel is open. */
  onOpen?: () => void;
}): CommentsContextValue {
  const queryClient = useQueryClient();
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  });
  const [mode, setMode] = useState<CommentsMode | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [targetSeq, setTargetSeq] = useState(0);
  const [targetMissing, setTargetMissing] = useState(false);
  const [newCommentsPending, setNewCommentsPending] = useState(false);
  // Per note, so a passage picked on one note never attaches to a comment on another. Text is in a ref: a keystroke must not render the page.
  const [anchors, setAnchors] = useState<ReadonlyMap<string, CommentDraftAnchor>>(() => new Map());
  const draftsRef = useRef(new Map<string, CommentDraft>());
  const anchorFocusRef = useRef(false);
  const [forNote, setForNote] = useState(noteId);

  // Same rule as the version history: the panel stays open across a note change and shows the new note's thread; the full-page sheet closes.
  if (forNote !== noteId) {
    setForNote(noteId);
    if (mode === "sheet") setMode(null);
    setTarget(null);
    setTargetMissing(false);
    setNewCommentsPending(false);
  }

  const active = enabled && noteId !== null;

  // `noteId === null` is NotePage's note-change transition, not a loss of access: keep the panel for the next note.
  useEffect(() => {
    if (active || noteId === null) return;
    setMode(null);
    setTarget(null);
    draftsRef.current.delete(noteId);
    setAnchors((prev) => withoutKey(prev, noteId));
  }, [active, noteId]);

  useEffect(() => {
    if (mode === null) return;
    const mql = window.matchMedia(PHONE_QUERY);
    const onChange = () => setMode(null);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mode]);

  const isOpen = active && mode !== null;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const targetRef = useRef(target);
  targetRef.current = target;

  const markTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markRead = useCallback(() => {
    if (noteId === null) return;
    void markCommentsRead(noteId).then(
      () => queryClient.setQueryData(commentUnreadKey(noteId, sessionUserId(queryClient)), { count: 0 }),
      () => {},
    );
  }, [noteId, queryClient]);
  const markReadSoon = useCallback(() => {
    clearTimeout(markTimerRef.current);
    markTimerRef.current = setTimeout(markRead, MARK_READ_DEBOUNCE_MS);
  }, [markRead]);
  useEffect(() => () => clearTimeout(markTimerRef.current), [noteId]);

  useEffect(() => {
    if (isOpen) markRead();
  }, [isOpen, markRead]);

  useEffect(() => {
    if (!active || provider === null || noteId === null) return;
    const onStateless = ({ payload }: { payload: string }) => {
      const msg = parseCommentMessage(payload);
      if (msg === null) return;
      void applyCommentChange(queryClient, noteId, msg.op, msg.commentId).then(() => {
        if (msg.op !== "created" || !isOpenRef.current) return;
        markReadSoon();
        const around = targetRef.current;
        if (around !== null && queryClient.getQueryData(commentListKey(noteId, sessionUserId(queryClient), around)) !== undefined && !listHasComment(queryClient, noteId, around, msg.commentId)) {
          setNewCommentsPending(true);
        }
      });
    };
    // Messages sent while disconnected are lost; every (re)sync reloads what is shown.
    const onSynced = () => {
      void queryClient.invalidateQueries({ queryKey: commentListsKey(noteId, sessionUserId(queryClient)) });
      if (isOpenRef.current) markRead();
      else void queryClient.invalidateQueries({ queryKey: commentUnreadKey(noteId, sessionUserId(queryClient)) });
    };
    provider.on("stateless", onStateless);
    provider.on("synced", onSynced);
    return () => {
      provider.off("stateless", onStateless);
      provider.off("synced", onSynced);
    };
  }, [active, provider, noteId, queryClient, markRead, markReadSoon]);

  const open = useCallback(
    (opts?: OpenCommentsOptions) => {
      if (!active) return;
      onOpenRef.current?.();
      setMode(isPhone() ? "sheet" : "panel");
      if (opts?.commentId !== undefined) {
        setTarget(opts.commentId.toLowerCase());
        setTargetSeq((n) => n + 1);
        setTargetMissing(false);
        setNewCommentsPending(false);
      }
      const anchor = opts?.draftAnchor;
      if (anchor !== undefined && noteId !== null) {
        anchorFocusRef.current = true;
        setAnchors((prev) => new Map(prev).set(noteId, anchor));
      }
    },
    [active, noteId],
  );
  const close = useCallback(() => {
    setMode(null);
    setTarget(null);
    setTargetMissing(false);
    setNewCommentsPending(false);
  }, []);
  const showNewest = useCallback(() => {
    setTarget(null);
    setNewCommentsPending(false);
  }, []);
  const reportTargetMissing = useCallback(() => {
    setTarget(null);
    setTargetMissing(true);
    setNewCommentsPending(false);
  }, []);
  const clearDraftAnchor = useCallback(() => {
    if (noteId !== null) setAnchors((prev) => withoutKey(prev, noteId));
  }, [noteId]);
  const readDraft = useCallback(() => (noteId === null ? EMPTY_DRAFT : (draftsRef.current.get(noteId) ?? EMPTY_DRAFT)), [noteId]);
  const saveDraft = useCallback(
    (patch: Partial<CommentDraft>) => {
      if (noteId === null) return;
      const next = { ...(draftsRef.current.get(noteId) ?? EMPTY_DRAFT), ...patch };
      if (next.text === "" && next.replyTo === null) draftsRef.current.delete(noteId);
      else draftsRef.current.set(noteId, next);
    },
    [noteId],
  );
  const takeDraft = useCallback((id: string) => {
    draftsRef.current.delete(id);
    setAnchors((prev) => withoutKey(prev, id));
  }, []);
  const settleSentDraft = useCallback((sent: SentCommentDraft, posted: boolean) => {
    const draft = draftsRef.current.get(sent.noteId);
    if (draft === undefined && posted) return;
    const base = draft ?? { text: sent.text, replyTo: null };
    draftsRef.current.set(sent.noteId, { ...base, replyTo: base.replyTo ?? sent.replyTo });
    const anchor = sent.anchor;
    if (anchor !== null) setAnchors((prev) => (prev.has(sent.noteId) ? prev : new Map(prev).set(sent.noteId, anchor)));
  }, []);
  const takeAnchorFocus = useCallback(() => {
    const take = anchorFocusRef.current;
    anchorFocusRef.current = false;
    return take;
  }, []);
  const draftAnchor = noteId === null ? null : (anchors.get(noteId) ?? null);

  return useMemo<CommentsContextValue>(
    () => ({
      enabled: active,
      noteId,
      mode: active ? mode : null,
      panelOpen: active && mode === "panel",
      target: active ? target : null,
      targetSeq,
      targetMissing: active && targetMissing,
      newCommentsPending: active && newCommentsPending,
      draftAnchor: active ? draftAnchor : null,
      readDraft,
      saveDraft,
      takeDraft,
      settleSentDraft,
      takeAnchorFocus,
      open,
      close,
      showNewest,
      reportTargetMissing,
      clearDraftAnchor,
    }),
    [active, noteId, mode, target, targetSeq, targetMissing, newCommentsPending, draftAnchor, readDraft, saveDraft, takeDraft, settleSentDraft, takeAnchorFocus, open, close, showNewest, reportTargetMissing, clearDraftAnchor],
  );
}
