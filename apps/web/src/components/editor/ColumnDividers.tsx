import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { collabUndoManager } from "@/collab/undo";
import { COLUMN_GAP_PX, columnKindOf, columnMinWidth, type PMNodeLike } from "@/collab/columns/layout";
import { STACKED_ATTR } from "@/collab/columns/layout-extension";
import { findNodeById } from "@/collab/columns/position";
import { createWidthPreview, writeColumnWidths, type WidthPreview } from "@/collab/columns/width-preview";
import { changedIndices, dividerResize, ratiosFromPixels } from "@/collab/columns/widths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyEditor = BlockNoteEditor<any, any, any>;

/** 桌面的命中區：溝的左側 8px（貼左欄右緣）；溝的右側留給欄內縮成 16px 的 ⋮⋮（`index.css`）。 */
const FINE_HIT_PX = 8;
/** 觸控沒有 hover、手指也比滑鼠粗：命中區佔滿整條溝。 */
const COARSE_HIT_PX = COLUMN_GAP_PX;
const COARSE_QUERY = "(pointer: coarse)";
/** 鍵盤每按一次移動「列寬 − 溝寬總和」的這個比例。 */
const KEY_STEP = 0.05;

const ROW_SELECTOR = `[data-node-type="${COLUMN_LIST_TYPE}"]`;

/** 一條分隔線：座標相對 `container`，aria 值是整數百分比。 */
interface DividerPlace {
  key: string;
  rowId: string;
  /** 左欄的 index（分隔線在第 index 與 index+1 欄之間）。 */
  index: number;
  columnIds: readonly string[];
  top: number;
  left: number;
  width: number;
  height: number;
  now: number;
  min: number;
  max: number;
  /** 觸控裝置：命中區佔滿溝、直線淡色常顯。 */
  touch: boolean;
}

/** 一列量到的東西：欄 id、各欄像素寬、各欄最小寬度。 */
interface RowMeasure {
  rowId: string;
  rowEl: HTMLElement;
  rowRect: DOMRect;
  columnEls: HTMLElement[];
  columnRects: DOMRect[];
  columnIds: string[];
  px: number[];
  mins: number[];
}

interface DragState {
  key: string;
  rowId: string;
  index: number;
  columnIds: readonly string[];
  pointerId: number;
  target: HTMLElement;
  startX: number;
  px: readonly number[];
  mins: readonly number[];
  /** 最近一次移動算出的整列比例；左右兩欄的像素沒變（沒動、或卡在最小寬度）時是 null，放開時不寫。 */
  next: number[] | null;
  preview: WidthPreview;
  prevUserSelect: string;
  controller: AbortController;
}

/** 未掛載時 tiptap 的 view 是代理物件，讀 `dom` 會丟例外。 */
function viewDomOf(editor: AnyEditor): HTMLElement | null {
  try {
    return editor.domElement ?? null;
  } catch {
    return null;
  }
}

function columnElsOf(rowEl: Element): HTMLElement[] {
  return Array.from(rowEl.children).filter((el): el is HTMLElement => el.getAttribute("data-node-type") === COLUMN_TYPE);
}

/** 堆疊、欄數不到兩欄、id 不齊、或與文件對不上的列 → null（不畫分隔線）。最小寬度依文件的欄內容判斷。 */
function measureRow(editor: AnyEditor, rowEl: HTMLElement): RowMeasure | null {
  if (rowEl.hasAttribute(STACKED_ATTR)) return null;
  const rowId = rowEl.getAttribute("data-id");
  if (!rowId) return null;
  const columnEls = columnElsOf(rowEl);
  if (columnEls.length < 2) return null;
  const columnIds = columnEls.map((el) => el.getAttribute("data-id") ?? "");
  if (columnIds.some((id) => !id)) return null;
  const hit = findNodeById(editor.prosemirrorState.doc as never, rowId, COLUMN_LIST_TYPE);
  if (!hit || hit.node.childCount !== columnEls.length) return null;
  const mins: number[] = [];
  (hit.node as unknown as PMNodeLike).forEach((col) => mins.push(columnMinWidth(columnKindOf(col))));
  const columnRects = columnEls.map((el) => el.getBoundingClientRect());
  return {
    rowId,
    rowEl,
    rowRect: rowEl.getBoundingClientRect(),
    columnEls,
    columnRects,
    columnIds,
    px: columnRects.map((r) => r.width),
    mins,
  };
}

