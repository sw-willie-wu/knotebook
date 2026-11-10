import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { SideMenuController } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { P, row, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { KnotebookSideMenu, NotePathContext, SIDE_MENU_FLOATING_OPTIONS } from "./KnotebookSideMenu";
import { DRAG_ACTIVE_CLASS, useDragActiveClass } from "./use-drag-active-class";

/**
 * 拖放進行中，⋮⋮ 與它外面的幾層都要不吃指標（drop 才落得到底下的編輯器）。jsdom 不載 `index.css`：把 `.kb-dragging` 那條規則
 * 原樣抽出來注入 `<style>`。
 *
 * jsdom 的 `getComputedStyle` 會做 `pointer-events` 的繼承：只關外層，裡面的元素量起來也是 none。所以先注入一張「每一層都明寫
 * auto」的底稿（特異度低於拖放規則）：每一層都得靠拖放規則直接選中才量得到 none，不能靠從外層繼承。這樣之後若有樣式在任何一層
 * 明寫 `auto`，規則也不會因為只關了外層而失效。
 */
const EXPLICIT_AUTO = "[data-kb-side-menu-popover], [data-kb-column-side-menu], .bn-side-menu, .bn-side-menu * { pointer-events: auto; }";
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\r\n/g, "\n");
function dragRules(): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selectors.includes(`.${DRAG_ACTIVE_CLASS}`)) out.push(`${selectors} {${m[2]}}`);
  }
  return out.join("\n");
}

let style: HTMLStyleElement | null = null;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  style = document.createElement("style");
  style.textContent = `${EXPLICIT_AUTO}\n${dragRules()}`;
  document.head.appendChild(style);
});
afterEach(() => {
  style?.remove();
  Reflect.deleteProperty(document, "elementsFromPoint");
});

const fire = (type: string, init: { relatedTarget?: EventTarget | null } = {}) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if ("relatedTarget" in init) Object.defineProperty(event, "relatedTarget", { value: init.relatedTarget });
  act(() => void document.dispatchEvent(event));
};

/** 欄（`columnEl`）掛 `useDragActiveClass`，裡面是真的 `SideMenuController`＋`KnotebookSideMenu`（帶 popover 標記），同筆記頁。 */
function mount(content: PartialBlockLike[]): { editor: AnyEditor; column: () => HTMLElement; unmount(): void } {
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: content as never }) as AnyEditor;
  function Column() {
    const [col, setCol] = useState<HTMLElement | null>(null);
    useDragActiveClass(col);
    return (
      <div ref={setCol} data-testid="column">
        <NotePathContext.Provider value="/n/h/note">
          <BlockNoteView editor={editor} editable sideMenu={false}>
            <SideMenuController sideMenu={KnotebookSideMenu} floatingUIOptions={SIDE_MENU_FLOATING_OPTIONS} />
          </BlockNoteView>
        </NotePathContext.Provider>
      </div>
    );
  }
  const { unmount } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Column />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { editor, column: () => screen.getByTestId("column"), unmount };
}

/** 讓 SideMenuView 指向第 2 欄的 b，回傳欄內 ⋮⋮ 的四層命中元素。 */
async function hoverColumnBlock(editor: AnyEditor): Promise<Record<"button" | "sideMenu" | "wrapper" | "popover", HTMLElement>> {
  const el = screen.getByText("b");
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [el] });
  act(() => {
    fireEvent.mouseMove(el, { clientX: 0, clientY: 0 });
  });
  expect(editor.getExtension(SideMenuExtension)!.store.state?.block?.id).toBe("b1");
  const button = await screen.findByLabelText("Open block menu");
  const layers = {
    button,
    sideMenu: button.closest<HTMLElement>(".bn-side-menu")!,
    wrapper: button.closest<HTMLElement>("[data-kb-column-side-menu]")!,
    popover: button.closest<HTMLElement>("[data-kb-side-menu-popover]")!,
  };
  for (const [name, layer] of Object.entries(layers)) expect(layer, name).toBeInstanceOf(HTMLElement);
  return layers;
}

const pointerEventsOf = (layers: Record<string, HTMLElement>) =>
  Object.fromEntries(Object.entries(layers).map(([name, el]) => [name, getComputedStyle(el).pointerEvents]));

