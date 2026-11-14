import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { AppErrorBoundary } from "./ErrorBoundary";
import { NoteList } from "./NoteList";

// 新增群組對話框的 lazy chunk 載入失敗：只在原位顯示 inline 錯誤，側欄與整個 app 不崩。
// `vi.mock` 整檔生效，所以獨立成檔（照 NoteList.folder-lazy-error.test.tsx）。
vi.mock("@/components/groups/GroupNameDialog", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/GroupNameDialog-abc.js")),
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("NoteList — 新增群組對話框 chunk 載入失敗", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    localStorage.setItem("sidebar.tab", "workspace");
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/notes") return Promise.resolve(json([]));
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

  it("重載額度已用完：按 New group 後 tabpanel 內出現 inline 錯誤，側欄標題列還在、app 沒崩", async () => {
    sessionStorage.setItem("knotebook:chunk-reload:groupDialog", "1");
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
    const add = await within(panel).findByRole("button", { name: "New group" });
    fireEvent.click(add);
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(alert.parentElement?.className).toBe("p-2");
    expect(within(panel).getByRole("button", { name: "New group" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
