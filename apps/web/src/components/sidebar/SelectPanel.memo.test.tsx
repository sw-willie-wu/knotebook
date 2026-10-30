import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { NoteList } from "@/components/NoteList";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { noteLocationLabel } from "@/components/sidebar/tree";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { Folder } from "@/components/ui/icons";
import { personalNote } from "@/test/select-fixtures";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";

// 只包一層計數（NS14：勾一列時哪些列重算了位置行），行為照原本（照 TrashPanel.test.tsx SM16）。
vi.mock("@/components/sidebar/tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/sidebar/tree")>();
  return { ...actual, noteLocationLabel: vi.fn(actual.noteLocationLabel) };
});

// NS14f：資料夾列勾選框（label 內的 `Folder` 圖示）每重繪一次就呼叫一次；只包計數、行為照原本。
vi.mock("@/components/ui/icons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/icons")>();
  return { ...actual, Folder: vi.fn(actual.Folder) };
});

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const ME: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: "tester",
  displayName: "Tester",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

const NOTES = ["p1", "p2", "p3"].map((id) => personalNote({ id, title: id }));

const panel = () => screen.getByRole("tabpanel");
const checkbox = (id: string) => panel().querySelector(`input[type="checkbox"][data-selection-key="note:${id}"]`) as HTMLInputElement;

describe("一般 tab 選取列的 memo", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("NS14 最近 tab：勾一列只重算那一列的位置行", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(NOTES));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    localStorage.setItem("sidebar.tab", "recent");
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-sidebar-instance="">
                <div role="tabpanel">
                  <NoteList />
                </div>
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
    await within(panel()).findAllByRole("link");
    fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
    expect(await within(panel()).findAllByRole("checkbox")).toHaveLength(3);

    const calls = vi.mocked(noteLocationLabel);
    calls.mockClear();
    fireEvent.click(checkbox("p1"));
    expect(checkbox("p1")).toBeChecked();
    expect(calls.mock.calls.map(([note]) => note.id)).toEqual(["p1"]);

    fireEvent.click(checkbox("p2"));
    expect(checkbox("p2")).toBeChecked();
    expect(calls.mock.calls.map(([note]) => note.id)).toEqual(["p1", "p2"]);
  });

  it("NS14f 我的筆記：勾資料夾 A 只重繪 A 那列（三個資料夾列，Folder 圖示只多畫一次）", async () => {
    const folders = ["A", "B", "C"].map((id) => folderDto({ id, name: id }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify({ folders }), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(NOTES));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-sidebar-instance="">
                <div role="tabpanel">
                  <NoteList />
                </div>
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
    await within(panel()).findAllByRole("link");
    fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
    // 3 篇＋3 個資料夾。
    expect(await within(panel()).findAllByRole("checkbox")).toHaveLength(6);
    const folderBox = (id: string) => panel().querySelector(`input[type="checkbox"][data-selection-key="folder:${id}"]`) as HTMLInputElement;

    const draws = vi.mocked(Folder);
    draws.mockClear();
    fireEvent.click(folderBox("A"));
    expect(folderBox("A")).toBeChecked();
    expect(within(header()).getByText("1 selected")).toBeInTheDocument();
    expect(draws).toHaveBeenCalledTimes(1);

    fireEvent.click(folderBox("C"));
    expect(folderBox("C")).toBeChecked();
    expect(draws).toHaveBeenCalledTimes(2);
  });
});
