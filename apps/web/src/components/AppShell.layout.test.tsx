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
  });
});
