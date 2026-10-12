import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type SVGProps,
} from "react";
import { useTranslation } from "react-i18next";
import { flip, offset, shift, size, type UseFloatingOptions } from "@floating-ui/react";
import { PositionPopover, useBlockNoteEditor, useEditorState } from "@blocknote/react";
import {
  CONTINUE_WRITING_ACTION_ID,
  INSTRUCTION_MAX_CODE_POINTS,
  REWRITE_ACTION_ID,
  SUMMARIZE_ACTION_ID,
  TRANSLATE_ACTION_ID,
  truncateCodePoints,
} from "@knotebook/shared";
import { verifyAnchor } from "@/ai/anchor";
import { blockRange, type BlockRange } from "@/ai/selection";
import { Button } from "@/components/ui/button";
import { ChevronsRight, Languages, ListCollapse, PenLine, Send, Sparkles, X } from "@/components/ui/icons";
import { activeAnchorOf, useAiSession, type AiTarget } from "./AiSession";
import { SelectionAiResult, type BoxFocusTarget, type RunWithFocus } from "./SelectionAiResult";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** 內建 quick 動作的專屬 icon（§5.4，以 shared 的固定 id 判）；自訂動作一律通用的 `Sparkles`。 */
const QUICK_ICONS: Record<string, IconComponent> = {
  [REWRITE_ACTION_ID]: PenLine,
  [TRANSLATE_ACTION_ID]: Languages,
  [SUMMARIZE_ACTION_ID]: ListCollapse,
  [CONTINUE_WRITING_ACTION_ID]: ChevronsRight,
};

/** 框的左右外框（`border` 各 1px）：框寬＝區塊寬＋外框，框內預覽的文字欄才等於區塊寬（D7）。 */
const BOX_BORDER_X = 2;
const NO_DISMISS = { enabled: false };
const NO_FOCUS_MANAGER = { disabled: true };
const ELEMENT_PROPS = { style: { zIndex: 40 } };

/**
 * 框選 AI 框（#263 spec §5.3、§5.4）：工具列原位的浮動框，四態（輸入、串流、預覽、錯誤）。由 `SelectionAiController` 渲染在
 * `<BlockNoteView>` 內，經 `PositionPopover` 掛到 `editor.portalElement`（DOM 上在 `[data-testid="note-editor"]` 之內）。
 *
 * - 定位（S3）：reference＝**活動錨點的首區塊**（posBefore～posAfter），每次 editor 交易經 `getNodeById` 重算；找不到節點時沿用上一次位置
 *   （RF4）。middleware 依內建工具列的順序 `offset(10)`、`shift()`、`flip()`，再加 `size()` 把最大高度設為 `min(40vh, 可用高度)`。
 * - 寬度：量活動錨點首區塊 `.bn-block-outer` 的寬度（ResizeObserver，目標換了就重新 observe）＋左右外框；上限可視寬減 16px。
 *   窄視窗（<768）同一個框、寬度同樣取區塊寬，chips 可換行（§5.6）。
 * - `role="region"` 而不是 `dialog`：全站快捷鍵與版本預覽的 Esc 以「頁上有 dialog」為放棄條件。
 * - 焦點（§5.3）：開啟時進輸入框（沒有 Instruct 時進第一顆 chip）——唯一無條件的轉移。其餘轉場只在「動作當下焦點在框內」時轉移：
 *   送出／chip／重試 → 取消鈕；完成 → 框容器；還原成功 → 框容器；關閉 → 編輯器。「當下焦點在不在框內」以 document 的 focusin 持續追蹤
 *   （pointerdown 後再排一個 macrotask 依實際焦點重讀：點不可聚焦處時焦點落到 body、不發 focusin），**在元素卸載前就已記下**——卸載後再讀 `document.activeElement` 只會讀到 body。只認框內的 Esc。
 */
