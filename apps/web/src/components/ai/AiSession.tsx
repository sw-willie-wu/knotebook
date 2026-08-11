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
import type { AiActionDto } from "@knotebook/shared";
import { fetchAiActions, streamAiAction } from "@/api/ai";
import { ApiFail } from "@/api/client";
import { useNotes } from "@/api/notes";
import { applyAiResult, hasNonTextBlock, revertAiResult } from "@/ai/apply";
import { captureAnchor, verifyAnchor, type AiAnchor } from "@/ai/anchor";
import { toast } from "@/components/ui/toast";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 NoteEditor.tsx/ai/apply.ts）
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上，Block 的實際泛型三元組
type AnyBlock = Block<any, any, any>;

export type AiPanelState =
  | { phase: "idle" }
  | { phase: "streaming"; actionName: string; partial: string }
  | {
      phase: "done";
      actionName: string;
      result: string;
      anchor: AiAnchor;
      /** preview 動作／全文／hasNonTextBlock 任一成因，或自動套用本身失敗——true 時側欄顯示「套用」鈕。 */
      pendingPreview: boolean;
      applied: { insertedAnchor: AiAnchor; replacedSnapshot: AnyBlock[] } | null;
    }
  | { phase: "error"; code: string };

export interface AiSessionValue {
  actions: AiActionDto[];
  state: AiPanelState;
  start(actionId: string): void;
  apply(): void;
  revert(): void;
  cancel(): void;
  dismiss(): void;
  /** 錯誤態的重試——重跑上一次呼叫的 `start(actionId)`。brief 的 Produces 區塊沒列出這支，
   * 是 Step 3「錯誤態…重試鈕」這條驗收條件在實作層必要的延伸（面板需要一個入口，而不是
   * 自己記住上一個 actionId）。 */
  retry(): void;
  /** `editable===false`（viewer）或 `actions.length===0` 時，toolbar 的 AI 項與側欄發起區
   * 皆不渲染——這兩處判定共用同一個來源，不重複從別的 context 拉。 */
  editable: boolean;
  /** 側欄收合狀態（brief 原文：「收合狀態也在 AiSession」，預設收合、`start()` 自動展開）。 */
  collapsed: boolean;
  setCollapsed(collapsed: boolean): void;
  /** revert 鈕啟用判定：`applied !== null && verifyAnchor(editor, applied.insertedAnchor) ===
   * "ok"`——brief 明文要求「render 時即時判」，故意不是 state 的一部分、不快取，每次呼叫
   * 都對 `editor` 現況重新算一次。 */
  canRevert(): boolean;
}

const AiSessionContext = createContext<AiSessionValue | null>(null);

export function useAiSession(): AiSessionValue {
  const value = useContext(AiSessionContext);
  if (!value) throw new Error("useAiSession must be used within an AiSessionProvider");
  return value;
}

const IDLE_STATE: AiPanelState = { phase: "idle" };
const EMPTY_ACTIONS: AiActionDto[] = [];

/** `applyAiResult`／守門 1 的「同一筆記」半條（Task 1 審查 I-3）＋成功後立刻用
 * `insertedIds` 重新 `captureAnchor` 存 `applied`——`start()` 的自動套用分支與手動
 * `apply()` 共用同一條路徑，行為不能分岔。 */
function runGuardedApply(
  editor: AnyEditor,
  noteId: string,
  anchor: AiAnchor,
  markdown: string,
  notes: { id: string; title: string }[],
):
  | { ok: true; insertedAnchor: AiAnchor; replacedSnapshot: AnyBlock[]; unboundCount: number }
  | { ok: false; reason: "missing" | "changed" | "empty" | "noteMismatch" } {
  if (anchor.noteId !== noteId) return { ok: false, reason: "noteMismatch" };
  const outcome = applyAiResult(editor, anchor, markdown, { notes });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const insertedAnchor = captureAnchor(editor, noteId, outcome.insertedIds);
  return { ok: true, insertedAnchor, replacedSnapshot: outcome.replacedSnapshot, unboundCount: outcome.unboundCount };
}

