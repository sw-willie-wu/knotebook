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
 * PR2 wave 1（地基）落的版本斷言**改版前現況**（根 `h-screen overflow-hidden`、
 * main `min-h-0 flex-1 overflow-y-auto`），先把當時無人守的高度鎖鏈釘住。
 * **wave 2（本次）改殼**：側欄卡化、捲動全部內移到側欄自己的清單容器，`main`
 * 不再自己 `overflow-y-auto`，改成寬度鏈的起點——`min-h-0 min-w-0 flex-1
 * flex-col`（見 `AppShell.tsx` 檔頭「PR2（BC2 卡片版面）」那段說明）。本檔同步
 * 換成新鏈的斷言，履行 wave 1 檔頭留下的承諾；不是「守著即將被改的舊行為」，
 * 是刻意的漸進式安全網。
 */
describe("AppShell 版面（PR2 wave 2 smoke）", () => {
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
