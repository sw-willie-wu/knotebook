import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { AppErrorBoundary } from "./ErrorBoundary";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 垃圾桶 tab 的 lazy chunk（TrashLazy）載入失敗（T9 fix r2 I-1）：只有垃圾桶那塊出錯，側欄其餘與頁面照常，不冒到 AppErrorBoundary。
// 錯誤訊息照 Chromium 的裸動態 import 失敗措辭（ErrorBoundary.tsx 的 CHUNK_ERROR_PATTERNS）；vitest 把 factory 的 reject 包成
// 「error when mocking a module」、原錯誤放 `cause`——`isChunkLoadError` 本來就查 cause 一層，所以照樣判成 chunk 錯誤。

vi.mock("@/components/sidebar/TrashLazy", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/TrashLazy-abc.js")),
);

const TRASH_FLAG = "knotebook:chunk-reload:trash";
const NOTEPAGE_FLAG = "knotebook:chunk-reload:notepage";

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([]));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderApp() {
  const appReload = vi.fn();
  render(
    <AppErrorBoundary reload={appReload}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>{<div data-testid="page-body">body</div>}</AppShell>} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>,
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;

describe("AppShell — 垃圾桶 chunk 載入失敗", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
  });

  it("TE1 本 session 已自動重整過一次：垃圾桶面板就地顯示 chunk 錯誤＋重試，tab 列、UserMenu、頁面內文照常", async () => {
    sessionStorage.setItem(TRASH_FLAG, "1");
    stubFetch();
    renderApp();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));

    const panel = within(aside()).getByRole("tabpanel");
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // 底部那份也接住了，但錯誤內容藏起來（面板那份已顯示）
    const footerAlerts = within(aside()).getAllByRole("alert").filter((el) => !panel.contains(el));
    expect(footerAlerts).toHaveLength(1);
    // 比對整個 className：沒有 errorClassName 時 alert 直接掛在 aside 下，而桌面 aside 自帶 `hidden md:flex`（toHaveClass 會空真）
    expect(footerAlerts[0]!.parentElement?.className).toBe("hidden");

    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(within(aside()).getByRole("button", { name: /Ann/ })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    // 切回別的 tab：側欄恢復正常
    fireEvent.click(within(aside()).getByRole("tab", { name: "My notes" }));
    expect(within(aside()).getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(aside()).queryByRole("alert")).toBeNull();
  });

  it("TE2 第一次失敗：用 trash 自己的額度自動重整一次（兩個掛載點只重整一次），NotePage 的額度不動、app 不崩", async () => {
    stubFetch();
    renderApp();
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(TRASH_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(NOTEPAGE_FLAG)).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
  });
});
