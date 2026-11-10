import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useComponentsContext } from "@blocknote/react";
import i18n from "@/i18n";
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { RECENT_COLORS_KEY, readRecentColors, resetRecentColorsForTest } from "@/lib/recent-colors";
import { createTestEditor } from "@/test/ai-host";
import {
  declaredContentWidth,
  layoutHostTrigger,
  menuNode,
  openHostMenu,
  renderColorMenuHost,
  settle,
  waitForMenuShown,
} from "@/test/color-menu-host";
import { applyColor } from "./apply-color";
import { ColorMenuBody, useColorMenu } from "./ColorMenuBody";
import { KeepOpenMenuItem } from "./KeepOpenMenuItem";

// 包住原函式、照常寫入，只是讓測試看得到呼叫（ESM 命名匯出不能直接 spyOn）。
vi.mock("./apply-color", async (orig) => {
  const m = await orig<typeof import("./apply-color")>();
  return { ...m, applyColor: vi.fn(m.applyColor) };
});

const applyMock = vi.mocked(applyColor);

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  applyMock.mockClear();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  vi.unstubAllGlobals();
});

/** 只有 `(pointer: fine)` 依 `fine` 回報，其餘查詢恆不符合。 */
function stubPointer(fine: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: fine && query === "(pointer: fine)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function TestItems() {
  const Components = useComponentsContext()!;
  const menu = useColorMenu()!;
  return (
    <>
      <KeepOpenMenuItem
        data-test="t-custom"
        data-kb-color-return="t-custom"
        onClick={(e) =>
          menu.openPanel({
            section: "text",
            target: { kind: "inline" },
            current: "default",
            byKeyboard: e.detail === 0,
            returnTo: "t-custom",
          })
        }
      >
        Custom…
      </KeepOpenMenuItem>
      <Components.Generic.Menu.Item data-test="t-other">other item</Components.Generic.Menu.Item>
    </>
  );
}

function mount() {
  const editor = createTestEditor([{ id: "p1", type: "paragraph", content: "hello" }]);
  const view = renderColorMenuHost(
    editor,
    <ColorMenuBody>
      <TestItems />
    </ColorMenuBody>,
  );
  return { editor, ...view };
}

