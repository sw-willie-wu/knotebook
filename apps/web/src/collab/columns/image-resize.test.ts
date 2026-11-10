import { afterEach, describe, expect, it, vi } from "vitest";
import { collabUndoManager } from "@/collab/undo";
import { IMG, P, mountEditor, row, shape, withChildren, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { expandColumnPixels, ratiosFromPixels } from "./widths";

// 欄內圖片把手：拉到不超過圖片可用寬只改圖；超過時擠壓其他欄（依各欄超出最小寬度的餘裕比例扣），放開時圖寬與欄寬一起寫、一步還原。

/** 原生把手按下時往 wrapper 塞的那個全幅 capture 元素（core `createResizableFileBlockWrapper` 的 eventCaptureElement）。 */
const CAPTURE = ":scope > div[style*='position: absolute']";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
  document.head.querySelectorAll("style[data-kb-col-preview]").forEach((s) => s.remove());
});

function mount(content: PartialBlockLike[], collab = false) {
  const mounted = mountEditor(content, { collab });
  cleanups.push(mounted.destroy);
  return mounted;
}

/**
 * jsdom 沒有版面，量值依身分回：
 * - `ck`：block id → 該 block 內容框（`.bn-block-content`）的 `clientWidth`，即圖片可用寬；
 * - `columns`：欄 id → 欄的像素寬（`getBoundingClientRect().width`）與 `clientWidth`；
 * - `rows`：列 id → 列的 `clientWidth`（堆疊時的上限）。
 * 欄的 width 一寫進文件 PM 就換一個新的欄元素，所以 mock 掛在 prototype、依 `data-id` 查表；查不到的元素回原實作。
 */
interface Geometry {
  ck?: Record<string, number>;
  columns?: Record<string, number>;
  rows?: Record<string, number>;
}
function mockGeometry({ ck = {}, columns = {}, rows = {} }: Geometry) {
  const rect = Element.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.getAttribute("data-node-type") === "column" ? columns[this.getAttribute("data-id") ?? ""] : undefined;
    return w === undefined ? rect.call(this) : new DOMRect(0, 0, w, 100);
  });
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!.get!;
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
    const id = this.getAttribute("data-id") ?? "";
    const type = this.getAttribute("data-node-type");
    let w: number | undefined;
    if (this.classList.contains("bn-block-content")) w = ck[this.closest(".bn-block-outer")?.getAttribute("data-id") ?? ""];
    else if (type === "column") w = columns[id];
    else if (type === "columnList") w = rows[id];
    return w === undefined ? clientWidth.call(this) : w;
  });
}

/**
 * `id` 那張圖的 wrapper／左右把手。預設量值：圖片可用寬 200、顯示寬 200（previewWidth 300 被 max-width 擠成可用寬）、
 * 兩欄各 200px（文字欄已在最小寬度）。
 */
function imageParts(container: HTMLElement, id: string, displayed = 200, geometry: Geometry = {}) {
  mockGeometry({ ck: { [id]: 200 }, columns: { rc0: 200, rc1: 200 }, ...geometry });
  const outer = container.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"]`)!;
  const wrapper = outer.querySelector<HTMLElement>(".bn-file-block-content-wrapper")!;
  const [left, right] = Array.from(wrapper.querySelectorAll<HTMLElement>(".bn-resize-handle"));
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, displayed, 100));
  return { wrapper, left, right };
}

const down = (el: Element, clientX: number) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX }));
// mousemove 直接發在 window（冒泡經過 document 會叫醒 core SideMenu 的 mousemove，它要 jsdom 沒有的 elementsFromPoint）；
// mouseup 照真實發在元素上冒泡到 window（原生的 window mouseup handler 會拿 target 做 `wrapper.contains`）。
const move = (clientX: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
const up = (clientX: number) => document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX }));
const previewWidth = (editor: AnyEditor, id: string) => (editor.getBlock(id)!.props as { previewWidth?: number }).previewWidth;
const widths = (editor: AnyEditor, rowId = "r") =>
  (editor.getBlock(rowId) as unknown as { children: { props: { width: number } }[] }).children.map((c) => c.props.width);
const previewTables = () => document.head.querySelectorAll("style[data-kb-col-preview]");
/** 預覽表裡某欄的 flex-grow；沒有預覽表或沒寫到這欄 → null。 */
const previewGrow = (columnId: string) => {
  const text = previewTables()[0]?.textContent ?? "";
  const m = new RegExp(`\\[data-id="${columnId}"\\] \\{ flex-grow: ([0-9.]+) !important; \\}`).exec(text);
  return m ? Number(m[1]) : null;
};

/** 數編輯器的 Y.Doc 收到幾次 update。 */
function countUpdates(editor: AnyEditor) {
  const spy = vi.fn();
  collabUndoManager(editor)!.doc.on("update", spy);
  return spy;
}

