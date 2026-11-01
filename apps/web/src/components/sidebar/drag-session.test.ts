import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCollapseForTests } from "./collapse";
import {
  __resetDragSessionForTests,
  beginDrag,
  endDrag,
  getDragSource,
  setCreating,
  setPreview,
  takeDropZone,
  applyDragOver,
  useDragView,
  type StackPreviewState,
} from "./drag-session";
import { DRAG_HOVER_DELAY_MS, type DragOverResult, type DragSource, type DropZone, type HoldAction } from "./drag-zone";
import { __resetFolderSortForTests } from "./folder-sort";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
  __resetDragSessionForTests();
  vi.useRealTimers();
});

/**
 * 拖曳狀態 store（資料夾 spec §6.13「離開樹容器的判定」「事件順序與狀態清理」「兩個 0.5 秒計時怎麼算」；PR-3c T3）。
 * DragOverResult 一律手造；容器照真實 DOM 形：`[data-sidebar-instance]` 裡的 `[data-sidebar-list]`（beginDrag 收的是後者）。
 */

const SOURCE: DragSource = { noteId: "A", space: "personal", folderId: null, title: "Alpha" };
const springF: HoldAction = { kind: "spring", folderId: "F" };
const springG: HoldAction = { kind: "spring", folderId: "G" };
const stackX: HoldAction = { kind: "stack", anchorNoteId: "X", parentFolderId: null };
const zoneF: DropZone = { kind: "place", folderId: "F", scope: { kind: "folder", folderId: "F" } };
const zoneG: DropZone = { kind: "place", folderId: "G", scope: { kind: "folder", folderId: "G" } };
const zoneList: DropZone = { kind: "place", folderId: null, scope: { kind: "list" } };
const zoneStack: DropZone = { kind: "stack", scope: { kind: "preview" } };
const overF: DragOverResult = { zone: zoneF, row: "folder:F", hold: springF };
const overG: DragOverResult = { zone: zoneG, row: "folder:G", hold: springG };
const PREVIEW_B: StackPreviewState = { anchorNoteId: "B", parentFolderId: null, name: "New folder", sourceTitle: "Alpha" };

function mountSidebar(): { list: HTMLElement; row: HTMLElement } {
  const instance = document.createElement("div");
  instance.setAttribute("data-sidebar-instance", "");
  const list = document.createElement("div");
  list.setAttribute("data-sidebar-list", "");
  const row = document.createElement("li");
  row.setAttribute("data-node-kind", "folder");
  row.setAttribute("data-node-id", "F");
  list.append(row);
  instance.append(list);
  document.body.append(instance);
  return { list, row };
}

function outsideEl(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-sidebar-header", "");
  document.body.append(el);
  return el;
}

/** document 上目前掛著的 dragover 監聽數（依 add／remove 的呼叫順序回放）；capture 才算 true 那格。 */
function trackDragoverListeners(): () => { capture: number; bubble: number } {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const isCapture = (opts: unknown) => opts === true || (typeof opts === "object" && opts !== null && (opts as { capture?: boolean }).capture === true);
  return () => {
    const ops = [
      ...add.mock.calls.map((c, i) => ({ order: add.mock.invocationCallOrder[i] ?? 0, on: true, call: c })),
      ...remove.mock.calls.map((c, i) => ({ order: remove.mock.invocationCallOrder[i] ?? 0, on: false, call: c })),
    ].sort((a, b) => a.order - b.order);
    const live = new Set<string>();
    const ids = new Map<unknown, number>();
    for (const { on, call } of ops) {
      if (call[0] !== "dragover") continue;
      if (!ids.has(call[1])) ids.set(call[1], ids.size);
      const key = `${ids.get(call[1])}:${isCapture(call[2])}`;
      if (on) live.add(key);
      else live.delete(key);
    }
    const all = [...live];
    return { capture: all.filter((k) => k.endsWith(":true")).length, bubble: all.filter((k) => k.endsWith(":false")).length };
  };
}

