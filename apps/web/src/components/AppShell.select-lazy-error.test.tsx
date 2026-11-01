import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { adminRole, groupDto } from "@/test/fixtures";
import { groupNote, personalNote } from "@/test/select-fixtures";
import { AppErrorBoundary } from "./ErrorBoundary";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 一般 tab 選取模式的 lazy chunk（SelectLazy）載入失敗（#181 PR-2c T6 AL2a／AL2b／AL3，拆法照 AppShell.trash-lazy-error.test.tsx）：
// 只有選取那幾塊出錯，側欄其餘與頁面照常，不冒到 AppErrorBoundary。錯誤訊息照 Chromium 的裸動態 import 失敗措辭；
// vitest 把 factory 的 reject 包成「error when mocking a module」、原錯誤放 `cause`（`isChunkLoadError` 查 cause 一層）。
// ⚠ 只 mock SelectLazy 時實測清單換成了真的勾選樹、select 旗標被成功那份的 beacon 清掉：NoteList 同一次 render 對 SelectLazy
// 發兩個 `import()`（標題列、清單），vitest 3.2.7 同一個 importer 的並發 import 有一支繞過 factory、載入真模組（`execute.js`
// requestWithMock 共用 callstack，註解「will not work if user does Promise.all(import(), import())」）。所以連真 SelectLazy
// 第一個 import 的字串包也讓它失敗，繞過的那一支照樣以同一個 chunk 錯誤失敗（真瀏覽器裡三個掛載點抓同一個 chunk，本來就一起失敗）。
vi.mock("@/components/sidebar/SelectLazy", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/SelectLazy-abc.js")),
);
vi.mock("@/i18n/select-strings", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/SelectLazy-abc.js")),
);

const SELECT_FLAG = "knotebook:chunk-reload:select";
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

const GROUP = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" }, adminRole());
const NOTES = [
  personalNote({ id: "p1", title: "p1" }),
  personalNote({ id: "p2", title: "p2" }),
  groupNote({ id: "w1", title: "w1", group: GROUP }),
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([GROUP]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(NOTES));
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

const aside = () => document.querySelector("aside") as HTMLElement;
const header = () => aside().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => aside().querySelector("[data-sidebar-list]") as HTMLElement;

/** 我的筆記 tab 等清單到了按「Select」。 */
async function startSelecting() {
  await within(aside()).findByRole("link", { name: "p1" });
  fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
}

describe("AppShell — 一般 tab 選取 chunk 載入失敗", () => {
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
    __resetCollapseForTests();
  });

  it("AL2a 本 session 已自動重整過一次：清單位置就地顯示 chunk 錯誤＋重試，標題列與底部的錯誤內容隱藏，側欄其餘照常", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    stubFetch();
    renderApp();
    await startSelecting();

    const listAlert = await within(list()).findByRole("alert");
    expect(listAlert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(within(listAlert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // 比對整個 className（同 TE1）：外框只有 `p-2`
    expect(listAlert.parentElement?.className).toBe("p-2");
    // 標題列那份也接住了，錯誤內容藏起來
    const headerAlerts = within(header()).getAllByRole("alert");
    expect(headerAlerts).toHaveLength(1);
    expect(headerAlerts[0]!.parentElement?.className).toBe("hidden");
    // 底部那份同理（清單、標題列以外只剩它一個）
    const footerAlerts = within(aside())
      .getAllByRole("alert")
      .filter((el) => !list().contains(el) && !header().contains(el));
    expect(footerAlerts).toHaveLength(1);
    expect(footerAlerts[0]!.parentElement?.className).toBe("hidden");
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();

    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(within(aside()).getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
    expect(within(aside()).getByRole("button", { name: /Ann/ })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("AL2b 第一次失敗：用 select 自己的額度自動重整一次（三個掛載點只重整一次），NotePage 與垃圾桶的額度不動、app 不崩", async () => {
    stubFetch();
    renderApp();
    await startSelecting();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(SELECT_FLAG)).not.toBeNull();
    expect(sessionStorage.getItem(NOTEPAGE_FLAG)).toBeNull();
    expect(sessionStorage.getItem(TRASH_FLAG)).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(within(aside()).getByRole("tablist", { name: "Sidebar sections" })).toBeInTheDocument();
    expect(screen.getByTestId("page-body")).toBeInTheDocument();
  });

  it("AL3 錯誤態沒有 Esc 與 Done：點 Groups 離開選取，群組是平常的列", async () => {
    sessionStorage.setItem(SELECT_FLAG, "1");
    stubFetch();
    renderApp();
    await startSelecting();
    await within(list()).findByRole("alert");

    fireEvent.click(within(aside()).getByRole("tab", { name: "Groups" }));
    expect(await within(list()).findByRole("link", { name: "w1" })).toBeInTheDocument();
    expect(within(list()).getByRole("button", { name: "R&D" })).toHaveAttribute("aria-expanded", "true");
    expect(within(header()).getByRole("button", { name: "Select" })).toBeEnabled();
    expect(within(aside()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(aside()).queryByRole("alert")).toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull(); // 群組 tab 沒有個人的新增鈕
  });
});
