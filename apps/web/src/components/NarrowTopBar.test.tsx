import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import HomePage from "@/pages/HomePage";
import { NotePageFallback } from "./NotePageFallback";

/**
 * #115：NarrowTopBar（`md:hidden` 的漢堡＋K logo 列）消費端守衛。
 *
 * spec §3a 的明確清單＝HomePage／NotePageFallback／NoteRouteErrorFallback 三處
 * （第三處的斷言在 `ErrorBoundary.test.tsx`，它有現成的錯誤畫面 harness；
 * **AppErrorFallback 刻意排除**的反向斷言也在那邊）——沒有這組守衛，窄視窗上
 * 這些頁面就是「側欄藏了、又沒有任何入口能打開抽屜」的死路，而 jsdom 不套 CSS
 * 看不出來。
 */

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

function fakeResponse(json: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(json) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/notes") return Promise.resolve(fakeResponse([]));
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderWithProviders(children: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>{children}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("NarrowTopBar 消費端（#115）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HomePage 內文卡頂有 md:hidden 的漢堡列（開抽屜入口）", async () => {
    renderWithProviders(<HomePage />);
    // 靜態側欄與 NarrowTopBar 各有一顆漢堡？不——靜態側欄沒有漢堡，唯一的
    // 「Open navigation」就是 NarrowTopBar 的。它必須在 main（內文卡）裡。
    const hamburger = await screen.findByRole("button", { name: "Open navigation" });
    expect(hamburger.closest("main")).not.toBeNull();
    // wrapper 與按鈕**各自**斷 md:hidden——`closest('[class*="md:hidden"]')` 含
    // 元素自身、按鈕本身就帶這個 class，那種寫法恆真（審查突變實證：wrapper 拔掉
    // md:hidden 仍全綠）。掉 wrapper 那個的後果是寬視窗每張內文卡頂多一條
    // 「K Knotebook」列。
    expect(hamburger.parentElement).toHaveClass("md:hidden");
    expect(hamburger).toHaveClass("md:hidden");
  });

  it("NotePageFallback（chunk 載入中的過渡畫面）同樣有漢堡列", async () => {
    renderWithProviders(<NotePageFallback />);
    const hamburger = await screen.findByRole("button", { name: "Open navigation" });
    expect(hamburger.closest("main")).not.toBeNull();
  });
});
