import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { TourContext } from "@/lib/tour-context";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";
import { ShortcutsDialog } from "./ShortcutsDialog";

/**
 * 外殼（ShortcutsDialog）＋真的內容元件（ShortcutsLazy）合在一起的行為：開啟落點、Tab 循環、選分類不關對話框。
 * 外殼單獨的行為（lazy 邊界、名稱、還焦點）在 ShortcutsDialog.test.tsx（內容換成替身）；內容單獨的在 ShortcutsLazy.test.tsx。
 */

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/ai/actions") return Promise.resolve(new Response(JSON.stringify({ actions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
}

/** 照 AppShell 的掛法：說明視窗一直掛著，開關與起始頁由外面的 state 控制，外面有導覽 context。 */
function renderHost(start: () => void) {
  stubFetch();
  let setOpen: (open: boolean, page?: ShortcutsStartPage) => void = () => {};
  function Host() {
    const [open, setOpenState] = useState(false);
    const [page, setPage] = useState<ShortcutsStartPage>("global");
    setOpen = (next, nextPage) => {
      if (nextPage) setPage(nextPage);
      setOpenState(next);
    };
    return <ShortcutsDialog open={open} onOpenChange={setOpenState} returnFocusRef={createRef<HTMLElement>()} page={page} />;
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TourContext.Provider value={{ start }}>
          <Host />
        </TourContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { setOpen: (open: boolean, page?: ShortcutsStartPage) => act(() => setOpen(open, page)) };
}

function renderOpen(onOpenChange: (open: boolean) => void = () => {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/ai/actions") return Promise.resolve(new Response(JSON.stringify({ actions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ShortcutsDialog open onOpenChange={onOpenChange} returnFocusRef={createRef<HTMLElement>()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ShortcutsDialog＋ShortcutsContent", () => {
  it("W1 第一次開啟（chunk 還在下載）：對話框先有名稱；內容到了之後焦點落在右卡內容區，名稱是「General」", async () => {
    renderOpen();
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
    const region = await screen.findByRole("region", { name: "General" });
    await waitFor(() => expect(region).toHaveFocus());
  });

  it("W2 Tab 在內容區與 ✕ 之間循環（左欄分類鈕與窄螢幕的返回鈕夾在中間）", async () => {
    renderOpen();
    const region = await screen.findByRole("region", { name: "General" });
    await waitFor(() => expect(region).toHaveFocus());
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.keyDown(region, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(region).toHaveFocus();
  });

  it("W3 DOM 順序：✕ → 左欄分類鈕 → 右卡內容區（開啟落點與 Tab 循環依賴它）", async () => {
    renderOpen();
    const region = await screen.findByRole("region", { name: "General" });
    const dialog = screen.getByRole("dialog", { name: "Help" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    const firstCategory = within(dialog).getByRole("button", { name: "General" });
    const order = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(order(close, firstCategory)).toBe(true);
    expect(order(firstCategory, region)).toBe(true);
  });

  it("W4 選分類：對話框不關、右卡換成那一類（Esc 才關）", async () => {
    const onOpenChange = vi.fn();
    renderOpen(onOpenChange);
    await screen.findByRole("region", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(await screen.findByRole("region", { name: "Columns" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("起始頁在「功能導覽」時按〔Start tour〕：說明視窗關掉，start 恰被呼叫一次", async () => {
    const start = vi.fn();
    const host = renderHost(start);
    await host.setOpen(true, "tour");
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Start tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("從「通用」頁切到「Feature tour」再按〔Start tour〕：說明視窗關掉，start 恰被呼叫一次", async () => {
    const start = vi.fn();
    const host = renderHost(start);
    await host.setOpen(true, "global");
    await screen.findByRole("region", { name: "General" });
    fireEvent.click(screen.getByRole("button", { name: "Feature tour" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("關閉動畫還沒跑完（內容仍掛著）就再以「通用」打開：這一次從「通用」開始，不沿用上一次的頁", async () => {
    // jsdom 沒有動畫：讓對話框內容看起來有關閉動畫，Radix 就會等 animationend 才卸載，內容停在畫面上。
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const real = realGetComputedStyle(el, pseudo);
      if (!el.hasAttribute("data-shortcuts-dialog")) return real;
      return new Proxy(real, {
        get: (target, key) => (key === "animationName" ? `dialog-${el.getAttribute("data-state")}` : Reflect.get(target, key, target)),
      });
    });
    const host = renderHost(vi.fn());
    await host.setOpen(true, "tour");
    await screen.findByRole("region", { name: "Feature tour" });
    await host.setOpen(false);
    expect(document.querySelector("[data-shortcuts-dialog]")).toHaveAttribute("data-state", "closed");
    await host.setOpen(true, "global");
    expect(await screen.findByRole("region", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "true");
  });
});
