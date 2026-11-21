import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import type { Block, BlockNoteEditor } from "@blocknote/core";
import { ShowSelectionExtension } from "@blocknote/core/extensions";
import { INSTRUCTION_MAX_CODE_POINTS, truncateCodePoints, type AiActionDto, type AiActionKind } from "@knotebook/shared";
import { fetchAiActions, streamAiAction } from "@/api/ai";
import { ApiFail } from "@/api/client";
import { useNotes } from "@/api/notes";
import { sameNoteId } from "@/lib/note-id";
import { aiKnowledgeContext, anchorPlacement, applyAiResult, expandAnchorForColumns, hasNonTextBlock, prepareAiResult, revertAiResult, type PreparedResult } from "@/ai/apply";
import { captureAnchor, verifyAnchor, type AiAnchor } from "@/ai/anchor";
import { estimateBlocksBytes } from "@/lib/note-size-guard";
import { aiMarkdownOf } from "@/ai/note-markdown";
import { buildPreview, isNoChange, stripTextWrapper, type AiPreview } from "@/ai/preview";
import { selectionFocus, selectionInsideAnchor, toolbarWouldShow } from "@/ai/selection";
import { toast } from "@/components/ui/toast";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; repo convention is any
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above, Block's generic triple
type AnyBlock = Block<any, any, any>;

export interface AiTarget {
  anchor: AiAnchor;
  /** Selected substring at `open()`; `""` when whole blocks are selected. */
  focus: string;
}

/** Resent unchanged by `retry()`; `kind`/`applyMode` are copied from the action list at `start()`; completion decides auto-apply from these copies. */
export interface AiRequest {
  actionId: string;
  actionName: string;
  kind: AiActionKind;
  applyMode: "direct" | "preview";
  /** Same serialization as MCP reads (`aiMarkdownOf`), so colors, columns and widths are carried. */
  text: string;
  /** Instruct only. Trimmed, cut to 500 code points. */
  instruction?: string;
}

export interface AiApplied {
  insertedAnchor: AiAnchor;
  replacedSnapshot: AnyBlock[];
}

export type AiSessionState =
  | { phase: "idle" }
  | { phase: "input"; target: AiTarget }
  | { phase: "streaming"; target: AiTarget; request: AiRequest; partial: string }
  | { phase: "done"; target: AiTarget; request: AiRequest; prepared: PreparedResult; preview: AiPreview; applied: AiApplied | null }
  | { phase: "error"; target: AiTarget; request: AiRequest; code: string };

/** Use this, not `target`, for positioning, width measurement, auto-close and anchor invalidation: after auto-apply it is the inserted blocks. */
export function activeAnchorOf(state: AiSessionState): AiAnchor | null {
  if (state.phase === "idle") return null;
  if (state.phase === "done" && state.applied) return state.applied.insertedAnchor;
  return state.target.anchor;
}

export interface AiSessionValue {
  actions: AiActionDto[];
  state: AiSessionState;
  editable: boolean;
  open(): void;
  /** start/apply/retry return true only when they took effect; RunWithFocus skips its focus move on false. */
  start(actionId: string, instruction?: string): boolean;
  apply(previewReady: boolean): boolean;
  revert(): void;
  cancel(): void;
  retry(): boolean;
  close(): void;
}

/** Separate key from BlockNote's own link button, so the two don't affect each other. */
export const SELECTION_AI_HIGHLIGHT_KEY = "selection-ai";

const AiSessionContext = createContext<AiSessionValue | null>(null);

export function useAiSession(): AiSessionValue {
  const value = useContext(AiSessionContext);
  if (!value) throw new Error("useAiSession must be used within an AiSessionProvider");
  return value;
}

const IDLE_STATE: AiSessionState = { phase: "idle" };
const EMPTY_ACTIONS: AiActionDto[] = [];

type GuardedApply =
  | { ok: true; insertedAnchor: AiAnchor; replacedSnapshot: AnyBlock[] }
  | { ok: false; reason: "missing" | "changed" | "noteMismatch" };

function aiGrowthBytes(editor: AnyEditor, anchor: AiAnchor, prepared: PreparedResult): number {
  // Missing anchor blocks are skipped: the apply guard rejects that case anyway.
  const replaced = anchor.blockIds.map(id => editor.getBlock(id)).filter((b): b is NonNullable<typeof b> => b !== undefined);
  return estimateBlocksBytes(prepared.blocks) - estimateBlocksBytes(replaced);
}

