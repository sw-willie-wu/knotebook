import { afterEach, describe, expect, it, vi } from "vitest";
import { collabUndoManager } from "@/collab/undo";
import { IMG, P, mountEditor, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

// 圖片寬度 ≤ 欄寬，不擴欄。

/** 原生把手按下時往 wrapper 塞的那個全幅 capture 元素（core `createResizableFileBlockWrapper` 的 eventCaptureElement）。 */
const CAPTURE = ":scope > div[style*='position: absolute']";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
});

function mount(content: PartialBlockLike[]) {
  const mounted = mountEditor(content);
  cleanups.push(mounted.destroy);
  return mounted;
}

/** `id` 那張圖的 wrapper／左右把手；欄內的圖墊上欄寬 200、顯示寬 200（previewWidth 300 被 max-width 擠成欄寬）。 */
function imageParts(container: HTMLElement, id: string, displayed = 200) {
  const outer = container.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"]`)!;
  const wrapper = outer.querySelector<HTMLElement>(".bn-file-block-content-wrapper")!;
  const [left, right] = Array.from(wrapper.querySelectorAll<HTMLElement>(".bn-resize-handle"));
  const column = outer.closest<HTMLElement>('[data-node-type="column"]');
  if (column) Object.defineProperty(column, "clientWidth", { value: 200, configurable: true });
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, displayed, 100));
  return { wrapper, left, right };
}

const down = (el: Element, clientX: number) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX }));
// mousemove 直接發在 window（冒泡經過 document 會叫醒 core SideMenu 的 mousemove，它要 jsdom 沒有的 elementsFromPoint）；
// mouseup 照真實發在元素上冒泡到 window（原生的 window mouseup handler 會拿 target 做 `wrapper.contains`）。
const move = (clientX: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
const up = (clientX: number) => document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX }));
const previewWidth = (editor: AnyEditor, id: string) => (editor.getBlock(id)!.props as { previewWidth?: number }).previewWidth;

const inColumn = (alignment?: string) => [
  P("x", "x0"),
  row([[{ ...IMG("i1", 300), ...(alignment ? { props: { ...IMG("i1", 300).props, textAlignment: alignment } } : {}) }], [P("b", "b1")]], "r"),
  P("z", "z9"),
];

describe("欄內圖片把手", () => {
  it("IR1 右把手：攔下原生（沒有 capture 元素、取消瀏覽器預設）；+100 → 夾在欄寬 200px；放開 → previewWidth 200；放開後的移動不再改寬、不再寫入", () => {
    const { editor, container } = mount(inColumn());
    const { wrapper, right } = imageParts(container, "i1");
    const before = wrapper.querySelectorAll(CAPTURE).length;
    expect(down(right, 500)).toBe(false); // dispatchEvent 在被 preventDefault 時回 false
    expect(wrapper.querySelectorAll(CAPTURE).length).toBe(before);
    move(600);
    expect(wrapper.style.width).toBe("200px");
    up(600);
    expect(previewWidth(editor, "i1")).toBe(200);
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    move(400);
    expect(wrapper.style.width).toBe("200px");
    up(400);
    expect(onChange).not.toHaveBeenCalled();
    expect(previewWidth(editor, "i1")).toBe(200);
  });

  it("IR6 一次調寬自成一個撤銷步（共編）：先打字不 stopCapturing 再拉圖，undo 一次只還原寬度、字還在", () => {
    const mounted = mountEditor(inColumn(), { collab: true });
    cleanups.push(mounted.destroy);
    const { editor, container } = mounted;
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
    const { right } = imageParts(container, "i1");
    const onChange = vi.fn();
    cleanups.push(editor.onChange(onChange) as () => void);
    down(right, 500);
    move(500);
    up(500);
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