const trigger = () => screen.getByTestId("host-trigger");
const customItem = () => document.querySelector<HTMLElement>('[data-kb-color-return="t-custom"]')!;
const panel = () => document.querySelector<HTMLElement>(".kb-color-panel");
const hexInput = () => screen.getByRole("textbox", { name: "Hex color", hidden: true }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;

/** 開選單 → 點「自訂…」，等面板掛上。`detail` 0 表示鍵盤啟動。 */
async function openPanel(detail = 0) {
  await openHostMenu();
  fireEvent.click(customItem(), { detail });
  await waitFor(() => expect(panel()).not.toBeNull());
}

/** 等 lazy 載入的 react-colorful 掛好，回傳兩個 slider（飽和度方塊、色相）。 */
async function sliders() {
  return waitFor(() => {
    const s = screen.getAllByRole("slider", { hidden: true });
    expect(s).toHaveLength(2);
    return s;
  });
}

function typeHex(value: string) {
  fireEvent.change(hexInput(), { target: { value } });
}

describe("CustomColorPanel／ColorMenuBody", () => {
  it("PN1 開面板：選單仍開、面板取代項目列表、焦點在面板內", async () => {
    mount();
    await openPanel();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(menuNode()).not.toBeNull();
    expect(screen.queryByText("other item")).toBeNull();
    expect(customItem()).toBeNull();
    expect(panel()!.contains(document.activeElement)).toBe(true);
    await settle();
    expect(menuNode()).not.toBeNull();
    expect(panel()!.contains(document.activeElement)).toBe(true);
  });

  it("PN2 輸入 F60 按 Enter：以 #ff6600 套用、選單關閉、記進最近用過", async () => {
    const { editor } = mount();
    await openPanel();
    typeHex("F60");
    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(editor, "text", { kind: "inline" }, "#ff6600");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(menuNode()).toBeNull());
    expect(readRecentColors()[0]).toBe("#ff6600");
  });

  it("PN2 輸入法選字中的 Enter 不套用、選單仍開", async () => {
    mount();
    await openPanel();
    typeHex("#ff6600");
    fireEvent.keyDown(hexInput(), { key: "Enter", isComposing: true });
    expect(applyMock).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(readRecentColors()).toEqual([]);
    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("PN3 不合法的 #ff66：標 aria-invalid、顯示提示、Apply 停用", async () => {
    mount();
    await openPanel();
    typeHex("#ff66");
    expect(hexInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a color as #rgb or #rrggbb")).toBeInTheDocument();
    expect(button("Apply")).toBeDisabled();
    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("PN4 色碼框裡的 ArrowDown 不被 preventDefault、焦點留在色碼框", async () => {
    mount();
    await openPanel();
    const input = hexInput();
    input.focus();
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "ArrowUp" })).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("PN5 點最近用過的第 3 個：套用該色、選單關閉、它移到最前面", async () => {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(["#111111", "#222222", "#333333"]));
    const { editor } = mount();
    await openPanel();
    fireEvent.click(button("#333333"));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(editor, "text", { kind: "inline" }, "#333333");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(menuNode()).toBeNull());
    expect(readRecentColors()).toEqual(["#333333", "#111111", "#222222"]);
  });

  it("PN6 Tab 繞回：有最近色時最後一個是第 3 個色塊", async () => {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(["#111111", "#222222", "#333333"]));
    mount();
    const restore = layoutHostTrigger();
    try {
      await openPanel();
      await waitForMenuShown();
      await sliders();
      const last = button("#333333");
      const back = button("Back");
      last.focus();
      expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(back);
      expect(trigger()).toHaveAttribute("aria-expanded", "true");
      back.focus();
      expect(fireEvent.keyDown(back, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(last);
      await settle();
      expect(menuNode()).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("PN6 Tab 繞回：沒有最近色時最後一個是 Apply", async () => {
    mount();
    const restore = layoutHostTrigger();
    try {
      await openPanel();
      await waitForMenuShown();
      await sliders();
      typeHex("#ff6600");
      const apply = button("Apply");
      const back = button("Back");
      expect(apply).toBeEnabled();
      expect(screen.queryAllByRole("button", { name: /^#/, hidden: true })).toHaveLength(0);
      apply.focus();
      expect(fireEvent.keyDown(apply, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(back);
      expect(trigger()).toHaveAttribute("aria-expanded", "true");
      back.focus();
      expect(fireEvent.keyDown(back, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(apply);
    } finally {
      restore();
    }
  });

  /** 在色碼框上送一個鍵，回傳 document 的 keydown 監聽收到的鍵。 */
  async function keysReachingDocument(key: string) {
    mount();
    await openPanel();
    const spy = vi.fn();
    document.addEventListener("keydown", spy);
    try {
      const input = hexInput();
      input.focus();
      fireEvent.keyDown(input, { key });
      return spy.mock.calls.map((c) => (c[0] as KeyboardEvent).key);
    } finally {
      document.removeEventListener("keydown", spy);
    }
  }

  it("PN7 色碼框的 Tab 傳得到 document", async () => {
    expect(await keysReachingDocument("Tab")).toEqual(["Tab"]);
  });

  it("PN7 色碼框的 Escape 傳得到 document", async () => {
    expect(await keysReachingDocument("Escape")).toEqual(["Escape"]);
  });

  it("PN7 色碼框的 ArrowDown 傳不到 document", async () => {
    expect(await keysReachingDocument("ArrowDown")).toEqual([]);
  });

  const sliderLabels = async () => (await sliders()).map((s) => s.getAttribute("aria-label"));

  it("PN8 兩個 slider 的 aria-label 改成 i18n 字串，re-render 後仍在", async () => {
    mount();
    await openPanel();
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);

    // 改色碼讓 HexColorPicker 以新的 color prop 重新 render
    typeHex("#ff6600");
    typeHex("#00ff00");
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);
    // 鍵盤調整色相：只有 react-colorful 內部 state 變動、外層不一定 re-render（拖曳同一路徑）
    const [, hue] = await sliders();
    // react-colorful 只看 which／keyCode
    fireEvent.keyDown(hue!, { key: "ArrowRight", keyCode: 39, which: 39 });
    await waitFor(() => expect(hexInput().value).not.toBe("#00ff00"));
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);
  });

  it("PN8 換成 zh-TW 後 slider 的 aria-label 跟著換", async () => {
    mount();
    await openPanel();
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);
    await act(() => i18n.changeLanguage("zh-TW"));
    expect(await sliderLabels()).toEqual(["飽和度與亮度", "色相"]);
  });

  it("PN9 (pointer: fine) 時聚焦色碼框", async () => {
    stubPointer(true);
    mount();
    await openPanel(1);
    expect(document.activeElement).toBe(hexInput());
  });

  it("PN9 (pointer: coarse) 以點擊開啟時焦點在面板根", async () => {
    stubPointer(false);
    mount();
    await openPanel(1);
    expect(document.activeElement).toBe(panel());
    await settle();
    expect(document.activeElement).toBe(panel());
  });

  it("PN9 (pointer: coarse) 以鍵盤開啟（detail 0）時聚焦色碼框", async () => {
    stubPointer(false);
    mount();
    await openPanel(0);
    expect(document.activeElement).toBe(hexInput());
  });

  it("PN10 Back：回到項目列表、焦點在「自訂…」；關掉再開仍是項目列表", async () => {
    mount();
    await openPanel();
    fireEvent.click(button("Back"));
    await waitFor(() => expect(customItem()).not.toBeNull());
    expect(panel()).toBeNull();
    expect(screen.getByText("other item")).toBeInTheDocument();
    expect(document.activeElement).toBe(customItem());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(customItem());
    await waitFor(() => expect(panel()).not.toBeNull());
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(menuNode()).toBeNull());
    await openHostMenu();
    expect(customItem()).not.toBeNull();
    expect(panel()).toBeNull();
  });

  it("PN11 Back、Apply、最近用過的色塊都在 Tab 順序裡", async () => {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(["#111111", "#222222"]));
    mount();
    await openPanel();
    for (const name of ["Back", "Apply", "#111111", "#222222"]) {
      expect(button(name).tabIndex, name).not.toBe(-1);
    }
  });

  it("PN12 輸入合法色碼只更新預覽與方塊、不寫入；按 Enter 才寫入一次", async () => {
    const { editor } = mount();
    await openPanel();
    const [saturation] = await sliders();
    const before = JSON.stringify(editor.document);
    const valueTextBefore = saturation!.getAttribute("aria-valuetext");

    typeHex("#ff6600");
    const preview = panel()!.querySelector("[data-text-color]");
    expect(preview).toHaveAttribute("data-text-color", "#ff6600");
    expect(preview).toHaveTextContent("Aa");
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(applyMock).not.toHaveBeenCalled();
    expect(readRecentColors()).not.toContain("#ff6600");
    await waitFor(() => expect(saturation!.getAttribute("aria-valuetext")).not.toBe(valueTextBefore));
    expect(saturation!.getAttribute("aria-valuetext")).toBe("Saturation 100%, Brightness 100%");

    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("PN13 面板的內容寬度容得下 react-colorful 的寬度，不會撐出橫向捲軸", async () => {
    mount();
    await openPanel();
    await sliders();
    const picker = panel()!.querySelector(".react-colorful")!;
    const pickerWidth = parseFloat(getComputedStyle(picker).width);
    expect(pickerWidth).toBe(200);
    expect(declaredContentWidth(panel()!)).toBeGreaterThanOrEqual(pickerWidth);
  });
});
