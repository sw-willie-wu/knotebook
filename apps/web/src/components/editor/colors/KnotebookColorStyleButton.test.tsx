import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { REWRITE_ACTION_ID, type AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SelectionAiController } from "@/components/ai/SelectionAiController";
import { installCustomColors, resetCustomColorsForTest } from "@/lib/custom-colors";
import { resetRecentColorsForTest } from "@/lib/recent-colors";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P } from "@/test/columns-fixtures";
import { layoutHostTrigger, waitForMenuShown } from "@/test/color-menu-host";

// 格式工具列的顏色鈕：10 種內建色之外每段多一個「自訂…」，點了在同一個 dropdown 裡開自訂色面板。
// 掛法照 `AiToolbar.test.tsx`：工具列由 `SelectionAiController` 經 `FormattingToolbarController` 掛上，選一段文字讓它出現。

const REWRITE: AiActionDto = { id: REWRITE_ACTION_ID, name: "Rewrite", applyMode: "direct", kind: "quick" };
const COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"];

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  vi.unstubAllGlobals();
});

function renderHost(editor: AnyEditor) {
  stubAiFetch({ actions: [REWRITE] });
  // 圖示與預覽用的是 block 種類的選擇器，production 靠全域 observer 登記；與 `main.tsx` 同序，先裝再掛。
  installCustomColors(document.body);
  renderAiHost({ editor, children: <SelectionAiController /> });
}

/** 兩段：`top`（p0）與 `target text`（p1）；p1 的文字可帶樣式。掛好後選取 p1 的 `target`，等工具列與 AI 鈕都出現。 */
async function mount(styles: Record<string, string> = {}): Promise<AnyEditor> {
  const editor = createTestEditor([
    { id: "p0", type: "paragraph", content: "top" },
    { id: "p1", type: "paragraph", content: [{ type: "text", text: "target text", styles }] },
  ]);
  renderHost(editor);
  selectInBlock(editor, "p1", 0, 6);
  // AI 鈕要等動作清單載入才出現；等它在，後面的步驟不會被這次工具列重繪打斷。
  await screen.findByRole("button", { name: "AI" });
  await waitFor(() => expect(colorsButton()).not.toBeNull());
  return editor;
}

