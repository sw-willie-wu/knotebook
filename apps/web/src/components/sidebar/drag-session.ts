import { useSyncExternalStore } from "react";
import { DRAG_HOVER_DELAY_MS, dropScopeKey, readDragTarget, type DragOverResult, type DragSource, type DropZone, type HoldAction } from "./drag-zone";

/**
 * 側欄拖曳的模組層 store（資料夾 spec §6.13；讀碼發現 7）：靜態卡與抽屜兩份 NoteList 共用拖曳狀態、預覽與「建立中」。
 * 計時只有一個（彈簧與疊資料夾不會同列，共用 DRAG_HOVER_DELAY_MS）；離開樹以 document 的 dragover（capture）對照**發起拖曳的那個容器**判定。
 */

export interface StackPreviewState {
  anchorNoteId: string;
  parentFolderId: string | null;
  name: string;
  sourceTitle: string;
}

export interface DragView {
  /** 有拖曳進行中（本 PR 接手的）。 */
  active: boolean;
  /** dropScopeKey；null＝不標示。 */
  scope: string | null;
  preview: StackPreviewState | null;
  /** 放開後的「建立中」（獨立狀態，endDrag 不清）。 */
  creating: StackPreviewState | null;
}

let view: DragView = { active: false, scope: null, preview: null, creating: null };
let source: DragSource | null = null;
let container: HTMLElement | null = null;
/** 計時用的目前列；離開樹時重設為 null，回到同一列要重新起算。 */
let currentRow: string | null = null;
/** 最後一發 dragover 的 zone（被拒或離開樹＝null）。 */
let lastZone: DropZone | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DragView {
  return view;
}

/** 值沒變就不換物件、不通知（快照穩定）。 */
function commit(patch: Partial<DragView>): void {
  const next = { ...view, ...patch };
  if (next.active === view.active && next.scope === view.scope && next.preview === view.preview && next.creating === view.creating) return;
  view = next;
  for (const listener of [...listeners]) listener();
}

function clearTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/** 離開樹容器：清標示、取消計時、收起預覽，目前列重設為 null。 */
function leaveTree(): void {
  clearTimer();
  currentRow = null;
  lastZone = null;
  commit({ scope: null, preview: null });
}

function onDocumentDragOver(event: DragEvent): void {
  if (container === null || readDragTarget(event.target, container).kind !== "outside") return;
  leaveTree();
}

/** 清拖曳狀態、標示、計時、預覽與 document 監聽；不動 creating。 */
function teardown(): void {
  document.removeEventListener("dragover", onDocumentDragOver, true);
  clearTimer();
  source = null;
  container = null;
  currentRow = lastZone = null;
  commit({ active: false, scope: null, preview: null });
}

export function useDragView(): DragView {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getDragSource(): DragSource | null {
  return source;
}

/** 開始：記來源與發起的容器；在 document 以 capture 掛 dragover，target 不在該容器 → leaveTree()。 */
export function beginDrag(next: DragSource, el: HTMLElement): void {
  teardown();
  source = next;
  container = el;
  document.addEventListener("dragover", onDocumentDragOver, true);
  commit({ active: true });
}

/**
 * 套用一發 dragover 的結果；回 accept（＝zone 非 null）。計時：row 改變才取消並重起，同列不重起；hold 非 null 才起算，到時呼叫 onHold(hold)。
 * 預覽在 row ∉ {"preview", "note:<anchor>"} 時收起；收起本身不起算計時，這一發的結果照常套用。
 */
export function applyDragOver(result: DragOverResult, onHold: (hold: HoldAction) => void): boolean {
  if (source === null) return false;
  lastZone = result.zone;
  let preview = view.preview;
  if (preview !== null && result.row !== "preview" && result.row !== `note:${preview.anchorNoteId}`) preview = null;
  if (result.row !== currentRow) {
    clearTimer();
    currentRow = result.row;
    const hold = result.hold;
    if (hold !== null) {
      timer = setTimeout(() => {
        timer = null;
        onHold(hold);
      }, DRAG_HOVER_DELAY_MS);
    }
  }
  commit({ scope: result.zone === null ? null : dropScopeKey(result.zone.scope), preview });
  return result.zone !== null;
}

export function setPreview(preview: StackPreviewState | null): void {
  commit({ preview });
}

/** drop 用：回最後一發 dragover 的 zone（那一發被拒或之後已離開樹＝null），並立刻清掉拖曳狀態、標示、計時、預覽與 document 監聽。 */
export function takeDropZone(): DropZone | null {
  const zone = lastZone;
  teardown();
  return zone;
}

/** dragend 用：冪等清除拖曳狀態、標示、計時、預覽與 document 監聽；不動 creating。 */
export function endDrag(): void {
  teardown();
}

export function setCreating(state: StackPreviewState | null): void {
  commit({ creating: state });
}

/** @internal 測試用 */
export function __resetDragSessionForTests(): void {
  teardown();
  commit({ creating: null });
}