const inColumn = (alignment?: string, columnWidths?: number[]) => [
  P("x", "x0"),
  row(
    [[{ ...IMG("i1", 300), ...(alignment ? { props: { ...IMG("i1", 300).props, textAlignment: alignment } } : {}) }], [P("b", "b1")]],
    "r",
    columnWidths,
  ),
  P("z", "z9"),
];

describe("欄內圖片把手", () => {
  it("IR1 右把手：攔下原生（沒有 capture 元素、取消瀏覽器預設）；+100 超過可用寬 200 → 文字欄讓出 100px；放開 → previewWidth 300、文字欄比例變小；放開後的移動不再改寬、不再寫入", () => {
    const { editor, container } = mount(inColumn(undefined, [1, 2]));
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 400 } });
    const before = wrapper.querySelectorAll(CAPTURE).length;
    expect(down(right, 500)).toBe(false); // dispatchEvent 在被 preventDefault 時回 false
    expect(wrapper.querySelectorAll(CAPTURE).length).toBe(before);
    move(600);
    expect(wrapper.style.width).toBe("300px");
    expect([previewGrow("rc0"), previewGrow("rc1")]).toEqual([1, 1]);
    up(600);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([1, 1]);
    expect(previewTables().length).toBe(0);
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    move(400);
    expect(wrapper.style.width).toBe("300px");
    up(400);
    expect(onChange).not.toHaveBeenCalled();
    expect(previewWidth(editor, "i1")).toBe(300);
  });

  it("IR6 一次調寬自成一個撤銷步（共編）：先打字不 stopCapturing 再拉圖，undo 一次只還原寬度、字還在", () => {
    const { editor, container } = mount(inColumn(), true);
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    editor.setTextCursorPosition("b1", "end");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("Q"));
    const { right } = imageParts(container, "i1");
    down(right, 500);
    move(450);
    up(450);
    expect(previewWidth(editor, "i1")).toBe(150);
    manager.undo();
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(image) | COL(paragraph:bQ)]  paragraph:z");
  });

  it("IR2 右把手往左拖 −50 → 寬度跟著縮、放開 → previewWidth 取整數（顯示寬 200.6 → 150.6px → 151）", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1", 200.6);
    down(right, 500);
    move(450);
    expect(wrapper.style.width).toBe("150.6px");
    up(450);
    expect(previewWidth(editor, "i1")).toBe(151);
  });

  it("IR2d 下限同原生 64px（往左拖 −1000）", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1");
    down(right, 1500);
    move(500);
    expect(wrapper.style.width).toBe("64px");
    up(500);
    expect(previewWidth(editor, "i1")).toBe(64);
  });

  it("IR2b 左把手往右拖 +50 → 150px（左側位移反向）", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, left } = imageParts(container, "i1");
    down(left, 100);
    move(150);
    expect(wrapper.style.width).toBe("150px");
    up(150);
    expect(previewWidth(editor, "i1")).toBe(150);
  });

  it("IR2c 置中的圖：位移乘 2（右把手 −30 → 140px）", () => {
    const { editor, container } = mount(inColumn("center"));
    const { wrapper, right } = imageParts(container, "i1");
    down(right, 500);
    move(470);
    expect(wrapper.style.width).toBe("140px");
    up(470);
    expect(previewWidth(editor, "i1")).toBe(140);
  });

  it("IR3 只按一下（無位移）→ 不寫入、沒有新交易", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1");
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    const before = wrapper.style.width;
    down(right, 500);
    move(500);
    up(500);
    expect(wrapper.style.width).toBe(before);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("IR4 頂層（非欄內）的圖：不攔，原生照舊塞 capture 元素", () => {
    const { container } = mount([P("x", "x0"), IMG("i0", 300), P("z", "z9")]);
    const { wrapper, right } = imageParts(container, "i0");
    const before = wrapper.querySelectorAll(CAPTURE).length;
    down(right, 500);
    expect(wrapper.querySelectorAll(CAPTURE).length).toBe(before + 1);
    up(500);
  });

  it("IR5 唯讀（isEditable=false）：欄內把手不攔", () => {
    const { editor, container } = mount(inColumn());
    editor.isEditable = false;
    const { wrapper, right } = imageParts(container, "i1");
    const before = wrapper.querySelectorAll(CAPTURE).length;
    down(right, 500);
    expect(wrapper.querySelectorAll(CAPTURE).length).toBe(before + 1);
    up(500);
  });
});