function setup() {
  vi.useFakeTimers();
  const { list, row } = mountSidebar();
  const hook = renderHook(() => useDragView());
  const onHold = vi.fn<(hold: HoldAction) => void>();
  act(() => beginDrag(SOURCE, list));
  const over = (result: DragOverResult) => {
    let accepted = false;
    act(() => {
      accepted = applyDragOver(result, onHold);
    });
    return accepted;
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  return { list, row, hook, onHold, over, advance, view: () => hook.result.current };
}

describe("drag-session", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("beginDrag：active true、記來源；takeDropZone 之後來源清空", () => {
    const { view } = setup();
    expect(view().active).toBe(true);
    expect(getDragSource()).toEqual(SOURCE);
    act(() => {
      takeDropZone();
    });
    expect(getDragSource()).toBeNull();
  });

  it("DS1 第一發 hold 起算：DELAY−1 未呼叫，再 1 呼叫一次、引數是 spring F", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(springF);
  });

  it("DS2 之後不再 dragover 也照樣到時呼叫", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("DS3 同列第二發在中途不重起：從第一發起算滿 DELAY 就呼叫", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS / 2);
    over(overF);
    advance(DRAG_HOVER_DELAY_MS / 2);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(springF);
  });

  it("DS4 換到 hold null 的列 → 永遠不呼叫；換到另一個有 hold 的列 → 從換列那一發重新起算", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    over({ zone: zoneList, row: null, hold: null });
    advance(DRAG_HOVER_DELAY_MS * 4);
    expect(onHold).not.toHaveBeenCalled();

    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    over(overG);
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(springG);
  });

  it("DS5 容器外的 document dragover → scope null、計時取消、預覽收起；容器內 → 不清", () => {
    const { over, advance, onHold, row, view } = setup();
    over(overF);
    act(() => setPreview(PREVIEW_B));
    act(() => {
      fireEvent.dragOver(row);
    });
    expect(view().scope).toBe("folder:F");
    expect(view().preview).toBe(PREVIEW_B);

    act(() => {
      fireEvent.dragOver(document.body);
    });
    expect(view().scope).toBeNull();
    expect(view().preview).toBeNull();
    expect(view().active).toBe(true);
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("DS6 takeDropZone 回最後一發（被接受）的 zone，並清狀態、計時與 document 監聽", () => {
    const listeners = trackDragoverListeners();
    const { over, advance, onHold, row, view } = setup();
    expect(listeners()).toEqual({ capture: 1, bubble: 0 });
    over(overF);
    act(() => setPreview(PREVIEW_B));
    let zone: DropZone | null = null;
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toEqual(zoneF);
    expect(view()).toMatchObject({ active: false, scope: null, preview: null });
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
    expect(listeners()).toEqual({ capture: 0, bubble: 0 });
    const snapshot = view();
    act(() => {
      fireEvent.dragOver(document.body);
      fireEvent.dragOver(row);
    });
    expect(view()).toBe(snapshot);
  });

  it("DS7 endDrag 冪等、清狀態與監聽，不動 creating", () => {
    const listeners = trackDragoverListeners();
    const { over, advance, onHold, view } = setup();
    over(overF);
    act(() => setPreview(PREVIEW_B));
    act(() => setCreating(PREVIEW_B));
    act(() => endDrag());
    expect(() => endDrag()).not.toThrow();
    expect(view()).toEqual({ active: false, scope: null, preview: null, creating: PREVIEW_B });
    expect(getDragSource()).toBeNull();
    expect(listeners()).toEqual({ capture: 0, bubble: 0 });
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();

    act(() => beginDrag(SOURCE, mountSidebar().list));
    act(() => {
      takeDropZone();
    });
    expect(() => endDrag()).not.toThrow();
    expect(view().creating).toBe(PREVIEW_B);
    act(() => setCreating(null));
    expect(view().creating).toBeNull();
  });

  it("DS8 預覽中一發換到別列 → 預覽收起；從這一發起算滿 DELAY 呼叫 onHold(stack X) 一次", () => {
    const { over, advance, onHold, view } = setup();
    over({ zone: zoneStack, row: "preview", hold: null });
    act(() => setPreview(PREVIEW_B));
    advance(DRAG_HOVER_DELAY_MS);
    expect(over({ zone: zoneList, row: "note:X", hold: stackX })).toBe(true);
    expect(view().preview).toBeNull();
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onHold).toHaveBeenCalledWith(stackX);
  });

  it("DS9 預覽中 row preview 與 row note:B 各一發 → 預覽保留、回 true", () => {
    const { over, view } = setup();
    act(() => setPreview(PREVIEW_B));
    expect(over({ zone: zoneStack, row: "preview", hold: null })).toBe(true);
    expect(view().preview).toBe(PREVIEW_B);
    expect(over({ zone: zoneStack, row: "note:B", hold: null })).toBe(true);
    expect(view().preview).toBe(PREVIEW_B);
    expect(view().scope).toBe("preview");
  });

  it("DS10 zone null → false、scope null；zone 非 null → true、scope＝dropScopeKey", () => {
    const { over, view } = setup();
    expect(over(overF)).toBe(true);
    expect(view().scope).toBe("folder:F");
    expect(over({ zone: null, row: "note:Q", hold: null })).toBe(false);
    expect(view().scope).toBeNull();
    expect(over({ zone: { kind: "place", folderId: null, scope: { kind: "group", groupId: "g1" } }, row: null, hold: null })).toBe(true);
    expect(view().scope).toBe("group:g1");
    expect(over({ zone: zoneList, row: null, hold: null })).toBe(true);
    expect(view().scope).toBe("list");
  });

  it("DS11 結果相同的連續兩發 → 快照 Object.is 相同、render 次數不變", () => {
    vi.useFakeTimers();
    const { list } = mountSidebar();
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useDragView();
    });
    const onHold = vi.fn<(hold: HoldAction) => void>();
    act(() => beginDrag(SOURCE, list));
    act(() => {
      applyDragOver(overF, onHold);
    });
    const before = hook.result.current;
    const rendersBefore = renders;
    act(() => {
      applyDragOver({ zone: { kind: "place", folderId: "F", scope: { kind: "folder", folderId: "F" } }, row: "folder:F", hold: springF }, onHold);
    });
    expect(Object.is(hook.result.current, before)).toBe(true);
    expect(renders).toBe(rendersBefore);
  });

  it("DS12 兩個容器：在另一份容器（c2）內發 → 視為離開；在發起的容器（c1）內 → 不清", () => {
    vi.useFakeTimers();
    const c1 = mountSidebar();
    const c2 = mountSidebar();
    const hook = renderHook(() => useDragView());
    const onHold = vi.fn<(hold: HoldAction) => void>();
    act(() => beginDrag(SOURCE, c1.list));
    act(() => {
      applyDragOver(overF, onHold);
    });
    act(() => {
      fireEvent.dragOver(c1.row);
    });
    expect(hook.result.current.scope).toBe("folder:F");
    act(() => {
      fireEvent.dragOver(c2.row);
    });
    expect(hook.result.current.scope).toBeNull();
    act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS * 2));
    expect(onHold).not.toHaveBeenCalled();
  });

  it("DS13 takeDropZone 取最後一發：後發被拒 → null；後來離開樹 → null；只有一發被接受 → 該 zone", () => {
    const { over } = setup();
    over(overF);
    over({ zone: null, row: "note:Q", hold: null });
    let zone: DropZone | null = zoneF;
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toBeNull();

    const second = mountSidebar();
    act(() => beginDrag(SOURCE, second.list));
    over(overF);
    act(() => {
      fireEvent.dragOver(outsideEl());
    });
    zone = zoneF;
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toBeNull();

    act(() => beginDrag(SOURCE, mountSidebar().list));
    over(overG);
    act(() => {
      zone = takeDropZone();
    });
    expect(zone).toEqual(zoneG);
  });

  it("DS14 document 監聽是 capture：容器外元素自己 stopPropagation 也照樣清標示", () => {
    const { over, view } = setup();
    over(overF);
    const blocker = outsideEl();
    blocker.addEventListener("dragover", (event) => event.stopPropagation());
    act(() => {
      fireEvent.dragOver(blocker);
    });
    expect(view().scope).toBeNull();
  });

  it("DS15 離開樹後回到同一列 → 從最後這一發起算滿 DELAY，onHold 恰一次", () => {
    const { over, advance, onHold } = setup();
    over(overF);
    advance(DRAG_HOVER_DELAY_MS / 2);
    act(() => {
      fireEvent.dragOver(document.body);
    });
    advance(DRAG_HOVER_DELAY_MS / 2);
    over(overF);
    advance(DRAG_HOVER_DELAY_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it("setPreview／setCreating 各自獨立；takeDropZone 收起預覽但不動 creating", () => {
    const { view } = setup();
    act(() => setPreview(PREVIEW_B));
    act(() => setCreating(PREVIEW_B));
    expect(view()).toEqual({ active: true, scope: null, preview: PREVIEW_B, creating: PREVIEW_B });
    act(() => {
      takeDropZone();
    });
    expect(view()).toEqual({ active: false, scope: null, preview: null, creating: PREVIEW_B });
  });

  it("beginDrag 時已在拖曳 → 舊的計時、標示、預覽與監聽一併清掉，只剩一個 capture 監聽", () => {
    const listeners = trackDragoverListeners();
    const { over, advance, onHold, view } = setup();
    over(overF);
    act(() => setPreview(PREVIEW_B));
    act(() => beginDrag(SOURCE, mountSidebar().list));
    expect(view()).toMatchObject({ active: true, scope: null, preview: null });
    expect(listeners()).toEqual({ capture: 1, bubble: 0 });
    advance(DRAG_HOVER_DELAY_MS * 2);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("沒有拖曳時 applyDragOver 回 false、不起計時、不改 view", () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useDragView());
    const onHold = vi.fn<(hold: HoldAction) => void>();
    const before = hook.result.current;
    let accepted = true;
    act(() => {
      accepted = applyDragOver(overF, onHold);
    });
    expect(accepted).toBe(false);
    expect(hook.result.current).toBe(before);
    act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS * 2));
    expect(onHold).not.toHaveBeenCalled();
  });
});