function rowElById(dom: HTMLElement, rowId: string): HTMLElement | null {
  const css = dom.ownerDocument.defaultView?.CSS ?? CSS;
  return dom.querySelector<HTMLElement>(`${ROW_SELECTOR}[data-id="${css.escape(rowId)}"]`);
}

function isCoarsePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(COARSE_QUERY).matches;
}

function placesOf(row: RowMeasure, box: DOMRect, coarse: boolean): DividerPlace[] {
  const out: DividerPlace[] = [];
  for (let i = 0; i + 1 < row.px.length; i++) {
    const pL = row.px[i]!;
    const pR = row.px[i + 1]!;
    const total = pL + pR;
    const percent = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 50);
    out.push({
      key: `${row.rowId}:${i}`,
      rowId: row.rowId,
      index: i,
      columnIds: row.columnIds,
      top: row.rowRect.top - box.top,
      left: row.columnRects[i]!.right - box.left,
      width: coarse ? COARSE_HIT_PX : FINE_HIT_PX,
      height: row.rowRect.height,
      now: percent(pL),
      min: total > 0 ? percent(row.mins[i]!) : 0,
      max: total > 0 ? percent(total - row.mins[i + 1]!) : 100,
      touch: coarse,
    });
  }
  return out;
}

const sameIds = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) =>
  !!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]);

function samePlace(a: DividerPlace, b: DividerPlace): boolean {
  return (
    a.key === b.key &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.now === b.now &&
    a.min === b.min &&
    a.max === b.max &&
    a.touch === b.touch &&
    sameIds(a.columnIds, b.columnIds)
  );
}

const samePlaces = (a: readonly DividerPlace[], b: readonly DividerPlace[]) =>
  a.length === b.length && a.every((p, i) => samePlace(p, b[i]!));

/** 文件裡這一列目前的欄 id 與欄寬；列不在（或不是並排列）→ null。 */
function rowInDoc(editor: AnyEditor, rowId: string): { ids: string[]; widths: number[] } | null {
  const row = editor.getBlock(rowId) as { type?: string; children?: { id: string; props?: { width?: number } }[] } | undefined;
  if (!row || row.type !== COLUMN_LIST_TYPE || !row.children) return null;
  return { ids: row.children.map((c) => c.id), widths: row.children.map((c) => c.props?.width ?? 1) };
}

/**
 * 欄間分隔線的浮層：疊在 `container`（編輯欄的 `relative` wrapper）上，不在 ProseMirror 管的 DOM 裡放任何東西。只該在可編輯時掛上。
 *
 * - 每個未堆疊的列、每對相鄰欄一條；座標相對 `container`，`container` 跟內容一起捲，所以不聽捲動。
 * - 重量（合併到下一個 animation frame）：文件變更；ResizeObserver 觀察 `container`、`view.dom`（列上方的內容長高會把列往下推，
 *   列與欄本身大小不變）、每一列與它的欄；視窗 resize。`pointerenter`／`pointerdown` 時再同步量一次，收 RO 都沒觸發的版面變動；
 *   位置變了就只更新位置，那一下 `pointerdown` 不開始拖曳。
 * - 指標拖曳：移動中只改預覽樣式表（`createWidthPreview`），放開時寫一次（一個撤銷步）；Esc、列變成堆疊、列被刪或欄 id 序列變了、
 *   卸載都會取消並清掉預覽，不寫。
 * - 鍵盤 ←／→：每次移列可用寬的 5%，夾最小寬度；算出的欄寬與文件現值相同就不寫。寫入不自成撤銷步：聚焦、失焦時各切一次，
 *   快速連按由 UndoManager 的合併時間窗併成一步。
 */
