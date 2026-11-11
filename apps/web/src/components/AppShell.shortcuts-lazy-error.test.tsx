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

// 快捷鍵頁的 lazy chunk（ShortcutsLazy）載入失敗：只有對話框內容區出錯，對話框外殼（標題）與頁面照常，不冒到 AppErrorBoundary。
// 骨架同 AppShell.trash-lazy-error.test.tsx：錯誤訊息照 Chromium 裸動態 import 失敗措辭，vitest 把 factory 的 reject 包成
// 「error when mocking a module」、原錯誤放 cause，isChunkLoadError 本來就查 cause 一層。

vi.mock("@/components/shortcuts/ShortcutsLazy", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/ShortcutsLazy-abc.js")),
);

const SHORTCUTS_FLAG = "knotebook:chunk-reload:shortcuts";
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
      if (url === "/api/ai/actions") return Promise.resolve(fakeResponse({ actions: [] }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderApp() {
  render(
    <AppErrorBoundary reload={vi.fn()}>
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

async function openShortcuts(): Promise<void> {
  await screen.findByTestId("page-body");
  fireEvent.keyDown(window, { key: "/", ctrlKey: true });
}

describe("AppShell — 快捷鍵頁 chunk 載入失敗", () => {
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

  it("SE1 本 session 已自動重整過一次：對話框與標題仍在，內容區就地顯示 chunk 錯誤＋重試，app 不崩", async () => {
    sessionStorage.setItem(SHORTCUTS_FLAG, "1");
    stubFetch();
    renderApp();
    await openShortcuts();

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("SE2 第一次失敗：用 shortcuts 自己的額度自動重整一次，NotePage 的額度不動、app 不崩", async () => {
    stubFetch();
    renderApp();
    await openShortcuts();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(SHORTCUTS_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(NOTEPAGE_FLAG)).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
  });
});
