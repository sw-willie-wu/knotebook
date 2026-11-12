import { SuggestionMenu } from "@blocknote/core";
import i18n from "@/i18n";
import "@/i18n/tour-strings";
import { getTourNoteEditor, setTourTransactionFilter, type TourEditor } from "@/lib/tour-bridge";
import { findFormattingToolbarButton, findTourTarget, type TourTargetId } from "@/lib/tour-targets";

/**
 * 功能導覽的現場演示：在示範筆記的編輯器裡叫出真的選單，整個過程不寫文件。
 *
 * - 游標放進最後的空段落，用 `deleteTriggerCharacter: false` 開選單：觸發字不會進文件，選單照樣出現，
 *   所以重新整理、關分頁、上一頁都不會留下東西，也不產生版本或撤銷紀錄。
 * - 演示期間開著編輯器的交易過濾（`setTourTransactionFilter`）：輸入法組字擋不在鍵盤層，只有在交易層擋得乾淨。
 *   過濾是常駐外掛上的旗標，演示中不註冊也不拆外掛（選單開著時動態註冊會弄壞選單的狀態）。
 * - 離站由站點的 `leave` 呼叫 `stopLiveTrigger`：關選單、還原選取、關過濾。可以重複呼叫，也可以在沒開始過時呼叫。
 */

export type TourTrigger = "[[" | "/";

/** 演示開始前的選取，離站時還原。 */
interface Saved {
  from: number;
  to: number;
}

/** 正在演示的編輯器。用編輯器當 key：編輯器卸載後不會留下東西。 */
const active = new WeakMap<TourEditor, Saved>();

function menuOf(editor: TourEditor) {
  return editor.getExtension(SuggestionMenu);
}

/** 文件最後一個頂層 block 是沒有內容的段落。 */
function lastBlockIsEmptyParagraph(editor: TourEditor): boolean {
  const last = editor.document[editor.document.length - 1];
  if (last === undefined || last.type !== "paragraph" || last.children.length > 0) return false;
  const content: unknown = last.content;
  return Array.isArray(content) && content.every((node: { type?: string; text?: string }) => node.type === "text" && (node.text ?? "") === "");
}

/**
 * 能不能在這篇示範筆記上現場演示：它的編輯器已登記、可編輯，而且最後一段是空段落（游標要放在那裡）。
 * 開始導覽時算一次；不成立的站改指筆記裡現成的成品。
 */
export function canRunLiveStop(noteId: string): boolean {
  const editor = getTourNoteEditor(noteId);
  if (editor === null) return false;
  try {
    return editor.isEditable && lastBlockIsEmptyParagraph(editor);
  } catch (err) {
    // 開始流程裡呼叫：讀不出文件就當不能演示，不讓導覽開不起來。
    console.error(err);
    return false;
  }
}

/** `trigger` 的選單目前是不是開著（外掛狀態，不看畫面）。兩種選單共用同一個外掛，所以要再比對是哪個觸發字開的。 */
export function isTriggerMenuShown(editor: TourEditor, trigger: TourTrigger): boolean {
  const menu = menuOf(editor);
  return menu?.shown() === true && menu.store.state?.triggerCharacter === trigger;
}

/**
 * 游標放進最後的空段落、叫出 `trigger` 的選單，回傳選單有沒有開。重複呼叫沒有作用。
 * 開選單會把焦點放進編輯器，也會把游標捲進可視範圍。
 */
export function startTourTrigger(editor: TourEditor, trigger: TourTrigger): boolean {
  if (active.has(editor)) return isTriggerMenuShown(editor, trigger);
  const menu = menuOf(editor);
  const last = editor.document[editor.document.length - 1];
  if (menu === undefined || last === undefined) return false;
  const { from, to } = editor._tiptapEditor.state.selection;
  active.set(editor, { from, to });
  editor.setTextCursorPosition(last, "start");
  menu.openSuggestionMenu(trigger, { deleteTriggerCharacter: false });
  return menu.shown();
}