const CONTENT = () => [P("x", "x1"), row([[P("a", "a1")], [P("b", "b1")]], "r")];
const ALL_NONE = { button: "none", sideMenu: "none", wrapper: "none", popover: "none" };

describe("U1 拖放進行中，欄內 ⋮⋮ 的每一層都不吃指標", () => {
  it("U1 前提：⋮⋮ 的 popover 在欄（columnEl）之內，祖先選擇器成立", async () => {
    const { editor, column } = mount(CONTENT());
    const { popover } = await hoverColumnBlock(editor);
    expect(column().contains(popover)).toBe(true);
  });

  it("U1 document 收到 dragenter（沒有先 dragstart：從作業系統或別的視窗拖進來）→ 欄有 class，四層 computed pointer-events 都是 none", async () => {
    const { editor, column } = mount(CONTENT());
    const layers = await hoverColumnBlock(editor);
    for (const value of Object.values(pointerEventsOf(layers))) expect(value).not.toBe("none"); // 對照：沒拖放時照常吃指標
    fire("dragenter");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    expect(pointerEventsOf(layers)).toEqual(ALL_NONE);
  });

  it("U1 只有 dragover（dragenter 漏掉）也加 class", async () => {
    const { column } = mount(CONTENT());
    fire("dragover");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
  });
});

describe("U1b 監聽在 capture 階段", () => {
  it.each(["dragenter", "dragover"])("U1b 落點元素的 %s handler 呼叫 stopPropagation → 仍然加上 class", (type) => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener(type, (e) => e.stopPropagation());
    const column = document.createElement("div");
    const { unmount } = renderHook(() => useDragActiveClass(column));
    try {
      act(() => void el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));
      expect(column.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    } finally {
      unmount();
      el.remove();
    }
  });

  it("U1b 落點元素的 drop handler 呼叫 stopPropagation → 仍然清掉 class", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener("drop", (e) => e.stopPropagation());
    const column = document.createElement("div");
    const { unmount } = renderHook(() => useDragActiveClass(column));
    try {
      fire("dragenter");
      act(() => void el.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })));
      expect(column.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    } finally {
      unmount();
      el.remove();
    }
  });
});

describe("U2 拖放結束時清掉", () => {
  it.each(["drop", "dragend", "pointermove"])("U2 dragenter 之後 %s → class 不在、四層都照常吃指標", async (end) => {
    const { editor, column } = mount(CONTENT());
    const layers = await hoverColumnBlock(editor);
    fire("dragenter");
    expect(pointerEventsOf(layers)).toEqual(ALL_NONE);
    fire(end);
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    for (const value of Object.values(pointerEventsOf(layers))) expect(value).not.toBe("none");
  });

  it.each([
    ["relatedTarget 是 null", null],
    ["relatedTarget 是元素", "element"],
  ] as const)("U2 拖放中途的 dragleave（%s）不清", (_label, related) => {
    const { column } = mount(CONTENT());
    fire("dragenter");
    fire("dragleave", { relatedTarget: related === null ? null : document.body });
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
  });
});

describe("U3 中途誤清會自己補回", () => {
  it("U3 dragenter → pointermove（誤清）→ dragover → class 回來", () => {
    const { column } = mount(CONTENT());
    fire("dragenter");
    fire("pointermove");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    fire("dragover");
    expect(column().classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
  });
});

describe("U4 卸載與換掉 columnEl", () => {
  it("U4 拖放中卸載 → class 拿掉；之後的 dragenter 不再加", () => {
    const el = document.createElement("div");
    const { unmount } = renderHook(() => useDragActiveClass(el));
    fire("dragenter");
    expect(el.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    unmount();
    expect(el.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    fire("dragenter");
    expect(el.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
  });

  it("U4 columnEl 換成另一個元素 → 舊的清掉、不再加；新的接手", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    const { rerender, unmount } = renderHook(({ el }) => useDragActiveClass(el), { initialProps: { el: first as HTMLElement | null } });
    fire("dragenter");
    rerender({ el: second });
    expect(first.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    fire("dragover");
    expect(first.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    expect(second.classList.contains(DRAG_ACTIVE_CLASS)).toBe(true);
    rerender({ el: null });
    expect(second.classList.contains(DRAG_ACTIVE_CLASS)).toBe(false);
    unmount();
  });
});