export function SelectionAiBox() {
  const { t } = useTranslation();
  const editor = useBlockNoteEditor();
  const session = useAiSession();
  const { state, editable, actions } = session;
  const anchor = activeAnchorOf(state);
  const boxOpen = state.phase !== "idle";

  const snapshot = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current || !anchor) return null;
      return {
        position: current.transact((tr) => blockRange(tr.doc, anchor.blockIds[0])),
        status: verifyAnchor(current, anchor),
      };
    },
  });
  const lastPositionRef = useRef<BlockRange | null>(null);
  if (!boxOpen) lastPositionRef.current = null;
  else if (snapshot?.position) lastPositionRef.current = snapshot.position;
  const position = boxOpen ? (lastPositionRef.current ?? undefined) : undefined;
  const anchorOk = snapshot?.status === "ok";

  // ── 寬度 ──
  const firstBlockId = anchor?.blockIds[0];
  const [blockWidth, setBlockWidth] = useState(0);
  useEffect(() => {
    if (!firstBlockId) return;
    const el = editor.domElement?.querySelector<HTMLElement>(`.bn-block-outer[data-id="${firstBlockId}"]`);
    if (!el) return;
    const measure = () => setBlockWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [editor, firstBlockId]);
  const boxWidth = blockWidth > 0 ? `min(${blockWidth + BOX_BORDER_X}px, calc(100vw - 16px))` : undefined;

  const floatingOptions = useMemo<UseFloatingOptions>(
    () => ({
      open: boxOpen && editable,
      placement: "top-start",
      middleware: [
        offset(10),
        shift(),
        flip(),
        size({
          apply({ availableHeight, elements }) {
            const cap = Math.max(0, Math.floor(Math.min(window.innerHeight * 0.4, availableHeight)));
            elements.floating.style.setProperty("--kb-ai-box-max-h", `${cap}px`);
          },
        }),
      ],
    }),
    [boxOpen, editable],
  );

  // ── 焦點 ──
  // 框的 DOM 由 PositionPopover 掛：floating-ui 的轉場（useTransitionStyles）讓它比 phase 變更晚一個 render 才真正掛上（jsdom 實測：
  // 只靠 phase 驅動的 layout effect 時 ref 還是 null、焦點落空）。所以另用 state 記「框元素已掛上」，開啟的焦點轉移等它到位才做。
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const setBoxRef = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
    setBoxEl(el);
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const firstChipRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const focusInsideRef = useRef(false);
  const pendingFocusRef = useRef<BoxFocusTarget | null>(null);
  const prevPhaseRef = useRef(state.phase);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      focusInsideRef.current = boxRef.current?.contains(event.target as Node) ?? false;
    };
    // 點框外不可聚焦處（頁面背景等）時焦點直接落到 body，只發 focusout、不發 focusin——只靠 focusin 旗標會停在 true，完成時把焦點拉回框。
    // 但「按在框外」不等於「焦點離開了框」（觸控捲動、拖框外捲軸、外部元件 preventDefault 掉 mousedown 都不動焦點），所以不直接改旗標：
    // pointerdown 先於瀏覽器預設的焦點移動，排一個 macrotask 等它做完，再以 `box.contains(document.activeElement)` 重讀實際焦點（spec §5.3）。
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const onPointerDown = () => {
      clearTimeout(recheck);
      recheck = setTimeout(() => {
        recheck = undefined;
        focusInsideRef.current = boxRef.current?.contains(document.activeElement) ?? false;
      }, 0);
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      clearTimeout(recheck);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  const run = useCallback<RunWithFocus>((action, target) => {
    const inside = focusInsideRef.current || (boxRef.current?.contains(document.activeElement) ?? false);
    const result = action();
    if (inside && result !== false) pendingFocusRef.current = target;
  }, []);

  const [instruction, setInstruction] = useState("");
  const inputTarget = state.phase === "input" ? state.target : null;
  const focusedTargetRef = useRef<AiTarget | null>(null);
  useLayoutEffect(() => {
    // 開啟（每個新 target 一次、且框已掛上）：清空輸入框（重開不沿用舊指令）、焦點進輸入框；沒有輸入框時進第一顆 chip。
    if (!inputTarget || !boxEl || focusedTargetRef.current === inputTarget) return;
    focusedTargetRef.current = inputTarget;
    setInstruction("");
    (textareaRef.current ?? firstChipRef.current)?.focus();
  }, [inputTarget, boxEl]);

  useLayoutEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = state.phase;
    if (prev === "streaming" && (state.phase === "done" || state.phase === "error") && pendingFocusRef.current === null && focusInsideRef.current) {
      pendingFocusRef.current = "container";
    }
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    if (target === "cancel") cancelRef.current?.focus();
    // preventScroll：串流期間使用者可能已捲走，完成／還原的焦點轉移不該把頁面捲回框（spec 沒要求捲動；jsdom 量不到，留 e2e）。
    else if (target === "container") boxRef.current?.focus({ preventScroll: true });
    else editor.focus();
  }, [state, editor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault(); // NotePage 的全頁 Esc 以 defaultPrevented 放棄
    event.stopPropagation();
    run(() => (state.phase === "streaming" ? session.cancel() : session.close()), "editor");
  };

  const instructAction = actions.find((action) => action.kind === "instruct");
  const quickActions = actions.filter((action) => action.kind === "quick");
  const submit = () => {
    if (!instructAction) return;
    const value = instruction.trim();
    if (value === "") return;
    run(() => session.start(instructAction.id, value), "cancel");
  };

  // 已套用（direct 自動套用）時錨點是插入的區塊——它變了只影響還原鈕，不顯示「原文已變更」。
  const showStale = boxOpen && !anchorOk && !(state.phase === "done" && state.applied !== null);
  const discardRow = (
    <div className="flex justify-end px-3 py-2">
      <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
        {t("ai.box.discard")}
      </Button>
    </div>
  );

  return (
    <PositionPopover
      position={position}
      useFloatingOptions={floatingOptions}
      useDismissProps={NO_DISMISS}
      focusManagerProps={NO_FOCUS_MANAGER}
      elementProps={ELEMENT_PROPS}
    >
      {boxOpen && editable && (
        <div
          ref={setBoxRef}
          role="region"
          aria-label={t("ai.box.label")}
          data-testid="selection-ai-box"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          style={{ width: boxWidth }}
          className="flex max-h-[var(--kb-ai-box-max-h,40vh)] max-w-[calc(100vw-16px)] flex-col overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none"
        >
          {showStale && (
            <p role="status" className="px-3 pt-2 text-xs text-destructive">
              {t("ai.box.stale")}
            </p>
          )}

          {state.phase === "input" &&
            (anchorOk ? (
              <div className="flex flex-wrap items-start gap-1 p-2 text-sm">
                {instructAction && (
                  <>
                    <textarea
                      ref={textareaRef}
                      rows={1}
                      aria-label={t("ai.box.inputLabel")}
                      placeholder={t("ai.box.placeholder")}
                      value={instruction}
                      onChange={(event) => setInstruction(truncateCodePoints(event.target.value, INSTRUCTION_MAX_CODE_POINTS))}
                      onKeyDown={(event) => {
                        // `isComposing`：輸入法選字時的 Enter 不送（同 FilePanel.tsx 慣例）；Shift+Enter 換行。
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          submit();
                        }
                      }}
                      className="field-sizing-content max-h-[5.75rem] min-h-8 min-w-40 flex-1 resize-none bg-transparent px-2 py-1.5 outline-none"
                    />
                    <Button type="button" variant="ghost" size="icon" aria-label={t("ai.box.send")} title={t("ai.box.send")} onClick={submit}>
                      <Send aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  {quickActions.map((action, index) => {
                    const Icon = QUICK_ICONS[action.id] ?? Sparkles;
                    return (
                      <Button
                        key={action.id}
                        ref={index === 0 ? firstChipRef : undefined}
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={action.name}
                        title={action.name}
                        onClick={() => run(() => session.start(action.id), "cancel")}
                      >
                        <Icon aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    );
                  })}
                  <Button type="button" variant="ghost" size="icon" aria-label={t("ai.box.close")} title={t("ai.box.close")} onClick={() => run(() => session.close(), "editor")}>
                    <X aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              discardRow
            ))}

          {state.phase === "streaming" && (
            <div className="space-y-2 p-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">
                {state.request.kind === "instruct" ? t("ai.box.instructLabel") : state.request.actionName}
              </p>
              <p className="text-muted-foreground">{t("ai.box.streaming")}</p>
              {state.partial && <p className="whitespace-pre-wrap">{state.partial}</p>}
              <div className="flex justify-end gap-2">
                {/* 錨點失效（§5.2）：按鈕列只剩「捨棄」，串流中另留取消。 */}
                {!anchorOk && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
                    {t("ai.box.discard")}
                  </Button>
                )}
                <Button ref={cancelRef} type="button" variant="outline" size="sm" onClick={() => run(() => session.cancel(), "editor")}>
                  {t("ai.box.cancel")}
                </Button>
              </div>
            </div>
          )}

          {state.phase === "done" && <SelectionAiResult state={state} anchorOk={anchorOk} run={run} />}

          {state.phase === "error" &&
            (anchorOk ? (
              <div className="space-y-2 p-3 text-sm">
                <p role="alert" className="text-destructive">
                  {t(`errors.${state.code}`, { defaultValue: t("errors.fallback") })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
                    {t("ai.box.close")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => run(() => session.retry(), "cancel")}>
                    {t("ai.box.retry")}
                  </Button>
                </div>
              </div>
            ) : (
              discardRow
            ))}
        </div>
      )}
    </PositionPopover>
  );
}