/** 關選單（已經關了就不動）並還原演示前的選取；沒開始過、重複呼叫都是空操作。不碰焦點。 */
export function stopTourTrigger(editor: TourEditor): void {
  const saved = active.get(editor);
  if (saved === undefined) return;
  active.delete(editor);
  const menu = menuOf(editor);
  if (menu?.shown() === true) menu.closeMenu();
  if (editor._tiptapEditor.isDestroyed) return;
  editor._tiptapEditor.commands.setTextSelection({ from: saved.from, to: saved.to });
}

/** 站點的 `prepare`：開過濾、叫出選單。示範筆記的編輯器拿不到就什麼都不做。 */
export function startLiveTrigger(noteId: string, trigger: TourTrigger): void {
  const editor = getTourNoteEditor(noteId);
  if (editor === null) return;
  setTourTransactionFilter(noteId, true);
  startTourTrigger(editor, trigger);
}

/** 站點的 `leave`：關選單、還原選取、關過濾。 */
export function stopLiveTrigger(noteId: string): void {
  try {
    const editor = getTourNoteEditor(noteId);
    if (editor !== null) stopTourTrigger(editor);
  } finally {
    // 關選單拋錯也要關過濾，否則使用者在這篇的輸入會一直被擋到導覽結束。
    setTourTransactionFilter(noteId, false);
  }
}

/** 正在框選演示句的編輯器。 */
const selecting = new WeakSet<TourEditor>();

type PmDoc = TourEditor["_tiptapEditor"]["state"]["doc"];

/**
 * 示範筆記裡要框起來的那句：內容等於範例句的段落；找不到（使用者改掉了）就是第一個非空段落。
 * 回傳文字內容的起訖位置，沒有任何非空段落時回 null。
 */
function findDemoSentenceRange(doc: PmDoc): { from: number; to: number } | null {
  const sentence = i18n.t("tourGuide.sample.aiSentence");
  let exact: { from: number; to: number } | null = null;
  let firstFilled: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (exact !== null) return false;
    if (!node.isTextblock) return true;
    if (node.textContent.trim() === "") return false;
    const range = { from: pos + 1, to: pos + 1 + node.content.size };
    if (node.textContent === sentence) exact = range;
    else if (firstFilled === null && node.type.name === "paragraph") firstFilled = range;
    return false;
  });
  return exact ?? firstFilled;
}

/**
 * 站點的 `prepare`（AI 站）：開過濾，焦點放進編輯器，再用一筆交易把演示句設成選取並捲進視窗。
 * 先要有焦點：沒有焦點時格式工具列雖然會出現，選取反白看不到，編輯器也不會捲到那句。
 * 只改選取、不改文件：不進撤銷、不寫進 Y 文件。重複呼叫沒有作用。
 */
export function startLiveSelection(noteId: string): void {
  const editor = getTourNoteEditor(noteId);
  if (editor === null) return;
  setTourTransactionFilter(noteId, true);
  if (selecting.has(editor)) return;
  const view = editor._tiptapEditor.view;
  const range = findDemoSentenceRange(view.state.doc);
  if (range === null) return;
  selecting.add(editor);
  editor.focus();
  const { state } = view;
  // TextSelection 沒有可 import 的來源：從目前選取的 class 取（`near` 在文字段落裡必回 TextSelection）。
  const current = state.selection.constructor as unknown as { near(pos: unknown): { constructor: unknown } };
  const TextSel = current.near(state.doc.resolve(range.from)).constructor as unknown as {
    create(doc: PmDoc, anchor: number, head: number): typeof state.selection;
  };
  view.dispatch(state.tr.setSelection(TextSel.create(state.doc, range.from, range.to)).scrollIntoView());
}

/** 站點的 `leave`（AI 站）：把選取收合到末端、關過濾。沒開始過、重複呼叫都是空操作；過濾一定關。 */
export function stopLiveSelection(noteId: string): void {
  try {
    const editor = getTourNoteEditor(noteId);
    if (editor !== null && selecting.delete(editor) && !editor._tiptapEditor.isDestroyed) {
      const { state, view } = editor._tiptapEditor;
      if (!state.selection.empty) {
        const SelCtor = state.selection.constructor as unknown as { near(pos: unknown): typeof state.selection };
        view.dispatch(state.tr.setSelection(SelCtor.near(state.doc.resolve(state.selection.to))));
      }
    }
  } finally {
    setTourTransactionFilter(noteId, false);
  }
}

