import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { createLongPress, type LongPress } from "@/lib/long-press";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（防循環 import，同 spec.tsx）
type AnyEditor = BlockNoteEditor<any, any, any>;

/** 比照 BlockNote `LinkToolbarController` 的 `useHover` delay（open／close 各 250 ms）。 */
export const HOVER_OPEN_MS = 250;
export const HOVER_CLOSE_MS = 250;

type Source = "hover" | "press";

/**
 * rev 7 §7.4：可編輯時 wikilink 工具列的兩個開法——滑鼠 hover（延遲開、移出延遲關、移進工具列或焦點在工具列裡不關）、
 * 觸控長按（`lib/long-press.ts`）。點擊不開（直接跳轉，見 `useWikilinkClick`）。鍵盤開不到（Willie 2026-10-15 裁定為已知限制）。
 * 都不搶焦點；hover 移出造成的關閉不把焦點拉回編輯器（`shouldRestoreFocus`）。
 */
export function useToolbarTriggers(editor: AnyEditor, editable: boolean) {
  const [source, setSourceState] = useState<Source | null>(null);
  const sourceRef = useRef<Source | null>(null);
  const hoverClosedRef = useRef(false);
  // 關閉時要不要把焦點還給編輯器：開啟當下編輯器有焦點，或使用者在工具列裡互動過（焦點進去、按過）。
  // 從沒碰過編輯器的人（例如手機長按開、點外關）不拉焦點，免得叫出虛擬鍵盤。
  const editorHadFocusRef = useRef(false);
  const interactedRef = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSource = useCallback(
    (next: Source | null) => {
      if (next !== null && sourceRef.current === null) {
        hoverClosedRef.current = false;
        interactedRef.current = false;
        try {
          editorHadFocusRef.current = editor._tiptapEditor.view.hasFocus();
        } catch {
          editorHadFocusRef.current = false; // view 未掛載／已卸載（tiptap 的 view Proxy 會丟錯）
        }
      }
      sourceRef.current = next;
      setSourceState(next);
    },
    [editor],
  );
  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);
  const scheduleHoverClose = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (sourceRef.current !== "hover" || closeTimer.current !== null) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (sourceRef.current !== "hover" || contentRef.current?.contains(document.activeElement)) return;
      hoverClosedRef.current = true;
      sourceRef.current = null;
      setSourceState(null);
    }, HOVER_CLOSE_MS);
  };
  const cancelHoverClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const [press] = useState<LongPress>(() =>
    createLongPress(() => {
      clearTimers();
      setSource("press");
    }),
  );
  useEffect(
    () => () => {
      clearTimers();
      press.dispose();
    },
    [clearTimers, press],
  );

  const anchorHandlers = editable
    ? {
        onPointerEnter: (e: PointerEvent<HTMLElement>) => {
          if (e.pointerType === "touch") return;
          cancelHoverClose();
          if (sourceRef.current !== null || openTimer.current !== null) return;
          openTimer.current = setTimeout(() => {
            openTimer.current = null;
            setSource("hover");
          }, HOVER_OPEN_MS);
        },
        onPointerLeave: (e: PointerEvent<HTMLElement>) => {
          if (e.pointerType !== "touch") scheduleHoverClose();
        },
        onPointerDown: (e: PointerEvent<HTMLElement>) => press.down(e),
        onPointerMove: (e: PointerEvent<HTMLElement>) => press.move(e),
        onPointerUp: () => press.end(),
        onPointerCancel: () => press.end(),
        onContextMenu: (e: MouseEvent<HTMLElement>) => {
          if (press.contextMenu()) e.preventDefault();
        },
        // 長按成立後瀏覽器可能補發滑鼠事件：capture 階段攔下，免得 ProseMirror 拿去搬游標、搶焦點把剛開的工具列關掉。
        onMouseDownCapture: (e: MouseEvent<HTMLElement>) => {
          if (!press.suppressing()) return;
          e.preventDefault();
          e.stopPropagation();
        },
      }
    : {};

  return {
    open: source !== null,
    contentRef,
    anchorHandlers,
    /** 回傳 true ＝這是長按後補發的 click，呼叫端要攔掉、不跳轉。 */
    consumeClick: (e: MouseEvent<HTMLElement>) => {
      if (!editable || !press.consumeClick()) {
        clearTimers();
        if (sourceRef.current === "hover") setSource(null);
        return false;
      }
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
    onOpenChange: (open: boolean) => {
      clearTimers();
      if (!open) setSource(null);
    },
    contentHandlers: {
      onPointerDownCapture: () => {
        interactedRef.current = true;
      },
      onFocusCapture: () => {
        interactedRef.current = true;
      },
      onPointerEnter: cancelHoverClose,
      onPointerLeave: (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType !== "touch") scheduleHoverClose();
      },
    },
    /** 開啟當下編輯器有沒有焦點。 */
    editorHadFocus: () => editorHadFocusRef.current,
    /** hover 移出造成的關閉不拉回焦點；其餘只在開啟時編輯器有焦點、或在工具列裡互動過時拉回。 */
    shouldRestoreFocus: () => !hoverClosedRef.current && (editorHadFocusRef.current || interactedRef.current),
  };
}
