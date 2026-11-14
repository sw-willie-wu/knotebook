import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import { adminRole, groupDto } from "@/test/fixtures";
import { GroupMenu } from "./GroupMenu";

// 改名／刪除群組對話框的 lazy chunk 載入失敗：只在原位顯示 inline 錯誤，⋮ 鈕與整個 app 不崩。
// `vi.mock` 整檔生效，所以獨立成檔（照 NoteList.folder-lazy-error.test.tsx）。
const fail = (name: string) => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: http://localhost/assets/${name}-abc.js`));
vi.mock("./GroupNameDialog", () => fail("GroupNameDialog"));
vi.mock("./DeleteGroupDialog", () => fail("DeleteGroupDialog"));

const GROUP = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());

describe("GroupMenu — 改名／刪除對話框 chunk 載入失敗", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    sessionStorage.setItem("knotebook:chunk-reload:groupDialog", "1");
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it.each(["Rename", "Delete group"])("⋮ → %s：出現 inline 錯誤，⋮ 鈕還在、app 沒崩", async (item) => {
    render(
      <AppErrorBoundary reload={vi.fn()}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <GroupMenu group={GROUP} />
          </MemoryRouter>
        </QueryClientProvider>
      </AppErrorBoundary>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Group actions for Workshop A" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: item }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(screen.getByRole("button", { name: "Group actions for Workshop A", hidden: true })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
