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
import {
  escapeLinkText,
  INSTRUCTION_MAX_CODE_POINTS,
  mapInlineArrays,
  truncateCodePoints,
  wikilinksToLinks,
  type AiActionDto,
  type AiActionKind,
} from "@knotebook/shared";
import { fetchAiActions, streamAiAction } from "@/api/ai";
import { ApiFail } from "@/api/client";
import { useNotes } from "@/api/notes";
import { applyAiResult, hasNonTextBlock, prepareAiResult, revertAiResult, type PreparedResult } from "@/ai/apply";
import { captureAnchor, verifyAnchor, type AiAnchor } from "@/ai/anchor";
import { buildPreview, isNoChange, stripTextWrapper, type AiPreview } from "@/ai/preview";
import { selectionFocus, selectionInsideAnchor, toolbarWouldShow } from "@/ai/selection";
import { toast } from "@/components/ui/toast";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/ai/apply.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上，Block 的實際泛型三元組
type AnyBlock = Block<any, any, any>;

/**
 * #269 §9.4：送出用 markdown 的匯出副本（不動文件）——wikilink 換成 `[顯示文字](/notes/<id>)` 的 link（`titleOf`＝現行標題查找），
 * 再把 `/notes/` 連結的文字做 markdown 跳脫（RF1，同 server `colors.ts` 的 `escapeNoteLinkText`：`blocksToMarkdownLossy` 不跳脫連結文字，
 * `[Draft]`、`a]b\` 之類的文字送出去會讓 AI 回寫的連結斷掉或 label 變形）。
 */
function blocksForAiMarkdown(blocks: AnyBlock[], titleOf: (id: string) => string | undefined): AnyBlock[] {
  return mapInlineArrays(wikilinksToLinks(blocks, titleOf), (inline) => {
    let changed = false;
    const out = inline.map((node) => {
      const n = node as { type?: unknown; href?: unknown; content?: unknown };
      if (n?.type !== "link" || typeof n.href !== "string" || !n.href.startsWith("/notes/") || !Array.isArray(n.content)) return node;
      changed = true;
      const content = n.content.map((c: { text?: unknown }) => (typeof c?.text === "string" ? { ...c, text: escapeLinkText(c.text) } : c));
      return { ...n, content };
    });
    return changed ? out : inline;
  });
}

/** 框作用的範圍（#263 §5.2）：`open()` 當下的錨點與框選子字串（整塊選取為 `""`）。 */
export interface AiTarget {
  anchor: AiAnchor;
  focus: string;
}