/** `[圖｜文字｜文字]`，各欄像素 200／400／300 與文件比例一致；兩個文字欄的餘裕 200 與 100。 */
const threeColumns = () => [
  P("x", "x0"),
  row([[IMG("i1", 300)], [P("b", "b1")], [P("c", "c1")]], "r", [0.67, 1.33, 1]),
  P("z", "z9"),
];
const THREE_PX = { rc0: 200, rc1: 400, rc2: 300 };

describe("欄內圖片擴欄", () => {
  it("E2 超過可用寬：其他欄依餘裕比例讓出，放開時 previewWidth＝round(W)、欄寬同一筆 Y update，undo 一次兩者都還原", () => {
    const { editor, container } = mount(threeColumns(), true);
    const manager = collabUndoManager(editor)!;
    const { wrapper, right } = imageParts(container, "i1", 200.4, { columns: THREE_PX });
    const updates = countUpdates(editor);
    down(right, 500);
    move(650);
    expect(wrapper.style.width).toBe("350.4px");
    const expected = expandColumnPixels([200, 400, 300], [96, 200, 200], 0, 150.4);
    expect(expected.granted).toBe(150.4);
    // 兩個文字欄依餘裕 200：100 扣。
    expect(400 - expected.px[1]!).toBeCloseTo(2 * (300 - expected.px[2]!), 9);
    const next = ratiosFromPixels(expected.px);
    expect(next).toEqual([1.17, 1, 0.83]);
    expect([previewGrow("rc0"), previewGrow("rc1"), previewGrow("rc2")]).toEqual(next);
    expect(updates).not.toHaveBeenCalled();
    up(650);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(previewWidth(editor, "i1")).toBe(350);
    expect(widths(editor)).toEqual(next);
    expect(previewTables().length).toBe(0);
    manager.undo();
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("E2b 拉大後拉回可用寬以內：預覽表拿掉，放開只寫 previewWidth、欄寬不變", () => {
    const { editor, container } = mount(threeColumns());
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(600);
    expect(previewTables().length).toBe(1);
    move(480);
    expect(wrapper.style.width).toBe("180px");
    expect(previewTables().length).toBe(0);
    up(480);
    expect(previewWidth(editor, "i1")).toBe(180);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("E2c 只超過 1px：算出的欄比例捨入後與文件現值相同，放開仍寫 previewWidth、欄寬不變", () => {
    const { editor, container } = mount(threeColumns());
    const { right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(501);
    expect(ratiosFromPixels(expandColumnPixels([200, 400, 300], [96, 200, 200], 0, 1).px)).toEqual([0.67, 1.33, 1]);
    up(501);
    expect(previewWidth(editor, "i1")).toBe(201);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("E3c 另一欄也是圖片欄：讓到圖片欄的最小寬度 96 為止（讓出 104px）", () => {
    const { editor, container } = mount([P("x", "x0"), row([[IMG("i1", 300)], [IMG("i3", 300)]], "r", [1, 1]), P("z", "z9")]);
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 200 } });
    down(right, 500);
    move(700);
    expect(wrapper.style.width).toBe("304px");
    up(700);
    expect(previewWidth(editor, "i1")).toBe(304);
    expect(widths(editor)).toEqual(ratiosFromPixels([304, 96]));
  });

  it("E3 其他欄都在最小寬度：寬度停在可用寬、欄不變、沒有預覽表", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1");
    down(right, 500);
    move(600);
    expect(wrapper.style.width).toBe("200px");
    expect(previewTables().length).toBe(0);
    up(600);
    expect(previewWidth(editor, "i1")).toBe(200);
    expect(widths(editor)).toEqual([1, 1]);
  });

  it("E3b 上限 4000：可用寬 3000＋文字欄餘裕 1800 足以撐到 4800，仍停在 4000、文字欄只讓 1000px", () => {
    const { editor, container } = mount(inColumn(undefined, [1.2, 0.8]));
    const { wrapper, right } = imageParts(container, "i1", 3000, { ck: { i1: 3000 }, columns: { rc0: 3000, rc1: 2000 } });
    down(right, 500);
    move(5500);
    expect(wrapper.style.width).toBe("4000px");
    up(5500);
    expect(previewWidth(editor, "i1")).toBe(4000);
    expect(widths(editor)).toEqual(ratiosFromPixels([4000, 1000]));
    expect(widths(editor)).toEqual([1.6, 0.4]);
  });

  it("E4 縮小從不改欄（文字欄有餘裕也一樣）", () => {
    const { editor, container } = mount(inColumn(undefined, [1, 2]));
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 400 } });
    down(right, 500);
    move(450);
    expect(wrapper.style.width).toBe("150px");
    expect(previewTables().length).toBe(0);
    up(450);
    expect(previewWidth(editor, "i1")).toBe(150);
    expect(widths(editor)).toEqual([1, 2]);
  });

  it("E4b 堆疊的列：上限是列寬、不動欄", () => {
    const { editor, container } = mount(inColumn(undefined, [1, 2]));
    container.querySelector('[data-node-type="columnList"]')!.setAttribute("data-stacked", "");
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: { rc0: 200, rc1: 400 }, rows: { r: 300 } });
    down(right, 500);
    move(1000);
    expect(wrapper.style.width).toBe("300px");
    expect(previewTables().length).toBe(0);
    up(1000);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([1, 2]);
  });

  it("E5 縮排子 block 裡的圖：可用寬取該 block 的內容框（比欄窄 40px），超過它就開始擴欄", () => {
    const content = [P("x", "x0"), row([[withChildren(P("t", "t1"), [IMG("i2", 300)])], [P("b", "b1")]], "r", [1, 2]), P("z", "z9")];
    const { editor, container } = mount(content);
    const { wrapper, right } = imageParts(container, "i2", 150, { ck: { i2: 160 }, columns: { rc0: 200, rc1: 400 } });
    down(right, 500);
    move(530);
    expect(wrapper.style.width).toBe("180px");
    up(530);
    expect(previewWidth(editor, "i2")).toBe(180);
    expect(widths(editor)).toEqual(ratiosFromPixels(expandColumnPixels([200, 400], [200, 200], 0, 20).px));
    expect(widths(editor)).toEqual([0.73, 1.27]);
  });
});