function runGuardedApply(editor: AnyEditor, noteId: string, anchor: AiAnchor, prepared: PreparedResult): GuardedApply {
  if (anchor.noteId !== noteId) return { ok: false, reason: "noteMismatch" };
  const outcome = applyAiResult(editor, anchor, prepared);
  if (!outcome.ok) return outcome;
  return { ok: true, insertedAnchor: captureAnchor(editor, noteId, outcome.insertedIds), replacedSnapshot: outcome.replacedSnapshot };
}

/**
 * Holds `flag` true during the box's own writes (auto-apply, manual apply, revert): `replaceBlocks` shifts the selection after the target and fires selection change
 * synchronously, which auto-close would otherwise take for the user selecting elsewhere.
 */
function withSelfWrite<T>(flag: { current: boolean }, fn: () => T): T {
  flag.current = true;
  try {
    return fn();
  } finally {
    flag.current = false;
  }
}

export function AiSessionProvider(props: {
  editor: AnyEditor;
  noteId: string;
  editable: boolean;
  children: ReactNode;
  /** Test only: called on auto-close (`close` itself can't serve as the hook). */
  onAutoClose?: () => void;
  /** Returns true when the content would exceed the note size limit; it has already shown the notice. Omit to skip the check. */
  sizeGuard?: (incomingBytes: number) => boolean;
}): JSX.Element {
  const { editor, noteId, editable, children, onAutoClose, sizeGuard } = props;
  const sizeGuardRef = useRef(sizeGuard);
  sizeGuardRef.current = sizeGuard;
  const { t } = useTranslation();

  const actionsQuery = useQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions });
  // `?? []` is a new array every render; a module constant + useMemo keeps the identity stable (exhaustive-deps warnings fail lint).
  const actions = useMemo(() => actionsQuery.data ?? EMPTY_ACTIONS, [actionsQuery.data]);
  const notesQuery = useNotes();

  const [state, setState] = useState<AiSessionState>(IDLE_STATE);

  // Read the latest value without making it a callback dependency: stream continuations and selection callbacks need "now".
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const notesRef = useRef(notesQuery.data ?? []);
  notesRef.current = notesQuery.data ?? [];
  // Case-insensitive id match: old documents may store `targetNoteId` in uppercase; the list is lowercase.
  const titleOf = useCallback((id: string) => notesRef.current.find((n) => sameNoteId(n.id, id))?.title, []);
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const tRef = useRef(t);
  tRef.current = t;
  const onAutoCloseRef = useRef(onAutoClose);
  onAutoCloseRef.current = onAutoClose;

  // Doubles as the "is this continuation still current" token: close / a new run replaces it, so a stale continuation no-ops.
  const abortRef = useRef<AbortController | null>(null);
  const partialRef = useRef("");
  const selfWriteRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const closeInternal = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE_STATE);
  }, []);

  const finish = useCallback((target: AiTarget, request: AiRequest, raw: string) => {
    const ed = editorRef.current;
    const markdown = stripTextWrapper(raw);
    const prepared = prepareAiResult(ed, markdown, {
      notes: notesRef.current,
      placement: anchorPlacement(ed, target.anchor.blockIds),
      knowledge: aiKnowledgeContext(ed, noteIdRef.current, target.anchor.blockIds),
    });
    if ("empty" in prepared) {
      setState({ phase: "error", target, request, code: "empty_result" });
      return;
    }
    if ("invalid" in prepared) {
      setState({ phase: "error", target, request, code: prepared.invalid }); // columns: same validation as MCP
      return;
    }
    // Preview before auto-apply: applying replaces the anchor blocks the preview reads.
    const preview = buildPreview(ed, target.anchor.blockIds, prepared.blocks, isNoChange(markdown, request.text));
    let applied: AiApplied | null = null;
    let notice: "ai.box.rebindNotice" | "ai.box.applyGuardFailed" | null = null;
    const autoApply =
      request.kind === "quick" &&
      request.applyMode === "direct" &&
      !hasNonTextBlock(ed, target.anchor.blockIds) &&
      !preview.noChange;
    // Over the note size limit (the guard has shown the notice): skip auto-apply; the box still reaches done with the
    // preview, and manual apply checks again.
    const sizeBlocked = autoApply && sizeGuardRef.current?.(aiGrowthBytes(ed, target.anchor, prepared)) === true;
    if (autoApply && !sizeBlocked) {
      // Read noteIdRef, not target.anchor.noteId: the note may change while streaming, which noteMismatch must see.
      const outcome = withSelfWrite(selfWriteRef, () => runGuardedApply(ed, noteIdRef.current, target.anchor, prepared));
      if (outcome.ok) {
        applied = { insertedAnchor: outcome.insertedAnchor, replacedSnapshot: outcome.replacedSnapshot };
        if (prepared.unboundCount > 0) notice = "ai.box.rebindNotice";
      } else {
        notice = "ai.box.applyGuardFailed";
      }
    }
    // Enter done before toasting: the revert entry lives in done, and a later throw must not turn it into error.
    setState({ phase: "done", target, request, prepared, preview, applied });
    if (notice !== null) toast({ title: tRef.current(notice) });
  }, []);

  const run = useCallback(
    (target: AiTarget, request: AiRequest) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      partialRef.current = "";
      setState({ phase: "streaming", target, request, partial: "" });
      streamAiAction({
        actionId: request.actionId,
        noteId: target.anchor.noteId,
        text: request.text,
        ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
        // Send focus only for Instruct and not when empty: the server answers 400 for it on other kinds.
        ...(request.kind === "instruct" && target.focus !== "" ? { focus: target.focus } : {}),
        signal: controller.signal,
        onDelta: (delta) => {
          if (abortRef.current !== controller) return;
          partialRef.current += delta;
          setState((prev) => (prev.phase === "streaming" ? { ...prev, partial: prev.partial + delta } : prev));
        },
      }).then(
        () => {
          if (abortRef.current !== controller) return;
          abortRef.current = null;
          try {
            finish(target, request, partialRef.current);
          } catch {
            // Failure callbacks below don't see a throw from here: still streaming -> error; already done -> keep the revert entry.
            setState((prev) => (prev.phase === "streaming" ? { phase: "error", target, request, code: "internal" } : prev));
          }
        },
        (err: unknown) => {
          if (abortRef.current !== controller) return;
          abortRef.current = null;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setState({ phase: "error", target, request, code: err instanceof ApiFail ? err.code : "internal" });
        },
      );
    },
    [finish],
  );

  const open = useCallback(() => {
    if (!editableRef.current) return;
    if (stateRef.current.phase === "streaming") return;
    if (stateRef.current.phase !== "idle") closeInternal();
    const ed = editorRef.current;
    const blocks = ed.getSelection()?.blocks;
    if (!blocks || blocks.length === 0) return; // empty selection and NodeSelection both give undefined
    const blockIds = expandAnchorForColumns(ed, blocks); // columns: widen to the whole top-level row for sending and applying
    const anchor = captureAnchor(ed, noteIdRef.current, blockIds);
    const focus = ed.transact((tr) => selectionFocus(tr, blockIds, titleOf));
    setState({ phase: "input", target: { anchor, focus } });
  }, [closeInternal, titleOf]);

  const start = useCallback(
    (actionId: string, instruction?: string): boolean => {
      const current = stateRef.current;
      if (current.phase !== "input") return false;
      const action = actionsRef.current.find((candidate) => candidate.id === actionId);
      if (!action) return false;
      const ed = editorRef.current;
      if (verifyAnchor(ed, current.target.anchor) !== "ok") return false;
      let trimmed: string | undefined;
      if (action.kind === "instruct") {
        trimmed = truncateCodePoints((instruction ?? "").trim(), INSTRUCTION_MAX_CODE_POINTS);
        if (trimmed === "") return false;
      }
      const blocks = current.target.anchor.blockIds
        .map((id) => ed.getBlock(id))
        .filter((block): block is AnyBlock => block !== undefined);
      const request: AiRequest = {
        actionId: action.id,
        actionName: action.name,
        kind: action.kind,
        applyMode: action.applyMode,
        text: aiMarkdownOf(blocks, titleOf, { knowledge: anchorPlacement(ed, current.target.anchor.blockIds) === "top" }),
        ...(trimmed !== undefined ? { instruction: trimmed } : {}),
      };
      run(current.target, request);
      return true;
    },
    [run, titleOf],
  );

  const retry = useCallback((): boolean => {
    const current = stateRef.current;
    if (current.phase !== "error" && !(current.phase === "done" && current.applied === null)) return false;
    if (verifyAnchor(editorRef.current, current.target.anchor) !== "ok") return false;
    run(current.target, current.request);
    return true;
  }, [run]);

  const apply = useCallback((previewReady: boolean): boolean => {
    const current = stateRef.current;
    // Invariant lives in the state machine, not only in the disabled apply button. previewReady (the box derives it from
    // `readyFor === state.preview`) is passed in because the machine doesn't own the preview child's lifecycle.
    if (!previewReady || current.phase !== "done" || current.applied !== null || current.preview.noChange) return false;
    const ed = editorRef.current;
    if (sizeGuardRef.current?.(aiGrowthBytes(ed, current.target.anchor, current.prepared)) === true) return false; // guard has shown the notice
    const outcome = withSelfWrite(selfWriteRef, () => runGuardedApply(ed, noteIdRef.current, current.target.anchor, current.prepared));
    if (!outcome.ok) {
      toast({ title: tRef.current("ai.box.applyGuardFailed") });
      return false;
    }
    if (current.prepared.unboundCount > 0) toast({ title: tRef.current("ai.box.rebindNotice") });
    setState(IDLE_STATE); // a manual apply closes the box; undo is Ctrl+Z
    return true;
  }, []);

  const revert = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== "done" || !current.applied) return;
    const { insertedAnchor, replacedSnapshot } = current.applied;
    const outcome = withSelfWrite(selfWriteRef, () => revertAiResult(editorRef.current, insertedAnchor, replacedSnapshot));
    if (outcome === "stale") toast({ title: tRef.current("ai.box.revertStale") });
    setState({ ...current, applied: null });
  }, []);

  const cancel = useCallback(() => {
    if (stateRef.current.phase !== "streaming") return;
    closeInternal();
  }, [closeInternal]);

  const close = useCallback(() => {
    if (stateRef.current.phase === "idle") return;
    closeInternal();
  }, [closeInternal]);

  // Hooked on onSelectionChange, not the toolbar store: the store is false during pointerdown and turns true on pointerup
  // without another selection change, so mouse drags would be missed. Not re-evaluated on phase change: streaming->done fires
  // no selection event, so finishing with the selection outside the target never closes. onSelectionChange excludes remote
  // (y-sync) selection changes by default.
  useEffect(
    () =>
      editor.onSelectionChange(() => {
        if (selfWriteRef.current) return;
        const current = stateRef.current;
        if (current.phase === "idle" || current.phase === "streaming") return;
        const anchor = activeAnchorOf(current);
        if (!anchor) return;
        const outside = editor.transact((tr) => toolbarWouldShow(tr) && !selectionInsideAnchor(tr, anchor.blockIds));
        if (!outside) return;
        onAutoCloseRef.current?.();
        closeInternal();
      }),
    [editor, closeInternal],
  );

  // Highlight follows the current selection: after the user clicks elsewhere it moves away while the box stays pinned to
  // the block; accepted. Not called for the initial idle: BlockNoteView may not have mounted the editor yet, and
  // showSelection dispatches.
  const highlight = state.phase !== "idle";
  const highlightRef = useRef(false);
  useEffect(() => {
    if (highlightRef.current === highlight) return;
    highlightRef.current = highlight;
    editor.getExtension(ShowSelectionExtension)?.showSelection(highlight, SELECTION_AI_HIGHLIGHT_KEY);
  }, [editor, highlight]);

  // In practice editable turns false on a demotion to viewer or when the outdated-client gate (#269) trips.
  useEffect(() => {
    if (!editable) closeInternal();
  }, [editable, closeInternal]);

  const prevNoteIdRef = useRef(noteId);
  useEffect(() => {
    if (prevNoteIdRef.current === noteId) return;
    prevNoteIdRef.current = noteId;
    closeInternal();
  }, [noteId, closeInternal]);

  const value = useMemo<AiSessionValue>(
    () => ({ actions, state, editable, open, start, apply, revert, cancel, retry, close }),
    [actions, state, editable, open, start, apply, revert, cancel, retry, close],
  );

  return <AiSessionContext.Provider value={value}>{children}</AiSessionContext.Provider>;
}
