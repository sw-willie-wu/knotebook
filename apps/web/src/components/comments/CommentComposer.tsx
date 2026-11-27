import "@/i18n/comments-strings";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { COMMENT_BODY_MAX, COMMENT_MENTIONS_MAX, parseMentionSpans, type CommentDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useEditComment, useMentionCandidates, usePostComment, useUnmatchedHandles } from "@/api/comments";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import type { CommentDraftAnchor, SentCommentDraft } from "@/lib/comments-context";
import { cn } from "@/lib/utils";
import { authorName } from "./comment-format";
import { MentionList, buildMentionOptions, mentionOptionId, type MentionOption } from "./MentionList";
import { mentionTokenAt } from "./mention-token";

// Same idle time as the email suggestions, kept local so the lazy chunk adds nothing to the entry chunk's exports.
const SUGGEST_DEBOUNCE_MS = 200;

const HANDLE_CHAR = /[A-Za-z0-9-]/;
const LABEL_CHAR = /[A-Za-z0-9._-]/;

/** The counter appears this close to the cap. */
const COUNTER_FROM = 3600;

export interface CommentComposerProps {
  noteId: string;
  /** Passage a new comment is attached to; null = a comment on the whole note. Not used while editing. */
  draftAnchor: CommentDraftAnchor | null;
  onClearAnchor: () => void;
  /** The comment a new one answers; null = not a reply. */
  replyTo: CommentDto | null;
  /** The comment being edited; null = writing a new one. */
  editing: CommentDto | null;
  /** After a successful post or save, with the comment the server returned; with null when a reply or edit is cancelled. */
  onDone: (saved: CommentDto | null) => void;
  /** Whether an edit has unsaved changes; false again when the composer goes away. */
  onDirtyChange?: (dirty: boolean) => void;
  /** A new comment's text to start from, and every change to it, so an unsent comment outlives the composer. */
  initialText?: string;
  onTextChange?: (text: string) => void;
  /** When a new comment's post starts, and when it ends (also when the composer is gone by then). */
  onSendStart?: (noteId: string) => void;
  onSendEnd?: (sent: SentCommentDraft, posted: boolean) => void;
  /** Whether the passage takes focus; without it, it always does. */
  takeAnchorFocus?: () => boolean;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Remount it (`key`) when `editing` changes: the text starts from the edited comment's body. */
export function CommentComposer({ noteId, draftAnchor, onClearAnchor, replyTo, editing, onDone, onDirtyChange, initialText, onTextChange, onSendStart, onSendEnd, takeAnchorFocus }: CommentComposerProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [text, setText] = useState(editing?.body ?? initialText ?? "");
  useEffect(() => {
    onTextChange?.(text);
  }, [text, onTextChange]);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // Esc hides the list for the token it was pressed on; blur hides it until the next focus or edit.
  const [escapedAt, setEscapedAt] = useState<number | null>(null);
  const [blurred, setBlurred] = useState(false);
  const [box, setBox] = useState<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const anchorRef = useRef(draftAnchor);
  anchorRef.current = draftAnchor;
  const textRef = useRef(text);
  textRef.current = text;
  // A reply restored with the draft (the thread remounted on a note switch) leaves focus where the person is.
  const restoredReplyRef = useRef<CommentDto | null | undefined>(replyTo);
  useEffect(() => {
    if (editing !== null) {
      box?.focus();
      return;
    }
    if (replyTo === restoredReplyRef.current) return;
    restoredReplyRef.current = undefined;
    if (replyTo !== null) box?.focus();
  }, [replyTo, editing, box]);
  // A passage picked in the note leaves focus in the editor or its toolbar, and the next thing the person does is type the comment.
  useEffect(() => {
    if (draftAnchor !== null && editing === null && box !== null && (takeAnchorFocus?.() ?? true)) box.focus({ preventScroll: true });
  }, [draftAnchor, editing, box, takeAnchorFocus]);
  const post = usePostComment(noteId);
  const edit = useEditComment();
  const pending = post.isPending || edit.isPending;
  const length = useMemo(() => [...text].length, [text]);
  const tooLong = length > COMMENT_BODY_MAX;
  const dirty = editing !== null && text !== editing.body;
  const canSend = text.trim() !== "" && !tooLong && !pending && (editing === null || dirty);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const token = useMemo(() => (caret === null ? null : mentionTokenAt(text, caret)), [text, caret]);
  const debouncedHandle = useDebounced(token?.handle ?? null, SUGGEST_DEBOUNCE_MS);
  const candidates = useMentionCandidates(noteId, debouncedHandle, token !== null);
  const options = useMemo(
    () => (token !== null && debouncedHandle === token.handle && candidates.data !== undefined && !candidates.isPlaceholderData ? buildMentionOptions(candidates.data, token) : []),
    [token, debouncedHandle, candidates.data, candidates.isPlaceholderData],
  );
  const expanded = options.length > 0 && !blurred && token !== null && token.start !== escapedAt;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  // Handles in the text that resolve to nobody who can read the note. The span being typed is left out by position, and the
  // list is built from one snapshot of `text` before it is debounced, so a half-typed or just-picked handle is never judged.
  const liveHandles = useMemo(() => {
    const tokenStart = token === null ? -1 : [...text.slice(0, token.start)].length;
    const seen = new Set<string>();
    for (const span of parseMentionSpans(text)) {
      if (seen.size >= COMMENT_MENTIONS_MAX) break;
      if (span.start !== tokenStart) seen.add(span.handle);
    }
    return [...seen];
  }, [text, token]);
  const judgedKey = useDebounced(liveHandles.join(","), SUGGEST_DEBOUNCE_MS);
  const judged = useMemo(() => (judgedKey === "" ? [] : judgedKey.split(",")), [judgedKey]);
  const unmatched = useUnmatchedHandles(noteId, judged).filter((h) => liveHandles.includes(h));

  useLayoutEffect(() => {
    const next = pendingCaretRef.current;
    if (next === null || box === null || box.value !== text) return;
    pendingCaretRef.current = null;
    box.setSelectionRange(next, next);
  }, [text, box]);

  const fail = (err: unknown) =>
    toast({
      title: err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback"),
      variant: "destructive",
    });

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    if (editing !== null) {
      edit.mutate({ commentId: editing.id, body: text }, { onSuccess: (saved) => onDone(saved), onError: fail });
      return;
    }
    const sent = { noteId, text, replyTo, anchor: draftAnchor };
    onSendStart?.(noteId);
    // Not `mutate`'s own callbacks: they are skipped once the composer unmounts, and the draft must be settled either way.
    post
      .mutateAsync({
        body: text,
        ...(replyTo !== null ? { replyToId: replyTo.id } : {}),
        ...(draftAnchor !== null ? { anchor: { blockId: draftAnchor.blockId, quote: draftAnchor.quote === "" ? null : draftAnchor.quote } } : {}),
      })
      .then(
        (saved) => {
          onSendEnd?.(sent, true);
          // Text typed while the post was on its way stays, and so do its reply and passage.
          if (!mountedRef.current || textRef.current !== sent.text) return;
          setText("");
          setCaret(null);
          if (anchorRef.current === sent.anchor) onClearAnchor();
          onDone(saved);
        },
        (err: unknown) => {
          onSendEnd?.(sent, false);
          fail(err);
        },
      );
  };