/** AI 站要挖亮的東西：框選工具列上的 AI 鈕。工具列還沒畫出來之前回空陣列，引擎會等。 */
export function liveSelectionTarget(): Element[] {
  const button = findFormattingToolbarButton(i18n.t("ai.toolbar.trigger"));
  return button === null ? [] : [button];
}

/** 已經為退路目標捲過的元素：目標每格畫面都會重查，只在第一次找到時捲，之後使用者自己捲走就不去搶。 */
const scrolledFallbacks = new WeakSet<Element>();

/**
 * 演示站要挖亮的東西：`trigger` 的選單開著就指選單（等它畫出來才有，畫出來之前回空陣列，引擎會等）；
 * 沒有在演示、或選單因故關掉（例如視窗失焦）就指筆記裡現成的成品，不留空箭頭。
 * 「開著」要是導覽自己開的、而且是這個觸發字的選單：使用者自己開的選單、上一站的選單都不算。
 */
export function liveTriggerTarget(noteId: string, trigger: TourTrigger, menuId: TourTargetId, fallbackId: TourTargetId): Element[] {
  const editor = getTourNoteEditor(noteId);
  if (editor !== null && active.has(editor) && isTriggerMenuShown(editor, trigger)) {
    const menu = findTourTarget(menuId);
    return menu === null ? [] : [menu];
  }
  const fallback = findInSampleEditor(noteId, fallbackId);
  if (fallback === null) return [];
  if (!scrolledFallbacks.has(fallback)) {
    scrolledFallbacks.add(fallback);
    if (typeof fallback.scrollIntoView === "function") fallback.scrollIntoView({ block: "nearest" });
  }
  return [fallback];
}

/** 只在示範筆記的編輯器裡找：頁面上可能還有別的編輯器畫面（例如版本預覽）。 */
export function findInSampleEditor(noteId: string, id: TourTargetId): Element | null {
  return findTourTarget(id, getTourNoteEditor(noteId)?.domElement ?? document);
}

export interface LiveStopInput {
  next: () => void;
  back: () => void;
}

/**
 * 演示站期間的鍵盤與滑鼠，都在 window 的 capture 階段接，比編輯器與 BlockNote 的選單都早：
 * - `→`／`Enter` 下一步、`←` 上一步；`Esc` 交給遮罩（它也在 capture 階段接，BlockNote 自己會用 `Esc` 關選單，要搶在前面）；
 *   其他按鍵一律不送進編輯器，選單才不會被方向鍵、字元、`Tab` 動到。
 * - 帶 `Ctrl`／`Meta`／`Alt` 的組合鍵一律不送進編輯器與選單（`stopPropagation`），但多數不 `preventDefault`，
 *   所以瀏覽器自己的快捷鍵（重新整理、開發人員工具、縮放）照常有效；功能鍵（F5、F12）整個放行。
 *   `z`／`y`（撤銷、重做：經 Y 回來的交易會通過交易過濾）、`v`／`x`／`a`（貼上、剪下、全選）和 `Enter` 另外 `preventDefault`。
 * - 選單項目的點擊擋掉：點項目會先關掉選單再執行它，插入雖然會被交易過濾擋下，選單卻沒了。
 * 回傳拆除函式。
 */
export function installLiveStopInput({ next, back }: LiveStopInput): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return;
    if (/^F\d{1,2}$/.test(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.stopPropagation();
      if (/^[zyvxa]$/i.test(e.key) || e.key === "Enter") e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.isComposing || e.keyCode === 229 || e.repeat) return;
    if (e.key === "ArrowRight" || e.key === "Enter") next();
    else if (e.key === "ArrowLeft") back();
  };
  const onClick = (e: MouseEvent) => {
    if (
      e.target instanceof Element &&
      e.target.closest('[data-kb-tour-target="wikilinkMenu"], [data-kb-tour-target="slashMenu"], [data-kb-formatting-toolbar-popover]') !== null
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("click", onClick, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("click", onClick, true);
  };
}
