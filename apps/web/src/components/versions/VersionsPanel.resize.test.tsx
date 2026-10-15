import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import type { VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { VersionsProvider, useVersionsController } from "@/lib/versions-context";
import { VersionsPanel } from "./VersionsPanel";
import { VERSIONS_ERROR_FRAME } from "./VersionsLazyBoundary";
import { useVersionsPanelWidth } from "./versions-panel-width";

const NOTE = "n1";
const KEY = "versions.panelWidth";
const EMPTY: VersionListDto = {
  versions: [],
  current: { baseSeq: null, base: null, dirty: false, nextSeq: 1, autoEnabled: true },
  nextBefore: null,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(EMPTY) } as Response)),
  );
}

/** 與 NoteEditor 的接法相同：state 在面板與錯誤外框的共同祖先，寬度以 CSS 變數往下傳。 */
function Host({ doc }: { doc: Y.Doc }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  const panelWidth = useVersionsPanelWidth();
  return (
    <VersionsProvider value={value}>
      <div data-testid="row" style={panelWidth.style}>
        <button type="button" onClick={value.open}>host-open</button>
        {value.panelOpen && <VersionsPanel doc={doc} width={panelWidth.width} onWidthChange={panelWidth.onChange} />}
        <div data-testid="error-frame" className={VERSIONS_ERROR_FRAME.panel} />
      </div>
    </VersionsProvider>
  );
}

async function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Host doc={new Y.Doc()} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("host-open"));
  const panel = await screen.findByTestId("versions-panel");
  const handle = screen.getByRole("separator", { name: "Resize versions panel" });
  const row = screen.getByTestId("row");
  return { panel, handle, row };
}
const widthVar = (row: HTMLElement) => row.style.getPropertyValue("--versions-panel-width");

describe("版本面板寬度把手（#274）", () => {
  let setPointerCapture: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
    window.localStorage.removeItem(KEY);
    setPointerCapture = vi.fn();
    Element.prototype.setPointerCapture = setPointerCapture;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as Partial<Element>).setPointerCapture;
    window.localStorage.removeItem(KEY);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  it("預設：320px、aria-valuenow/min/max、可聚焦、把手伸進內文卡與面板之間的間隙（right-full）、寬度走 CSS 變數", async () => {
    const { panel, handle, row } = await renderPanel();
    expect(widthVar(row)).toBe("320px");
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    expect(handle).toHaveAttribute("aria-valuemin", "240");
    expect(handle).toHaveAttribute("aria-valuemax", "560");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle.tabIndex).toBe(0);
    expect(panel.contains(handle)).toBe(true);
    // Tab 順序：把手是面板最後一個子元素（不是第一個停點）。
    expect(panel.lastElementChild).toBe(handle);
    expect(handle).toHaveClass("absolute", "right-full", "w-3", "cursor-col-resize");
    expect(handle).not.toHaveClass("left-0");
    // 面板根不得裁切（overflow-hidden 在內層），否則 right-full 的把手會被裁掉。
    expect(panel).not.toHaveClass("overflow-hidden");
    expect(panel.querySelector(":scope > .overflow-hidden")).not.toBeNull();
  });

  it("窄螢幕（底部卡片）沒有把手：把手只在 md+ 顯示（class 契約）；面板在 md+ 為 relative 以承載把手", async () => {
    const { panel, handle } = await renderPanel();
    expect(handle).toHaveClass("max-md:hidden");
    expect(panel).toHaveClass("md:relative", "md:w-[var(--versions-panel-width)]");
    expect(panel).not.toHaveClass("md:w-80");
  });

  it("把手在面板外：清單內距還原為 p-2，不再留 pl-3", async () => {
    const { panel } = await renderPanel();
    const list = panel.querySelector("ul");
    expect(list).not.toBeNull();
    expect(list).toHaveClass("p-2");
    expect(list).not.toHaveClass("pl-3");
  });

  it("錯誤外框與面板同一個寬度來源（同吃 CSS 變數），不再寫死 md:w-80", async () => {
    await renderPanel();
    const frame = screen.getByTestId("error-frame");
    expect(frame).toHaveClass("md:w-[var(--versions-panel-width)]");
    expect(frame).not.toHaveClass("md:w-80");
  });

  it("拖曳：往左變寬（把手在左緣）、夾在 240／560、拖曳中鎖 body、放開才寫入", async () => {
    const { handle, row } = await renderPanel();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 1 });
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 });
    expect(widthVar(row)).toBe("370px");
    expect(handle).toHaveAttribute("aria-valuenow", "370");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerMove(handle, { clientX: 550, pointerId: 1 });
    expect(widthVar(row)).toBe("270px");

    fireEvent.pointerMove(handle, { clientX: -5000, pointerId: 1 });
    expect(widthVar(row)).toBe("560px");
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(widthVar(row)).toBe("240px");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerUp(handle, { clientX: 5000, pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe("240");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    // 拖曳已結束：之後的 move 不再改寬度（clientX 選 450 → 若沒結束會算成 370）。
    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 });
    expect(widthVar(row)).toBe("240px");
  });

  it("鍵盤：往外（ArrowLeft）變寬 16px、ArrowRight 變窄、Home／End、每次都寫入", async () => {
    const { handle, row } = await renderPanel();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthVar(row)).toBe("336px");
    expect(window.localStorage.getItem(KEY)).toBe("336");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthVar(row)).toBe("304px");
    expect(window.localStorage.getItem(KEY)).toBe("304");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(widthVar(row)).toBe("240px");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthVar(row)).toBe("240px");

    fireEvent.keyDown(handle, { key: "End" });
    expect(widthVar(row)).toBe("560px");
    expect(window.localStorage.getItem(KEY)).toBe("560");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(widthVar(row)).toBe("560px");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle).toHaveAttribute("aria-valuenow", "560");
  });

  it("雙擊回 320 並清掉儲存", async () => {
    const { handle, row } = await renderPanel();
    fireEvent.keyDown(handle, { key: "End" });
    expect(window.localStorage.getItem(KEY)).toBe("560");
    fireEvent.doubleClick(handle);
    expect(widthVar(row)).toBe("320px");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("不動側欄的鍵：sidebar.width 不被碰", async () => {
    window.localStorage.setItem("sidebar.width", "300");
    const { handle } = await renderPanel();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(window.localStorage.getItem("sidebar.width")).toBe("300");
    expect(window.localStorage.getItem(KEY)).toBe("336");
  });

  it.each([
    ["abc", "320"],
    ["9999", "320"],
    ["100", "320"],
    ["300.5", "320"],
    ["", "320"],
    ["400", "400"],
  ])("讀到 %j → %spx", async (raw, expected) => {
    window.localStorage.setItem(KEY, raw);
    const { row, handle } = await renderPanel();
    expect(widthVar(row)).toBe(`${expected}px`);
    expect(handle).toHaveAttribute("aria-valuenow", expected);
  });
});