describe("欄內圖片拖曳的取消與放開", () => {
  it("E6 拖曳中按 Esc：不寫、預覽表拿掉、圖寬回到按下前；之後的移動與放開不再有作用", () => {
    const { editor, container } = mount(threeColumns());
    const { wrapper, right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    const styleBefore = wrapper.style.width;
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    down(right, 500);
    move(650);
    expect(previewTables().length).toBe(1);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(previewTables().length).toBe(0);
    expect(wrapper.style.width).toBe(styleBefore);
    move(700);
    up(700);
    expect(onChange).not.toHaveBeenCalled();
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("E7 拖曳中列的欄 id 序列變了（另一端刪了一欄）：取消、不寫", () => {
    const { editor, container } = mount(threeColumns());
    const { right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(650);
    editor.removeBlocks(["rc2"]);
    expect(previewTables().length).toBe(0);
    const before = JSON.stringify(editor.document);
    move(700);
    up(700);
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(previewWidth(editor, "i1")).toBe(300);
  });

  it("E7b 拖曳中圖片被刪（列沒變）：取消，放開不丟例外、不寫", () => {
    const content = [P("x", "x0"), row([[withChildren(P("t", "t1"), [IMG("i2", 300)])], [P("b", "b1")]], "r", [1, 2]), P("z", "z9")];
    const { editor, container } = mount(content);
    const { right } = imageParts(container, "i2", 150, { ck: { i2: 160 }, columns: { rc0: 200, rc1: 400 } });
    down(right, 500);
    move(560);
    expect(previewTables().length).toBe(1);
    editor.removeBlocks(["i2"]);
    expect(previewTables().length).toBe(0);
    const before = JSON.stringify(editor.document);
    // 事件 listener 丟的例外不會從 dispatchEvent 傳出來，jsdom 改在 window 上發 error 事件。
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    cleanups.push(() => window.removeEventListener("error", onError));
    up(560);
    expect(errors).toEqual([]);
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(widths(editor)).toEqual([1, 2]);
  });

  it("E8 拖曳中編輯器卸載：預覽表拿掉、之後的放開不寫", () => {
    const mounted = mountEditor(threeColumns());
    const { right } = imageParts(mounted.container, "i1", 200, { columns: THREE_PX });
    const write = vi.spyOn(mounted.editor, "updateBlock");
    down(right, 500);
    move(650);
    expect(previewTables().length).toBe(1);
    mounted.destroy();
    expect(previewTables().length).toBe(0);
    up(700);
    expect(write).not.toHaveBeenCalled();
  });

  it("E9 拖曳中變成唯讀：放開不寫、預覽表拿掉", () => {
    const { editor, container } = mount(threeColumns());
    const { right } = imageParts(container, "i1", 200, { columns: THREE_PX });
    down(right, 500);
    move(650);
    editor.isEditable = false;
    up(650);
    expect(previewTables().length).toBe(0);
    expect(previewWidth(editor, "i1")).toBe(300);
    expect(widths(editor)).toEqual([0.67, 1.33, 1]);
  });

  it("E10 放開那一筆的位置也算：沒有 mousemove、直接在 −50 處放開 → previewWidth 150", () => {
    const { editor, container } = mount(inColumn());
    const { right } = imageParts(container, "i1");
    down(right, 500);
    up(450);
    expect(previewWidth(editor, "i1")).toBe(150);
  });
});
