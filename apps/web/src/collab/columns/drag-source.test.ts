/* eslint-disable @typescript-eslint/no-explicit-any -- 測試直接摸 PM 的 view（型別在 apps/web 拿不到） */
import { afterEach, describe, expect, it, vi } from "vitest";
import { P, mountEditor, row, startBlockDrag, type PartialBlockLike } from "@/test/columns-fixtures";
import * as dragSource from "./drag-source";
import { clearDraggedBlocks, draggedBlocksOf } from "./drag-source";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  vi.restoreAllMocks();
});

/** 掛編輯器。記錄器由列的版面 extension 在 mount 時掛上（用 `noteSchema` 的編輯器都有），unmount 時跟著拆掉。 */
function mount(content: PartialBlockLike[]) {
  const mounted = mountEditor(content);
  cleanups.push(mounted.destroy);
  return { ...mounted, view: mounted.editor.prosemirrorView as any };
}

const fire = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

describe("DS 拖曳來源記錄器", () => {
  it("DS1 ⋮⋮ 拖單一 block → 記下 node", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    expect(view.dragging).toBeTruthy(); // 前提：core 把它當成 block 拖曳
    expect(draggedBlocksOf(view)).toEqual({ ids: ["x1"], kind: "node", hasRows: false });
  });

  it("DS1 多選含頂層列 → hasRows", () => {
    const { editor, view } = mount([P("p", "p1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("y", "y1")]);
    startBlockDrag(editor, "p1", { range: ["p1", "a1"] });
    expect(draggedBlocksOf(view)).toEqual({ ids: ["p1", "r"], kind: "multi", hasRows: true });
  });

  it("DS2 多選兩個頂層 block → multi、ids 依文件順序", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    startBlockDrag(editor, "z1", { range: ["y1", "z1"] });
    expect(draggedBlocksOf(view)).toEqual({ ids: ["y1", "z1"], kind: "multi", hasRows: false });
  });

  it("DS3 document 上的 capture drop 之後記錄仍在；dragend 之後清掉", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "y1");
    let seenInCapture: unknown = "not-called";
    document.addEventListener("drop", () => (seenInCapture = draggedBlocksOf(view)), { capture: true, once: true });
    fire(document, "drop");
    expect(seenInCapture).toEqual({ ids: ["y1"], kind: "node", hasRows: false });
    expect(draggedBlocksOf(view)).toEqual({ ids: ["y1"], kind: "node", hasRows: false });
    fire(document, "dragend");
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("DS3 clearDraggedBlocks 清掉記錄", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "y1");
    clearDraggedBlocks(view);
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("DS4 唯讀編輯器的 dragstart 記 null（蓋掉之前的記錄）", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    expect(draggedBlocksOf(view)).not.toBeNull(); // 對照：可編輯時有記
    editor.isEditable = false;
    startBlockDrag(editor, "y1");
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("DS5 記錄器的 document 監聽帶 mount 的 signal；unmount 之後 signal 已 abort、dragstart 不再記", () => {
    // document 上還有 core 的其他 dragstart／dragend 監聽，只看記錄器自己那次呼叫期間註冊的。
    const add = vi.spyOn(document, "addEventListener");
    const original = dragSource.attachDragSourceRecorder;
    let mountSignal: AbortSignal | undefined;
    let registered: Array<[string, AddEventListenerOptions | undefined]> = [];
    vi.spyOn(dragSource, "attachDragSourceRecorder").mockImplementation((editor, dom, signal) => {
      const before = add.mock.calls.length;
      original(editor, dom, signal);
      mountSignal = signal;
      registered = add.mock.calls.slice(before).map(([type, , options]) => [type, options as AddEventListenerOptions | undefined]);
    });
    const mounted = mountEditor([P("x", "x1"), P("y", "y1")]);
    const { editor } = mounted;
    const view = editor.prosemirrorView as any;
    const host = editor.domElement!.parentElement!;
    expect(mountSignal).toBeInstanceOf(AbortSignal); // 前提：mount 時掛了記錄器
    expect(registered.map(([type]) => type)).toEqual(["dragstart", "dragend"]);
    for (const [, options] of registered) expect(options?.signal).toBe(mountSignal);
    startBlockDrag(editor, "x1");
    expect(draggedBlocksOf(view)).not.toBeNull(); // 對照：mount 中有記
    clearDraggedBlocks(view);
    mounted.destroy();
    expect(mountSignal!.aborted).toBe(true);
    // unmount 後 `editor.domElement` 不在，光看這一句會空真；承重的是上面的 signal 斷言。
    const source = document.createElement("div");
    host.appendChild(source);
    cleanups.push(() => source.remove());
    expect(source.isConnected).toBe(true);
    fire(source, "dragstart");
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("DS6 dragstart 被 preventDefault → 記 null（蓋掉之前的記錄）", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    expect(draggedBlocksOf(view)).not.toBeNull(); // 對照：沒被取消時有記
    const { event } = startBlockDrag(editor, "y1", { prevent: true });
    expect(event.defaultPrevented).toBe(true);
    expect(view.dragging).toBeTruthy(); // 被取消的 dragstart 照樣讓 core 設了 view.dragging
    expect(draggedBlocksOf(view)).toBeNull();
  });

  it("DS7 編輯器容器外的 dragstart → 記 null", () => {
    const { editor, view } = mount([P("x", "x1"), P("y", "y1")]);
    startBlockDrag(editor, "x1");
    const outside = document.createElement("div");
    document.documentElement.appendChild(outside);
    cleanups.push(() => outside.remove());
    expect(editor.domElement!.parentElement!.contains(outside)).toBe(false); // 前提
    fire(outside, "dragstart");
    expect(draggedBlocksOf(view)).toBeNull();
  });
});
