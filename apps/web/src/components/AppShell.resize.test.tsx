import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppShell } from "./AppShell";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: false, status: 401 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const KEY = "sidebar.width";

async function renderShell() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell>content</AppShell>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("content");
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  const aside = handle.closest("aside");
  if (!aside) throw new Error("resize handle is not inside the sidebar <aside>");
  return { handle, aside };
}

/**
 * 側欄寬度把手（Task 4）。**全檔都是 state／attribute 斷言**：jsdom 沒有 CSS、沒有版面、
 * 沒有 `setPointerCapture`（這裡用 spy 補上）——「游標離開把手仍跟手」「把手真的蓋在
 * `gap-3` 上」「focus 時看得到線」這類行為只能手動驗。
 */
describe("AppShell 側欄寬度把手", () => {
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
    document.documentElement.removeAttribute("data-accent");
  });

  it("預設：256px、aria-valuenow/min/max、可聚焦、把手在 aside 內（把手位置是 class 斷言）", async () => {
    const { handle, aside } = await renderShell();

    expect(aside.style.width).toBe("256px");
    expect(handle).toHaveAttribute("aria-valuenow", "256");
    expect(handle).toHaveAttribute("aria-valuemin", "200");
    expect(handle).toHaveAttribute("aria-valuemax", "480");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle.tabIndex).toBe(0);
    expect(aside.contains(handle)).toBe(true);
    // class 斷言，不是行為斷言：jsdom 沒有版面，量不到它是否真的蓋在 gap-3 上。
    expect(handle).toHaveClass("absolute", "left-full", "w-3", "cursor-col-resize");
  });

  it("拖曳：夾在上下限、拖曳中鎖 body、放開才寫入", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe("336px");
    expect(handle).toHaveAttribute("aria-valuenow", "336");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(aside.style.width).toBe("480px");

    fireEvent.pointerMove(handle, { clientX: -5000, pointerId: 1 });
    expect(aside.style.width).toBe("200px");
    expect(window.localStorage.getItem(KEY)).toBeNull();

    fireEvent.pointerUp(handle, { clientX: -5000, pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe("200");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    // 拖曳已結束：之後的 move 不再改寬度。clientX 刻意選 180——若拖曳沒結束會算出 336、
    // 與 200 不同值；選 0 的話算出來恰好也夾在 200，斷言分不出來（review r1 I1）。
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe("200px");
  });

  it("pointercancel 也收尾：寫入、body 還原、之後的 move 不改寬度", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe("336px");

    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe("336");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(aside.style.width).toBe("336px");
  });

  it("lostpointercapture 也收尾（系統奪走 capture、沒有 pointerup／cancel 的那條路）", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe("336px");

    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe("336");
    expect(document.body.style.userSelect).toBe("");
    expect(document.body.style.cursor).toBe("");

    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(aside.style.width).toBe("336px");
  });

  it.each([
    [1, "中鍵"],
    [2, "右鍵"],
  ])("button=%i（%s）的 pointerdown 不開始拖曳", async (button) => {
    const { handle, aside } = await renderShell();

    fireEvent.pointerDown(handle, { button, clientX: 100, pointerId: 1 });
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("");

    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 });
    expect(aside.style.width).toBe("256px");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("把手的線：平常透明、hover 不畫線，只在鍵盤聚焦與拖曳中出線（class／attribute 契約，不是行為斷言）", async () => {
    // Willie 2026-09-30 裁決：hover 只換游標、不畫線。jsdom 沒有 CSS，只能釘 class 字串與屬性。
    const { handle } = await renderShell();
    const line = handle.firstElementChild;
    if (!line) throw new Error("resize handle has no line element");
    expect(line).toHaveAttribute("aria-hidden", "true");
    // 容器與線都不得有任何 hover 形的 class（group-hover/…、hover:…）。
    expect(handle.className).not.toMatch(/hover/);
    expect(line.className).not.toMatch(/hover/);
    expect(line).toHaveClass("group-focus-visible/resize:bg-ring", "group-data-[dragging]/resize:bg-ring");

    // `group-data-[dragging]` 以「屬性存在」比對：平常必須完全沒有這個屬性——
    // `data-dragging={dragging}` 會被 React 渲染成 "false"（存在），線就恆亮。
    expect(handle).not.toHaveAttribute("data-dragging");
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    expect(handle).toHaveAttribute("data-dragging");
    fireEvent.pointerUp(handle, { clientX: 100, pointerId: 1 });
    expect(handle).not.toHaveAttribute("data-dragging");
  });

  it("鍵盤：左右 16px、Home／End、到頂不再動、每次都寫入", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(aside.style.width).toBe("272px");
    expect(window.localStorage.getItem(KEY)).toBe("272");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(aside.style.width).toBe("200px");
    expect(window.localStorage.getItem(KEY)).toBe("200");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(aside.style.width).toBe("200px");

    fireEvent.keyDown(handle, { key: "End" });
    expect(aside.style.width).toBe("480px");
    expect(window.localStorage.getItem(KEY)).toBe("480");

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(aside.style.width).toBe("480px");
    expect(handle).toHaveAttribute("aria-valuenow", "480");
  });

  it("雙擊回預設並清掉儲存", async () => {
    const { handle, aside } = await renderShell();

    fireEvent.keyDown(handle, { key: "End" });
    expect(window.localStorage.getItem(KEY)).toBe("480");

    fireEvent.doubleClick(handle);
    expect(aside.style.width).toBe("256px");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ["abc", "256px"],
    ["9999", "256px"],
    ["150", "256px"],
    ["300.5", "256px"],
    ["", "256px"],
    ["300", "300px"],
  ])("讀到 %j → %s", async (raw, expected) => {
    window.localStorage.setItem(KEY, raw);
    const { aside, handle } = await renderShell();
    expect(aside.style.width).toBe(expected);
    expect(handle).toHaveAttribute("aria-valuenow", expected.replace("px", ""));
  });

  it("sidebar.width 讀取丟錯 → 預設、頁面照常渲染", async () => {
    // 只對 sidebar.width 丟錯：theme.tsx 讀自己的鍵沒有 try/catch，全面丟錯會先炸在 ThemeProvider。
    const original = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === KEY) throw new Error("storage blocked");
      return original.call(this, key);
    });
    const { aside } = await renderShell();
    expect(spy).toHaveBeenCalledWith(KEY);
    expect(aside.style.width).toBe("256px");
    expect(screen.getByText("content")).toBeInTheDocument();
  });
});