export function ColumnDividers({ container, editor }: { container: HTMLElement | null; editor: AnyEditor }): JSX.Element | null {
  const { t } = useTranslation();
  const [places, setPlaces] = useState<DividerPlace[]>([]);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const placesRef = useRef<DividerPlace[]>(places);

  /** 結束拖曳：`commit` 為 true 且文件裡的欄 id 序列沒變才寫；一律清預覽、還原 `user-select`。 */
  const stopDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.controller.abort();
    if (commit && drag.next && sameIds(rowInDoc(editor, drag.rowId)?.ids, drag.columnIds)) {
      writeColumnWidths(editor, drag.rowId, drag.next);
    }
    drag.preview.clear();
    document.body.style.userSelect = drag.prevUserSelect;
    if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    setDraggingKey(null);
  };
  const stopDragRef = useRef(stopDrag);
  stopDragRef.current = stopDrag;

  /** 量全部的列；套用新位置，並在拖曳中的那一列消失（堆疊、被刪）或欄 id 序列變了時取消拖曳。回傳新位置。 */
  const measureAll = (): DividerPlace[] => {
    const dom = viewDomOf(editor);
    let next: DividerPlace[] = [];
    if (container && dom && editor.isEditable) {
      const box = container.getBoundingClientRect();
      const coarse = isCoarsePointer();
      dom.querySelectorAll<HTMLElement>(ROW_SELECTOR).forEach((rowEl) => {
        const row = measureRow(editor, rowEl);
        if (row) next = next.concat(placesOf(row, box, coarse));
      });
    }
    const drag = dragRef.current;
    if (drag && !next.some((p) => p.key === drag.key && sameIds(p.columnIds, drag.columnIds))) stopDragRef.current(false);
    if (!samePlaces(placesRef.current, next)) {
      placesRef.current = next;
      setPlaces(next);
    }
    return placesRef.current;
  };
  const measureAllRef = useRef(measureAll);
  measureAllRef.current = measureAll;

  useEffect(() => {
    if (!container) return;
    let frame = 0;
    let disposed = false;
    const observed = new Set<Element>();
    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!disposed) run();
      });
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    // 只對新出現的目標 observe、對消失的 unobserve：每次都重來會讓 RO 對每個目標再報一次，變成無窮重量。
    // 堆疊的列也觀察：它變寬到不再堆疊時，要靠它的大小變化重量。
    const syncObserved = () => {
      if (!observer) return;
      const targets = new Set<Element>([container]);
      const dom = viewDomOf(editor);
      if (dom) {
        targets.add(dom);
        dom.querySelectorAll(ROW_SELECTOR).forEach((rowEl) => {
          targets.add(rowEl);
          for (const col of columnElsOf(rowEl)) targets.add(col);
        });
      }
      for (const el of observed) {
        if (!targets.has(el)) {
          observer.unobserve(el);
          observed.delete(el);
        }
      }
      for (const el of targets) {
        if (!observed.has(el)) {
          observer.observe(el);
          observed.add(el);
        }
      }
    };
    const run = () => {
      syncObserved();
      measureAllRef.current();
    };
    const offChange = editor.onChange(schedule);
    window.addEventListener("resize", schedule);
    run();
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      offChange?.();
      window.removeEventListener("resize", schedule);
      stopDragRef.current(false);
    };
  }, [container, editor]);

  /** 同步重量；這條分隔線的位置變了（或已不在）→ true。 */
  const remeasureMoved = (place: DividerPlace): boolean => {
    const fresh = measureAllRef.current().find((p) => p.key === place.key);
    return !fresh || fresh.top !== place.top || fresh.left !== place.left || fresh.height !== place.height || fresh.width !== place.width;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, place: DividerPlace) => {
    if (e.button !== 0 || dragRef.current || !container) return;
    if (remeasureMoved(place)) return;
    const dom = viewDomOf(editor);
    const rowEl = dom && rowElById(dom, place.rowId);
    const row = rowEl && measureRow(editor, rowEl);
    if (!row || !sameIds(row.columnIds, place.columnIds)) return;
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const controller = new AbortController();
    const drag: DragState = {
      key: place.key,
      rowId: place.rowId,
      index: place.index,
      columnIds: row.columnIds,
      pointerId: e.pointerId,
      target,
      startX: e.clientX,
      px: row.px,
      mins: row.mins,
      next: null,
      preview: createWidthPreview(document),
      prevUserSelect: document.body.style.userSelect,
      controller,
    };
    dragRef.current = drag;
    document.body.style.userSelect = "none";
    setDraggingKey(place.key);
    const listen = { signal: controller.signal };
    /** 依指標位置算整列比例並更新預覽；放開那一筆也要算，它的位置不一定有 pointermove 報過。 */
    const apply = (ev: PointerEvent) => {
      const i = drag.index;
      const [left, right] = dividerResize(drag.px[i]!, drag.px[i + 1]!, drag.mins[i]!, drag.mins[i + 1]!, ev.clientX - drag.startX);
      const px = [...drag.px];
      px[i] = left;
      px[i + 1] = right;
      const grows = ratiosFromPixels(px, [i, i + 1]);
      drag.next = left === drag.px[i] ? null : grows;
      drag.preview.set({ columnIds: drag.columnIds, grows });
    };
    window.addEventListener("pointermove", (ev) => ev.pointerId === drag.pointerId && apply(ev), listen);
    window.addEventListener(
      "pointerup",
      (ev) => {
        if (ev.pointerId !== drag.pointerId) return;
        apply(ev);
        stopDragRef.current(true);
      },
      listen,
    );
    window.addEventListener("pointercancel", (ev) => ev.pointerId === drag.pointerId && stopDragRef.current(false), listen);
    window.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        stopDragRef.current(false);
      },
      { ...listen, capture: true },
    );
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, place: DividerPlace) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    if (dragRef.current) return;
    // 每次按鍵都從畫面重量：上一次的寫入已經改了欄寬。
    const dom = viewDomOf(editor);
    const rowEl = dom && rowElById(dom, place.rowId);
    const row = rowEl && measureRow(editor, rowEl);
    const inDoc = rowInDoc(editor, place.rowId);
    if (!row || !inDoc || !sameIds(row.columnIds, place.columnIds) || !sameIds(inDoc.ids, row.columnIds)) return;
    const i = place.index;
    const step = Math.max(0, row.rowRect.width - COLUMN_GAP_PX * (row.px.length - 1)) * KEY_STEP;
    const [left, right] = dividerResize(row.px[i]!, row.px[i + 1]!, row.mins[i]!, row.mins[i + 1]!, e.key === "ArrowLeft" ? -step : step);
    // 已在最小寬度：像素沒變就不寫（否則文件寬度與畫面不成比例的列會被整列改寫，多出一個看不出變化的撤銷步）。
    if (left === row.px[i]) return;
    const px = [...row.px];
    px[i] = left;
    px[i + 1] = right;
    const next = ratiosFromPixels(px, [i, i + 1]);
    if (changedIndices(inDoc.widths, next).length === 0) return;
    writeColumnWidths(editor, place.rowId, next, { undoStep: false });
  };

  const cutUndoStep = () => collabUndoManager(editor)?.stopCapturing();

  if (!container || places.length === 0) return null;
  return (
    <div className="kb-column-dividers pointer-events-none absolute inset-0 z-[5]">
      {places.map((place) => (
        <div
          key={place.key}
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          aria-label={t("note.columns.resize")}
          aria-valuenow={place.now}
          aria-valuemin={place.min}
          aria-valuemax={place.max}
          data-row-id={place.rowId}
          data-index={place.index}
          data-touch={place.touch ? "" : undefined}
          data-dragging={draggingKey === place.key ? "" : undefined}
          className="pointer-events-auto absolute cursor-col-resize touch-none"
          style={{ top: place.top, left: place.left, width: place.width, height: place.height }}
          onPointerEnter={() => void remeasureMoved(place)}
          onPointerDown={(e) => onPointerDown(e, place)}
          // 滑鼠按下不把焦點移到分隔線：焦點留在編輯器，拖完立刻 Ctrl+Z 就能撤銷；也免得按住拖曳時選到字。
          // 鍵盤使用者用 Tab 聚焦分隔線。
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => onKeyDown(e, place)}
          onFocus={cutUndoStep}
          onBlur={cutUndoStep}
        />
      ))}
    </div>
  );
}