const colorsButton = () => document.querySelector<HTMLElement>('.bn-formatting-toolbar [data-test="colors"]');
const dropdown = () => document.querySelector<HTMLElement>(".bn-formatting-toolbar .bn-color-picker-dropdown");
const panel = () => document.querySelector<HTMLElement>(".bn-formatting-toolbar .kb-color-panel");
const item = (test: string) => document.querySelector<HTMLElement>(`[data-test="${test}"]`)!;
const hexInput = () => screen.getByRole("textbox", { name: "Hex color", hidden: true }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/**
 * `.bn-toolbar` 是 `overflow-x: auto`，floating-ui 把它當成顏色鈕的裁切祖先；jsdom 裡它的框是 0×0，
 * hide 中介層就判定顏色鈕被裁掉、把 dropdown 標成 display:none。給工具列一個包住顏色鈕的框（須在開選單之前呼叫）。
 */
function layoutToolbar(): () => void {
  const toolbar = document.querySelector<HTMLElement>(".bn-formatting-toolbar")!;
  toolbar.getBoundingClientRect = () => new DOMRect(90, 90, 400, 40);
  Object.defineProperty(toolbar, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(toolbar, "clientHeight", { value: 40, configurable: true });
  return () => {
    delete (toolbar as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    delete (toolbar as { clientWidth?: number }).clientWidth;
    delete (toolbar as { clientHeight?: number }).clientHeight;
  };
}

/** Menu.Item 的 checked 為真時右側是勾號 svg，為 false 時是 `.bn-tick-space` 佔位。 */
const isChecked = (el: Element) => el.querySelector(".bn-tick-space") === null && el.querySelector("svg") !== null;

/** p1 開頭 `target` 那段文字目前的樣式。 */
function targetStyles(editor: AnyEditor): Record<string, string> {
  const content = editor.getBlock("p1")!.content as Array<{ text: string; styles: Record<string, string> }>;
  return content.find((c) => c.text.startsWith("target"))!.styles;
}

/** 開顏色選單，等 dropdown 掛上，並讓 Mantine 開選單時排的初始聚焦計時器（含工具列 trap 啟用後的那一個）跑完。 */
async function openColors() {
  fireEvent.click(colorsButton()!);
  await waitFor(() => expect(dropdown()).not.toBeNull());
  await wait(50);
}

/** 開選單 → 點「自訂…」（`detail` 0＝鍵盤啟動，色碼框取得焦點），等面板掛上。 */
async function openPanel(section: "text" | "background" = "text") {
  await openColors();
  fireEvent.click(item(`${section}-color-custom`), { detail: 0 });
  await waitFor(() => expect(panel()).not.toBeNull());
}

describe("KnotebookColorStyleButton", () => {
  it("TB1 顏色選單：兩段各 10 個內建色項（data-test 不變）加一個「自訂…」", async () => {
    await mount();
    await openColors();
    const ids = (prefix: string) =>
      Array.from(dropdown()!.querySelectorAll(`[data-test^="${prefix}-color-"]`)).map((el) => el.getAttribute("data-test"));
    expect(ids("text")).toEqual([...COLORS.map((c) => `text-color-${c}`), "text-color-custom"]);
    expect(ids("background")).toEqual([...COLORS.map((c) => `background-color-${c}`), "background-color-custom"]);
    expect(item("text-color-custom")).toHaveTextContent("Custom…");
  });

  it("TB2 選取文字是正規形色碼：「自訂…」打勾、default 不打勾", async () => {
    await mount({ textColor: "#ff6600" });
    await openColors();
    expect(isChecked(item("text-color-custom"))).toBe(true);
    expect(isChecked(item("text-color-default"))).toBe(false);
    expect(isChecked(item("background-color-custom"))).toBe(false);
    expect(isChecked(item("background-color-default"))).toBe(true);
  });

  it("TB2 選取文字是非正規形的 rgb(1, 2, 3)：文字段沒有任何一項打勾，兩個「自訂…」都不打勾", async () => {
    await mount({ textColor: "rgb(1, 2, 3)" });
    await openColors();
    for (const c of [...COLORS, "custom"]) expect(isChecked(item(`text-color-${c}`)), `text-color-${c}`).toBe(false);
    expect(isChecked(item("background-color-custom"))).toBe(false);
    expect(isChecked(item("background-color-default"))).toBe(true);
  });

  it("TB3 「自訂…」開面板、選單不關；輸入 #ff6600 按 Apply → 套到選取文字、選單關、工具列圖示換成該色", async () => {
    const editor = await mount();
    await openPanel();
    expect(colorsButton()).toHaveAttribute("aria-expanded", "true");
    fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
    fireEvent.click(button("Apply"));
    expect(targetStyles(editor).textColor).toBe("#ff6600");
    expect(colorsButton()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => {
      const icon = document.querySelector<HTMLElement>('[data-test="colors"] .bn-color-icon')!;
      expect(icon.getAttribute("data-text-color")).toBe("#ff6600");
      expect(getComputedStyle(icon).color).toBe("rgb(255, 102, 0)");
    });
  });

  it("TB4 內建色 background-color-red：套用、選單關（行為與原生相同）", async () => {
    const editor = await mount();
    await openColors();
    fireEvent.click(item("background-color-red"));
    expect(targetStyles(editor).backgroundColor).toBe("red");
    expect(colorsButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("TB5 沒有最近色時，面板最後一個 Apply 按 Tab 繞回 Back，顏色 dropdown 仍在工具列裡", async () => {
    // jsdom 的 fireEvent.click 不聚焦，dropdown 的 trap 比工具列的先註冊；真瀏覽器是相反的順序，由 e2e 驗。
    await mount();
    const restore = layoutHostTrigger(colorsButton()!);
    const restoreToolbar = layoutToolbar();
    try {
      await openPanel();
      await waitForMenuShown(() => dropdown()!);
      fireEvent.change(hexInput(), { target: { value: "#ff6600" } });
      const apply = button("Apply");
      expect(apply).toBeEnabled();
      expect(screen.queryAllByRole("button", { name: /^#/, hidden: true })).toHaveLength(0);
      apply.focus();
      expect(fireEvent.keyDown(apply, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(button("Back"));
      expect(dropdown()).not.toBeNull();
      expect(colorsButton()).toHaveAttribute("aria-expanded", "true");
    } finally {
      restoreToolbar();
      restore();
    }
  });

  it("TB6 Back：回到項目列表，焦點在文字段的「自訂…」", async () => {
    await mount();
    await openPanel();
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(item("text-color-custom")));
    expect(panel()).toBeNull();
  });

  it("TB7 面板開著時文件在選取之前多了一段（工具列重繪）：焦點留在色碼框、面板不關、已輸入的字還在", async () => {
    const editor = await mount();
    await openPanel();
    const hex = hexInput();
    hex.focus();
    fireEvent.change(hex, { target: { value: "#ff6" } });
    await wait(20);
    // 基準：插入之前焦點就在色碼框。這裡紅表示是焦點初次進入工具列時的搶焦點，不是重繪那一次。
    expect(document.activeElement).toBe(hex);
    // 選取被重映射 → 工具列的定位變 → 工具列重繪，Mantine 的 focus trap 重新收到 ref，排一次 focusNode
    act(() => {
      editor.insertBlocks([{ type: "paragraph", content: "x" }], "p0", "before");
    });
    await wait(20);
    expect(document.activeElement).toBe(hex);
    expect(panel()).not.toBeNull();
    expect(hex.value).toBe("#ff6");
  });

  it("TB8 從面板按 Back 之後工具列重繪：dropdown 的初始聚焦佔位元素已放回，焦點留在 dropdown 裡", async () => {
    const editor = await mount();
    await openPanel();
    fireEvent.click(button("Back"));
    await waitFor(() => expect(document.activeElement).toBe(item("text-color-custom")));
    const dd = dropdown()!;
    act(() => {
      editor.insertBlocks([{ type: "paragraph", content: "x" }], "p0", "before");
    });
    await wait(30);
    // 面板借走的 data-autofocus 要還回去：只剩佔位元素那一個，工具列重新聚焦時落在它身上，不會跳出 dropdown。
    expect(dd.querySelectorAll("[data-autofocus]")).toHaveLength(1);
    expect(dd.contains(document.activeElement)).toBe(true);
  });

  it("TB9 選取的 block 都沒有行內內容（選到圖片）：工具列在，但沒有顏色鈕", async () => {
    const editor = createTestEditor([P("x", "x"), IMG("img"), P("z", "z")]);
    renderHost(editor);
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    // 等到自家的檔案刪除鈕出現，確定這次選取的工具列已經畫完，再斷言顏色鈕不在。
    await waitFor(() => expect(document.querySelector(".bn-formatting-toolbar [data-kb-file-delete]")).not.toBeNull());
    expect(colorsButton()).toBeNull();
  });
});
