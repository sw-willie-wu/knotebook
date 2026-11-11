import { useEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;

/**
 * 筆記頁的撤銷／重做快捷鍵（#430）：焦點不在編輯器時（例如拖放之後、點了頁面空白處、欄間分隔線有焦點），Ctrl+Z、Ctrl+Shift+Z、
 * Ctrl+Y（Mac 是 Cmd+Z、Cmd+Shift+Z）照樣作用在這篇筆記上，與編輯器自己的鍵位走同一條路（`editor.undo()`／`editor.redo()`，
 * 共編時是 y-prosemirror 的 UndoManager），做完把焦點移回編輯器、讓使用者看到游標。
 *
 * 一般 window keydown（非 capture，同頁上 Ctrl+S 的寫法）。讓路的情形一律不 `preventDefault`，瀏覽器或別的元件照常處理：
 * - 事件已被處理過（`defaultPrevented`：焦點在編輯器、編輯器的鍵位撤銷了一步）、輸入法組字中。
 * - 按鍵目標或焦點在自己有文字編輯與撤銷的元素裡：文字類的 input、textarea、select、任何 contenteditable（含編輯器本身：
 *   編輯器的鍵位沒有東西可撤時不 `preventDefault`，冒泡上來也不能再撤一次）。
 * - 有對話框、選單、下拉清單、AI 框、自訂顏色面板開著。
 * - 這篇對目前使用者唯讀（`editor.isEditable` 為 false）、呼叫端關掉（簡報模式、版本預覽中）。
 */

export type UndoAction = "undo" | "redo";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * 按的字母。`key` 是拉丁字母或 ASCII 符號時就以它為準：Dvorak 在 Z 的位置打出 `;`、BÉPO 打出 `à`，都不是 Z。
 * 只有 `key` 是其他文字（西里爾、希臘字母等，那種配置沒有拉丁字母可按）時才看實體鍵位。
 */
function letterOf(event: KeyboardEvent): string | null {
  const key = event.key;
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  if ([...key].length !== 1 || /[\x21-\x7e]|\p{Script=Latin}/u.test(key)) return null;
  if (event.code === "KeyZ") return "z";
  if (event.code === "KeyY") return "y";
  return null;
}

/** 任一平台的撤銷／重做組合（Ctrl 或 Cmd 加 Z、Shift+Z、Y）。 */
export function undoKeyOf(event: KeyboardEvent): UndoAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const letter = letterOf(event);
  if (letter === "z") return event.shiftKey ? "redo" : "undo";
  if (letter === "y" && !event.shiftKey) return "redo";
  return null;
}

/**
 * 頁面快捷鍵認的鍵，同編輯器的 `Mod-z`／`Shift-Mod-z`／`Mod-y`，只認這個平台的 Mod 鍵（Mac 是 Cmd、其他是 Ctrl）。Mac 上不接 Cmd+Y：
 * 那是瀏覽器的「歷史記錄」，頁面上沒有文字輸入時不該攔下來。
 */
export function undoActionOf(event: KeyboardEvent, mac: boolean = IS_MAC): UndoAction | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  const action = undoKeyOf(event);
  if (mac && action === "redo" && !event.shiftKey) return null;
  return action;
}

/** 自己有文字編輯與撤銷的元素。勾選框、按鈕、滑桿、顏色、檔案這類 input 沒有，焦點在它們上面照樣撤銷筆記。 */
const TEXT_ENTRY = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"]):not([type="hidden"])',
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
].join(", ");
/** 開著就讓路的浮層：Radix／Mantine 的對話框、選單、下拉清單（含窄視窗的側欄抽屜），AI 框，自訂顏色面板。 */
const OPEN_LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-kb-ai-box], .kb-color-panel';

/** 這次按鍵要讓給別人處理 → true。 */
export function pageUndoYields(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return true;
  for (const el of [event.target, document.activeElement]) {
    if (el instanceof Element && el.closest(TEXT_ENTRY)) return true;
  }
  return document.querySelector(OPEN_LAYER) !== null;
}

/** 掛上快捷鍵；回傳解除函式。`isEnabled` 在每次按鍵當下才讀。 */
export function attachPageUndoShortcut(editor: AnyEditor, isEnabled: () => boolean): () => void {
  const onKey = (event: KeyboardEvent) => {
    const action = undoActionOf(event);
    if (!action || !isEnabled() || !editor.isEditable || pageUndoYields(event)) return;
    if (!editor.prosemirrorView) return;
    event.preventDefault();
    const done = action === "undo" ? editor.undo() : editor.redo();
    // 沒有東西可撤／可重做時焦點留在原處（例如側欄的按鈕上）。
    if (done) editor.focus();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** {@link attachPageUndoShortcut} 的 React 包裝：`enabled` 經 ref 讀當下的值，換值不重掛監聽。 */
export function usePageUndoShortcut(editor: AnyEditor, enabled: boolean): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => attachPageUndoShortcut(editor, () => enabledRef.current), [editor]);
}