  const pick = (option: MentionOption) => {
    if (token === null) return;
    // The rest of the word to the right of the caret belongs to the token being replaced.
    let end = token.end;
    const rest = token.label !== null ? LABEL_CHAR : HANDLE_CHAR;
    while (end < text.length && rest.test(text[end]!)) end++;
    if (token.label === null && option.label !== null && text[end] === "/") {
      end++;
      while (end < text.length && LABEL_CHAR.test(text[end]!)) end++;
    }
    const spaced = end < text.length && /\s/.test(text[end]!);
    const insert = spaced ? option.insert : `${option.insert} `;
    const next = token.start + option.insert.length + 1;
    pendingCaretRef.current = next;
    setText(text.slice(0, token.start) + insert + text.slice(end));
    setCaret(next);
    setActive(0);
    box?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari ends a composition with an Enter that already reports isComposing = false and keyCode 229.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (!expanded) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((activeIndex + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((activeIndex - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(options[activeIndex]!);
    } else if (event.key === "Escape") {
      // Same event would otherwise reach the panel or sheet; they stay open while there is a draft, but only the list should react.
      event.preventDefault();
      event.stopPropagation();
      setEscapedAt(token!.start);
    }
  };

  const syncCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };
  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => syncCaret(event.currentTarget);

  const context = editing !== null ? t("comments.composer.editing") : replyTo !== null ? t("comments.composer.replyingTo", { who: authorName(replyTo) }) : null;
  const unmatchedId = `${listId}-unmatched`;
  const counterId = `${listId}-counter`;
  const describedBy = [unmatched.length > 0 ? unmatchedId : null, length >= COUNTER_FROM ? counterId : null].filter(Boolean).join(" ");

  return (
    <form data-testid="comment-composer" onSubmit={submit} className="space-y-2 border-t border-border p-3">
      {context !== null && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{context}</span>
          <Button type="button" variant="ghost" size="sm" className="px-2 text-xs" onClick={() => onDone(null)}>
            {t("comments.cancel")}
          </Button>
        </div>
      )}
      {editing === null && draftAnchor !== null && (
        <div data-testid="composer-anchor" className="flex items-start gap-1 rounded-md border border-border bg-brand-soft px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 line-clamp-2">{draftAnchor.quote || t("comments.passage")}</span>
          <button type="button" aria-label={t("comments.composer.removePassage")} onClick={onClearAnchor} className="rounded-sm p-0.5 text-muted-foreground hover:bg-brand-soft-strong pointer-coarse:p-2">
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
      )}
      <textarea
        ref={setBox}
        aria-label={t("comments.composer.label")}
        placeholder={t("comments.composer.placeholder")}
        aria-autocomplete="list"
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded ? mentionOptionId(listId, activeIndex) : undefined}
        aria-describedby={describedBy || undefined}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          syncCaret(event.target);
          setActive(0);
          setBlurred(false);
        }}
        onSelect={onSelect}
        onFocus={() => setBlurred(false)}
        onBlur={() => setBlurred(true)}
        onKeyDown={onKeyDown}
        rows={3}
        className="block w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:text-base"
      />
      {expanded && <MentionList id={listId} options={options} active={activeIndex} reference={box} onPick={pick} onHover={setActive} />}
      {/* Always mounted: a live region that appears together with its text is often not announced. */}
      <p id={unmatchedId} role="status" data-testid="mention-unmatched" className="text-xs text-muted-foreground empty:sr-only">
        {unmatched.length > 0 ? t("comments.composer.unmatched", { handles: unmatched.map((h) => `@${h}`).join(", ") }) : null}
      </p>
      <div className="flex items-center justify-end gap-3">
        {length >= COUNTER_FROM && (
          <span id={counterId} data-testid="comment-counter" className={cn("text-xs tabular-nums text-muted-foreground", tooLong && "text-destructive")}>
            {t("comments.composer.counter", { count: length, max: COMMENT_BODY_MAX })}
          </span>
        )}
        <Button type="submit" size="sm" variant="brandDeep" disabled={!canSend}>
          {editing !== null ? t("comments.composer.save") : t("comments.composer.send")}
        </Button>
      </div>
    </form>
  );
}