export function AiSessionProvider(props: {
  editor: AnyEditor;
  noteId: string;
  editable: boolean;
  children: ReactNode;
}): JSX.Element {
  const { editor, noteId, editable, children } = props;
  const { t } = useTranslation();

  const actionsQuery = useQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions });
  // `useMemo`＋模組層級的 `EMPTY_ACTIONS` 常數：`?? []` 每次 render 都會是新陣列 identity，
  // 讓下面 `start` 的 `useCallback([actions, t])` 依賴陣列每個 render 都判定「變了」，
  // exhaustive-deps 因此示警（root lint `--max-warnings=0` 視為 error）——這裡把 identity
  // 釘住，只在 `actionsQuery.data` 真的換手時才變。
  const actions = useMemo(() => actionsQuery.data ?? EMPTY_ACTIONS, [actionsQuery.data]);
  const notesQuery = useNotes();

  const [state, setState] = useState<AiPanelState>(IDLE_STATE);
  const [collapsed, setCollapsed] = useState(true);

  // 讀最新值但不進任何 effect/callback 的依賴陣列——同 `NoteEditor.tsx` 的
  // `translateRef`/`canEditRef` 既有手法：`start()`/`apply()`/`revert()` 這些 callback
  // 若直接把 `state`/`noteId`/... 放進 `useCallback` deps，串流期間任何一次 re-render
  // 都會讓 identity 改變，而這裡的邏輯需要在「非同步 delta 陸續抵達」的過程中讀到永遠
  // 最新的值（尤其是 `abortRef`／`state` 的比對），用 ref 比重新設計整個依賴鏈簡單且不會
  // 有 stale closure 的風險。
  const stateRef = useRef(state);
  stateRef.current = state;
  const notesRef = useRef(notesQuery.data ?? []);
  notesRef.current = notesQuery.data ?? [];
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // 目前這一輪串流的 abort 控制器；同時當作「這個 promise 續體還算不算數」的識別碼——
  // `cancel()`／新一輪 `start()` 都會換掉它，舊的 `.then/.catch` 續體比對不到就直接
  // no-op，不會在使用者已經取消或重新開始之後，還把舊結果寫回 state。
  const abortControllerRef = useRef<AbortController | null>(null);
  // 上一次呼叫的 actionId，`retry()` 用；串流期間累積的文字（比 state.partial 更即時，
  // `done` 事件抵達時直接讀這裡組出最終文字，不必依賴非同步 setState 的時序）。
  const lastActionIdRef = useRef<string | null>(null);
  const partialRef = useRef("");

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  // fix round 1 I-1 加分項：`noteId` 換手（同一個 `AiSessionProvider` 實例被重新掛在
  // 不同筆記上——實務上目前的 `NoteEditor`/`useCreateBlockNote` deps 設計下極少見，但
  // `AiSessionProvider` 本身沒有 key 住 noteId，不能排除）時，若當下正在串流，直接
  // abort＋把 state 收回 idle：單一結果槽語意——這個 provider 實例的每一刻只服務「當下
  // 這個 noteId」，不該讓串流續體在「不知情」的狀況下，事後才被下面 `runGuardedApply` 的
  // `anchor.noteId !== noteId` 攔下來。
  //
  // 刻意只在 `phase === "streaming"` 時才收——**不**對 "done"/"error" 態也做同樣的事：
  // 一來已經落地的結果沒有「來不及被寫入」這個風險（`apply()`/`revert()` 手動觸發時
  // 一樣會被 `runGuardedApply`/`verifyAnchor` 擋下，見下方兩支函式），二來這樣才留得住
  // `apply()` 的 `noteMismatch` 分支可測（I-4）：真要在這裡連 "done" 也重置，使用者
  // 永遠沒機會在「筆記已經換手」的狀態下點到那顆理論上還在畫面上的「套用」鈕，這條守門
  // 就變成連 UI 都構不到的死碼——跟 I-1 原本要修的問題是同一種錯誤。
  useEffect(() => {
    if (stateRef.current.phase !== "streaming") return;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState(IDLE_STATE);
  }, [noteId]);

  const start = useCallback(
    (actionId: string) => {
      if (stateRef.current.phase === "streaming") return; // 重入防呆：上一輪還在跑就忽略
      const action = actions.find((candidate) => candidate.id === actionId);
      if (!action) return;

      const currentEditor = editorRef.current;
      const currentNoteId = noteIdRef.current;
      const selectionBlocks = currentEditor.getSelection()?.blocks ?? [];
      const isFullText = selectionBlocks.length === 0;
      const blockIds = isFullText
        ? currentEditor.document.map((block: AnyBlock) => block.id)
        : selectionBlocks.map((block: AnyBlock) => block.id);

      const anchor = captureAnchor(currentEditor, currentNoteId, blockIds);
      const anchorBlocks = blockIds
        .map((id) => currentEditor.getBlock(id))
        .filter((block): block is AnyBlock => block !== undefined);
      const markdown = currentEditor.blocksToMarkdownLossy(anchorBlocks);
      const forcePreview = isFullText || hasNonTextBlock(currentEditor, blockIds);
      const autoApply = action.applyMode === "direct" && !forcePreview;

      lastActionIdRef.current = actionId;
      partialRef.current = "";
      setCollapsed(false); // brief：「start() 自動展開」
      setState({ phase: "streaming", actionName: action.name, partial: "" });

      const controller = new AbortController();
      abortControllerRef.current = controller;

      streamAiAction({
        actionId: action.id,
        noteId: currentNoteId,
        text: markdown,
        signal: controller.signal,
        onDelta: (delta) => {
          if (abortControllerRef.current !== controller) return; // 已被 cancel()/新一輪 start() 取代
          partialRef.current += delta;
          setState((prev) => (prev.phase === "streaming" ? { ...prev, partial: prev.partial + delta } : prev));
        },
      }).then(
        () => {
          if (abortControllerRef.current !== controller) return;
          const finalText = partialRef.current;

          if (!autoApply) {
            setState({ phase: "done", actionName: action.name, result: finalText, anchor, pendingPreview: true, applied: null });
            return;
          }

          // fix round 1 I-1：自動套用是串流「結束後」才跑的續體，跟 `start()` 呼叫當下已經
          // 隔了一段非同步時間——這段時間內使用者完全可能換了筆記（`AiSessionProvider`
          // 沒有隨 noteId 重新掛載）。這裡刻意改讀 `editorRef.current`/`noteIdRef.current`
          // （**不是**上面 closure 捕捉到的 `currentEditor`/`currentNoteId`，那兩個變數只
          // 用來組出「這次要送出去的請求」，反映的是 start() 呼叫當下的快照，故意不隨後續
          // 變動）：若真的換了筆記，`runGuardedApply` 內 `anchor.noteId !== noteId` 這條
          // （比較 anchor 記下的舊 noteId 對上這裡讀到的*現在* noteId）才會是活的判斷，
          // 不會恆假；即使這條沒攔到，寫入的目標也會是「現在」掛著的 editor，不會寫進一個
          // 可能已經被拆掉、不再對應任何畫面的舊 editor 實例。上面新增的 noteId 換手
          // effect 是第一層防線（直接 abort＋收回 idle），這裡是第二層——兩層防線刻意都
          // 要在，effect 防線處理不了「effect 還沒跑到、但 noteId 已經換手」的極短窗口。
          const outcome = runGuardedApply(editorRef.current, noteIdRef.current, anchor, finalText, notesRef.current);
          if (outcome.ok) {
            setState({
              phase: "done",
              actionName: action.name,
              result: finalText,
              anchor,
              pendingPreview: false,
              applied: { insertedAnchor: outcome.insertedAnchor, replacedSnapshot: outcome.replacedSnapshot },
            });
            if (outcome.unboundCount > 0) toast({ title: t("ai.panel.rebindNotice") });
          } else {
            setState({ phase: "done", actionName: action.name, result: finalText, anchor, pendingPreview: true, applied: null });
            toast({ title: t(outcome.reason === "empty" ? "ai.panel.emptyResult" : "ai.panel.applyGuardFailed") });
          }
        },
        (err: unknown) => {
          if (abortControllerRef.current !== controller) return;
          if (err instanceof DOMException && err.name === "AbortError") return; // cancel() 已經處理過 UI 轉場
          const code = err instanceof ApiFail ? err.code : "internal";
          setState({ phase: "error", code });
        },
      );
    },
    [actions, t],
  );

  const apply = useCallback(() => {
    const current = stateRef.current;
    // review fix round 1「concern 1 裁定」：不變量進狀態機本身，不只寄在 JSX 的
    // `pendingPreview && applied === null` 渲染條件——`apply()` 被重複呼叫（不只是
    // UI 按兩下，任何繞過渲染條件的呼叫端都算）時，已經套用過的結果不能被覆蓋套用第二次。
    if (current.phase !== "done" || current.applied) return;
    const outcome = runGuardedApply(editorRef.current, noteIdRef.current, current.anchor, current.result, notesRef.current);
    if (outcome.ok) {
      setState({
        ...current,
        pendingPreview: false,
        applied: { insertedAnchor: outcome.insertedAnchor, replacedSnapshot: outcome.replacedSnapshot },
      });
      if (outcome.unboundCount > 0) toast({ title: t("ai.panel.rebindNotice") });
    } else {
      toast({ title: t(outcome.reason === "empty" ? "ai.panel.emptyResult" : "ai.panel.applyGuardFailed") });
    }
  }, [t]);

  const revert = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== "done" || !current.applied) return;
    const outcome = revertAiResult(editorRef.current, current.applied.insertedAnchor, current.applied.replacedSnapshot);
    if (outcome === "stale") {
      toast({ title: t("ai.panel.revertStale") });
      setState({ ...current, applied: null });
      return;
    }
    // 成功還原：回到「尚未套用」的樣子，讓使用者可以重新決定要不要再套用一次。
    setState({ ...current, applied: null, pendingPreview: true });
  }, [t]);

  const cancel = useCallback(() => {
    if (stateRef.current.phase !== "streaming") return;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState(IDLE_STATE);
  }, []);

  const dismiss = useCallback(() => {
    if (stateRef.current.phase === "streaming") {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    }
    setState(IDLE_STATE);
  }, []);

  const retry = useCallback(() => {
    if (lastActionIdRef.current) start(lastActionIdRef.current);
  }, [start]);

  const canRevert = useCallback((): boolean => {
    const current = stateRef.current;
    if (current.phase !== "done" || !current.applied) return false;
    return verifyAnchor(editorRef.current, current.applied.insertedAnchor) === "ok";
  }, []);

  const value: AiSessionValue = {
    actions,
    state,
    start,
    apply,
    revert,
    cancel,
    dismiss,
    retry,
    editable,
    collapsed,
    setCollapsed,
    canRevert,
  };

  return <AiSessionContext.Provider value={value}>{children}</AiSessionContext.Provider>;
}
