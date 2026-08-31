import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

/**
 * AppShell 版面 smoke：直接斷言高度＋寬度鎖鏈的 class 字串本身——根
 * `h-screen overflow-hidden`（連同 `gap-3 bg-background p-3`），`main`
 * `min-h-0 min-w-0 flex-1 flex-col`（側欄卡化後捲動全部內移到側欄自己的清單
 * 容器，main 不再自己 `overflow-y-auto`，改成寬度鏈的起點——見 `AppShell.tsx`
 * 檔頭「PR2（BC2 卡片版面）」那段說明）。這類 class 組合在 jsdom 快照/一般
 * 互動測試裡看起來完全正常，只有真的有滾動內容、真的有 flex 容器擠壓時才會
 * 露餡，必須直接斷言字串本身，不能只看畫面像不像對。
 */
describe("AppShell 版面 smoke", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("根＝flex h-screen overflow-hidden gap-3 bg-background p-3；main＝flex min-h-0 min-w-0 flex-1 flex-col", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <AppShell>content</AppShell>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const main = await screen.findByText("content");
    const root = main.closest("main")?.parentElement;

    expect(main.closest("main")).toHaveClass("flex", "min-h-0", "min-w-0", "flex-1", "flex-col");
    expect(root).toHaveClass("flex", "h-screen", "overflow-hidden", "gap-3", "bg-background", "p-3");

    // #115：靜態側欄卡 `<md` 藏起來（抽屜接手）、`md+` 才以卡片顯示——`hidden`
    // 搭配 `md:flex md:flex-col` 缺一即壞（缺 md:flex 寬螢幕也消失；缺 md:flex-col
    // 內部堆疊失去方向）。
    const aside = root?.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside).toHaveClass("hidden", "w-64", "shrink-0", "md:flex", "md:flex-col");
  });

  // PR3：K logo 與新增筆記鈕跟主題色。K 的 <span> 是 aria-hidden——getByText 不受
  // 可及性樹過濾，是這裡唯一取得到它的握把（N3）。ThemeProvider 掛載會恆設
  // data-accent 在 <html> 上（見 theme.tsx）——m4：跟 UserMenu.test.tsx 同一套
  // 清理紀律，finally 清掉避免污染同檔案後續案。
  it("K logo 套用 text-brand；新增筆記鈕套用 brand tint variant", async () => {
    try {
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

      expect(screen.getByText("K")).toHaveClass("text-brand");
      expect(screen.getByRole("button", { name: "New note" })).toHaveClass(
        "bg-brand-soft",
        "text-brand-on-soft",
        "hover:bg-brand-soft-strong",
      );
    } finally {
      document.documentElement.removeAttribute("data-accent");
    }
  });
});
