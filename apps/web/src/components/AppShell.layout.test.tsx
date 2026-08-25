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
 * PR2 wave 1（地基）：本斷言刻意描述**改版前現況**，把目前無人守的高度鎖鏈
 * （AppShell 根 `h-screen overflow-hidden` → `main` `min-h-0 flex-1
 * overflow-y-auto`——見 `AppShell.tsx` 檔頭關於 `h-screen`/`min-h-0` 必要性的
 * 說明）先釘住，讓後續 wave 改殼時如果不慎弄丟這條鏈，這裡會先紅。
 * **wave 2 改殼（側欄卡＋新 main class）時，本檔會同步換成新版鏈的斷言**——
 * 這不是「守著即將被改的舊行為」的無意義測試，是刻意的漸進式安全網。
 */
describe("AppShell 版面（PR2 wave 1 smoke）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("根＝flex h-screen overflow-hidden；main＝min-h-0 flex-1 overflow-y-auto", async () => {
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

    expect(main.closest("main")).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(root).toHaveClass("flex", "h-screen", "overflow-hidden");
  });
});
