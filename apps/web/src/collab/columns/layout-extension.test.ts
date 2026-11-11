import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { columnListBlockSpec, createHeadlessNoteSchema } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { IMG, P, mountEditor, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { COLUMN_KIND_ATTR, STACKED_ATTR, columnsLayoutExtension, withColumnsLayout } from "./layout-extension";

// 並排的欄寬與版面擴充。

/**
 * 可手動觸發的 ResizeObserver 替身：記下 observe 的目標；測試一律經 `fire(el)` 觸發，先斷言 el 已被 observe——
 * 直接對沒被 observe 的元素呼叫回呼，會讓「外掛根本沒 observe」的接線缺陷空真。
 */
const observed = new Set<Element>();
let instances: FakeResizeObserver[] = [];
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    instances.push(this);
  }
  observe(target: Element) {
    observed.add(target);
    this.targets.add(target);
  }
  unobserve(target: Element) {
    observed.delete(target);
    this.targets.delete(target);
  }
  disconnect() {
    for (const t of this.targets) observed.delete(t);
    this.targets.clear();
  }
}

function fire(el: Element) {
  expect(observed.has(el)).toBe(true);
  for (const ro of instances) {
    if (ro.targets.has(el)) ro.callback([{ target: el } as unknown as ResizeObserverEntry], ro as unknown as ResizeObserver);
  }
}

function setWidth(el: Element, value: number) {
  Object.defineProperty(el, "clientWidth", { value, configurable: true });
}

const rowEl = (root: ParentNode) => root.querySelector<HTMLElement>('[data-node-type="columnList"]')!;
const columnEls = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('[data-node-type="column"]'));

let cleanups: Array<() => void> = [];
beforeEach(() => {
  observed.clear();
  instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.unstubAllGlobals();
});

function mount(content: PartialBlockLike[]) {
  const mounted = mountEditor(content);
  cleanups.push(mounted.destroy);
  return mounted;
}

const textRow = () => [P("x", "x0"), row([[P("a")], [P("b")]], "r"), P("z", "z9")];

describe("L3／L4 堆疊", () => {
  it("L3 兩欄文字：列寬 300 → data-stacked；改成 900 → 拿掉", () => {
    const { container } = mount(textRow());
    setWidth(rowEl(container), 300);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(true);
    setWidth(rowEl(container), 900);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });

  it("L4 clientWidth 0（未排版、隱藏）→ 不堆疊", () => {
    const { container } = mount(textRow());
    setWidth(rowEl(container), 0);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });

  it("L4 兩欄全圖片、列寬 300 → 不堆疊（96+24+96 ≤ 300）", () => {
    const { container } = mount([P("x", "x0"), row([[IMG("i1")], [IMG("i2")]], "r"), P("z", "z9")]);
    setWidth(rowEl(container), 300);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });
});

describe("L5 接線：editor.mount 路徑（DiffEditor／公開頁），mount 後沒有交易", () => {
  it("不經 mountEditor／BlockNoteView：view() 建立時就 observe，fire 前不 dispatch 任何交易", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: textRow() as never }) as AnyEditor;
    const div = document.createElement("div");
    document.body.appendChild(div);
    editor.mount(div);
    cleanups.push(() => {
      editor.unmount();
      div.remove();
    });
    setWidth(rowEl(div), 300);
    fire(rowEl(div));
    expect(rowEl(div).hasAttribute(STACKED_ATTR)).toBe(true);
    setWidth(rowEl(div), 900);
    fire(rowEl(div));
    expect(rowEl(div).hasAttribute(STACKED_ATTR)).toBe(false);
  });
});

describe("L11／L12 mount 之後才出現／消失的列", () => {
  it("L11 mount 時沒有列，之後插入一列（/grid、貼上、撤銷叫回）→ update() 掃到並 observe，列寬 300 → 堆疊", () => {
    const { editor, container } = mount([P("x", "x0"), P("z", "z9")]);
    expect(rowEl(container)).toBeNull();
    editor.insertBlocks([row([[P("a")], [P("b")]], "r2")], "x0", "after");
    setWidth(rowEl(container), 300);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(true);
  });

  it("L12 列被刪掉後，舊元素的通知 → 不再觀察", () => {
    const { editor, container } = mount(textRow());
    const old = rowEl(container);
    editor.removeBlocks(["r"]);
    expect(old.isConnected).toBe(false);
    setWidth(old, 0);
    fire(old);
    expect(observed.has(old)).toBe(false);
  });

  it("L12b 元素離開 DOM 被取消觀察後又接回 → 下一次 update() 的 scan() 重新觀察", () => {
    const { editor, container } = mount(textRow());
    const el = rowEl(container);
    const parent = el.parentNode!;
    const next = el.nextSibling;
    el.remove();
    fire(el);
    expect(observed.has(el)).toBe(false);
    parent.insertBefore(el, next);
    editor.setTextCursorPosition("x0", "end");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("Q"));
    expect(rowEl(container)).toBe(el);
    expect(observed.has(el)).toBe(true);
  });
});

describe("L6 只含圖片的欄", () => {
  it("image 欄掛 data-kb-col-kind=image、文字欄沒有", () => {
    const { container } = mount([P("x", "x0"), row([[IMG("i1")], [P("b", "b1")]], "r"), P("z", "z9")]);
    const [imageCol, textCol] = columnEls(container);
    expect(imageCol.getAttribute(COLUMN_KIND_ATTR)).toBe("image");
    expect(textCol.hasAttribute(COLUMN_KIND_ATTR)).toBe(false);
  });
});

describe("L8 沒有 ResizeObserver", () => {
  it("mount 不丟例外", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    expect(() => mount(textRow())).not.toThrow();
  });
});

describe("L9 內容改變重算（列寬不變、不再 fire）", () => {
  it("圖片 → 文字逐欄換：用最近量到的寬度 400 重算", async () => {
    const { editor, container } = mount([P("x", "x0"), row([[IMG("i1")], [IMG("i2")]], "r"), P("z", "z9")]);
    setWidth(rowEl(container), 400);
    fire(rowEl(container));
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);

    editor.replaceBlocks(["i1"], [P("t1", "t1")]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:t1) | COL(image)]  paragraph:z");
    await Promise.resolve();
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false); // [text, image] 需 200+24+96＝320 ≤ 400

    editor.replaceBlocks(["i2"], [P("t2", "t2")]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:t1) | COL(paragraph:t2)]  paragraph:z");
    await Promise.resolve();
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(true); // 424 > 400

    editor.replaceBlocks(["t1"], [IMG("j1")]);
    editor.replaceBlocks(["t2"], [IMG("j2")]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(image) | COL(image)]  paragraph:z");
    await Promise.resolve();
    expect(rowEl(container).hasAttribute(STACKED_ATTR)).toBe(false);
  });
});

describe("L10 不改 shared spec", () => {
  it("shared 的 columnListBlockSpec 與 headless schema 不含版面外掛；noteSchema 含；withColumnsLayout 回新物件", () => {
    expect(columnListBlockSpec.extensions ?? []).not.toContain(columnsLayoutExtension);
    expect(createHeadlessNoteSchema(window.location.href).blockSpecs.columnList.extensions ?? []).not.toContain(columnsLayoutExtension);
    expect(noteSchema.blockSpecs.columnList.extensions).toContain(columnsLayoutExtension);
    expect(withColumnsLayout(columnListBlockSpec)).not.toBe(columnListBlockSpec);
  });
});