/** 一次送出（`retry()` 原樣重送）。`kind`／`applyMode` 在 `start()` 當下從清單抄下，完成時據此決定要不要自動套用。 */
export interface AiRequest {
  actionId: string;
  actionName: string;
  kind: AiActionKind;
  applyMode: "direct" | "preview";
  /** 實際送出的 markdown（錨點區塊的 `blocksToMarkdownLossy`）。 */
  text: string;
  /** Instruct 才有：trim 後、以 code point 截到 500。 */
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

/** 活動錨點（§5.2）：已自動套用時是插入後的區塊，其餘是 target。定位、寬度量測、D12、錨點失效判定一律用它。 */
export function activeAnchorOf(state: AiSessionState): AiAnchor | null {
  if (state.phase === "idle") return null;
  if (state.phase === "done" && state.applied) return state.applied.insertedAnchor;
  return state.target.anchor;
}

export interface AiSessionValue {
  actions: AiActionDto[];
  state: AiSessionState;
  /** `editable === false` 時入口與框都不渲染（§5.2）。 */
  editable: boolean;
  /** 從當下選取開框（§5.2）：串流中不動作；input／done／error 先 `close()` 再開。 */
  open(): void;
  /** input 態送出（chip 或指令）；真的開始串流回 true。 */
  start(actionId: string, instruction?: string): boolean;
  /** done 態、未套用、非 noChange、且預覽已就緒（`previewReady`，由框推導後傳入，spec §5.2／§5.4）時走守門套用；成功回 true 並回 idle（S1）。 */
  apply(previewReady: boolean): boolean;
  /** 已套用時還原（沿用 `revertAiResult`；stale 時 toast 並清掉 applied）。 */
  revert(): void;
  /** 串流中取消 → idle。 */
  cancel(): void;
  /** done（未套用）／error 態以同一組 request 重送；真的重送回 true。 */
  retry(): boolean;
  /** 任一態 → idle（串流中先 abort）。 */
  close(): void;
}

/** `ShowSelectionExtension.showSelection(bool, key)` 的 key：與 BlockNote 自己的連結鈕等用途分開計（同 key 才互相影響）。 */
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

/** 守門 1 的「同一筆記」半條＋`applyAiResult`＋成功後立刻以 insertedIds 重新 `captureAnchor`——自動套用與手動 `apply()` 共用。 */
function runGuardedApply(editor: AnyEditor, noteId: string, anchor: AiAnchor, prepared: PreparedResult): GuardedApply {
  if (anchor.noteId !== noteId) return { ok: false, reason: "noteMismatch" };
  const outcome = applyAiResult(editor, anchor, prepared);
  if (!outcome.ok) return outcome;
  return { ok: true, insertedAnchor: captureAnchor(editor, noteId, outcome.insertedIds), replacedSnapshot: outcome.replacedSnapshot };
}

/**
 * 框自己的寫入（自動套用、手動套用、還原）期間把旗標設 true（#263 §5.2，修 r4 I-1）：`replaceBlocks` 會平移 target 後方的選取並**同步**發
 * selection change，旗標為真時 D12 回呼直接略過，不把自家寫入誤判成「使用者在別處做了選取」。
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
  /** **測試專用**（生產不傳）：D12 自動關閉時呼叫（§7：手動套用那一半以白箱斷言，`close` 本身不能當掛點）。 */
  onAutoClose?: () => void;
}): JSX.Element {
  const { editor, noteId, editable, children, onAutoClose } = props;
  const { t } = useTranslation();

  const actionsQuery = useQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions });
  // `?? []` 每次 render 都是新陣列 identity——用模組層常數＋useMemo 釘住，只在 data 換手時才變（exhaustive-deps 是 warn＝紅）。
  const actions = useMemo(() => actionsQuery.data ?? EMPTY_ACTIONS, [actionsQuery.data]);
  const notesQuery = useNotes();

  const [state, setState] = useState<AiSessionState>(IDLE_STATE);

  // 讀最新值但不進任何 callback 的依賴陣列（同既有 `NoteEditor.tsx` 的 translateRef 手法）：串流續體與選取回呼都要讀到「此刻」的值。
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const notesRef = useRef(notesQuery.data ?? []);
  notesRef.current = notesQuery.data ?? [];
  // #269 §9.4：送出前的現行標題查找（讀 ref——串流續體與選取回呼要讀到「此刻」的清單）。
  const titleOf = useCallback((id: string) => notesRef.current.find((n) => n.id === id)?.title, []);
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

  // 目前這一輪串流的 abort 控制器，同時當「這個續體還算不算數」的識別碼：close／新一輪 run 會換掉它，舊續體比對不到就 no-op。
  const abortRef = useRef<AbortController | null>(null);
  const partialRef = useRef("");
  const selfWriteRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const closeInternal = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE_STATE);
  }, []);

  /** 串流完成（§5.2，順序固定）：0 剝外殼 → 1 prepare（空→error）→ 2 先凍結 Preview → 3 noChange → 4 決定自動套用 → 5 done。 */
  const finish = useCallback((target: AiTarget, request: AiRequest, raw: string) => {
    const ed = editorRef.current;
    const markdown = stripTextWrapper(raw);
    const prepared = prepareAiResult(ed, markdown, { notes: notesRef.current });
    if ("empty" in prepared) {
      setState({ phase: "error", target, request, code: "empty_result" });
      return;
    }
    const preview = buildPreview(ed, target.anchor.blockIds, prepared.blocks, isNoChange(markdown, request.text));
    let applied: AiApplied | null = null;
    const autoApply =
      request.kind === "quick" &&
      request.applyMode === "direct" &&
      !hasNonTextBlock(ed, target.anchor.blockIds) &&
      !preview.noChange;
    if (autoApply) {
      // 讀 noteIdRef（不是 target.anchor.noteId）：串流期間筆記若換手，守門 1 的 noteMismatch 才是活的判斷。
      const outcome = withSelfWrite(selfWriteRef, () => runGuardedApply(ed, noteIdRef.current, target.anchor, prepared));
      if (outcome.ok) {
        applied = { insertedAnchor: outcome.insertedAnchor, replacedSnapshot: outcome.replacedSnapshot };
        if (prepared.unboundCount > 0) toast({ title: tRef.current("ai.box.rebindNotice") });
      } else {
        toast({ title: tRef.current("ai.box.applyGuardFailed") });
      }
    }
    setState({ phase: "done", target, request, prepared, preview, applied });
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
        // §5.2 start()：focus 只有 Instruct 送，且 "" 時不送該欄位（非 Instruct 帶了 server 會回 400）。
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
          finish(target, request, partialRef.current);
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
    if (stateRef.current.phase === "streaming") return; // 串流中 AI 鈕本來就停用（S2）
    if (stateRef.current.phase !== "idle") closeInternal(); // 舊結果、還原入口、標亮一併丟棄
    const ed = editorRef.current;
    const blocks = ed.getSelection()?.blocks;
    if (!blocks || blocks.length === 0) return; // 空選取與 NodeSelection 都回 undefined
    const blockIds = blocks.map((block: AnyBlock) => block.id);
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
      if (verifyAnchor(ed, current.target.anchor) !== "ok") return false; // 原文已變更：框只剩捨棄
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
        text: ed.blocksToMarkdownLossy(blocksForAiMarkdown(blocks, titleOf)),
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
    // 不變量進狀態機本身（spec §5.2）：預覽未就緒、已套用、noChange、非 done 一律不動——不只靠 UI 停用套用鈕。
    // previewReady 由框推導（`readyFor === state.preview`，§5.4），狀態機不持有預覽子元件的生命週期，所以以參數傳入。
    if (!previewReady || current.phase !== "done" || current.applied !== null || current.preview.noChange) return false;
    const ed = editorRef.current;
    const outcome = withSelfWrite(selfWriteRef, () => runGuardedApply(ed, noteIdRef.current, current.target.anchor, current.prepared));
    if (!outcome.ok) {
      toast({ title: tRef.current("ai.box.applyGuardFailed") });
      return false;
    }
    if (current.prepared.unboundCount > 0) toast({ title: tRef.current("ai.box.rebindNotice") });
    setState(IDLE_STATE); // S1：使用者自己按的套用就關，復原靠 Ctrl+Z
    return true;
  }, []);

  const revert = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== "done" || !current.applied) return;
    const { insertedAnchor, replacedSnapshot } = current.applied;
    const outcome = withSelfWrite(selfWriteRef, () => revertAiResult(editorRef.current, insertedAnchor, replacedSnapshot));
    if (outcome === "stale") toast({ title: tRef.current("ai.box.revertStale") });
    // 成功：回到「尚未套用」，按鈕列回「套用／捨棄／重試」；stale：沿用現況清掉 applied（還原入口沒了）。
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

  // D12（§5.2）：掛在 onSelectionChange（不是工具列 store：store 在 pointerdown 期間恆為 false、pointerup 寫回 true 時不再有 selection
  // change，拿它判會漏掉滑鼠拖選）。只在選取事件裡判，不以 effect 在 phase 變更時重評——streaming→done 是 setState、不產生選取事件，
  // 所以「串流完成當下即使選取在 target 外也不關」是結構保證。onSelectionChange 預設不含遠端（y-sync）造成的選取變更。
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

  // 標亮（§5.2）：phase !== idle 驅動 ShowSelectionExtension。它跟的是**當下選取**——使用者點到別處後標亮跟著移走、框仍釘在原區塊旁，
  // 接受（spec §5.6）。初始 idle 不呼叫（editor 此時可能還沒被 BlockNoteView 掛上，showSelection 會 dispatch）。
  const highlight = state.phase !== "idle";
  const highlightRef = useRef(false);
  useEffect(() => {
    if (highlightRef.current === highlight) return;
    highlightRef.current = highlight;
    editor.getExtension(ShowSelectionExtension)?.showSelection(highlight, SELECTION_AI_HIGHLIGHT_KEY);
  }, [editor, highlight]);

  // editable 轉 false（實務上只有角色被降為 viewer）：收回 idle（串流中先 abort）。
  useEffect(() => {
    if (!editable) closeInternal();
  }, [editable, closeInternal]);

  // noteId 換手：任一非 idle 態回 idle（串流中先 abort）。
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
