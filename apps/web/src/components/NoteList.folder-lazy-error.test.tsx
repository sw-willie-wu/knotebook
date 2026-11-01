import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { personalNote } from "@/test/select-fixtures";
import { AppErrorBoundary } from "./ErrorBoundary";
import { NoteList } from "./NoteList";

// 資料夾對話框的 lazy chunk（FolderLazy）載入失敗（plan T3 FD11，mock 做法照 AppShell.select-lazy-error.test.tsx）：
// `vi.mock` 整檔生效，所以獨立成檔。字串包也讓它失敗（同一個 chunk 的另一個 import 不得繞過 factory 載入真模組）。
vi.mock("@/components/sidebar/FolderLazy", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/FolderLazy-abc.js")),
);
vi.mock("@/i18n/folder-strings", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/FolderLazy-abc.js")),
);

const FOLDER_FLAG = "knotebook:chunk-reload:folder";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("NoteList — 資料夾對話框 chunk 載入失敗", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/notes") return Promise.resolve(json([personalNote({ id: "p1", title: "p1" })]));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    __resetCollapseForTests();
    __resetFolderSortForTests();
  });

  it("FD11 重載額度已用完：按 New folder 後 tabpanel 內出現看得見的 inline 錯誤（外框 className 恰為 p-2，不是 hidden）", async () => {
    sessionStorage.setItem(FOLDER_FLAG, "1");
    render(
      <AppErrorBoundary reload={vi.fn()}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <ActiveNoteProvider>
              <SidebarTabProvider>
                <div role="tabpanel">
                  <NoteList />
                </div>
              </SidebarTabProvider>
            </ActiveNoteProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </AppErrorBoundary>,
    );
    const panel = screen.getByRole("tabpanel");
    await within(panel).findByRole("link", { name: "p1" });
    fireEvent.click(within(panel).getByRole("button", { name: "New folder" }));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(alert.parentElement?.className).toBe("p-2");
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
